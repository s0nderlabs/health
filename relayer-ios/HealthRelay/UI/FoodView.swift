// The Food tab: today's intake at a glance, capture in one tap.
// Layout (his call, Nov 16 2026): the day ring (kcal with its range, protein
// against its target), today's meals with thumbnails, camera + quick text.
// No week view yet. Before the baseline exists there is NO kcal target and
// the screen never invents one: the ring tracks protein (which has a target
// from day one) and the kcal number stands alone with its range.

import SwiftUI
import PhotosUI
import UIKit

struct FoodView: View {
    @ObservedObject var store: FoodStore
    @State private var quickText = ""
    @State private var showCamera = false
    @State private var showLibrary = false
    @State private var libraryItem: PhotosPickerItem?
    /// The pending capture. A stable item (one id per shot) so re-renders
    /// from store publishes never re-present the sheet and wipe the note.
    @State private var composing: ComposeItem?
    @State private var detail: FoodMeal?
    @FocusState private var quickFocused: Bool

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                header
                if let day = store.day {
                    ringCard(day)
                } else {
                    placeholderCard
                }
                captureRow
                if let err = store.error {
                    Text(err)
                        .font(.system(size: 12.5))
                        .foregroundStyle(Theme.textTertiary)
                        .padding(.horizontal, 2)
                }
                mealsSection
            }
            .padding(.horizontal, 20)
            .padding(.top, 12)
            .padding(.bottom, 110)
        }
        .scrollIndicators(.hidden)
        .scrollDismissesKeyboard(.interactively)
        .background(AmbientBackground())
        .refreshable {
            store.refresh()
            store.flush()
        }
        .onAppear {
            store.refresh()
            store.flush()
            if Demo.active {
                switch ProcessInfo.processInfo.environment["HR_DEMO_FOOD_SHEET"] {
                case "detail": detail = store.day?.meals.first { !$0.photos.isEmpty && !$0.pending }
                case "compose": composing = DemoFood.image("compose").map(ComposeItem.init)
                default: break
                }
            }
        }
        .fullScreenCover(isPresented: $showCamera) {
            CameraPicker { image in
                showCamera = false
                if let image = image { composing = ComposeItem(image: image) }
            }
            .ignoresSafeArea()
        }
        .photosPicker(isPresented: $showLibrary, selection: $libraryItem, matching: .images)
        .onChange(of: libraryItem) { _, item in
            guard let item = item else { return }
            item.loadTransferable(type: Data.self) { result in
                DispatchQueue.main.async {
                    if case .success(let data?) = result, let img = UIImage(data: data) { composing = ComposeItem(image: img) }
                    libraryItem = nil
                }
            }
        }
        .sheet(item: $composing) { item in
            ComposeSheet(image: item.image, demoNote: Demo.active ? ProcessInfo.processInfo.environment["HR_DEMO_FOOD_NOTE"] : nil) { note in
                store.log(photo: item.image, note: note)
                composing = nil
            } cancel: {
                composing = nil
            }
            .presentationDetents([.large])
            // A stray swipe must not throw away the photo and note: Cancel
            // is the explicit way out.
            .interactiveDismissDisabled()
        }
        .sheet(item: $detail) { meal in
            MealDetail(meal: meal, store: store)
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
        }
    }

    // ── header ───────────────────────────────────────────────────────

    private var header: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text("Food")
                .font(.system(size: 30, weight: .bold, design: .rounded))
                .foregroundStyle(Theme.textPrimary)
            Text(subtitle)
                .font(Theme.rounded(14))
                .foregroundStyle(Theme.textSecondary)
        }
        .padding(.top, 4)
    }

    private var subtitle: String {
        guard let day = store.day else { return "Today" }
        var parts = [prettyDate(day.date)]
        if let w = day.weight { parts.append(String(format: "%.1f kg", w.kg)) }
        return parts.joined(separator: " · ")
    }

    private static let dayParser: DateFormatter = {
        let p = DateFormatter()
        p.dateFormat = "yyyy-MM-dd"
        p.locale = Locale(identifier: "en_US_POSIX")
        return p
    }()

    private static let dayLabel: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "EEE, MMM d"
        return f
    }()

    private func prettyDate(_ raw: String) -> String {
        guard let d = Self.dayParser.date(from: raw) else { return raw }
        return Self.dayLabel.string(from: d)
    }

    // ── the day ring ─────────────────────────────────────────────────

    private func ringCard(_ day: FoodDay) -> some View {
        let t = day.totals
        let proteinFrac = day.targets.protein_g > 0 ? t.protein_g / day.targets.protein_g : 0
        let kcalTarget = day.targets.kcal
        return VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .center, spacing: 20) {
                DayRing(
                    protein: proteinFrac,
                    kcal: kcalTarget.map { t.kcal / $0 },
                    kcalLo: kcalTarget.map { t.kcal_lo / $0 },
                    kcalHi: kcalTarget.map { t.kcal_hi / $0 }
                ) {
                    VStack(spacing: 1) {
                        Text(FoodFormat.int(t.kcal))
                            .font(Theme.heroNumber(34))
                            .monospacedDigit()
                            .foregroundStyle(Theme.textPrimary)
                            .minimumScaleFactor(0.6)
                            .lineLimit(1)
                        Text("kcal")
                            .font(Theme.rounded(12, .semibold))
                            .foregroundStyle(Theme.textTertiary)
                    }
                    .padding(.horizontal, 16)
                }
                .frame(width: 136, height: 136)

                VStack(alignment: .leading, spacing: 12) {
                    stat(
                        "PROTEIN",
                        value: "\(FoodFormat.int(t.protein_g))",
                        unit: "/ \(FoodFormat.int(day.targets.protein_g)) g")
                    if let target = kcalTarget {
                        let left = target - t.kcal
                        stat(
                            left >= 0 ? "LEFT" : "OVER",
                            value: FoodFormat.int(abs(left)),
                            unit: "of \(FoodFormat.int(target))")
                    } else {
                        stat("RANGE", value: FoodFormat.range(t.kcal_lo, t.kcal_hi) ?? "–", unit: nil)
                    }
                }
                Spacer(minLength: 0)
            }
            if let e = day.energy {
                Rectangle().fill(Theme.hairline).frame(height: 1)
                energyRow(e)
            }
            baselineLine(day)
        }
        .padding(20)
        .glassCard(strong: true)
    }

    /// Burn and balance, quietly. Before calibration it is only WHOOP's raw
    /// burn, labelled as such, and never a deficit or surplus claim. After,
    /// the balance (intake minus calibrated burn) with its band; today reads
    /// "so far" and is never projected.
    @ViewBuilder
    private func energyRow(_ e: FoodEnergy) -> some View {
        let balance = e.calibrated ? e.balance_kcal : nil
        let note = e.note ?? energyFallbackNote(e)
        VStack(alignment: .leading, spacing: 4) {
            if let b = balance {
                let word = b.rounded() < 0 ? "deficit" : b.rounded() > 0 ? "surplus" : "even"
                let band = FoodFormat.band(b, e.balance_lo, e.balance_hi)
                // A provisional factor (fitted while a confounder window was
                // open) says so in the tag, not only in the note.
                let kind = e.provisional == true ? "provisional" : "calibrated"
                energyHeader(e.so_far ? "BALANCE SO FAR" : "BALANCE",
                             tag: e.factor.map { "WHOOP, \(kind) \u{00D7}" + String(format: "%.2f", $0) } ?? "WHOOP, \(kind)")
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    Text(FoodFormat.signed(b))
                        .font(Theme.rounded(22, .semibold))
                        .monospacedDigit()
                        .foregroundStyle(Theme.textPrimary)
                    Text(word)
                        .font(Theme.rounded(13))
                        .foregroundStyle(Theme.textSecondary)
                    if let band = band {
                        Text(band)
                            .font(Theme.rounded(12.5))
                            .monospacedDigit()
                            .foregroundStyle(Theme.textTertiary)
                            .padding(.leading, 4)
                    }
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("\(FoodFormat.signed(b)) kcal \(word)\(band.map { ", band \($0)" } ?? "")\(e.so_far ? ", so far" : "")\(e.provisional == true ? ", provisional" : "")")
                .accessibilityIdentifier("food.energy.value")
            } else if let burn = e.burn_kcal {
                energyHeader(e.so_far ? "BURNED SO FAR" : "BURNED",
                             tag: e.calibrated ? "WHOOP, raw" : "WHOOP, uncalibrated")
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    Text(FoodFormat.int(burn))
                        .font(Theme.rounded(22, .semibold))
                        .monospacedDigit()
                        .foregroundStyle(Theme.textPrimary)
                    Text("kcal")
                        .font(Theme.rounded(13))
                        .foregroundStyle(Theme.textSecondary)
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Burned \(FoodFormat.int(burn)) kcal\(e.so_far ? " so far" : ""), WHOOP\(e.calibrated ? "" : ", uncalibrated")")
                .accessibilityIdentifier("food.energy.value")
            } else {
                energyHeader("BURNED", tag: "WHOOP")
            }
            if let note = note {
                Text(note)
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("food.energy.note")
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("food.energy")
    }

    private func energyHeader(_ label: String, tag: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label)
                .font(Theme.sectionLabel(9.5))
                .kerning(1.3)
                .foregroundStyle(Theme.textTertiary)
            Spacer(minLength: 8)
            Text(tag)
                .font(Theme.rounded(11))
                .foregroundStyle(Theme.textTertiary)
                .accessibilityIdentifier("food.energy.tag")
        }
    }

    /// Used only when the daemon sends no note of its own.
    private func energyFallbackNote(_ e: FoodEnergy) -> String? {
        switch e.coverage {
        case "none": return "No scored WHOOP cycle for this day yet."
        case "partial": return e.so_far ? "Cycle still running. Nothing projected." : "Partial WHOOP coverage for this day."
        default: return nil
        }
    }

    private func stat(_ label: String, value: String, unit: String?) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label)
                .font(Theme.sectionLabel(9.5))
                .kerning(1.3)
                .foregroundStyle(Theme.textTertiary)
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text(value)
                    .font(Theme.rounded(22, .semibold))
                    .monospacedDigit()
                    .foregroundStyle(Theme.textPrimary)
                if let unit = unit {
                    Text(unit)
                        .font(Theme.rounded(13))
                        .foregroundStyle(Theme.textSecondary)
                }
            }
        }
    }

    /// The honest footer: what the numbers are not yet, and what they need.
    @ViewBuilder
    private func baselineLine(_ day: FoodDay) -> some View {
        let b = day.baseline
        let pending = day.totals.pending + store.outbox.filter { $0.kind == .meal }.count
        HStack(spacing: 8) {
            Image(systemName: b.ready || day.targets.kcal != nil ? "target" : "chart.line.uptrend.xyaxis")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(Theme.textTertiary)
            Group {
                if day.targets.kcal != nil {
                    Text(day.targets.kcal_provisional == true
                         ? "Provisional budget (confounder window)"
                         : "Budget set from your baseline")
                } else if b.status == "provisional" {
                    // No budget is suggested while a confounder window is open.
                    Text(b.provisional_until.flatMap(FoodFormat.monthDay).map { "Baseline provisional until \($0)" }
                         ?? "Baseline provisional (confounder window)")
                } else if b.ready {
                    Text("Baseline ready. Ask Claude for your budget.")
                } else {
                    Text("Baseline day \(min(b.complete_days + 1, b.days_needed)) of \(b.days_needed) · \(b.weigh_ins)/\(b.weigh_ins_needed) weigh-ins")
                }
            }
            .font(.system(size: 12.5))
            .foregroundStyle(Theme.textSecondary)
            Spacer(minLength: 0)
            if pending > 0 {
                Text("\(pending) pending")
                    .font(Theme.rounded(11.5, .semibold))
                    .foregroundStyle(Theme.textTertiary)
            }
        }
    }

    private var placeholderCard: some View {
        HStack {
            Text(store.loading ? "Loading today…" : "No food log yet today.")
                .font(.system(size: 14))
                .foregroundStyle(Theme.textSecondary)
            Spacer()
        }
        .padding(20)
        .glassCard(strong: true)
    }

    // ── capture ──────────────────────────────────────────────────────

    private var captureRow: some View {
        HStack(spacing: 10) {
            Button {
                if UIImagePickerController.isSourceTypeAvailable(.camera) {
                    showCamera = true
                } else {
                    showLibrary = true // simulator, or a camera-less device
                }
            } label: {
                HStack(spacing: 7) {
                    Image(systemName: "camera.fill")
                        .font(.system(size: 14, weight: .semibold))
                    Text("Photo")
                        .font(Theme.rounded(15, .semibold))
                }
                .padding(.horizontal, 18)
                .frame(height: 48)
            }
            .background(Theme.accent, in: Capsule())
            .foregroundStyle(Theme.accentInk)
            .contextMenu {
                Button {
                    showLibrary = true
                } label: {
                    Label("Choose from library", systemImage: "photo.on.rectangle")
                }
            }

            HStack(spacing: 6) {
                TextField("", text: $quickText, prompt: Text("americano, 2 eggs…").foregroundStyle(Theme.textTertiary))
                    .font(.system(size: 15))
                    .foregroundStyle(Theme.textPrimary)
                    .submitLabel(.send)
                    .focused($quickFocused)
                    .onSubmit(sendQuick)
                if !quickText.trimmingCharacters(in: .whitespaces).isEmpty {
                    Button(action: sendQuick) {
                        Image(systemName: "arrow.up")
                            .font(.system(size: 13, weight: .bold))
                            .foregroundStyle(Theme.accentInk)
                            .frame(width: 32, height: 32)
                            .background(Theme.accent, in: Circle())
                    }
                    .transition(.scale.combined(with: .opacity))
                }
            }
            .padding(.leading, 16)
            .padding(.trailing, 8)
            .frame(height: 48)
            .glassCapsule()
            .animation(.easeOut(duration: 0.15), value: quickText.isEmpty)
        }
    }

    private func sendQuick() {
        let t = quickText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        store.log(photo: nil, note: t)
        quickText = ""
        quickFocused = false
    }

    // ── meals ────────────────────────────────────────────────────────

    private var mealsSection: some View {
        let meals = (store.day?.meals ?? []).sorted { $0.eaten_at > $1.eaten_at }
        let queued = store.outbox.filter { $0.kind == .meal }
        let count = meals.count + queued.count
        return VStack(alignment: .leading, spacing: 10) {
            Text(count == 0 ? "MEALS" : "MEALS · \(count)")
                .font(Theme.sectionLabel())
                .kerning(1.4)
                .foregroundStyle(Theme.textTertiary)
                .padding(.horizontal, 2)
                .padding(.top, 4)
            if count == 0 {
                Text("Nothing logged yet. Snap a photo or type what you had; Claude estimates it.")
                    .font(.system(size: 13.5))
                    .lineSpacing(2)
                    .foregroundStyle(Theme.textSecondary)
                    .padding(.horizontal, 2)
            }
            ForEach(queued.reversed()) { e in
                QueuedRow(entry: e) { store.discard(e.id) }
            }
            ForEach(meals) { meal in
                Button { detail = meal } label: {
                    MealRow(meal: meal, store: store)
                }
                .buttonStyle(.plain)
            }
        }
    }
}

