// The Food tab: today's intake at a glance, capture in one tap.
// Layout (his call, Nov 16 2026): the day ring (kcal with its range, protein
// against its target), today's meals with thumbnails, camera + quick text.
// Nov 18 2026: the gallery is one tap beside the camera (it was hidden behind
// a long press), and a meal carries up to six photos (the daemon's cap).
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
    @State private var libraryItems: [PhotosPickerItem] = []
    /// The pending capture. A stable item (one id per shot) so re-renders
    /// from store publishes never re-present the sheet and wipe the note.
    @State private var composing: ComposeItem?
    @State private var detail: FoodMeal?
    @State private var history = false
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
                case "detail":
                    // HR_DEMO_FOOD_MEAL=<id> opens that meal (else the first with a photo).
                    let want = ProcessInfo.processInfo.environment["HR_DEMO_FOOD_MEAL"].flatMap(Int.init)
                    detail = store.day?.meals.first { want != nil ? $0.id == want : (!$0.photos.isEmpty && !$0.pending) }
                case "compose": composing = DemoFood.composeImages().map { ComposeItem(images: $0) }
                case "history": history = true
                default: break
                }
            }
        }
        .fullScreenCover(isPresented: $showCamera) {
            CameraPicker { image in
                showCamera = false
                if let image = image { composing = ComposeItem(images: [FoodStore.downscaled(image)]) }
            }
            .ignoresSafeArea()
        }
        // The system picker runs out of process: no photo-library permission
        // prompt and no Info.plist key. Ordered, so the first pick is the cover.
        .photosPicker(isPresented: $showLibrary, selection: $libraryItems, maxSelectionCount: FoodStore.maxPhotos,
                      selectionBehavior: .ordered, matching: .images)
        .onChange(of: libraryItems) { _, items in
            guard !items.isEmpty else { return }
            Task {
                let images = await PickedPhotos.load(items)
                libraryItems = []
                if !images.isEmpty { composing = ComposeItem(images: images) }
            }
        }
        .sheet(item: $composing) { item in
            ComposeSheet(images: item.images, demoNote: Demo.active ? ProcessInfo.processInfo.environment["HR_DEMO_FOOD_NOTE"] : nil) { photos, note in
                store.log(photos: photos, note: note)
                composing = nil
            } cancel: {
                composing = nil
            }
            .presentationDetents([.large])
            // A stray swipe must not throw away the photo and note: Cancel
            // is the explicit way out.
            .interactiveDismissDisabled()
        }
        .sheet(isPresented: $history) {
            HistorySheet(store: store,
                         openDay: Demo.active ? ProcessInfo.processInfo.environment["HR_DEMO_FOOD_DAY"].flatMap(Int.init) : nil)
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
        }
        .sheet(item: $detail) { meal in
            MealDetail(meal: meal, store: store,
                       startPage: Demo.active ? ProcessInfo.processInfo.environment["HR_DEMO_FOOD_PAGE"].flatMap(Int.init) ?? 0 : 0)
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
        }
    }

    // ── header ───────────────────────────────────────────────────────

    private var header: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 5) {
                Text("Food")
                    .font(.system(size: 30, weight: .bold, design: .rounded))
                    .foregroundStyle(Theme.textPrimary)
                Text(subtitle)
                    .font(Theme.rounded(14))
                    .foregroundStyle(Theme.textSecondary)
            }
            Spacer()
            // Past days: a quiet glass circle, the header's only control.
            Button { history = true } label: {
                Image(systemName: "calendar")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(Theme.textPrimary.opacity(0.9))
                    .frame(width: 42, height: 42)
                    .contentShape(Circle())
            }
            .glassCapsule()
            .padding(.top, 2)
            .accessibilityLabel("Meal history")
            .accessibilityIdentifier("food.history")
        }
        .padding(.top, 4)
    }

    private var subtitle: String {
        guard let day = store.day else { return "Today" }
        var parts = [prettyDate(day.date)]
        if let w = day.weight { parts.append(String(format: "%.1f kg", w.kg)) }
        return parts.joined(separator: " · ")
    }

    private func prettyDate(_ raw: String) -> String { FoodFormat.dayTitle(raw) }

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
                    VStack(alignment: .leading, spacing: 3) {
                        stat(
                            "PROTEIN",
                            value: "\(FoodFormat.int(t.protein_g))",
                            unit: "/ \(FoodFormat.int(day.targets.protein_g)) g")
                        proteinLeftLine(logged: t.protein_g, target: day.targets.protein_g)
                    }
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

    /// What protein the day still needs, always on under "88 / 140 g". Same
    /// quiet voice whether short, met or over: going over is never an alarm.
    /// No target, no line. Protein only: there is deliberately no kcal-left
    /// here (no kcal target exists during the baseline).
    @ViewBuilder
    private func proteinLeftLine(logged: Double, target: Double) -> some View {
        if let p = FoodFormat.proteinLeft(logged: logged, target: target) {
            Text(p.text)
                .font(Theme.rounded(12.5))
                .monospacedDigit()
                .foregroundStyle(Theme.textSecondary)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityLabel(p.spoken)
                .accessibilityIdentifier("food.protein.left")
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

    /// Camera and gallery, both one tap: the camera is the primary (accent)
    /// action, the gallery its quiet sibling, then the quick-text field.
    private var captureRow: some View {
        HStack(spacing: 8) {
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
                .padding(.horizontal, 16)
                .frame(height: 48)
            }
            .background(Theme.accent, in: Capsule())
            .foregroundStyle(Theme.accentInk)
            .accessibilityIdentifier("food.capture.camera")

            Button {
                showLibrary = true
            } label: {
                Image(systemName: "photo.on.rectangle.angled")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(Theme.textPrimary.opacity(0.9))
                    .frame(width: 48, height: 48)
                    .contentShape(Circle())
            }
            .glassCapsule()
            .accessibilityLabel("Choose from library")
            .accessibilityIdentifier("food.capture.library")

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
        store.log(photos: [], note: t)
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
                .overlay(alignment: .bottomTrailing) {
                    if meal.photos.count > 1 { PhotoCountBadge(count: meal.photos.count).padding(3) }
                }
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
        let sending = store.sendingPhotos(for: meal.id)
        if sending > 0 { parts.append("\(sending) photo\(sending == 1 ? "" : "s") sending") }
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
                } else if entry.staging != nil {
                    Color.white.opacity(0.05) // its photos are still being written
                } else {
                    TextGlyph()
                }
            }
            .frame(width: 54, height: 54)
            .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
            .opacity(0.7)
            .overlay(alignment: .bottomTrailing) {
                if photoCount > 1 { PhotoCountBadge(count: photoCount).padding(3) }
            }
            VStack(alignment: .leading, spacing: 3) {
                Text(entry.note ?? (photoCount > 1 ? "\(photoCount) photos" : "Photo"))
                    .font(Theme.rounded(15.5, .semibold))
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(2)
                Text(entry.attempts == 0 ? "sending…" : "queued, sends when online")
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
        .task(id: entry.files.first) {
            guard let f = entry.files.first else { return }
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

    /// While staging, the photos it WILL carry (the files land a beat later).
    private var photoCount: Int { entry.staging ?? entry.files.count }
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

/// "this meal has N photos" on a cover thumb: a small dark capsule in the
/// corner, the count with a stack glyph. Never on a single-photo meal.
struct PhotoCountBadge: View {
    let count: Int

    var body: some View {
        HStack(spacing: 2) {
            Image(systemName: "square.on.square.fill")
                .font(.system(size: 7.5, weight: .bold))
            Text("\(count)")
                .font(Theme.rounded(10.5, .semibold))
                .monospacedDigit()
        }
        .foregroundStyle(.white.opacity(0.95))
        .padding(.horizontal, 5)
        .frame(height: 17)
        .background(Capsule().fill(Color.black.opacity(0.6)))
        .overlay(Capsule().strokeBorder(Color.white.opacity(0.16), lineWidth: 0.5))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(count) photos")
        .accessibilityIdentifier("meal.photocount")
    }
}

// ── capture sheets ────────────────────────────────────────────────

struct ComposeItem: Identifiable {
    let id = UUID()
    let images: [UIImage]
}

/// One photo in the compose sheet, with a stable id (removing one never
/// reshuffles the others' selection or animation).
struct ComposePhoto: Identifiable, Equatable {
    let id = UUID()
    let image: UIImage
}

/// Library picks, loaded in parallel but returned IN PICK ORDER (the first
/// is the cover), each decoded straight down to the upload size.
enum PickedPhotos {
    static func load(_ items: [PhotosPickerItem]) async -> [UIImage] {
        await withTaskGroup(of: (Int, UIImage?).self) { group in
            for (i, item) in items.enumerated() {
                group.addTask {
                    guard let data = try? await item.loadTransferable(type: Data.self) else { return (i, nil) }
                    return (i, FoodStore.downscaled(data))
                }
            }
            var slots = [UIImage?](repeating: nil, count: items.count)
            for await (i, img) in group { slots[i] = img }
            return slots.compactMap { $0 }
        }
    }
}

/// After the shot: the meal's photos (up to six, the first is its cover), one
/// optional line ("half portion", "dirty latte"), Send. The line is what makes
/// an ambiguous plate estimable; the extra angles (the bowl from above, the
/// side dish, the menu board) are what make a big meal estimable.
struct ComposeSheet: View {
    let images: [UIImage]
    /// Mock / UI-test only: a pre-typed note with the keyboard up.
    var demoNote: String? = nil
    var send: ([UIImage], String?) -> Void
    var cancel: () -> Void
    @State private var photos: [ComposePhoto] = []
    @State private var shown: UUID?
    @State private var note = ""
    @State private var showCamera = false
    @State private var showLibrary = false
    @State private var picks: [PhotosPickerItem] = []
    @State private var confirmCancel = false
    @FocusState private var focused: Bool

    private var remaining: Int { FoodStore.maxPhotos - photos.count }
    private var canSend: Bool { !photos.isEmpty || !note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private var current: ComposePhoto? { photos.first { $0.id == shown } ?? photos.first }
    /// The strip's tiles: 64 pt, smaller when they would not all fit (six
    /// photos on a 375 pt screen), smaller still while typing.
    @State private var stripWidth: CGFloat = 335
    private var tile: CGFloat {
        let n = CGFloat(photos.count + (remaining > 0 ? 1 : 0))
        let fit = ((stripWidth - 8 - 10 * (n - 1)) / max(n, 1)).rounded(.down)
        return min(focused ? 46 : 64, fit)
    }

    var body: some View {
        // A ScrollView so the sheet can never be taller than the space above
        // the keyboard (the header used to be pushed under the top inset).
        ScrollView {
        VStack(spacing: 14) {
            HStack {
                Button("Cancel") {
                    // Two or more photos are real work to lose: ask first.
                    if photos.count > 1 { confirmCancel = true } else { cancel() }
                }
                .font(Theme.rounded(15))
                .foregroundStyle(Theme.textSecondary)
                Spacer()
                Text("New meal")
                    .font(Theme.rounded(16, .semibold))
                    .foregroundStyle(Theme.textPrimary)
                    .accessibilityIdentifier("compose.title")
                Spacer()
                Button {
                    send(photos.map(\.image), note)
                } label: {
                    Text("Send")
                        .font(Theme.rounded(15, .semibold))
                        .padding(.horizontal, 16)
                        .frame(height: 34)
                }
                .background(Theme.accent.opacity(canSend ? 1 : 0.35), in: Capsule())
                .foregroundStyle(Theme.accentInk)
                .disabled(!canSend)
            }
            .padding(.top, 18)

            // Shrinks while typing so the field and the hint stay above the
            // keyboard.
            PhotoBox(image: current?.image)
                .frame(height: focused ? 110 : 300)
                .overlay {
                    if photos.isEmpty {
                        Text("No photo. Add one, or send just the note.")
                            .font(.system(size: 13))
                            .foregroundStyle(Theme.textTertiary)
                    }
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Shown photo")
                .accessibilityValue(current.flatMap { c in photos.firstIndex(of: c) }.map { "\($0 + 1) of \(photos.count)" } ?? "none")
                .accessibilityIdentifier("compose.photo")

            strip

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
        .animation(.timingCurve(0.23, 1, 0.32, 1, duration: 0.25), value: photos)
        }
        // Always bounces, so a downward drag dismisses the keyboard even when
        // the content fits.
        .scrollDismissesKeyboard(.interactively)
        .background(AmbientBackground())
        .preferredColorScheme(.dark)
        .onAppear {
            if photos.isEmpty { photos = images.prefix(FoodStore.maxPhotos).map { ComposePhoto(image: $0) } }
            if let n = demoNote {
                note = n
                // A sheet's field cannot take focus until presentation settles.
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { focused = true }
            }
        }
        .fullScreenCover(isPresented: $showCamera) {
            CameraPicker { image in
                showCamera = false
                if let image = image, remaining > 0 { add([FoodStore.downscaled(image)]) }
            }
            .ignoresSafeArea()
        }
        .photosPicker(isPresented: $showLibrary, selection: $picks, maxSelectionCount: max(remaining, 1),
                      selectionBehavior: .ordered, matching: .images)
        .onChange(of: picks) { _, items in
            guard !items.isEmpty else { return }
            Task {
                let images = await PickedPhotos.load(items)
                picks = []
                add(images)
            }
        }
        .confirmationDialog("Discard this meal?", isPresented: $confirmCancel, titleVisibility: .visible) {
            Button("Discard \(photos.count) photos", role: .destructive, action: cancel)
            Button("Keep editing", role: .cancel) {}
        }
    }

    /// The meal's photos in order, the first marked as the cover, each with a
    /// remove; then an add tile until six. "3 of 6" says the room left.
    private var strip: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text("PHOTOS")
                    .font(Theme.sectionLabel())
                    .kerning(1.4)
                    .foregroundStyle(Theme.textTertiary)
                Spacer()
                Text("\(photos.count) of \(FoodStore.maxPhotos)")
                    .font(Theme.rounded(12, .semibold))
                    .monospacedDigit()
                    .foregroundStyle(Theme.textTertiary)
                    .accessibilityIdentifier("compose.count")
            }
            .padding(.horizontal, 2)
            // Every tile on screen at once, never a hidden sixth behind a scroll.
            HStack(spacing: 10) {
                ForEach(Array(photos.enumerated()), id: \.element.id) { i, p in
                    thumb(p, index: i)
                }
                if remaining > 0 { addTile }
                Spacer(minLength: 0)
            }
            // Room for the remove buttons that sit over the tile corners.
            .padding(.top, 7)
            .padding(.leading, 1)
            .background(GeometryReader { g in
                Color.clear.onAppear { stripWidth = g.size.width }.onChange(of: g.size.width) { _, w in stripWidth = w }
            })
        }
    }

    private func thumb(_ p: ComposePhoto, index i: Int) -> some View {
        let selected = p.id == current?.id && photos.count > 1
        return ZStack(alignment: .topTrailing) {
            Button {
                shown = p.id
            } label: {
                Color.white.opacity(0.04)
                    .overlay { Image(uiImage: p.image).resizable().scaledToFill().allowsHitTesting(false) }
                    .frame(width: tile, height: tile)
                    .overlay(alignment: .bottom) {
                        if i == 0 && photos.count > 1 && !focused {
                            Text("COVER")
                                .font(.system(size: 8, weight: .bold))
                                .kerning(0.8)
                                .foregroundStyle(.white.opacity(0.92))
                                .frame(maxWidth: .infinity)
                                .frame(height: 15)
                                .background(Color.black.opacity(0.5))
                        }
                    }
                    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .strokeBorder(selected ? Color.white.opacity(0.9) : Theme.hairline, lineWidth: selected ? 2 : 1)
                    )
            }
            .buttonStyle(.plain)
            .accessibilityLabel(i == 0 ? "Photo 1, cover" : "Photo \(i + 1)")
            .accessibilityIdentifier("compose.thumb.\(i)")
            Button {
                remove(p)
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 8.5, weight: .bold))
                    .foregroundStyle(.white.opacity(0.95))
                    .frame(width: 20, height: 20)
                    .background(Circle().fill(Color(white: 0.16)))
                    .overlay(Circle().strokeBorder(Color.white.opacity(0.22), lineWidth: 0.75))
                    // A 20 pt mark, a 36 pt target (the tile is tapped too).
                    .frame(width: 36, height: 36)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .offset(x: 14, y: -14)
            .accessibilityLabel("Remove photo \(i + 1)")
            .accessibilityIdentifier("compose.remove.\(i)")
        }
        .transition(.scale(scale: 0.9).combined(with: .opacity))
    }

    /// Camera or library; on a device with no camera (the simulator) the
    /// library opens straight away.
    @ViewBuilder
    private var addTile: some View {
        let label = RoundedRectangle(cornerRadius: 14, style: .continuous)
            .strokeBorder(Color.white.opacity(0.26), style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
            .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Color.white.opacity(0.03)))
            .frame(width: tile, height: tile)
            .overlay {
                Image(systemName: "plus")
                    .font(.system(size: focused ? 14 : 18, weight: .medium))
                    .foregroundStyle(Theme.textSecondary)
            }
            .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        Group {
            if UIImagePickerController.isSourceTypeAvailable(.camera) {
                Menu {
                    Button { showCamera = true } label: { Label("Take photo", systemImage: "camera") }
                    Button { showLibrary = true } label: { Label("Choose from library", systemImage: "photo.on.rectangle.angled") }
                } label: { label }
            } else {
                Button { showLibrary = true } label: { label }
                    .buttonStyle(.plain)
            }
        }
        .accessibilityLabel("Add photo")
        .accessibilityIdentifier("compose.add")
    }

    private func add(_ images: [UIImage]) {
        let fresh = images.prefix(max(remaining, 0)).map { ComposePhoto(image: $0) }
        guard !fresh.isEmpty else { return }
        photos.append(contentsOf: fresh)
        shown = fresh.first?.id
    }

    private func remove(_ p: ComposePhoto) {
        guard let i = photos.firstIndex(of: p) else { return }
        let wasShown = p.id == current?.id
        photos.remove(at: i)
        if wasShown { shown = photos.isEmpty ? nil : photos[min(i, photos.count - 1)].id }
    }
}

