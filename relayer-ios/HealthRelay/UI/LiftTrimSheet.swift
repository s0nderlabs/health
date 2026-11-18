// The trim sheet: our own filmstrip and handles, never UIVideoEditorController
// (it re-encodes). The selection is a time range only; the cut itself is a
// passthrough export (LiftMedia.exportTrim), so the Mac gets the camera's
// pixels. The preview follows whichever handle is being dragged, frame
// accurate, so he can land the start on the unrack and the end on the rerack.

import AVFoundation
import SwiftUI
import UIKit

struct LiftTrimSheet: View {
    let batch: TrimBatch
    /// The clip, its range, and the call to make once its upload task exists
    /// (a full clip: at once; a trimmed one: after the cut).
    var send: (PickedClip, Double, Double, @escaping () -> Void) -> Void
    var skip: (PickedClip) -> Void
    var close: () -> Void

    @State private var index = 0
    @State private var start: Double = 0
    @State private var end: Double = 0
    @State private var thumbs: [UIImage] = []
    /// Send tapped, task not created yet: the sheet holds the screen so the
    /// upload is created while the app is in front (see LiftStore).
    @State private var sending = false
    @StateObject private var preview = TrimPreview()

    /// Nothing shorter than a second: a rep needs at least that.
    static let minLength: Double = 1.0

    private var clip: PickedClip { batch.clips[min(index, batch.clips.count - 1)] }
    private var duration: Double { max(clip.info.duration, 0.1) }
    private var isFull: Bool { start <= 0.05 && end >= duration - 0.05 }
    private var length: Double { end - start }