// ── components ────────────────────────────────────────────────────

/// Two concentric arcs. Outer: protein against its target (from day one).
/// Inner: kcal against the budget, only once a budget exists, with the
/// estimate's range as a faint band so the uncertainty stays visible.
struct DayRing<Center: View>: View {
    let protein: Double
    let kcal: Double?
    let kcalLo: Double?
    let kcalHi: Double?
    @ViewBuilder var center: () -> Center

    var body: some View {
        ZStack {
            arc(1, color: Theme.barTrack, width: 9)
            arc(min(protein, 1), color: Theme.textPrimary.opacity(0.88), width: 9)
            if let kcal = kcal {
                arc(1, color: Theme.barTrack, width: 7).padding(15)
                if let lo = kcalLo, let hi = kcalHi {
                    Circle()
                        .trim(from: min(lo, 1), to: min(hi, 1))
                        .stroke(Theme.accent.opacity(0.28), style: StrokeStyle(lineWidth: 7, lineCap: .round))
                        .rotationEffect(.degrees(-90))
                        .padding(15)
                }
                arc(min(kcal, 1), color: kcal > 1 ? Theme.accent : Theme.accent.opacity(0.9), width: 7).padding(15)
            }
            center()
        }
        .animation(.easeOut(duration: 0.5), value: protein)
        .animation(.easeOut(duration: 0.5), value: kcal)
    }