struct MealDetail: View {
    let meal: FoodMeal
    @ObservedObject var store: FoodStore
    /// Mock / UI-test only: open on this photo (zero-based).
    var startPage = 0
    /// A past day's meal: look only (no fix, no adding photos).
    var readOnly = false
    @State private var page = 0
    @State private var viewer = false
    @State private var showCamera = false
    @State private var showLibrary = false
    @State private var picks: [PhotosPickerItem] = []
    @State private var fix = ""
    @State private var sent = false
    @FocusState private var focused: Bool

    /// Always render the freshest copy: an estimate can land while open.
    private var live: FoodMeal { store.day?.meals.first { $0.id == meal.id } ?? meal }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if !live.photos.isEmpty {
                    pager
                }
                if !readOnly { addPhotos }
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

                if !readOnly { fixField }
            }
            .padding(.horizontal, 20)
            .padding(.top, 22)
            .padding(.bottom, 40)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(AmbientBackground())
        .preferredColorScheme(.dark)
        .onAppear { page = min(max(startPage, 0), max(live.photos.count - 1, 0)) }
        .fullScreenCover(isPresented: $viewer) {
            PhotoViewer(paths: live.photos.map(\.url), page: $page, store: store)
        }
    }

    private var sending: Int { store.sendingPhotos(for: live.id) }
    private var room: Int { max(0, FoodStore.maxPhotos - live.photos.count - sending) }

    /// More photos for this meal (the side dish, the bill, the bowl from
    /// above), camera or library, up to six in all. They go through the
    /// outbox like a capture; Claude re-estimates and the numbers refresh.
    private var addPhotos: some View {
        HStack(spacing: 10) {
            if room > 0 {
                Group {
                    if UIImagePickerController.isSourceTypeAvailable(.camera) {
                        Menu {
                            Button { showCamera = true } label: { Label("Take photo", systemImage: "camera") }
                            Button { showLibrary = true } label: { Label("Choose from library", systemImage: "photo.on.rectangle.angled") }
                        } label: { addLabel }
                    } else {
                        Button { showLibrary = true } label: { addLabel }
                    }
                }
                .glassCapsule()
                .accessibilityIdentifier("detail.addphoto")
            }
            if sending > 0 {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.mini).tint(Theme.textTertiary)
                    Text("\(sending) photo\(sending == 1 ? "" : "s") sending")
                }
                .font(.system(size: 12.5))
                .foregroundStyle(Theme.textSecondary)
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("detail.sending")
            }
            Spacer(minLength: 4)
            Text(room > 0 ? "\(live.photos.count + sending) of \(FoodStore.maxPhotos)" : "\(FoodStore.maxPhotos) of \(FoodStore.maxPhotos), the most a meal holds")
                .font(Theme.rounded(12, .semibold))
                .monospacedDigit()
                .foregroundStyle(Theme.textTertiary)
                .accessibilityIdentifier("detail.photocount")
        }
        .fullScreenCover(isPresented: $showCamera) {
            CameraPicker { image in
                showCamera = false
                if let image = image { store.addPhotos(mealId: live.id, photos: [FoodStore.downscaled(image)]) }
            }
            .ignoresSafeArea()
        }
        .photosPicker(isPresented: $showLibrary, selection: $picks, maxSelectionCount: max(room, 1),
                      selectionBehavior: .ordered, matching: .images)
        .onChange(of: picks) { _, items in
            guard !items.isEmpty else { return }
            Task {
                let images = await PickedPhotos.load(items)
                picks = []
                store.addPhotos(mealId: live.id, photos: Array(images.prefix(room)))
            }
        }
    }

    private var addLabel: some View {
        HStack(spacing: 6) {
            Image(systemName: "plus")
                .font(.system(size: 12, weight: .bold))
            Text(live.photos.isEmpty ? "Add a photo" : "Add photo")
                .font(Theme.rounded(14, .semibold))
        }
        .foregroundStyle(Theme.textPrimary.opacity(0.92))
        .padding(.horizontal, 14)
        .frame(height: 36)
        .contentShape(Capsule())
    }

    /// Every photo of the meal, swiped through; a tap opens it full screen.
    /// One photo looks exactly as before (no dots, no counter).
    private var pager: some View {
        let n = live.photos.count
        return VStack(spacing: 10) {
            TabView(selection: $page) {
                ForEach(Array(live.photos.enumerated()), id: \.offset) { i, photo in
                    FullPhoto(path: photo.url, store: store)
                        .contentShape(Rectangle())
                        .onTapGesture { viewer = true }
                        .tag(i)
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel(n > 1 ? "Photo \(i + 1) of \(n)" : "Photo")
                        .accessibilityAddTraits(.isButton)
                        .accessibilityIdentifier("detail.photo.\(i)")
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
            .frame(maxWidth: .infinity)
            .frame(height: 300)
            .overlay(alignment: .topTrailing) {
                if n > 1 {
                    Text("\(page + 1) / \(n)")
                        .font(Theme.rounded(11.5, .semibold))
                        .monospacedDigit()
                        .foregroundStyle(.white.opacity(0.92))
                        .padding(.horizontal, 8)
                        .frame(height: 22)
                        .background(Capsule().fill(Color.black.opacity(0.5)))
                        .padding(10)
                        .allowsHitTesting(false)
                        .accessibilityIdentifier("detail.page")
                }
            }
            if n > 1 { PageDots(count: n, page: page) }
        }
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

/// The pager's position: small dots, the current one bright.
struct PageDots: View {
    let count: Int
    let page: Int

    var body: some View {
        HStack(spacing: 6) {
            ForEach(0..<count, id: \.self) { i in
                Circle()
                    .fill(Color.white.opacity(i == page ? 0.9 : 0.25))
                    .frame(width: 6, height: 6)
            }
        }
        .animation(.easeOut(duration: 0.18), value: page)
        .accessibilityHidden(true)
    }
}

/// A meal's photos full screen, whole (fit, never cropped), swiped through;
/// Done or a tap closes it.
struct PhotoViewer: View {
    let paths: [String?]
    @Binding var page: Int
    @ObservedObject var store: FoodStore
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ZStack(alignment: .top) {
            Color.black.ignoresSafeArea()
            TabView(selection: $page) {
                ForEach(Array(paths.enumerated()), id: \.offset) { i, path in
                    FitPhoto(path: path, store: store)
                        .contentShape(Rectangle())
                        .onTapGesture { dismiss() }
                        .tag(i)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: paths.count > 1 ? .always : .never))
            .ignoresSafeArea()
            HStack {
                if paths.count > 1 {
                    Text("\(page + 1) / \(paths.count)")
                        .font(Theme.rounded(13, .semibold))
                        .monospacedDigit()
                        .foregroundStyle(.white.opacity(0.85))
                }
                Spacer()
                Button("Done") { dismiss() }
                    .font(Theme.rounded(15, .semibold))
                    .foregroundStyle(.white)
            }
            .padding(.horizontal, 20)
            .padding(.top, 8)
        }
        .preferredColorScheme(.dark)
    }
}

/// One full photo, scaled to fit (the viewer shows the whole frame).
struct FitPhoto: View {
    let path: String?
    @ObservedObject var store: FoodStore
    @State private var image: UIImage?

    var body: some View {
        ZStack {
            if let image = image {
                Image(uiImage: image).resizable().scaledToFit()
            } else {
                ProgressView().tint(.white.opacity(0.6))
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onAppear {
            guard let path = path else { return }
            store.image(for: path) { image = $0 }
        }
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

// ── history ───────────────────────────────────────────────────────

/// Past days, newest first: one row per day with a meal (its first cover,
/// kcal and protein against the day's targets, how many meals and photos, a
/// quiet mark when he marked it fully logged). Tap a day for its meals,
/// read-only, in the same rows and detail as today.
struct HistorySheet: View {
    @ObservedObject var store: FoodStore
    /// Mock / UI-test only: open the day this many rows down.
    var openDay: Int? = nil
    @State private var path: [String] = []

    var body: some View {
        NavigationStack(path: $path) {
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    if let days = pastDays {
                        if store.historyError != nil {
                            // A refresh failed: keep the last list, say so quietly.
                            Text("Couldn't refresh")
                                .font(.system(size: 12))
                                .foregroundStyle(Theme.textTertiary)
                                .accessibilityIdentifier("history.stale")
                        }
                        if days.isEmpty {
                            Text("No past days yet. Every day with a meal lands here.")
                                .font(.system(size: 13.5))
                                .foregroundStyle(Theme.textSecondary)
                                .padding(.top, 8)
                        }
                        ForEach(days) { d in
                            NavigationLink(value: d.date) { HistoryRow(day: d, store: store) }
                                .buttonStyle(.plain)
                                .accessibilityIdentifier("history.day.\(d.date)")
                        }
                    } else if let err = store.historyError {
                        Text(err)
                            .font(.system(size: 13))
                            .foregroundStyle(Theme.textTertiary)
                    } else {
                        ProgressView().tint(Theme.textTertiary).frame(maxWidth: .infinity).padding(.top, 30)
                    }
                }
                .padding(.horizontal, 20)
                .padding(.top, 8)
                .padding(.bottom, 40)
            }
            .scrollIndicators(.hidden)
            .background(AmbientBackground())
            .navigationTitle("History")
            .navigationBarTitleDisplayMode(.large)
            .navigationDestination(for: String.self) { date in
                PastDayView(date: date, store: store)
            }
        }
        .preferredColorScheme(.dark)
        .onAppear {
            store.loadHistory()
            if let i = openDay, let days = pastDays, days.indices.contains(i) { path = [days[i].date] }
        }
    }

    /// Past days only, against TODAY as of this render (a list loaded before
    /// the 04:00 rollover, or from an older daemon that still sent today,
    /// never opens today read-only).
    private var pastDays: [FoodHistoryDay]? {
        let today = store.today
        return store.history?.filter { $0.date != today }
    }
}

struct HistoryRow: View {
    let day: FoodHistoryDay
    @ObservedObject var store: FoodStore

    var body: some View {
        HStack(spacing: 13) {
            Thumb(path: day.cover_thumb_url, store: store, textOnly: day.cover_thumb_url == nil)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 5) {
                    Text(FoodFormat.dayLabel(day.date))
                        .fixedSize()
                        .font(Theme.rounded(15.5, .semibold))
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(1)
                    if day.complete {
                        Image(systemName: "checkmark.circle.fill")
                            .font(.system(size: 11.5))
                            .foregroundStyle(Theme.textTertiary)
                            .accessibilityLabel("fully logged")
                    }
                }
                Text(countLine)
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.textTertiary)
                    .lineLimit(1)
            }
            Spacer(minLength: 6)
            VStack(alignment: .trailing, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: 3) {
                    Text(FoodFormat.int(day.kcal))
                        .font(Theme.rounded(18, .semibold))
                        .monospacedDigit()
                        .foregroundStyle(Theme.textPrimary)
                    Text(day.kcal_target.map { "/ \(FoodFormat.int($0))" } ?? "kcal")
                        .font(Theme.rounded(11))
                        .monospacedDigit()
                        .foregroundStyle(Theme.textTertiary)
                }
                Text(proteinLine)
                    .font(.system(size: 11.5))
                    .monospacedDigit()
                    .foregroundStyle(Theme.textSecondary)
            }
            .fixedSize()
        }
        .padding(12)
        .glassCard(cornerRadius: 20)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    private var countLine: String {
        var parts = ["\(day.meals) meal\(day.meals == 1 ? "" : "s")"]
        if day.photos > 0 { parts.append("\(day.photos) photo\(day.photos == 1 ? "" : "s")") }
        return parts.joined(separator: " · ")
    }

    private var proteinLine: String {
        guard let p = day.protein_g else { return "protein ?" }
        if let t = day.protein_target_g, t > 0 { return "\(FoodFormat.int(p)) / \(FoodFormat.int(t)) g protein" }
        return "\(FoodFormat.int(p)) g protein"
    }
}

/// One past day, read-only: its totals against that day's targets, then its
/// meals in the same rows as today; a meal opens the same detail (the photo
/// pager included) without the fix field or adding photos.
struct PastDayView: View {
    let date: String
    @ObservedObject var store: FoodStore
    @State private var day: FoodDay?
    @State private var error: String?
    @State private var detail: FoodMeal?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                if let d = day {
                    summary(d)
                    Text("MEALS · \(d.meals.count)")
                        .font(Theme.sectionLabel())
                        .kerning(1.4)
                        .foregroundStyle(Theme.textTertiary)
                        .padding(.horizontal, 2)
                        .padding(.top, 6)
                    ForEach(d.meals.sorted { $0.eaten_at > $1.eaten_at }) { meal in
                        Button { detail = meal } label: { MealRow(meal: meal, store: store) }
                            .buttonStyle(.plain)
                    }
                } else if let e = error {
                    Text(e).font(.system(size: 13)).foregroundStyle(Theme.textTertiary)
                } else {
                    ProgressView().tint(Theme.textTertiary).frame(maxWidth: .infinity).padding(.top, 30)
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 8)
            .padding(.bottom, 40)
        }
        .scrollIndicators(.hidden)
        .background(AmbientBackground())
        .navigationTitle(FoodFormat.dayLabel(date))
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            guard day == nil else { return }
            store.loadDay(date) { d, e in
                day = d
                error = e
            }
        }
        .sheet(item: $detail) { meal in
            MealDetail(meal: meal, store: store, readOnly: true)
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
        }
    }

    /// The day's totals: kcal and protein against that day's own targets
    /// (none before the baseline), and whether it was marked fully logged.
    private func summary(_ d: FoodDay) -> some View {
        HStack(alignment: .top, spacing: 0) {
            figure("KCAL", FoodFormat.int(d.totals.kcal), d.targets.kcal.map { "/ \(FoodFormat.int($0))" },
                   FoodFormat.range(d.totals.kcal_lo, d.totals.kcal_hi))
            Spacer(minLength: 8)
            figure("PROTEIN", FoodFormat.int(d.totals.protein_g),
                   d.targets.protein_g > 0 ? "/ \(FoodFormat.int(d.targets.protein_g)) g" : "g", nil)
            Spacer(minLength: 8)
            figure("STATUS", d.complete == true ? "Complete" : "Partial", nil, d.complete == true ? "marked fully logged" : "not marked complete", small: true)
        }
        .padding(18)
        .glassCard(strong: true)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("history.summary")
    }

    private func figure(_ label: String, _ value: String, _ unit: String?, _ sub: String?, small: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(Theme.sectionLabel(10))
                .kerning(1.3)
                .foregroundStyle(Theme.textTertiary)
            HStack(alignment: .firstTextBaseline, spacing: 3) {
                Text(value)
                    .font(Theme.rounded(small ? 16 : 24, .semibold))
                    .monospacedDigit()
                    .foregroundStyle(Theme.textPrimary)
                if let u = unit {
                    Text(u)
                        .font(Theme.rounded(12))
                        .monospacedDigit()
                        .foregroundStyle(Theme.textTertiary)
                }
            }
            .lineLimit(1)
            .minimumScaleFactor(0.8)
            if let sub = sub {
                Text(sub)
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.textTertiary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.85)
            }
        }
    }
}

