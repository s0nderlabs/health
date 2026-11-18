// The Plan tab's "Lift clips" card: where a lifter already is when he wants
// a set looked at. Add opens Photos (originals only), each pick goes through
// the trim sheet, and the card then shows the upload queue and, below a
// hairline, the clips already on the Mac.
//
// A secondary surface on purpose: the session card above stays the hero
// (it alone wears the strong glass and the accent Start). Here the accent
// appears only on the trim sheet's Send.

import SwiftUI
import PhotosUI

/// One pick from Photos, carried into the trim sheet.
struct TrimBatch: Identifiable {
    let id = UUID()
    let clips: [PickedClip]
    var demoRange: (Double, Double)? = nil
}

struct LiftClipsCard: View {
    @ObservedObject var store = LiftStore.shared
    @ObservedObject private var probe = LiftProbe.shared
    @ObservedObject private var settings = Settings.shared
    #if DEBUG
    private static var autoAdded = false
    private static var demoPicked: PickedClip?
    #endif
    @State private var picking = false
    @State private var trimming: TrimBatch?
    /// Picked clips that finished loading while the picker sheet was still
    /// on its way out. SwiftUI drops a second sheet presented mid-dismissal,
    /// so the trim sheet opens from the picker's onDismiss instead.
    @State private var pendingTrim: TrimBatch?
    @State private var pickerGone = true