    private func arc(_ to: Double, color: Color, width: CGFloat) -> some View {
        Circle()
            .trim(from: 0, to: max(0, to))
            .stroke(color, style: StrokeStyle(lineWidth: width, lineCap: .round))
            .rotationEffect(.degrees(-90))
    }
}

struct MealRow: View {
    let meal: FoodMeal
    @ObservedObject var store: FoodStore

    var body: some View {
        HStack(spacing: 13) {
            Thumb(path: meal.photos.first?.thumb_url, store: store, textOnly: meal.photos.isEmpty)
            VStack(alignment: .leading, spacing: 3) {
                Text(meal.title)
                    .font(Theme.rounded(15.5, .semibold))
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(2)
                Text(metaLine)
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.textTertiary)
                    .lineLimit(1)
            }
            Spacer(minLength: 6)
            if meal.pending {
                ProgressView()
                    .controlSize(.small)
                    .tint(Theme.textTertiary)
            } else {
                VStack(alignment: .trailing, spacing: 2) {
                    HStack(alignment: .firstTextBaseline, spacing: 3) {
                        Text(FoodFormat.int(meal.kcal))
                            .font(Theme.rounded(18, .semibold))
                            .monospacedDigit()
                            .foregroundStyle(Theme.textPrimary)
                        Text("kcal")
                            .font(Theme.rounded(11))
                            .foregroundStyle(Theme.textTertiary)
                    }
                    Text("\(FoodFormat.grams(meal.protein_g)) protein")
                        .font(.system(size: 11.5))
                        .monospacedDigit()
                        .foregroundStyle(Theme.textSecondary)
                }
            }
        }
        .padding(12)
        .glassCard(cornerRadius: 20)
        .contentShape(Rectangle())
    }

    private var metaLine: String {
        var parts = [FoodFormat.time(meal.eaten_at)]
        if meal.pending {
            parts.append(meal.fix_text != nil ? "re-estimating" : "waiting on Claude")
        } else {
            if let r = FoodFormat.range(meal.kcal_lo, meal.kcal_hi) { parts.append(r) }
            if meal.fix_text != nil && meal.revision > 1 { parts.append("revised") }
        }
        if meal.source == "chat" { parts.append("from chat") }
        return parts.joined(separator: " · ")
    }
}