extension FoodFormat {
    // Built once (formatters are expensive; history renders one per row).
    /// YYYY-MM-DD food days, both ways.
    static let dayParser: DateFormatter = {
        let p = DateFormatter()
        p.dateFormat = "yyyy-MM-dd"
        p.locale = Locale(identifier: "en_US_POSIX")
        return p
    }()

    private static let dayTitleFormat: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "EEE, MMM d"
        return f
    }()

    /// "Mon, Nov 16" for a YYYY-MM-DD food day (the raw string otherwise).
    static func dayTitle(_ day: String) -> String {
        guard let d = dayParser.date(from: day) else { return day }
        return dayTitleFormat.string(from: d)
    }

    /// "Yesterday" / "Mon, Nov 16" for a YYYY-MM-DD food day.
    static func dayLabel(_ day: String) -> String {
        if day == FoodStore.localFoodDay(Date().addingTimeInterval(-86400)) { return "Yesterday" }
        return dayTitle(day)
    }
}

extension FoodFormat {
    /// "52 g protein left" / "target met" / "+12 g over", or nil when there
    /// is no usable target. Worked on the rounded numbers the card shows, so
    /// "88 / 140 g" always pairs with exactly "52 g protein left".
    static func proteinLeft(logged: Double, target: Double) -> (text: String, spoken: String)? {
        guard target.isFinite, target.rounded() > 0 else { return nil }
        let have = logged.isFinite ? max(logged.rounded(), 0) : 0
        let left = target.rounded() - have
        if left > 0 { return ("\(int(left)) g protein left", "\(int(left)) grams of protein left") }
        if left == 0 { return ("target met", "Protein target met") }
        return ("+\(int(-left)) g over", "Protein target met, \(int(-left)) grams over")
    }
}