    // Top: what he is looking at. Bottom, in thumb reach with one chalky
    // hand: the strip he drags and the Send he taps.
    var body: some View {
        VStack(spacing: 0) {
            topBar
            VStack(spacing: 16) {
                // The box hugs a landscape clip; a portrait one is capped
                // (ratio 1.2, about 290 pt tall) and letterboxed inside it.
                PlayerLayerView(player: preview.player)
                    .aspectRatio(max(aspect, 1.2), contentMode: .fit)
                    .frame(maxWidth: .infinity)
                    .background(Color.black)
                    .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(Theme.hairline, lineWidth: 1))
                    .overlay { playGlyph }
                    .contentShape(Rectangle())
                    .onTapGesture { preview.toggle(start: start, end: end) }
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(preview.playing ? "Pause preview" : "Play selection")
                    .accessibilityAddTraits(.isButton)
                    .accessibilityIdentifier("trim.preview")

                readout

                VStack(alignment: .leading, spacing: 6) {
                    Text(facts)
                        .font(.system(size: 12.5))
                        .monospacedDigit()
                        .foregroundStyle(Theme.textSecondary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                        .accessibilityIdentifier("trim.facts")
                    Text(isFull
                        ? "Sent as is: the original file, byte for byte."
                        : "Cut without re-encoding: full resolution, frame rate and HDR, and it plays from exactly this frame.")
                        .font(.system(size: 12))
                        .lineSpacing(1.5)
                        .foregroundStyle(Theme.textTertiary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 2)
            }
            Spacer(minLength: 16)
            VStack(spacing: 14) {
                TrimStrip(duration: duration, start: $start, end: $end, thumbs: thumbs,
                          playhead: preview.playing ? preview.current : nil,
                          minLength: Self.minLength) { t in
                    preview.scrub(to: t)
                }
                .frame(height: 58)

                HStack(spacing: 10) {
                    fullButton
                    sendButton
                }
            }
            .disabled(sending)
        }
        .padding(.horizontal, 20)
        .padding(.bottom, 12)
        .background(AmbientBackground())
        .preferredColorScheme(.dark)
        .accessibilityElement(children: .contain) // or the id below lands on every child
        .accessibilityIdentifier("trim.sheet")
        .task(id: index) { await load() }
        .onDisappear { preview.player.pause() }
        #if DEBUG
        // Frame of the held state: the sheet opens already on "Cutting…".
        .onAppear { if Demo.active, ProcessInfo.processInfo.environment["HR_DEMO_LIFT_CUTTING"] != nil { sending = true } }
        #endif
    }

    // ── pieces ───────────────────────────────────────────────────────

    private var topBar: some View {
        HStack {
            Button("Cancel") {
                for c in batch.clips[index...] { skip(c) }
                close()
            }
            .font(Theme.rounded(15))
            .foregroundStyle(Theme.textSecondary)
            .disabled(sending)
            Spacer()
            Text(batch.clips.count > 1 ? "Clip \(index + 1) of \(batch.clips.count)" : "Trim clip")
                .font(Theme.rounded(16, .semibold))
                .foregroundStyle(Theme.textPrimary)
                .monospacedDigit()
                .accessibilityIdentifier("trim.title")
            Spacer()
            // Skip is rare: up here, out of the thumb's way. A clear twin
            // keeps the title centred when there is nothing to skip.
            Button("Skip") {
                skip(clip)
                advance()
            }
            .font(Theme.rounded(15))
            .foregroundStyle(Theme.textSecondary)
            .opacity(batch.clips.count > 1 ? 1 : 0)
            .disabled(batch.clips.count < 2 || sending)
            .accessibilityHidden(batch.clips.count < 2)
            .accessibilityIdentifier("trim.skip")
        }
        .frame(height: 34)
        .padding(.top, 18)
        .padding(.bottom, 16)
    }

    private var fullButton: some View {
        Button {
            withAnimation(.timingCurve(0.23, 1, 0.32, 1, duration: 0.28)) {
                start = 0
                end = duration
            }
            preview.scrub(to: 0)
        } label: {
            HStack(spacing: 6) {
                Image(systemName: isFull ? "checkmark" : "arrow.left.and.right")
                    .font(.system(size: 11, weight: .bold))
                Text(isFull ? "Full clip" : "Use full clip")
                    .font(Theme.rounded(14, .semibold))
                    .lineLimit(1)
            }
            .padding(.horizontal, 15)
            .frame(height: 50)
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .foregroundStyle(isFull ? Theme.textSecondary : Theme.textPrimary)
        .glassCapsule()
        .disabled(isFull)
        .fixedSize()
        .accessibilityIdentifier("trim.full")
    }

    private var sendButton: some View {
        Button {
            sending = true
            preview.player.pause()
            let at = index
            send(clip, start, end) {
                // Still on the clip it was sent from (the sheet cannot move
                // while sending, but stay strict).
                guard index == at else { return }
                sending = false
                advance()
            }
        } label: {
            HStack(spacing: 8) {
                if sending {
                    ProgressView().controlSize(.small).tint(Theme.accentInk)
                    Text(isFull ? "Sending…" : "Cutting…")
                        .accessibilityIdentifier("trim.cutting")
                } else {
                    Text("Send")
                }
            }
            .font(Theme.rounded(16, .semibold))
            .frame(maxWidth: .infinity)
            .frame(height: 50)
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .background(Theme.accent.opacity(sending ? 0.7 : 1), in: Capsule())
        .foregroundStyle(Theme.accentInk)
        .accessibilityIdentifier("trim.send")
    }

    /// The selection as one hero number, the range beside it in the quiet
    /// voice. Full clip says so instead of "0.0–58.2".
    private var readout: some View {
        HStack(alignment: .lastTextBaseline) {
            HStack(alignment: .firstTextBaseline, spacing: 3) {
                Text(LiftFormat.s(length))
                    .font(Theme.heroNumber(40))
                    .monospacedDigit()
                    .foregroundStyle(Theme.textPrimary)
                    .contentTransition(.numericText())
                Text("s")
                    .font(Theme.rounded(17, .semibold))
                    .foregroundStyle(Theme.textTertiary)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Selected \(LiftFormat.s(length)) seconds")
            .accessibilityValue("\(LiftFormat.s(length)) s")
            .accessibilityIdentifier("trim.duration")
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                Text(isFull ? "Full clip" : "\(LiftFormat.s(start)) – \(LiftFormat.s(end)) s")
                    .font(Theme.rounded(15, .semibold))
                    .monospacedDigit()
                    .foregroundStyle(Theme.textSecondary)
                    .accessibilityIdentifier("trim.range")
                Text("of \(LiftFormat.s(duration)) s")
                    .font(Theme.rounded(12.5))
                    .monospacedDigit()
                    .foregroundStyle(Theme.textTertiary)
            }
        }
        .padding(.horizontal, 2)
    }

    @ViewBuilder
    private var playGlyph: some View {
        if !preview.playing {
            Image(systemName: "play.fill")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(.white.opacity(0.92))
                .frame(width: 48, height: 48)
                .background(Circle().fill(.ultraThinMaterial))
                .overlay(Circle().strokeBorder(Color.white.opacity(0.14), lineWidth: 1))
                .allowsHitTesting(false)
        }
    }

    private var aspect: CGFloat {
        let w = CGFloat(max(clip.info.width, 1)), h = CGFloat(max(clip.info.height, 1))
        return w / h
    }

    private var facts: String {
        var parts = [clip.originalName]
        if clip.info.width > 0 { parts.append("\(clip.info.width)×\(clip.info.height)") }
        if clip.info.fps > 0 { parts.append("\(Int(clip.info.fps.rounded())) fps") }
        parts.append(clip.info.codec == "hevc" ? "HEVC" : clip.info.codec == "h264" ? "H.264" : clip.info.codec.uppercased())
        if let r = clip.info.recordedAt { parts.append("rec \(LiftFormat.recorded(r))") }
        return parts.joined(separator: " · ")
    }

    // ── flow ─────────────────────────────────────────────────────────

    private func advance() {
        if index + 1 < batch.clips.count {
            index += 1
        } else {
            close()
        }
    }

    private func load() async {
        let c = clip
        start = 0
        end = c.info.duration
        if index == 0, let r = batch.demoRange {
            start = max(0, min(r.0, c.info.duration))
            end = max(start + Self.minLength, min(r.1, c.info.duration))
        }
        thumbs = []
        preview.load(c.source, at: start)
        thumbs = await TrimPreview.filmstrip(c.source, count: 10)
    }
}

/// The filmstrip with its two handles. Frames fill the track; the selection
/// is a bright frame with a tab at each end, everything outside it dimmed.
/// Handles snap to 0.1 s (the daemon's file-name precision) and hold a 1 s
/// minimum between them.
struct TrimStrip: View {
    let duration: Double
    @Binding var start: Double
    @Binding var end: Double
    let thumbs: [UIImage]
    let playhead: Double?
    let minLength: Double
    var scrub: (Double) -> Void

    @State private var active: Edge?
    /// Where on the tab the finger landed, so grabbing a handle never
    /// jumps it: the edge keeps its offset from the finger.
    @State private var grab: CGFloat = 0
    private let tab: CGFloat = 18
    private let frame = Theme.textPrimary

    enum Edge { case start, end }

    var body: some View {
        GeometryReader { g in
            let track = g.size.width - tab * 2
            let x0 = tab + track * CGFloat(start / duration)
            let x1 = tab + track * CGFloat(end / duration)
            ZStack(alignment: .topLeading) {
                // Frames.
                HStack(spacing: 0) {
                    if thumbs.isEmpty {
                        Color.white.opacity(0.05)
                    } else {
                        ForEach(Array(thumbs.enumerated()), id: \.offset) { _, img in
                            Color.clear
                                .overlay { Image(uiImage: img).resizable().scaledToFill() }
                                .clipped()
                        }
                    }
                }
                .frame(width: track, height: g.size.height - 8)
                .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                .offset(x: tab, y: 4)

                // Outside the selection: dimmed.
                Rectangle().fill(Color.black.opacity(0.58))
                    .frame(width: max(0, x0 - tab), height: g.size.height - 8)
                    .offset(x: tab, y: 4)
                Rectangle().fill(Color.black.opacity(0.58))
                    .frame(width: max(0, tab + track - x1), height: g.size.height - 8)
                    .offset(x: x1, y: 4)

                // The selection frame: top and bottom bars, a tab each end.
                Path { p in
                    p.addRect(CGRect(x: x0, y: 0, width: x1 - x0, height: 3))
                    p.addRect(CGRect(x: x0, y: g.size.height - 3, width: x1 - x0, height: 3))
                }
                .fill(frame)

                if let t = playhead {
                    Capsule().fill(Color.white)
                        .frame(width: 2.5, height: g.size.height - 2)
                        .shadow(color: .black.opacity(0.5), radius: 1.5)
                        .offset(x: tab + track * CGFloat(t / duration) - 1.25, y: 1)
                        .allowsHitTesting(false)
                }

                handle(.start, x: x0 - tab, edgeX: x0, height: g.size.height, track: track)
                handle(.end, x: x1, edgeX: x1, height: g.size.height, track: track)
            }
            .coordinateSpace(name: "strip")
        }
    }

    private func handle(_ edge: Edge, x: CGFloat, edgeX: CGFloat, height: CGFloat, track: CGFloat) -> some View {
        let shape = UnevenRoundedRectangle(
            topLeadingRadius: edge == .start ? 7 : 0, bottomLeadingRadius: edge == .start ? 7 : 0,
            bottomTrailingRadius: edge == .end ? 7 : 0, topTrailingRadius: edge == .end ? 7 : 0,
            style: .continuous)
        return shape.fill(frame)
            .overlay {
                Image(systemName: edge == .start ? "chevron.compact.left" : "chevron.compact.right")
                    .font(.system(size: 17, weight: .bold))
                    .foregroundStyle(Theme.accentInk.opacity(0.85))
            }
            .frame(width: tab, height: height)
            .scaleEffect(active == edge ? 1.06 : 1, anchor: edge == .start ? .trailing : .leading)
            // A 44 pt target around an 18 pt tab, reaching outward.
            .frame(width: 44, height: height, alignment: edge == .start ? .trailing : .leading)
            .contentShape(Rectangle())
            .offset(x: edge == .start ? x - (44 - tab) : x)
            .gesture(
                DragGesture(minimumDistance: 0, coordinateSpace: .named("strip"))
                    .onChanged { v in
                        if active != edge {
                            active = edge
                            grab = v.startLocation.x - edgeX
                            UISelectionFeedbackGenerator().selectionChanged()
                        }
                        // The tab's inner edge follows the finger, at the
                        // offset it was grabbed with.
                        let t = Double((v.location.x - grab - tab) / track) * duration
                        move(edge, to: t)
                    }
                    .onEnded { _ in active = nil }
            )
            .animation(.easeOut(duration: 0.12), value: active)
            .accessibilityElement()
            .accessibilityLabel(edge == .start ? "Start" : "End")
            .accessibilityValue("\(LiftFormat.s(edge == .start ? start : end)) seconds")
            .accessibilityAdjustableAction { dir in
                let step = dir == .increment ? 1.0 : -1.0
                move(edge, to: (edge == .start ? start : end) + step)
            }
            .accessibilityIdentifier(edge == .start ? "trim.start" : "trim.end")
    }

    private func move(_ edge: Edge, to raw: Double) {
        let t = (raw * 10).rounded() / 10
        switch edge {
        case .start:
            start = min(max(0, t), end - minLength)
            scrub(start)
        case .end:
            // The last tenth snaps to the true end, so "full" is reachable.
            let snapped = t >= duration - 0.05 ? duration : t
            end = max(min(duration, snapped), start + minLength)
            scrub(end)
        }
    }
}

/// The preview player: frame-accurate scrubbing (seeks chase the finger
/// without piling up), tap to loop the selection.
final class TrimPreview: ObservableObject {
    let player = AVPlayer()
    @Published var playing = false
    @Published var current: Double = 0
    private var target: Double?
    private var seeking = false
    private var observer: Any?
    private var loop: (Double, Double) = (0, 0)

    init() {
        player.isMuted = true
        player.actionAtItemEnd = .pause
        observer = player.addPeriodicTimeObserver(forInterval: CMTime(value: 1, timescale: 30), queue: .main) { [weak self] time in
            guard let self = self, self.playing else { return }
            self.current = time.seconds
            if time.seconds >= self.loop.1 { self.seekNow(self.loop.0, thenPlay: true) }
        }
    }

    deinit {
        if let o = observer { player.removeTimeObserver(o) }
    }

    func load(_ url: URL, at t: Double) {
        playing = false
        player.replaceCurrentItem(with: AVPlayerItem(url: url))
        scrub(to: t)
    }

    func toggle(start: Double, end: Double) {
        if playing {
            player.pause()
            playing = false
        } else {
            loop = (start, end)
            playing = true
            seekNow(start, thenPlay: true)
        }
    }

    /// Follow a handle: pause, then chase the newest target (one seek in
    /// flight at a time, the latest wins).
    func scrub(to t: Double) {
        if playing {
            player.pause()
            playing = false
        }
        target = t
        if !seeking { chase() }
    }

    private func chase() {
        guard let t = target else { return }
        target = nil
        seeking = true
        player.seek(to: CMTime(seconds: t, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] _ in
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.seeking = false
                self.current = t
                if self.target != nil { self.chase() }
            }
        }
    }

    private func seekNow(_ t: Double, thenPlay: Bool) {
        player.seek(to: CMTime(seconds: t, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] _ in
            DispatchQueue.main.async { if thenPlay, self?.playing == true { self?.player.play() } }
        }
    }

    /// `count` frames spread over the clip, small, rotation applied.
    static func filmstrip(_ url: URL, count: Int) async -> [UIImage] {
        let asset = AVURLAsset(url: url)
        guard let d = try? await asset.load(.duration), d.seconds > 0 else { return [] }
        let gen = AVAssetImageGenerator(asset: asset)
        gen.appliesPreferredTrackTransform = true
        gen.maximumSize = CGSize(width: 160, height: 160)
        gen.requestedTimeToleranceBefore = CMTime(seconds: 0.5, preferredTimescale: 600)
        gen.requestedTimeToleranceAfter = CMTime(seconds: 0.5, preferredTimescale: 600)
        var out: [UIImage] = []
        for i in 0..<count {
            let t = d.seconds * (Double(i) + 0.5) / Double(count)
            if let img = try? await gen.image(at: CMTime(seconds: t, preferredTimescale: 600)).image {
                out.append(UIImage(cgImage: img))
            }
        }
        return out
    }
}

/// AVPlayerLayer, no controls (the strip is the control).
struct PlayerLayerView: UIViewRepresentable {
    let player: AVPlayer

    final class LayerView: UIView {
        override static var layerClass: AnyClass { AVPlayerLayer.self }
        var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
    }

    func makeUIView(context: Context) -> LayerView {
        let v = LayerView()
        v.playerLayer.player = player
        v.playerLayer.videoGravity = .resizeAspect
        v.backgroundColor = .black
        return v
    }

    func updateUIView(_ v: LayerView, context: Context) {
        v.playerLayer.player = player
    }
}