struct QueuedRow: View {
    let entry: OutboxEntry
    var discard: () -> Void
    /// Decoded once per row, downsampled to the 54 pt tile, off the main
    /// thread: never re-read from disk on every render.
    @State private var thumb: UIImage?

    var body: some View {
        HStack(spacing: 13) {
            Group {
                if let img = thumb {
                    Image(uiImage: img).resizable().scaledToFill()
                } else {
                    TextGlyph()
                }
            }
            .frame(width: 54, height: 54)
            .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
            .opacity(0.7)
            VStack(alignment: .leading, spacing: 3) {
                Text(entry.note ?? "Photo")
                    .font(Theme.rounded(15.5, .semibold))
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(2)
                Text(entry.attempts == 0 ? "sending…" : "queued · sends when your Mac is back")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.textTertiary)
                    .lineLimit(1)
            }
            Spacer(minLength: 6)
            Image(systemName: entry.attempts == 0 ? "arrow.up.circle" : "clock.arrow.circlepath")
                .font(.system(size: 16))
                .foregroundStyle(Theme.textTertiary)
        }
        .padding(12)
        .glassCard(cornerRadius: 20)
        .task(id: entry.photoFile) {
            guard let f = entry.photoFile else { return }
            let url = FoodStore.photoURL(f)
            thumb = await Task.detached(priority: .utility) {
                UIImage(contentsOfFile: url.path)?.preparingThumbnail(of: CGSize(width: 162, height: 162))
            }.value
        }
        .contextMenu {
            Button(role: .destructive, action: discard) {
                Label("Discard", systemImage: "trash")
            }
        }
    }
}

struct Thumb: View {
    let path: String?
    @ObservedObject var store: FoodStore
    var textOnly = false
    var size: CGFloat = 54
    @State private var image: UIImage?

    var body: some View {
        ZStack {
            if let image = image {
                Image(uiImage: image).resizable().scaledToFill()
            } else if textOnly {
                TextGlyph()
            } else {
                Color.white.opacity(0.05)
            }
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: size * 0.24, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: size * 0.24, style: .continuous).strokeBorder(Theme.hairline, lineWidth: 1))
        .onAppear(perform: load)
        .onChange(of: path) { _, _ in load() }
    }

    private func load() {
        guard let path = path else { return }
        store.image(for: path) { image = $0 }
    }
}

/// The stand-in for a text-only meal: a quiet glyph, not an empty frame.
struct TextGlyph: View {
    var body: some View {
        ZStack {
            Color.white.opacity(0.05)
            Image(systemName: "text.quote")
                .font(.system(size: 17, weight: .medium))
                .foregroundStyle(Theme.textTertiary)
        }
    }
}

// ── capture sheets ────────────────────────────────────────────────

struct ComposeItem: Identifiable {
    let id = UUID()
    let image: UIImage
}

/// After the shot: the photo, one optional line ("half portion", "dirty
/// latte"), Send. The line is what makes an ambiguous plate estimable.
struct ComposeSheet: View {
    let image: UIImage
    /// Mock / UI-test only: a pre-typed note with the keyboard up.
    var demoNote: String? = nil
    var send: (String?) -> Void
    var cancel: () -> Void
    @State private var note = ""
    @FocusState private var focused: Bool