// ── simulator demo (HR_DEMO=1 HR_DEMO_TAB=food) ───────────────────

enum DemoFood {
    /// HR_DEMO_FOOD_PHOTOS=<dir on the Mac>: the simulator reads host files,
    /// so real plates can stand in for daemon thumbnails in a mock.
    static func image(_ path: String) -> UIImage? {
        guard let dir = ProcessInfo.processInfo.environment["HR_DEMO_FOOD_PHOTOS"] else { return plate(seed(path)) }
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

    /// The compose sheet's demo photos: the host directory's (one photo, as
    /// the layout tests use it), else HR_DEMO_FOOD_COMPOSE_N synthetic plates.
    static func composeImages() -> [UIImage]? {
        if ProcessInfo.processInfo.environment["HR_DEMO_FOOD_PHOTOS"] != nil { return image("compose").map { [$0] } }
        let n = ProcessInfo.processInfo.environment["HR_DEMO_FOOD_COMPOSE_N"].flatMap(Int.init) ?? 1
        return (0..<max(1, min(n, FoodStore.maxPhotos))).map { plate(20 + $0) }
    }

    /// A stable seed from a daemon photo path ("meal=2&n=1" -> 21).
    private static func seed(_ path: String) -> Int {
        func num(_ key: String) -> Int {
            guard let r = path.range(of: "\(key)=(\\d+)", options: .regularExpression) else { return 0 }
            return Int(path[r].dropFirst(key.count + 1)) ?? 0
        }
        return num("meal") * 10 + num("n")
    }

    /// A SYNTHETIC plate (nothing from any real library): a table-top
    /// gradient, a plate, a few soft food shapes, all from the seed. Reads as
    /// "a photo of food" at thumbnail size and is obviously a placeholder
    /// full size.
    static func plate(_ seed: Int) -> UIImage {
        var rng = UInt64(truncatingIfNeeded: seed &* 2654435761 &+ 97)
        func rand() -> CGFloat {
            rng = rng &* 6364136223846793005 &+ 1442695040888963407
            return CGFloat((rng >> 33) % 10000) / 10000
        }
        let size = CGSize(width: 1200, height: 900)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let tables: [(UIColor, UIColor)] = [
            (UIColor(red: 0.42, green: 0.30, blue: 0.22, alpha: 1), UIColor(red: 0.25, green: 0.17, blue: 0.12, alpha: 1)),
            (UIColor(red: 0.30, green: 0.33, blue: 0.36, alpha: 1), UIColor(red: 0.16, green: 0.18, blue: 0.20, alpha: 1)),
            (UIColor(red: 0.55, green: 0.47, blue: 0.38, alpha: 1), UIColor(red: 0.36, green: 0.29, blue: 0.22, alpha: 1)),
        ]
        let foods: [UIColor] = [
            UIColor(red: 0.96, green: 0.94, blue: 0.88, alpha: 1), // rice
            UIColor(red: 0.72, green: 0.42, blue: 0.18, alpha: 1), // fried
            UIColor(red: 0.36, green: 0.58, blue: 0.26, alpha: 1), // greens
            UIColor(red: 0.84, green: 0.30, blue: 0.18, alpha: 1), // sambal
            UIColor(red: 0.93, green: 0.74, blue: 0.32, alpha: 1), // egg, curry
            UIColor(red: 0.55, green: 0.32, blue: 0.20, alpha: 1), // soy, meat
        ]
        let t = tables[abs(seed) % tables.count]
        return UIGraphicsImageRenderer(size: size, format: format).image { ctx in
            let cg = ctx.cgContext
            let grad = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: [t.0.cgColor, t.1.cgColor] as CFArray, locations: [0, 1])!
            cg.drawLinearGradient(grad, start: CGPoint(x: 0, y: 0), end: CGPoint(x: size.width * 0.4, y: size.height), options: [])
            let cx = size.width * (0.42 + rand() * 0.16), cy = size.height * (0.46 + rand() * 0.08)
            let r = size.height * (0.34 + rand() * 0.06)
            cg.setShadow(offset: CGSize(width: 0, height: 18), blur: 40, color: UIColor.black.withAlphaComponent(0.45).cgColor)
            UIColor(white: 0.93, alpha: 1).setFill()
            cg.fillEllipse(in: CGRect(x: cx - r, y: cy - r * 0.92, width: r * 2, height: r * 1.84))
            cg.setShadow(offset: .zero, blur: 0, color: nil)
            UIColor(white: 0.86, alpha: 1).setFill()
            cg.fillEllipse(in: CGRect(x: cx - r * 0.8, y: cy - r * 0.74, width: r * 1.6, height: r * 1.48))
            for _ in 0..<(3 + Int(rand() * 3)) {
                let c = foods[Int(rand() * CGFloat(foods.count)) % foods.count]
                let w = r * (0.35 + rand() * 0.4), h = w * (0.6 + rand() * 0.3)
                let x = cx - r * 0.55 + rand() * r * 1.1 - w / 2, y = cy - r * 0.5 + rand() * r - h / 2
                c.setFill()
                cg.fillEllipse(in: CGRect(x: x, y: y, width: w, height: h))
                UIColor.white.withAlphaComponent(0.18).setFill()
                cg.fillEllipse(in: CGRect(x: x + w * 0.2, y: y + h * 0.12, width: w * 0.35, height: h * 0.25))
            }
        }
    }