    /// The locked-phone claim only once the probe has proven the path clips
    /// use; until then it says what is known.
    private var lockedLine: String {
        probe.run(settings.liftTransport).state == .ok && !probe.run(settings.liftTransport).background
            ? "Keeps sending with the phone locked."
            : "Locked-phone sending not yet tested."
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            if store.clips.isEmpty && store.preparing == 0 {
                Text("Pick a set from Photos and trim it. It goes to the Mac exactly as the camera shot it, never a compressed copy.")
                    .font(.system(size: 13))
                    .lineSpacing(2)
                    .foregroundStyle(Theme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 10)
                    .accessibilityIdentifier("lift.empty")
            }
            if store.preparing > 0 {
                preparingRow
            }
            ForEach(store.active) { clip in
                Rectangle().fill(Theme.hairline).frame(height: 1)
                LiftClipRow(clip: clip, store: store)
            }
            if store.active.contains(where: { $0.state == .uploading || $0.state == .queued }) {
                // Said once for the whole queue, not on every row.
                Text(lockedLine)
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.textTertiary)
                    .padding(.top, 2)
                    .accessibilityIdentifier("lift.locked")
            }
            if let err = store.error {
                Text(err)
                    .font(.system(size: 12.5))
                    .foregroundStyle(Theme.textTertiary)
                    .padding(.top, 8)
            }
            let done = Array(store.delivered.prefix(LiftStore.keepDone))
            let mixed = !store.active.isEmpty || store.preparing > 0
            if !done.isEmpty {
                if mixed {
                    Text("ON THE MAC")
                        .font(Theme.sectionLabel(9.5))
                        .kerning(1.3)
                        .foregroundStyle(Theme.textTertiary)
                        .padding(.top, 16)
                        .padding(.bottom, 2)
                }
                // Alone, every row already says "On the Mac": no second label.
                ForEach(Array(done.enumerated()), id: \.element.id) { i, clip in
                    if i > 0 || !mixed { Rectangle().fill(Theme.hairline).frame(height: 1) }
                    LiftClipRow(clip: clip, store: store)
                }
            }
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 16)
        .glassCard()
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("lift.card")
        .sheet(isPresented: $picking, onDismiss: {
            pickerGone = true
            if let b = pendingTrim {
                pendingTrim = nil
                trimming = b
            }
        }) {
            pickerSheet
        }
        .sheet(item: $trimming) { batch in
            LiftTrimSheet(batch: batch) { clip, start, end, submitted in
                if Demo.active { return Self.demoSend(submitted) }
                store.add(clip, start: start, end: end, submitted: submitted)
            } skip: { clip in
                store.discard(clip)
            } close: {
                trimming = nil
            }
            .presentationDetents([.large])
            .interactiveDismissDisabled()
        }
        .onAppear(perform: demoHooks)
        // Bytes and the stall line from the live tasks while the card is on
        // screen (a suspended app got no progress callbacks).
        .task(id: store.active.contains { $0.state == .queued || $0.state == .uploading }) {
            while !Task.isCancelled {
                store.refreshLive()
                try? await Task.sleep(nanoseconds: 20_000_000_000)
            }
        }
    }

    @ViewBuilder
    private var pickerSheet: some View {
        #if DEBUG
        if Demo.active, ProcessInfo.processInfo.environment["HR_DEMO_LIFT_PICK"] != nil {
            // UI-test stand-in for Photos: one tap returns the synthetic clip
            // at once, the fastest load there is, through the same path.
            Button("Choose test clip") {
                picked(count: 1) {
                    if let ready = Self.demoPicked { return ([ready], 0) }
                    guard let url = await DemoLift.syntheticClip(), let info = await LiftMedia.inspect(url) else { return ([], 1) }
                    return ([PickedClip(id: "demo-pick", source: url, originalName: url.lastPathComponent, info: info)], 0)
                }
            }
            .accessibilityIdentifier("lift.fakepick")
        } else {
            realPicker
        }
        #else
        realPicker
        #endif
    }

    private var realPicker: some View {
        LiftVideoPicker { results in
            picked(count: results.count) { await LiftMedia.load(results, into: LiftStore.dir) }
        }
        .ignoresSafeArea()
    }

    /// The picker closed with `count` clips; `load` copies and inspects them.
    /// The trim sheet opens when both the load and the picker's dismissal
    /// are done, whichever finishes last.
    private func picked(count: Int, load: @escaping () async -> (clips: [PickedClip], failed: Int)) {
        picking = false
        guard count > 0 else { return }
        store.preparing += count
        Task {
            let loaded = await load()
            await MainActor.run {
                store.preparing = max(0, store.preparing - count)
                store.error = loaded.failed > 0
                    ? "Couldn't read \(loaded.failed) of \(count) clips. If the original is only in iCloud, open it in Photos once, then pick it again."
                    : nil
                guard !loaded.clips.isEmpty else { return }
                let batch = TrimBatch(clips: loaded.clips)
                if pickerGone { trimming = batch } else { pendingTrim = batch }
            }
        }
    }

    /// Demo Send: the sheet's "Cutting…" for a moment, then on. With
    /// HR_DEMO_LIFT_CUTTING it never finishes (the frame of that state).
    private static func demoSend(_ submitted: @escaping () -> Void) {
        guard ProcessInfo.processInfo.environment["HR_DEMO_LIFT_CUTTING"] == nil else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2, execute: submitted)
    }

    private var header: some View {
        HStack(spacing: 10) {
            Text(headerText)
                .font(Theme.sectionLabel())
                .kerning(1.4)
                .foregroundStyle(Theme.textTertiary)
                .accessibilityIdentifier("lift.header")
            Spacer(minLength: 8)
            Button {
                pickerGone = false
                picking = true
            } label: {
                HStack(spacing: 5) {
                    Image(systemName: "plus")
                        .font(.system(size: 10, weight: .bold))
                    Text("Add")
                        .font(Theme.rounded(12.5, .semibold))
                }
                .padding(.horizontal, 13)
                .frame(height: 28)
                .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .foregroundStyle(Theme.textPrimary.opacity(0.9))
            .background(Color.white.opacity(0.07), in: Capsule())
            .overlay(Capsule().strokeBorder(Theme.hairline, lineWidth: 1))
            .accessibilityLabel("Add lift clips")
            .accessibilityIdentifier("lift.add")
        }
        .padding(.bottom, 4)
    }

    private var headerText: String {
        let sending = store.active.filter { $0.state == .uploading }.count
        let waiting = store.active.filter { $0.state == .queued || $0.state == .exporting }.count
        if sending > 0 { return "LIFT CLIPS · \(sending) SENDING" }
        if waiting > 0 { return "LIFT CLIPS · \(waiting) QUEUED" }
        return "LIFT CLIPS"
    }

    private var preparingRow: some View {
        HStack(spacing: 10) {
            ProgressView().controlSize(.small).tint(Theme.textTertiary)
            Text(store.preparing == 1 ? "Getting the original from Photos…" : "Getting \(store.preparing) originals from Photos…")
                .font(.system(size: 13))
                .foregroundStyle(Theme.textSecondary)
        }
        .padding(.vertical, 12)
    }

    private func demoHooks() {
        #if DEBUG
        // Simulator pipeline test (NOT demo: real copy, cut, upload to a
        // throwaway sink via HR_LIFT_*): HR_LIFT_AUTOADD=<path>,<start>,<end>
        // runs exactly what a pick + Send runs. Once per launch. Simulator
        // only: the phone is built in Debug too.
        #if targetEnvironment(simulator)
        if !Demo.active, !Self.autoAdded, let raw = ProcessInfo.processInfo.environment["HR_LIFT_AUTOADD"] {
            Self.autoAdded = true
            let p = raw.split(separator: ",").map(String.init)
            let src = URL(fileURLWithPath: p[0])
            Task {
                let id = UUID().uuidString
                let copy = LiftStore.dir.appendingPathComponent("\(id)-src.\(src.pathExtension)")
                try? FileManager.default.copyItem(at: src, to: copy)
                guard let info = await LiftMedia.inspect(copy) else { return rlog("lift autoadd: inspect failed") }
                let clip = PickedClip(id: id, source: copy, originalName: src.lastPathComponent, info: info)
                let start = p.count > 2 ? Double(p[1]) ?? 0 : 0
                let end = p.count > 2 ? Double(p[2]) ?? info.duration : info.duration
                rlog("lift autoadd: \(clip.originalName) \(info) range \(start)-\(end)")
                await MainActor.run { store.add(clip, start: start, end: end) }
            }
        }
        #endif
        if Demo.active, ProcessInfo.processInfo.environment["HR_DEMO_LIFT_PICK"] != nil {
            // Written and inspected ahead: the pick returns at once, mid-dismissal.
            Task {
                guard let url = await DemoLift.syntheticClip(), let info = await LiftMedia.inspect(url) else { return }
                Self.demoPicked = PickedClip(id: "demo-pick", source: url, originalName: url.lastPathComponent, info: info)
            }
        }
        guard Demo.active, trimming == nil,
              let path = ProcessInfo.processInfo.environment["HR_DEMO_LIFT_TRIM"] else { return }
        let range = ProcessInfo.processInfo.environment["HR_DEMO_LIFT_TRIM_RANGE"]
        Task {
            // "synthetic": a 10 s clip written in-app (UI tests need no Mac file).
            guard let url = path == "synthetic" ? await DemoLift.syntheticClip() : URL(fileURLWithPath: path) else { return }
            guard let info = await LiftMedia.inspect(url) else { return }
            let clip = PickedClip(id: "demo-trim", source: url, originalName: url.lastPathComponent, info: info)
            var r: (Double, Double)?
            if let raw = range {
                let p = raw.split(separator: ",").compactMap { Double($0) }
                if p.count == 2 { r = (p[0], p[1]) }
            }
            let n = ProcessInfo.processInfo.environment["HR_DEMO_LIFT_TRIM_N"].flatMap(Int.init) ?? 1
            await MainActor.run {
                trimming = TrimBatch(clips: Array(repeating: clip, count: max(1, n)), demoRange: r)
            }
        }
        #endif
    }
}