    var body: some View {
        // A ScrollView so the sheet can never be taller than the space above
        // the keyboard (the header used to be pushed under the top inset).
        ScrollView {
        VStack(spacing: 16) {
            HStack {
                Button("Cancel", action: cancel)
                    .font(Theme.rounded(15))
                    .foregroundStyle(Theme.textSecondary)
                Spacer()
                Text("New meal")
                    .font(Theme.rounded(16, .semibold))
                    .foregroundStyle(Theme.textPrimary)
                    .accessibilityIdentifier("compose.title")
                Spacer()
                Button {
                    send(note)
                } label: {
                    Text("Send")
                        .font(Theme.rounded(15, .semibold))
                        .padding(.horizontal, 16)
                        .frame(height: 34)
                }
                .background(Theme.accent, in: Capsule())
                .foregroundStyle(Theme.accentInk)
            }
            .padding(.top, 18)

            // Shrinks while typing so the field and the hint stay above the
            // keyboard.
            PhotoBox(image: image)
                .frame(height: focused ? 150 : 360)
                .accessibilityIdentifier("compose.photo")

            TextField("", text: $note, prompt: Text("Add a note: dirty latte, half portion…").foregroundStyle(Theme.textTertiary), axis: .vertical)
                .font(.system(size: 15.5))
                .foregroundStyle(Theme.textPrimary)
                .lineLimit(1...3)
                .focused($focused)
                .padding(.horizontal, 16)
                .padding(.vertical, 13)
                .glassCard(cornerRadius: 18)
                .accessibilityIdentifier("compose.note")

            Text("Claude estimates it in your session and the number lands here.")
                .font(.system(size: 12))
                .foregroundStyle(Theme.textTertiary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 2)
                .accessibilityIdentifier("compose.hint")
        }
        .padding(.horizontal, 20)
        .padding(.bottom, 16)
        // On the whole stack, so the field and hint move WITH the photo.
        .animation(.easeOut(duration: 0.25), value: focused)
        }
        // Always bounces, so a downward drag dismisses the keyboard even when
        // the content fits.
        .scrollDismissesKeyboard(.interactively)
        .background(AmbientBackground())
        .preferredColorScheme(.dark)
        .onAppear {
            if let n = demoNote {
                note = n
                // A sheet's field cannot take focus until presentation settles.
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { focused = true }
            }
        }
    }
}

struct MealDetail: View {
    let meal: FoodMeal
    @ObservedObject var store: FoodStore
    @State private var fix = ""
    @State private var sent = false
    @FocusState private var focused: Bool

    /// Always render the freshest copy: an estimate can land while open.
    private var live: FoodMeal { store.day?.meals.first { $0.id == meal.id } ?? meal }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let photo = live.photos.first {
                    FullPhoto(path: photo.url, store: store)
                        .frame(maxWidth: .infinity)
                        .frame(height: 300)
                }
                VStack(alignment: .leading, spacing: 5) {
                    Text(live.title)
                        .font(.system(size: 24, weight: .bold, design: .rounded))
                        .foregroundStyle(Theme.textPrimary)
                    Text(detailMeta)
                        .font(Theme.rounded(13.5))
                        .foregroundStyle(Theme.textSecondary)
                }

                if live.pending {
                    HStack(spacing: 10) {
                        ProgressView().controlSize(.small).tint(Theme.textTertiary)
                        Text(live.fix_text != nil ? "Claude is re-estimating with your fix." : "Waiting on Claude's estimate.")
                            .font(.system(size: 14))
                            .foregroundStyle(Theme.textSecondary)
                    }
                    .padding(16)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .glassCard(cornerRadius: 20)
                } else {
                    itemsCard
                }

                if let f = live.fix_text {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Image(systemName: "arrow.uturn.backward")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(Theme.textTertiary)
                        Text("Your fix: \(f)")
                            .font(.system(size: 13))
                            .foregroundStyle(Theme.textSecondary)
                    }
                    .padding(.horizontal, 2)
                }

                fixField
            }
            .padding(.horizontal, 20)
            .padding(.top, 22)
            .padding(.bottom, 40)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(AmbientBackground())
        .preferredColorScheme(.dark)
    }

    private var detailMeta: String {
        var parts = [FoodFormat.time(live.eaten_at)]
        if live.source == "chat" { parts.append("logged in chat") }
        if let c = live.confidence { parts.append("\(c) confidence") }
        if live.revision > 1 { parts.append("revised \(live.revision - 1)×") }
        return parts.joined(separator: " · ")
    }

    private var itemsCard: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(live.items.enumerated()), id: \.offset) { i, item in
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(item.name)
                            .font(.system(size: 15))
                            .foregroundStyle(Theme.textPrimary)
                        if let g = item.grams {
                            Text("\(FoodFormat.int(g)) g")
                                .font(.system(size: 12))
                                .foregroundStyle(Theme.textTertiary)
                        }
                    }
                    Spacer(minLength: 8)
                    VStack(alignment: .trailing, spacing: 2) {
                        Text("\(FoodFormat.int(item.kcal))")
                            .font(Theme.rounded(16, .semibold))
                            .monospacedDigit()
                            .foregroundStyle(Theme.textPrimary)
                        Text("\(FoodFormat.grams(item.protein_g)) P")
                            .font(.system(size: 11.5))
                            .monospacedDigit()
                            .foregroundStyle(Theme.textSecondary)
                    }
                }
                .padding(.vertical, 11)
                if i < live.items.count - 1 {
                    Rectangle().fill(Theme.hairline).frame(height: 1)
                }
            }
            Rectangle().fill(Color.white.opacity(0.14)).frame(height: 1).padding(.top, 2)
            HStack(alignment: .firstTextBaseline) {
                Text("Total")
                    .font(Theme.rounded(15, .semibold))
                    .foregroundStyle(Theme.textPrimary)
                if let r = FoodFormat.range(live.kcal_lo, live.kcal_hi) {
                    Text(r)
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.textTertiary)
                }
                Spacer()
                Text("\(FoodFormat.int(live.kcal)) kcal · \(FoodFormat.grams(live.protein_g))")
                    .font(Theme.rounded(15, .semibold))
                    .monospacedDigit()
                    .foregroundStyle(Theme.textPrimary)
            }
            .padding(.top, 12)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 6)
        .padding(.bottom, 10)
        .glassCard(cornerRadius: 20)
    }

    private var fixField: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("FIX")
                .font(Theme.sectionLabel())
                .kerning(1.4)
                .foregroundStyle(Theme.textTertiary)
                .padding(.horizontal, 2)
            HStack(spacing: 6) {
                TextField("", text: $fix, prompt: Text(sent ? "Sent. Claude will re-estimate." : "it was soto betawi, not gulai…").foregroundStyle(Theme.textTertiary))
                    .font(.system(size: 15))
                    .foregroundStyle(Theme.textPrimary)
                    .submitLabel(.send)
                    .focused($focused)
                    .onSubmit(sendFix)
                if !fix.trimmingCharacters(in: .whitespaces).isEmpty {
                    Button(action: sendFix) {
                        Image(systemName: "arrow.up")
                            .font(.system(size: 13, weight: .bold))
                            .foregroundStyle(Theme.accentInk)
                            .frame(width: 32, height: 32)
                            .background(Theme.accent, in: Circle())
                    }
                }
            }
            .padding(.leading, 16)
            .padding(.trailing, 8)
            .frame(height: 48)
            .glassCapsule()
        }
    }

    private func sendFix() {
        let t = fix.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        store.fix(mealId: live.id, text: t)
        fix = ""
        sent = true
        focused = false
    }
}