    /// Synthetic history (made-up numbers), ONE source for both the list
    /// and the opened day, so a row's kcal, protein, meal and photo counts
    /// are exactly its day's sums: the last 30 days with gaps (only days with
    /// a meal), targets once the baseline was ready (16 days ago), most days
    /// marked complete.
    private static let pastBacks = (1...30).filter { ![4, 9, 10, 17, 23].contains($0) }

    private static func pastDate(_ back: Int) -> String {
        FoodStore.localFoodDay(Date().addingTimeInterval(-Double(back) * 86400))
    }

    private static func pastMeals(_ back: Int) -> [FoodMeal] {
        let base = FoodFormat.dayParser.date(from: pastDate(back)) ?? Date()
        let iso = ISO8601DateFormatter()
        let at = { (hh: Int, mm: Int) -> String in
            iso.string(from: Calendar.current.date(bySettingHour: hh, minute: mm, second: 0, of: base) ?? base)
        }
        // Portions vary a little day to day.
        let f = 0.85 + Double((back * 13) % 30) / 100
        func item(_ n: String, _ g: Double?, _ k: Double, _ pr: Double) -> FoodItem {
            FoodItem(name: n, grams: g, kcal: (k * f).rounded(), kcal_lo: (k * f * 0.85).rounded(), kcal_hi: (k * f * 1.18).rounded(),
                     protein_g: (pr * f).rounded(), preset_slug: nil)
        }
        let table: [(String, Int, Int, [FoodItem], Int)] = [
            ("Kopi susu", 8, 10, [item("Kopi susu, less sugar", 250, 160, 6)], back % 7 == 5 ? 0 : 1),
            ("Nasi padang: rendang, daun singkong, telur", 12, 40,
             [item("Rice, 1 centong", 150, 195, 4), item("Rendang", 90, 290, 24), item("Daun singkong", 80, 60, 3),
              item("Telur balado", 60, 120, 8), item("Kuah gulai", 60, 215, 5)], back % 7 == 5 ? 0 : 3),
            ("Pecel lele + nasi", 19, 30, [item("Fried catfish", 160, 380, 30), item("Rice", 150, 195, 4), item("Lalapan + sambal", 60, 185, 4)],
             back % 7 == 5 ? 0 : 2),
            ("Whey shake, 1 scoop", 21, 0, [item("Whey shake, 1 scoop in water", 300, 140, 26)], 0),
        ]
        let count = 3 + back % 2
        return table.prefix(count).enumerated().map { i, m in
            let id = 1000 + back * 10 + i
            let k = m.3.reduce(0) { $0 + $1.kcal }, lo = m.3.reduce(0) { $0 + $1.kcal_lo }, hi = m.3.reduce(0) { $0 + $1.kcal_hi }
            return FoodMeal(id: id, source: m.4 == 0 ? "chat" : "app", status: "estimated", eaten_at: at(m.1, m.2), label: m.0,
                            note: nil, confidence: "medium", revision: 1, kcal: k, kcal_lo: lo, kcal_hi: hi,
                            protein_g: m.3.reduce(0) { $0 + $1.protein_g }, fix_text: nil, items: m.3,
                            photos: (0..<m.4).map { FoodPhoto(n: $0, url: "/meal-photo?meal=\(id)&n=\($0)", thumb_url: "/meal-photo?meal=\(id)&n=\($0)&thumb=1") })
        }
    }