/// One clip in the card: poster, name, what part of the original it is and
/// how big, then its delivery state.
struct LiftClipRow: View {
    let clip: LiftClip
    @ObservedObject var store: LiftStore
    @State private var poster: UIImage?

    var body: some View {
        HStack(alignment: .top, spacing: 13) {
            ZStack {
                Color.white.opacity(0.05)
                if let poster = poster {
                    Image(uiImage: poster).resizable().scaledToFill()
                } else {
                    Image(systemName: "video")
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(Theme.textTertiary)
                }
            }
            .frame(width: 48, height: 48)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Theme.hairline, lineWidth: 1))
            .opacity(clip.state == .done ? 1 : 0.85)

            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(clip.stem)
                        .font(Theme.rounded(15.5, .semibold))
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    trailing
                }
                Text(sizeLine)
                    .font(.system(size: 12.5))
                    .monospacedDigit()
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.85)
                status
            }
        }
        .padding(.vertical, 11)
        .contentShape(Rectangle())
        .contextMenu {
            if (clip.state == .failed || clip.state == .refused) && clip.retryable {
                Button { store.retryNow(clip.id) } label: { Label("Retry now", systemImage: "arrow.clockwise") }
            }
            Button(role: .destructive) { store.remove(clip.id) } label: {
                Label(clip.state == .done ? "Hide from this list" : "Remove", systemImage: clip.state == .done ? "eye.slash" : "trash")
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("lift.row.\(clip.state.rawValue)")
        .task(id: clip.poster) {
            guard let p = clip.poster else { return }
            let url = LiftStore.url(p)
            poster = await Task.detached(priority: .utility) {
                UIImage(contentsOfFile: url.path)?.preparingThumbnail(of: CGSize(width: 144, height: 144))
            }.value
        }
    }

    private var sizeLine: String {
        let range = LiftFormat.range(clip)
        return clip.bytes > 0 ? "\(range) · \(LiftFormat.size(clip.bytes))" : range
    }

    @ViewBuilder
    private var trailing: some View {
        switch clip.state {
        case .uploading:
            Text("\(Int((clip.fraction * 100).rounded(.down)))%")
                .font(Theme.rounded(13, .semibold))
                .monospacedDigit()
                .foregroundStyle(Theme.textPrimary)
        case .done:
            Text("rec \(LiftFormat.recorded(clip.recordedAt))")
                .font(Theme.rounded(12.5))
                .monospacedDigit()
                .foregroundStyle(Theme.textTertiary)
        case .refused where !clip.retryable:
            EmptyView() // nothing left to send: Remove is in the menu
        case .failed, .refused:
            Button { store.retryNow(clip.id) } label: {
                Text("Retry")
                    .font(Theme.rounded(12, .semibold))
                    .padding(.horizontal, 11)
                    .frame(height: 24)
                    .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .foregroundStyle(Theme.textPrimary.opacity(0.9))
            .background(Color.white.opacity(0.07), in: Capsule())
            .overlay(Capsule().strokeBorder(Theme.hairline, lineWidth: 1))
            .accessibilityIdentifier("lift.retry")
        case .queued, .exporting:
            Image(systemName: clip.state == .exporting ? "scissors" : "clock")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Theme.textTertiary)
        }
    }

    @ViewBuilder
    private var status: some View {
        switch clip.state {
        case .uploading:
            VStack(alignment: .leading, spacing: 5) {
                GeometryReader { g in
                    ZStack(alignment: .leading) {
                        Capsule().fill(Theme.barTrack)
                        Capsule().fill(Theme.barWork)
                            .frame(width: max(3, g.size.width * clip.fraction))
                    }
                }
                .frame(height: 3)
                .padding(.top, 4)
                .animation(.easeOut(duration: 0.25), value: clip.sent)
                .accessibilityIdentifier("lift.progress")
                // The % is in the corner and the size in the line above:
                // the bar alone carries the rest.
            }
        case .queued:
            statusText(queuedLine)
        case .exporting:
            statusText("Cutting, no re-encode…")
        case .failed:
            statusText(clip.file == nil && clip.source != nil && clip.cutAttempts >= LiftStore.maxAutoCuts
                ? "Not sent: \(clip.lastError ?? "unknown"). Tap Retry to cut it again."
                : "Not sent: \(clip.lastError ?? "unknown"). Retries on its own.")
        case .refused:
            statusText("Refused: \(clip.lastError ?? "unknown")")
        case .done:
            HStack(spacing: 5) {
                Image(systemName: "checkmark")
                    .font(.system(size: 9.5, weight: .bold))
                    .foregroundStyle(Theme.okDim)
                statusText(clip.dedupe == "syncthing"
                    ? "On the Mac · Syncthing had it already"
                    : "On the Mac · \(macFolder)")
            }
        }
    }

    /// A queued row says why it has not started, most useful reason first.
    private var queuedLine: String {
        if clip.stalled { return "No route to the Mac yet. iOS keeps trying; Diagnostics tests both paths." }
        if clip.heldInBackground { return "Queued in the background: iOS may hold it. Opening the app restarts it." }
        if clip.attempts > 0 { return "Queued, retry \(clip.attempts + 1) · \(clip.lastError ?? "")" }
        return "Queued · starts when a slot frees"
    }

    /// "lift/2026-11-16" from the daemon's path, the part he'd look for.
    private var macFolder: String {
        guard let p = clip.macPath else { return "delivered" }
        let parts = p.split(separator: "/")
        if let i = parts.firstIndex(of: "lift"), i + 1 < parts.count { return "lift/\(parts[i + 1])" }
        return "delivered"
    }

    private func statusText(_ s: String) -> some View {
        Text(s)
            .font(.system(size: 12))
            .foregroundStyle(Theme.textTertiary)
            .lineLimit(2)
            .fixedSize(horizontal: false, vertical: true)
    }
}