struct FullPhoto: View {
    let path: String?
    @ObservedObject var store: FoodStore
    @State private var image: UIImage?

    var body: some View {
        PhotoBox(image: image)
        .onAppear {
            guard let path = path else { return }
            store.image(for: path) { image = $0 }
        }
    }
}

/// A photo that FILLS whatever box its parent gives it and is clipped to it.
/// Never put scaledToFill on an Image inside a flexible frame: a photo wider
/// than the box reports its full fill width, the parent grows past the screen
/// and gets centered (Nov 16 2026: the compose sheet's note field, Cancel and
/// Send went off screen). The overflow is clipped for drawing AND hit testing,
/// so it can never swallow taps meant for the views above it.
struct PhotoBox: View {
    let image: UIImage?

    var body: some View {
        Color.white.opacity(0.04)
            .overlay {
                if let image = image {
                    Image(uiImage: image).resizable().scaledToFill().allowsHitTesting(false)
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).strokeBorder(Theme.hairline, lineWidth: 1))
    }
}

/// UIKit camera, wrapped. Returns the shot (or nil on cancel).
struct CameraPicker: UIViewControllerRepresentable {
    var done: (UIImage?) -> Void

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let p = UIImagePickerController()
        p.sourceType = .camera
        p.delegate = context.coordinator
        return p
    }

    func updateUIViewController(_ vc: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(done: done) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let done: (UIImage?) -> Void
        init(done: @escaping (UIImage?) -> Void) { self.done = done }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            done(info[.originalImage] as? UIImage)
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            done(nil)
        }
    }
}

// ── simulator demo (HR_DEMO=1 HR_DEMO_TAB=food) ───────────────────

enum DemoFood {
    /// HR_DEMO_FOOD_PHOTOS=<dir on the Mac>: the simulator reads host files,
    /// so real plates can stand in for daemon thumbnails in a mock.
    static func image(_ path: String) -> UIImage? {
        guard let dir = ProcessInfo.processInfo.environment["HR_DEMO_FOOD_PHOTOS"] else { return nil }
        let files = ((try? FileManager.default.contentsOfDirectory(atPath: dir)) ?? [])
            .filter { $0.lowercased().hasSuffix(".jpg") }
            .sorted()
        guard !files.isEmpty else { return nil }
        let idx: Int
        if path == "compose" {
            idx = files.count - 1
        } else if let m = path.range(of: "meal=(\\d+)", options: .regularExpression) {
            idx = (Int(path[m].dropFirst(5)) ?? 0) % files.count
        } else {
            idx = 0
        }
        return UIImage(contentsOfFile: "\(dir)/\(files[idx])")
    }