    /// HR_DEMO_FOOD_HISTORY_TODAY=1: also list TODAY first, as a daemon from
    /// before the past-days-only change did (the phone must filter it out).
    static func history() -> [FoodHistoryDay] {
        let withToday = ProcessInfo.processInfo.environment["HR_DEMO_FOOD_HISTORY_TODAY"] != nil
        return ((withToday ? [0] : []) + pastBacks).map { back in
            let meals = pastMeals(back)
            let cover = meals.sorted { $0.eaten_at < $1.eaten_at }.first { !$0.photos.isEmpty }?.photos.first?.thumb_url
            return FoodHistoryDay(
                date: pastDate(back), kcal: meals.reduce(0) { $0 + ($1.kcal ?? 0) }, kcal_target: back <= 16 ? 2300 : nil,
                protein_g: meals.reduce(0) { $0 + ($1.protein_g ?? 0) }, protein_target_g: 140,
                meals: meals.count, photos: meals.reduce(0) { $0 + $1.photos.count },
                cover_thumb_url: cover, complete: back % 6 != 3)
        }
    }

    /// One synthetic past day for the history detail (the same meals).
    static func pastDay(_ date: String) -> FoodDay? {
        guard let back = pastBacks.first(where: { pastDate($0) == date }) else { return nil }
        let meals = pastMeals(back)
        let kcal = meals.reduce(0) { $0 + ($1.kcal ?? 0) }
        return FoodDay(
            date: date, today: FoodStore.localFoodDay(), meals: meals,
            totals: FoodTotals(kcal: kcal, kcal_lo: meals.reduce(0) { $0 + ($1.kcal_lo ?? 0) }, kcal_hi: meals.reduce(0) { $0 + ($1.kcal_hi ?? 0) },
                               protein_g: meals.reduce(0) { $0 + ($1.protein_g ?? 0) }, estimated: meals.count, pending: 0),
            complete: back % 6 != 3, targets: FoodTargets(protein_g: 140, kcal: back <= 16 ? 2300 : nil),
            baseline: FoodBaseline(ready: back <= 16, complete_days: 14, days_needed: 14, weigh_ins: 8, weigh_ins_needed: 8),
            weight: nil)
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
            photos: (0..<2).map { FoodPhoto(n: $0, url: "/meal-photo?meal=1&n=\($0)", thumb_url: "/meal-photo?meal=1&n=\($0)&thumb=1") })
        let lunch = FoodMeal(
            id: 2, source: "app", status: "estimated", eaten_at: at(12, 50), label: "Nasi + ayam goreng + sayur", note: nil,
            confidence: "medium", revision: 2, kcal: 720, kcal_lo: 610, kcal_hi: 840, protein_g: 41, fix_text: "half the rice",
            items: [
                item("Rice, half centong", 75, 98, 85, 110, 2),
                item("Crispy fried chicken thigh", 140, 410, 350, 470, 31),
                item("Sayur asem", 200, 70, 50, 90, 2),
                item("Sambal goreng + kecap", 40, 142, 125, 170, 6),
            ],
            // Three angles of one plate (the multi-photo meal).
            photos: (0..<3).map { FoodPhoto(n: $0, url: "/meal-photo?meal=2&n=\($0)", thumb_url: "/meal-photo?meal=2&n=\($0)&thumb=1") })
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
        if mode.hasPrefix("protein-") {
            return proteinDay(String(mode.dropFirst(8)), at: at, morning: [latte, lunch, americano], item: item)
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

    /// The protein-left states, today, baseline still collecting (so no kcal
    /// target, exactly as the baseline phase ships). Synthetic numbers kept
    /// consistent with the meal list: protein-met = 50 + 38 + 52 = 140 of 140,
    /// protein-over adds a 12 g yogurt (152), protein-notarget sends a zero
    /// target (the line must not render).
    private static func proteinDay(
        _ mode: String, at: (Int, Int) -> String, morning: [FoodMeal],
        item: (String, Double?, Double, Double, Double, Double, String?) -> FoodItem
    ) -> FoodDay? {
        let dinner = FoodMeal(
            id: 5, source: "app", status: "estimated", eaten_at: at(19, 25), label: "Soto ayam + nasi", note: "soto, 1 centong",
            confidence: "medium", revision: 1, kcal: 690, kcal_lo: 580, kcal_hi: 820, protein_g: 38, fix_text: nil,
            items: [item("Soto ayam", 450, 340, 290, 400, 30, nil), item("Rice, 1 centong", 150, 195, 175, 215, 4, nil),
                    item("Emping + sambal", 30, 155, 115, 205, 4, nil)],
            photos: [FoodPhoto(n: 0, url: "/meal-photo?meal=4&n=0", thumb_url: "/meal-photo?meal=4&n=0&thumb=1")])
        let shake = FoodMeal(
            id: 7, source: "chat", status: "estimated", eaten_at: at(21, 0), label: "Whey shake, 2 scoops", note: "whey 2 scoops",
            confidence: "high", revision: 1, kcal: 260, kcal_lo: 230, kcal_hi: 290, protein_g: 52, fix_text: nil,
            items: [item("Whey shake, 2 scoops in milk", 400, 260, 230, 290, 52, nil)], photos: [])
        let yogurt = FoodMeal(
            id: 8, source: "chat", status: "estimated", eaten_at: at(22, 15), label: "Greek yogurt", note: "greek yogurt",
            confidence: "medium", revision: 1, kcal: 120, kcal_lo: 100, kcal_hi: 140, protein_g: 12, fix_text: nil,
            items: [item("Greek yogurt, plain", 150, 120, 100, 140, 12, nil)], photos: [])
        let collecting = FoodBaseline(ready: false, complete_days: 6, days_needed: 14, weigh_ins: 4, weigh_ins_needed: 8, status: "collecting")
        let today = FoodStore.localFoodDay()
        let meals: [FoodMeal]
        let totals: FoodTotals
        switch mode {
        case "over":
            meals = morning + [dinner, shake, yogurt]
            totals = FoodTotals(kcal: 1990, kcal_lo: 1680, kcal_hi: 2340, protein_g: 152, estimated: 6, pending: 0)
        default: // met, notarget
            meals = morning + [dinner, shake]
            totals = FoodTotals(kcal: 1870, kcal_lo: 1580, kcal_hi: 2200, protein_g: 140, estimated: 5, pending: 0)
        }
        return FoodDay(
            date: today, today: today, meals: meals, totals: totals, complete: true,
            targets: FoodTargets(protein_g: mode == "notarget" ? 0 : 140, kcal: nil),
            baseline: collecting, weight: FoodWeight(kg: 75.0, at: at(7, 5), fat_pct: 20.0))
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