    static func day(_ mode: String) -> FoodDay? {
        if mode == "empty" {
            return FoodDay(
                date: FoodStore.localFoodDay(), today: FoodStore.localFoodDay(), meals: [],
                totals: FoodTotals(kcal: 0, kcal_lo: 0, kcal_hi: 0, protein_g: 0, estimated: 0, pending: 0),
                complete: true, targets: FoodTargets(protein_g: 140, kcal: nil),
                baseline: FoodBaseline(ready: false, complete_days: 0, days_needed: 14, weigh_ins: 0, weigh_ins_needed: 8),
                weight: nil)
        }
        let target = mode == "target"
        // Energy modes (synthetic numbers only): energy-uncal, energy-deficit,
        // energy-surplus, energy-none, energy-provisional and energy-malformed
        // are a finished day (yesterday); energy-sofar and energy-pending are
        // today with the cycle still running.
        let energyMode = mode.hasPrefix("energy-") ? String(mode.dropFirst(7)) : nil
        let pastDay = energyMode != nil && energyMode != "sofar" && energyMode != "pending"
        let dayDate = pastDay ? Calendar.current.date(byAdding: .day, value: -1, to: Date()) ?? Date() : Date()
        let iso = ISO8601DateFormatter()
        let at = { (h: Int, m: Int) -> String in
            var c = Calendar.current.dateComponents([.year, .month, .day], from: dayDate)
            c.hour = h
            c.minute = m
            return iso.string(from: Calendar.current.date(from: c) ?? Date())
        }
        func item(_ n: String, _ g: Double?, _ k: Double, _ lo: Double, _ hi: Double, _ p: Double, preset: String? = nil) -> FoodItem {
            FoodItem(name: n, grams: g, kcal: k, kcal_lo: lo, kcal_hi: hi, protein_g: p, preset_slug: preset)
        }
        let latte = FoodMeal(
            id: 1, source: "app", status: "estimated", eaten_at: at(8, 40), label: "Dirty latte", note: "dirty latte",
            confidence: "medium", revision: 1, kcal: 190, kcal_lo: 150, kcal_hi: 240, protein_g: 9, fix_text: nil,
            items: [item("Dirty latte (double shot, whole milk)", 300, 190, 150, 240, 9)],
            photos: [FoodPhoto(n: 0, url: "/meal-photo?meal=1&n=0", thumb_url: "/meal-photo?meal=1&n=0&thumb=1")])
        let lunch = FoodMeal(
            id: 2, source: "app", status: "estimated", eaten_at: at(12, 50), label: "Nasi + ayam goreng + sayur", note: nil,
            confidence: "medium", revision: 2, kcal: 720, kcal_lo: 610, kcal_hi: 840, protein_g: 41, fix_text: "half the rice",
            items: [
                item("Rice, half centong", 75, 98, 85, 110, 2),
                item("Crispy fried chicken thigh", 140, 410, 350, 470, 31),
                item("Sayur asem", 200, 70, 50, 90, 2),
                item("Sambal goreng + kecap", 40, 142, 125, 170, 6),
            ],
            photos: [FoodPhoto(n: 0, url: "/meal-photo?meal=2&n=0", thumb_url: "/meal-photo?meal=2&n=0&thumb=1")])
        let americano = FoodMeal(
            id: 3, source: "chat", status: "estimated", eaten_at: at(15, 10), label: "Americano", note: "americano",
            confidence: "high", revision: 1, kcal: 10, kcal_lo: 10, kcal_hi: 10, protein_g: 0, fix_text: nil,
            items: [item("Americano", 350, 10, 10, 10, 0)], photos: [])
        let dinner = FoodMeal(
            id: 4, source: "app", status: "pending", eaten_at: at(19, 25), label: nil, note: "soto mama, 1 centong",
            confidence: nil, revision: 0, kcal: nil, kcal_lo: nil, kcal_hi: nil, protein_g: nil, fix_text: nil,
            items: [], photos: [FoodPhoto(n: 0, url: "/meal-photo?meal=4&n=0", thumb_url: "/meal-photo?meal=4&n=0&thumb=1")])
        if let e = energyMode {
            return energyDay(e, at: at, date: dayDate, morning: [latte, lunch, americano], pending: dinner, item: item)
        }
        let meals = [latte, lunch, americano, dinner]
        return FoodDay(
            date: FoodStore.localFoodDay(), today: FoodStore.localFoodDay(), meals: meals,
            totals: FoodTotals(kcal: 920, kcal_lo: 770, kcal_hi: 1090, protein_g: 50, estimated: 3, pending: 1),
            complete: false, targets: FoodTargets(protein_g: 140, kcal: target ? 2300 : nil),
            baseline: target
                ? FoodBaseline(ready: true, complete_days: 18, days_needed: 14, weigh_ins: 15, weigh_ins_needed: 8)
                : FoodBaseline(ready: false, complete_days: 2, days_needed: 14, weigh_ins: 3, weigh_ins_needed: 8),
            weight: FoodWeight(kg: target ? 74.6 : 75.4, at: at(7, 5), fat_pct: 20.6))
    }

    /// The energy-row states. Intake, burn and factor are made up but kept
    /// arithmetically consistent: balance = intake - burn * factor. Every
    /// note is the EXACT string the daemon's dayEnergy() sends for that state
    /// (the daemon's note always wins on device), so the mock is what ships.
    private static func energyDay(
        _ mode: String, at: (Int, Int) -> String, date: Date, morning: [FoodMeal], pending: FoodMeal,
        item: (String, Double?, Double, Double, Double, Double, String?) -> FoodItem
    ) -> FoodDay? {
        let dinner = FoodMeal(
            id: 5, source: "app", status: "estimated", eaten_at: at(19, 25), label: "Soto ayam + nasi", note: "soto, 1 centong",
            confidence: "medium", revision: 1, kcal: 690, kcal_lo: 580, kcal_hi: 820, protein_g: 38, fix_text: nil,
            items: [item("Soto ayam", 450, 340, 290, 400, 30, nil), item("Rice, 1 centong", 150, 195, 175, 215, 4, nil),
                    item("Emping + sambal", 30, 155, 115, 205, 4, nil)],
            photos: [FoodPhoto(n: 0, url: "/meal-photo?meal=4&n=0", thumb_url: "/meal-photo?meal=4&n=0&thumb=1")])
        let snack = FoodMeal(
            id: 6, source: "chat", status: "estimated", eaten_at: at(22, 10), label: "Banana bread, 2 slices", note: "banana bread 2 slices",
            confidence: "low", revision: 1, kcal: 560, kcal_lo: 450, kcal_hi: 700, protein_g: 10, fix_text: nil,
            items: [item("Banana bread, 2 slices", 160, 560, 450, 700, 10, nil)], photos: [])
        let today = FoodStore.localFoodDay()
        let day = FoodStore.localFoodDay(date)
        let uncal = FoodBaseline(ready: false, complete_days: 9, days_needed: 14, weigh_ins: 6, weigh_ins_needed: 8, status: "collecting")
        let ready = FoodBaseline(ready: true, complete_days: 16, days_needed: 14, weigh_ins: 11, weigh_ins_needed: 8, status: "ready")
        let until = FoodStore.localFoodDay(Calendar.current.date(byAdding: .day, value: 12, to: Date()) ?? Date())
        let provisional = FoodBaseline(ready: true, complete_days: 15, days_needed: 14, weigh_ins: 10, weigh_ins_needed: 8,
                                       status: "provisional", provisional_until: until)
        // Synthetic body values (not anyone's real numbers).
        let weight = FoodWeight(kg: 75.0, at: at(7, 5), fat_pct: 20.0)
        let protein = FoodTargets(protein_g: 140, kcal: nil)
        func full(_ meals: [FoodMeal], _ t: FoodTotals, _ b: FoodBaseline, _ e: FoodEnergy) -> FoodDay {
            FoodDay(date: day, today: today, meals: meals, totals: t, complete: true,
                    targets: protein, baseline: b, weight: weight, energy: e)
        }
        let base = morning + [dinner]
        let baseTotals = FoodTotals(kcal: 1610, kcal_lo: 1350, kcal_hi: 1910, protein_g: 88, estimated: 4, pending: 0)
        let morningTotals = FoodTotals(kcal: 920, kcal_lo: 770, kcal_hi: 1090, protein_g: 50, estimated: 3, pending: 0)
        switch mode {
        case "uncal":
            return full(base, baseTotals, uncal, FoodEnergy(
                burn_kcal: 2350, calibrated: false, factor: nil, balance_kcal: nil, balance_lo: nil, balance_hi: nil,
                so_far: false, coverage: "full", note: "No balance until the baseline calibrates WHOOP.", provisional: false))
        case "surplus":
            // Partial coverage (the longest note a balance row carries):
            // 2,170 - 2,291 x 0.86 = +200.
            return full(base + [snack], FoodTotals(kcal: 2170, kcal_lo: 1800, kcal_hi: 2610, protein_g: 98, estimated: 5, pending: 0),
                        ready, FoodEnergy(burn_kcal: 2291, calibrated: true, factor: 0.86, balance_kcal: 200,
                                          balance_lo: 30, balance_hi: 370, so_far: false, coverage: "partial",
                                          note: "Two WHOOP cycles share this day, so the burn is loose.", provisional: false))
        case "none":
            return full(base, baseTotals, ready, FoodEnergy(
                burn_kcal: nil, calibrated: true, factor: 0.86, balance_kcal: nil, balance_lo: nil, balance_hi: nil,
                so_far: false, coverage: "none", note: "No scored WHOOP cycle for this day.", provisional: false))
        case "sofar":
            // Today, cycle running, every meal estimated: 920 - 1,240 x 0.86 = -146, so far.
            return FoodDay(
                date: today, today: today, meals: morning, totals: morningTotals,
                complete: true, targets: protein, baseline: ready, weight: weight,
                energy: FoodEnergy(burn_kcal: 1240, calibrated: true, factor: 0.86, balance_kcal: -146,
                                   balance_lo: -261, balance_hi: -31, so_far: true, coverage: "partial",
                                   note: "So far today, not a projection.", provisional: false))
        case "pending":
            // Today with a meal still pending: its kcal is missing, so no balance.
            return FoodDay(
                date: today, today: today, meals: morning + [pending],
                totals: FoodTotals(kcal: 920, kcal_lo: 770, kcal_hi: 1090, protein_g: 50, estimated: 3, pending: 1),
                complete: false, targets: protein, baseline: ready, weight: weight,
                energy: FoodEnergy(burn_kcal: 1240, calibrated: true, factor: 0.86, balance_kcal: nil,
                                   balance_lo: nil, balance_hi: nil, so_far: true, coverage: "partial",
                                   note: "1 meal not estimated yet, so no balance yet.", provisional: false))
        case "provisional":
            // Factor fitted while a confounder window is open: 1,610 - 2,395 x 0.86 = -450.
            return full(base, baseTotals, provisional, FoodEnergy(
                burn_kcal: 2395, calibrated: true, factor: 0.86, balance_kcal: -450, balance_lo: -630, balance_hi: -270,
                so_far: false, coverage: "full", note: "Provisional factor (confounder window).", provisional: true))
        case "malformed":
            // A daemon sending a broken energy object: decoded through the
            // real wire decoder, the day must still render (no energy row).
            let json = """
            {"date":"\(day)","today":"\(today)","meals":[],"complete":true,
             "totals":{"kcal":1610,"kcal_lo":1350,"kcal_hi":1910,"protein_g":88,"estimated":4,"pending":0},
             "targets":{"protein_g":140,"kcal":null},
             "baseline":{"ready":true,"complete_days":16,"days_needed":14,"weigh_ins":11,"weigh_ins_needed":8},
             "weight":null,
             "energy":{"burn_kcal":"2395","calibrated":true}}
            """
            return try? JSONDecoder().decode(FoodDay.self, from: Data(json.utf8))
        default: // deficit, full coverage, nothing to add: the daemon sends no note.
            return full(base, baseTotals, ready, FoodEnergy(
                burn_kcal: 2395, calibrated: true, factor: 0.86, balance_kcal: -450, balance_lo: -630, balance_hi: -270,
                so_far: false, coverage: "full", note: nil, provisional: false))
        }
    }
}
