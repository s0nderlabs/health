// The Plan screen: today's /gym session, built for the between-sets glance.
// ONE session component for every day shape: ordered lift rows, each
// expandable into its ladder, where ramp rungs are dim, working sets bright,
// AMRAP marked with its cap, back-offs in their own tone, PR attempts coral,
// and conditionals outlined. An 8-lift build day, a Pana Friday, a two-test
// exception day, and a rest day all fall out of the same rules.

import SwiftUI

struct PlanView: View {
    @ObservedObject var store: PlanStore
    @ObservedObject private var progress = SessionProgress.shared
    /// Fired by the header's Start capsule: same cascade as the intent sheet.
    var onStartSession: () -> Void = {}
    /// Fired by the header's End capsule while armed: mirrors the lock
    /// screen's End button, so a session never traps you on the lock screen.
    var onEndSession: () -> Void = {}
    @State private var expanded: Set<Int>
    @State private var seededExpansion = false
    @StateObject private var routes = RouteStore()
    /// An explicit toggle tap, keyed to the plan it was made on so a new
    /// day's plan goes back to the time-of-day default.
    @State private var chosenFace: (key: String, face: Face)?

    enum Face: Hashable { case ride, lift }
    enum DayShape { case both, rideOnly, liftOnly, neither }

    private func dayShape(_ plan: Plan) -> DayShape {
        if plan.rest == true { return .neither }
        let ride = plan.ride != nil
        let lifts = !(plan.lifts ?? []).isEmpty
        switch (ride, lifts) {
        case (true, true): return .both
        case (true, false): return .rideOnly
        case (false, true): return .liftOnly
        // rest:false with nothing in it: a plan with no session is a rest
        // day in all but name, never a blank page.
        case (false, false): return .neither
        }
    }

    /// Which face shows. Single-sport days have no choice. Double days: an
    /// explicit tap wins for that plan; otherwise the ride until an hour
    /// after it should have ended (05:00 + 2 h -> ride until 08:00), then
    /// the lift. A plan for a later date shows the ride, the first thing
    /// coming up.
    private func activeFace(_ plan: Plan, shape: DayShape) -> Face {
        switch shape {
        case .rideOnly: return .ride
        case .liftOnly, .neither: return .lift
        case .both: break
        }
        // A live gym session owns the tab: its End capsule, checkmarks and
        // rest rungs must stay reachable whatever the clock says.
        if armed { return .lift }
        if let chosen = chosenFace, chosen.key == planKey(plan) { return chosen.face }
        if Demo.active, let raw = ProcessInfo.processInfo.environment["HR_DEMO_FACE"] {
            return raw == "lift" ? .lift : .ride
        }
        guard planIsToday, let ride = plan.ride, let slot = ride.slot else { return .ride }
        let parts = slot.split(separator: ":").compactMap { Int($0) }
        guard parts.count == 2 else { return .ride }
        let rideOver = parts[0] * 60 + parts[1] + (ride.duration_min ?? 120) + 60
        let now = Calendar.current.dateComponents([.hour, .minute], from: Date())
        let minutes = (now.hour ?? 0) * 60 + (now.minute ?? 0)
        return minutes >= rideOver ? .lift : .ride
    }

    private func planKey(_ plan: Plan) -> String {
        [plan.date, plan.generated_at].compactMap { $0 }.joined(separator: "|")
    }

    /// "The coach named a route but the map is not here" must look different
    /// from "no route was planned": one quiet line says which.
    private func routeNote(_ ride: Plan.Ride) -> String? {
        guard let file = ride.route?.file, !file.isEmpty else { return nil }
        if routes.route(for: file) != nil { return nil }
        switch routes.status(for: file) {
        case .loading: return "route loading"
        case .failed: return "route unavailable, pull to refresh"
        case .idle: return nil
        }
    }

    /// The toggle: one glass capsule, two halves, the live half raised a
    /// step. Same grammar as the tab pill so it reads as navigation, not as
    /// a control that does something to the session.
    private func segmentToggle(_ plan: Plan) -> some View {
        let face = activeFace(plan, shape: .both)
        return HStack(spacing: 2) {
            segmentHalf("Ride", icon: "bicycle", on: face == .ride) {
                chosenFace = (planKey(plan), .ride)
            }
            segmentHalf("Lift", icon: "dumbbell.fill", on: face == .lift) {
                chosenFace = (planKey(plan), .lift)
            }
        }
        .padding(3)
        .glassCapsule()
        .animation(.easeOut(duration: 0.22), value: face)
    }

    private func segmentHalf(_ title: String, icon: String, on: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 7) {
                Image(systemName: icon)
                    .font(.system(size: 12, weight: .semibold))
                Text(title)
                    .font(Theme.rounded(14, .semibold))
            }
            .foregroundStyle(on ? Theme.textPrimary : Theme.textTertiary)
            .frame(maxWidth: .infinity)
            .frame(height: 38)
            .background {
                if on {
                    Capsule().fill(Color.white.opacity(0.10))
                }
            }
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
    }

    private var armed: Bool { progress.sessionActive }

    init(store: PlanStore, onStartSession: @escaping () -> Void = {}, onEndSession: @escaping () -> Void = {}) {
        self.store = store
        self.onStartSession = onStartSession
        self.onEndSession = onEndSession
        // Screenshot hook: HR_DEMO_EXPAND=<index> opens one lift for audits.
        var initial: Set<Int> = []
        if Demo.active,
           let raw = ProcessInfo.processInfo.environment["HR_DEMO_EXPAND"],
           let index = Int(raw) {
            initial = [index]
        }
        _expanded = State(initialValue: initial)
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if let plan = store.plan {
                        header(plan)
                        // Double days (Mon/Tue/Thu) split into two faces
                        // behind one toggle; single-sport days show their
                        // one face with no toggle; rest days show rest.
                        let shape = dayShape(plan)
                        if shape == .both {
                            segmentToggle(plan)
                        }
                        if let note = plan.recovery_note, !note.isEmpty {
                            guardrailLine(note, recovery: plan.recovery)
                        }
                        if shape == .neither {
                            restBlock(plan)
                            // A rest day still carries the day's habits
                            // (creatine, chalk for tomorrow): never drop them.
                            if let reminders = plan.reminders, !reminders.isEmpty {
                                quietSection("REMINDERS", items: reminders)
                            }
                        } else {
                            // ONE card per face. The session (or the ride,
                            // with its route and clock inside it) is the only
                            // raised surface; warmup, notes, reminders and the
                            // coach's margin note sit on the base layer.
                            let face = activeFace(plan, shape: shape)
                            Group {
                                if face == .ride, let ride = plan.ride {
                                    // On a ride-only day the warmup is the
                                    // pre-ride prep (race-day wake/fuel steps
                                    // live there), so it renders above the
                                    // ride. On a double day it is the lift's.
                                    if shape == .rideOnly, let warmup = plan.warmup, !warmup.isEmpty {
                                        quietSection("BEFORE THE RIDE", items: warmup)
                                            .padding(.top, -6)
                                    }
                                    RideCard(
                                        ride: ride,
                                        liftsLater: shape == .both,
                                        route: routes.route(for: ride.route?.file),
                                        routeNote: routeNote(ride))
                                        .id("ride")
                                } else if let lifts = plan.lifts, !lifts.isEmpty {
                                    sessionCard(lifts, warmup: plan.warmup ?? [])
                                }
                                // Notes and reminders belong to the lift half
                                // when there is one (chalk, creatine, bar
                                // speed); on a ride-only day they are the
                                // ride's.
                                if face == .lift || shape == .rideOnly {
                                    if let notes = plan.session_notes, !notes.isEmpty {
                                        quietSection("NOTES", items: notes)
                                    }
                                    if let reminders = plan.reminders, !reminders.isEmpty {
                                        quietSection("REMINDERS", items: reminders)
                                    }
                                }
                            }
                            .id(face)
                            .transition(.opacity)
                        }
                        freshness(plan)
                    } else {
                        emptyState
                    }
                }
                .padding(.horizontal, 20)
                .padding(.top, 12)
                .padding(.bottom, 110)
            }
            .scrollIndicators(.hidden)
            .background(AmbientBackground())
            .refreshable {
                store.refresh()
                routes.load(file: store.plan?.ride?.route?.file, name: store.plan?.ride?.route?.name, retry: true)
            }
            .onAppear {
                seedExpansion()
                attachProgress()
                routes.load(file: store.plan?.ride?.route?.file, name: store.plan?.ride?.route?.name)
                // Screenshot hook: HR_DEMO_SCROLL=<index> parks a lift at the
                // top of the frame so audits can capture a whole ladder.
                // Also accepts a card name (ride, route, clock) with an
                // optional ":bottom" suffix, for cards taller than a frame.
                if Demo.active,
                   let raw = ProcessInfo.processInfo.environment["HR_DEMO_SCROLL"],
                   let first = raw.split(separator: ":").first {
                    let parts = raw.split(separator: ":").map(String.init)
                    let target = Int(first).map { "lift-\($0)" } ?? String(first)
                    let anchor: UnitPoint = parts.count > 1 && parts[1] == "bottom" ? .bottom : .top
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.9) {
                        proxy.scrollTo(target, anchor: anchor)
                    }
                }
            }
            .onChange(of: store.plan?.generated_at) { _, _ in
                seededExpansion = false
                seedExpansion()
                attachProgress()
                routes.load(file: store.plan?.ride?.route?.file, name: store.plan?.ride?.route?.name, retry: true)
            }
        }
    }

    private func attachProgress() {
        // Keyed by date AND generation: completion tokens are positional, so
        // a same-day regenerated plan (new shape, new indices) must start
        // from a clean sheet rather than remap checkmarks onto other lifts.
        let parts = [store.plan?.date, store.plan?.generated_at].compactMap { $0 }
        guard !parts.isEmpty else { return }
        progress.attach(planKey: parts.joined(separator: "|"))
    }

    /// Focused days (one or two lifts) arrive open; long days arrive folded
    /// so the order reads first and a tap opens the lift you're on.
    private func seedExpansion() {
        guard !seededExpansion, let lifts = store.plan?.lifts else { return }
        seededExpansion = true
        // Assign, never accumulate: a short day's auto-expansion must not
        // leak into the next long day when the plan changes underneath.
        expanded = lifts.count <= 2 ? Set(lifts.indices) : []
        if Demo.active,
           let raw = ProcessInfo.processInfo.environment["HR_DEMO_EXPAND"],
           let index = Int(raw) {
            expanded.insert(index)
        }
    }

    // ── Header ───────────────────────────────────────────────────────

    private func header(_ plan: Plan) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(plan.title ?? "Today")
                .font(.system(size: 30, weight: .bold, design: .rounded))
                .foregroundStyle(Theme.textPrimary)
            HStack(spacing: 0) {
                if let date = plan.date {
                    Text(prettyDate(date))
                }
                if let cycle = plan.cycle, let week = plan.week {
                    Text(" · Cycle \(cycle) · Week \(week)")
                }
            }
            .font(Theme.rounded(14))
            .foregroundStyle(Theme.textSecondary)
        }
        .padding(.top, 4)
    }

    private func prettyDate(_ raw: String) -> String {
        let parser = DateFormatter()
        parser.dateFormat = "yyyy-MM-dd"
        parser.locale = Locale(identifier: "en_US_POSIX")
        guard let date = parser.date(from: raw) else { return raw }
        let out = DateFormatter()
        out.dateFormat = "EEE, MMM d"
        return out.string(from: date)
    }

    // ── Guardrail: the coach's margin note ───────────────────────────

    /// The coach's margin note, at the base layer. The recovery score is
    /// system data and the sentence is coaching, so they get different
    /// voices: a band-coloured dot + the number as the lead, the prose
    /// after it one register quieter. Falls back to plain prose when the
    /// note does not open with a score.
    private func guardrailLine(_ note: String, recovery: Plan.Recovery?) -> some View {
        // Structured data first; the regex is the fallback for plans that
        // predate the field. Either way the number appears once.
        let parsed = Self.recoveryLead(note)
        let lead: RecoveryLead? = {
            if let score = recovery?.score {
                // A structured score without a band still takes the band
                // the prose named, so the dot is never grey by accident.
                return RecoveryLead(
                    score: score,
                    band: recovery?.band?.lowercased() ?? parsed?.band,
                    rest: parsed?.rest ?? note)
            }
            return parsed
        }()
        return HStack(alignment: .firstTextBaseline, spacing: 9) {
            if let lead = lead {
                Circle()
                    .fill(bandColor(lead.band))
                    .frame(width: 7, height: 7)
                    .offset(y: -1)
                Text("\(lead.score)%")
                    .font(Theme.rounded(15, .semibold))
                    .monospacedDigit()
                    .foregroundStyle(Theme.textPrimary)
            }
            Text(lead?.rest ?? note)
                .font(.system(size: 13))
                .lineSpacing(2)
                .foregroundStyle(Theme.textSecondary)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 2)
    }

    private struct RecoveryLead {
        let score: Int
        let band: String?
        let rest: String
    }

    /// "Recovery 74%, green. Full volume..." -> 74 / green / "Full volume..."
    /// Only a note that OPENS with the score is tokenised; a score quoted
    /// mid-sentence ("Sunday was 51% amber") is history, not today's lead.
    private static func recoveryLead(_ note: String) -> RecoveryLead? {
        let pattern = "^\\s*(?:recovery\\s+)?(\\d{1,3})\\s*%\\s*,?\\s*(green|amber|red)?\\s*[.,:;]?\\s*"
        guard let re = try? NSRegularExpression(pattern: pattern, options: .caseInsensitive) else { return nil }
        let ns = note as NSString
        guard let m = re.firstMatch(in: note, range: NSRange(location: 0, length: ns.length)),
              let score = Int(ns.substring(with: m.range(at: 1))) else { return nil }
        let band = m.range(at: 2).location == NSNotFound
            ? nil : ns.substring(with: m.range(at: 2)).lowercased()
        var rest = ns.substring(from: m.range.location + m.range.length)
            .trimmingCharacters(in: .whitespaces)
        if let first = rest.first { rest = first.uppercased() + rest.dropFirst() }
        return RecoveryLead(score: score, band: band, rest: rest)
    }

    /// Green stays the quiet link-dot green; amber is a desaturated warm
    /// tone that cannot outshout the accent; red IS the accent, because a
    /// red morning is the one that earns attention.
    private func bandColor(_ band: String?) -> Color {
        switch band {
        case "green": return Theme.okDim
        case "amber": return Color(red: 0.86, green: 0.66, blue: 0.36)
        case "red": return Theme.accent
        default: return Theme.textTertiary
        }
    }

    // ── The session: ordered rows, expandable ladders ────────────────

    private func sessionCard(_ lifts: [Plan.Lift], warmup: [String]) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                label(armed
                    ? "SESSION · LIVE"
                    : (lifts.count == 1 ? "SESSION" : "SESSION · \(lifts.count) LIFTS"))
                Spacer(minLength: 8)
                if !armed && planIsToday {
                    Button(action: onStartSession) {
                        HStack(spacing: 5) {
                            Image(systemName: "play.fill")
                                .font(.system(size: 9, weight: .bold))
                            Text("Start")
                                .font(Theme.rounded(12.5, .semibold))
                        }
                        .padding(.horizontal, 13)
                        .frame(height: 28)
                    }
                    .background(Theme.accent, in: Capsule())
                    .foregroundStyle(Theme.accentInk)
                } else if armed {
                    // The quiet exit: ending is a demotion, not the hero
                    // action, so it wears the app's hairline control language
                    // rather than the accent.
                    Button(action: onEndSession) {
                        HStack(spacing: 5) {
                            Image(systemName: "stop.fill")
                                .font(.system(size: 9, weight: .bold))
                            Text("End")
                                .font(Theme.rounded(12.5, .semibold))
                        }
                        .padding(.horizontal, 13)
                        .frame(height: 28)
                    }
                    .background(Color.white.opacity(0.055), in: Capsule())
                    .overlay(Capsule().strokeBorder(Theme.hairline, lineWidth: 1))
                    .foregroundStyle(Theme.textSecondary)
                }
            }
            .padding(.bottom, 4)
            // The warmup is the same four lines every session and he knows
            // them: one quiet run-on line inside the card, not a card of
            // its own with four bullets.
            if !warmup.isEmpty {
                Text(warmup.joined(separator: "  ·  "))
                    .font(.system(size: 12))
                    .lineSpacing(2.5)
                    .foregroundStyle(Theme.textTertiary)
                    .padding(.top, 6)
                    .padding(.bottom, 10)
                Rectangle().fill(Theme.hairline).frame(height: 1)
            }
            ForEach(Array(lifts.enumerated()), id: \.offset) { index, lift in
                liftRow(lift, index: index)
                    .id("lift-\(index)")
                if index < lifts.count - 1 {
                    Rectangle().fill(Theme.hairline).frame(height: 1)
                }
            }
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 16)
        .glassCard(strong: true)
        .animation(.easeOut(duration: 0.3), value: armed)
    }

    /// Circles render while the session is live, and stay for the day's
    /// record once anything is checked; a pristine future plan shows none.
    private var showChecks: Bool { armed || !progress.done.isEmpty }

    private var planIsToday: Bool {
        guard let plan = store.plan, plan.rest != true, let date = plan.date else { return false }
        let fmt = DateFormatter()
        fmt.dateFormat = "yyyy-MM-dd"
        return fmt.string(from: Date()) == date
    }

    private func liftRow(_ lift: Plan.Lift, index: Int) -> some View {
        let rungs = buildRungs(lift)
        let isOpen = expanded.contains(index)
        let liftDone = rungs.isEmpty
            ? progress.isDone(SessionProgress.lift(index))
            : rungs.indices.allSatisfy { progress.isDone(SessionProgress.rung(index, $0)) }
        return VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Group {
                    if liftDone {
                        Image(systemName: "checkmark")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(Theme.okDim)
                    } else {
                        Text("\(lift.order ?? index + 1)")
                            .font(Theme.rounded(11))
                            .monospacedDigit()
                            .foregroundStyle(Theme.textTertiary)
                    }
                }
                .frame(width: 15, alignment: .trailing)
                Text(lift.name ?? "Lift")
                    .font(Theme.rounded(16, .semibold))
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.85)
                if !rungs.isEmpty {
                    Image(systemName: "chevron.down")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(Theme.textTertiary)
                        .rotationEffect(.degrees(isOpen ? 180 : 0))
                }
                Spacer(minLength: 8)
                weightText(lift.weight_kg)
            }
            .opacity(liftDone ? 0.5 : 1)
            if let whisper = whisperText(lift) {
                whisper
                    .lineSpacing(1.5)
                    .padding(.leading, 27)
                    .padding(.top, 3)
                    .opacity(liftDone ? 0.5 : 1)
            }
            if isOpen, !rungs.isEmpty {
                ladder(rungs, liftIndex: index, lift: lift)
                    .padding(.leading, 27)
                    .padding(.top, 9)
            }
        }
        .padding(.vertical, 10.5)
        .contentShape(Rectangle())
        .onTapGesture {
            if rungs.isEmpty {
                // No ladder to expand: the row itself is the checkbox.
                guard armed else { return }
                let nowDone = progress.toggle(SessionProgress.lift(index))
                let next = nextPointer()
                LiveActivityController.shared.setPlanLine(next)
                if nowDone, let rest = Self.parseRestSeconds(lift.rest) {
                    progress.startRest(seconds: rest, thenLine: next)
                }
            } else {
                withAnimation(.easeOut(duration: 0.28)) {
                    if isOpen { expanded.remove(index) } else { expanded.insert(index) }
                }
            }
        }
        .onLongPressGesture {
            // Bulk toggle: hold a lift to mark the WHOLE exercise done (or
            // clear it). Retroactive bookkeeping, so no rest timer here.
            guard armed, !rungs.isEmpty else { return }
            withAnimation(.easeOut(duration: 0.25)) {
                if liftDone {
                    for j in rungs.indices where progress.isDone(SessionProgress.rung(index, j)) {
                        progress.toggle(SessionProgress.rung(index, j))
                    }
                } else {
                    for j in rungs.indices where !progress.isDone(SessionProgress.rung(index, j)) {
                        progress.toggle(SessionProgress.rung(index, j))
                    }
                }
            }
            LiveActivityController.shared.setPlanLine(nextPointer())
        }
    }

    private func weightText(_ kg: Double?) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 3) {
            if let kg = kg, kg > 0 {
                Text(fmt(kg))
                    .font(Theme.rounded(16, .semibold))
                    .monospacedDigit()
                    .foregroundStyle(Theme.textPrimary)
                Text("kg")
                    .font(Theme.rounded(11.5))
                    .foregroundStyle(Theme.textTertiary)
            } else {
                // Bodyweight work: "0 kg" would be a domain error.
                Text("BW")
                    .font(Theme.rounded(16, .semibold))
                    .foregroundStyle(Theme.textSecondary)
            }
        }
    }

    /// The line under a lift: the scheme leads in the data voice, cues and
    /// rest follow one register quieter.
    private func whisperText(_ lift: Plan.Lift) -> Text? {
        var scheme: Text?
        if let raw = lift.scheme, !raw.isEmpty {
            scheme = Text(pretty(raw))
                .font(Theme.rounded(12.5))
                .foregroundColor(Theme.textSecondary)
        }
        var parts: [String] = []
        if let notes = lift.notes, !notes.isEmpty { parts.append(notes) }
        if let rest = lift.rest, !rest.isEmpty { parts.append("rest: \(rest)") }
        var tail: Text?
        if !parts.isEmpty {
            tail = Text((scheme == nil ? "" : " · ") + parts.joined(separator: " · "))
                .font(.system(size: 11.5))
                .foregroundColor(Theme.textTertiary)
        }
        switch (scheme, tail) {
        case (let s?, let t?): return s + t
        case (let s?, nil): return s
        case (nil, let t?): return t
        case (nil, nil): return nil
        }
    }

    // ── Ladder rungs: one bar scale, four meanings ───────────────────

    private enum RungTone { case ramp, work, backoff, pr, maybe }

    private struct Rung {
        let weight: Double
        let detail: String?
        let note: String?
        let noteHot: Bool
        let tone: RungTone
        let restSeconds: TimeInterval?
    }

    /// "5-7 min" -> 420, "90s-2min" -> 120, "(60s)" -> 60. Ranges resolve to
    /// the generous end: heavy work earns full rest.
    private static func parseRestSeconds(_ text: String?) -> TimeInterval? {
        guard let text = text?.lowercased(), !text.isEmpty else { return nil }
        guard let re = try? NSRegularExpression(
            pattern: "(\\d+(?:\\.\\d+)?)\\s*(min\\b|m\\b|sec\\b|s\\b)") else { return nil }
        let ns = text as NSString
        var best: TimeInterval?
        for match in re.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            let value = Double(ns.substring(with: match.range(at: 1))) ?? 0
            let unit = ns.substring(with: match.range(at: 2))
            let seconds = unit.hasPrefix("m") ? value * 60 : value
            best = max(best ?? 0, seconds)
        }
        return best
    }

    private func buildRungs(_ lift: Plan.Lift) -> [Rung] {
        // A lone working-set rung would just repeat the row above it; lifts
        // with a ramp, an AMRAP, back-offs, or 2+ working sets can expand.
        let hasLadder = !(lift.ladder ?? "").isEmpty
        let workSets = Self.parseScheme(lift.scheme)?.sets ?? 1
        if !hasLadder && lift.amrap == nil && (lift.backoff ?? []).isEmpty
            && workSets < 2 { return [] }

        var rungs: [Rung] = []

        // 1. Ramp rungs from the ladder string.
        if let ladder = lift.ladder, !ladder.isEmpty {
            for segment in ladder.components(separatedBy: " / ") {
                let text = segment.trimmingCharacters(in: .whitespaces)
                let scanner = Scanner(string: text)
                guard let weight = scanner.scanDouble() else {
                    // A rung without a leading weight: keep it visible as a
                    // note on the previous rung rather than dropping data.
                    if !rungs.isEmpty && !text.isEmpty {
                        let prev = rungs.removeLast()
                        let merged = [prev.note, text].compactMap { $0 }.joined(separator: " · ")
                        rungs.append(Rung(weight: prev.weight, detail: prev.detail, note: merged,
                                          noteHot: prev.noteHot, tone: prev.tone,
                                          restSeconds: prev.restSeconds))
                    }
                    continue
                }
                var reps: Int?
                if scanner.scanString("x") != nil { reps = scanner.scanInt() }
                var remainder = String(text[scanner.currentIndex...])
                    .trimmingCharacters(in: CharacterSet(charactersIn: " ·"))
                var detail = reps.map { "×\($0)" }
                // A bare parenthetical is the rest interval: it rides inline
                // ("20 ×8 · 60s"), only real cues earn a note line.
                if remainder.range(of: "^\\(.+\\)$", options: .regularExpression) != nil {
                    let rest = remainder.dropFirst().dropLast()
                    detail = [detail, String(rest)].compactMap { $0 }.joined(separator: " · ")
                    remainder = ""
                }
                let lower = remainder.lowercased()
                let isPR = remainder.range(of: "\\bPR\\b", options: .regularExpression) != nil
                let isMaybe = lower.contains("if it flies") || lower.contains("only if")
                rungs.append(Rung(
                    weight: weight,
                    detail: detail,
                    note: remainder.isEmpty ? nil : remainder,
                    noteHot: isPR,
                    tone: isPR ? .pr : (isMaybe ? .maybe : .ramp),
                    restSeconds: Self.parseRestSeconds(text)))
            }
        }

        // 2. The working sets, unless the ladder already tops out at (or
        //    beyond) the working weight, as it does on test days. One rung
        //    PER SET: each check is a set done and starts that set's rest.
        let weight = lift.weight_kg ?? 0
        let ladderMax = rungs.map(\.weight).max() ?? 0
        let workRest = Self.parseRestSeconds(lift.rest)
        let parsed = Self.parseScheme(lift.scheme)
        // A "1x AMRAP" scheme describes the set the amrap struct below
        // already renders; a scheme-derived rung would duplicate it.
        let schemeIsAmrap = lift.amrap != nil
            && parsed?.reps.range(of: "amrap", options: .caseInsensitive) != nil
        if !schemeIsAmrap {
            // Weighted work must clear the ramp; bodyweight work has no
            // weight to clear and earns rungs once there are 2+ sets.
            if let (sets, reps) = parsed, weight > 0 ? weight > ladderMax : sets >= 2 {
                let label = reps.first?.isNumber == true ? "×\(reps)" : reps
                for set in 1...sets {
                    rungs.append(Rung(
                        weight: weight,
                        detail: sets == 1 ? label : "\(label) · \(set)/\(sets)",
                        note: nil, noteHot: false, tone: .work,
                        restSeconds: workRest))
                }
            } else if parsed == nil, weight > 0, weight > ladderMax {
                // Unparsed scheme ("top double"): one rung, shown as written.
                rungs.append(Rung(
                    weight: weight,
                    detail: workDetail(lift.scheme),
                    note: nil, noteHot: false, tone: .work,
                    restSeconds: workRest))
            }
        }

        // 3. AMRAP as its own rung at the working weight (BW when unloaded).
        if let amrap = lift.amrap {
            var noteParts: [String] = []
            if let rir = amrap.rir, !rir.isEmpty { noteParts.append("RIR \(rir)") }
            if let target = amrap.target, !target.isEmpty { noteParts.append("target \(target)") }
            rungs.append(Rung(
                weight: weight,
                detail: "AMRAP",
                note: noteParts.isEmpty ? nil : noteParts.joined(separator: " · "),
                noteHot: true, tone: .work,
                restSeconds: workRest))
        }

        // 4. Back-off rungs, one per set. weight_kg 0 is bodyweight back-off
        //    work (pull-up doubles), not a hole in the plan.
        for backoff in lift.backoff ?? [] {
            guard let boWeight = backoff.weight_kg, boWeight >= 0 else { continue }
            var noteParts = ["back-off"]
            if let rest = backoff.rest, !rest.isEmpty { noteParts.append(rest) }
            if let note = backoff.note, !note.isEmpty { noteParts.append(note) }
            let boRest = Self.parseRestSeconds(backoff.rest ?? lift.rest)
            let boParsed = Self.parseScheme(backoff.sets)
            let boSets = boParsed?.sets ?? 1
            let boLabel = boParsed.map { $0.reps.first?.isNumber == true ? "×\($0.reps)" : $0.reps }
                ?? backoff.sets.map { $0.replacingOccurrences(of: "x", with: "×") }
            for set in 1...boSets {
                rungs.append(Rung(
                    weight: boWeight,
                    detail: boSets == 1 ? boLabel : boLabel.map { "\($0) · \(set)/\(boSets)" },
                    note: set == 1 ? noteParts.joined(separator: " · ") : nil,
                    noteHot: false, tone: .backoff,
                    restSeconds: boRest))
            }
        }

        return rungs
    }

    /// "4x4 + AMRAP" -> (4, "4"); "2x10-12" -> (2, "10-12"); "1x AMRAP" ->
    /// (1, "AMRAP"); nil when there is no leading set count ("top double").
    /// The cap keeps a plan typo from exploding into a wall of rungs.
    private static func parseScheme(_ scheme: String?) -> (sets: Int, reps: String)? {
        guard var text = scheme?.trimmingCharacters(in: .whitespaces), !text.isEmpty else { return nil }
        if let plus = text.range(of: "+") {
            text = String(text[..<plus.lowerBound]).trimmingCharacters(in: .whitespaces)
        }
        let scanner = Scanner(string: text)
        guard let sets = scanner.scanInt(), (1...12).contains(sets),
              scanner.scanString("x") != nil else { return nil }
        let reps = String(text[scanner.currentIndex...]).trimmingCharacters(in: .whitespaces)
        guard !reps.isEmpty else { return nil }
        return (sets, reps)
    }

    /// "2x8 + AMRAP" -> "×8 · 2 sets"; anything unparsed shows as written.
    private func workDetail(_ scheme: String?) -> String? {
        guard var text = scheme?.trimmingCharacters(in: .whitespaces), !text.isEmpty else { return nil }
        if let plus = text.range(of: "+") { text = String(text[..<plus.lowerBound]).trimmingCharacters(in: .whitespaces) }
        let scanner = Scanner(string: text)
        if let sets = scanner.scanInt(), scanner.scanString("x") != nil,
           let reps = scanner.scanInt(), scanner.isAtEnd {
            return "×\(reps) · \(sets) set\(sets == 1 ? "" : "s")"
        }
        return text
    }

    private func ladder(_ rungs: [Rung], liftIndex: Int, lift: Plan.Lift) -> some View {
        // Floor of 1: an all-bodyweight ladder must not divide by zero.
        let maxWeight = max(rungs.map(\.weight).max() ?? 1, 1)
        return VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(rungs.enumerated()), id: \.offset) { j, rung in
                let token = SessionProgress.rung(liftIndex, j)
                let isDone = progress.isDone(token)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 10) {
                        if showChecks {
                            Image(systemName: isDone ? "checkmark.circle.fill" : "circle")
                                .font(.system(size: 15, weight: .medium))
                                .foregroundStyle(isDone ? Theme.okDim : Theme.textTertiary)
                                .transition(.opacity)
                        }
                        bar(fraction: rung.weight / maxWeight, tone: rung.tone)
                        HStack(alignment: .firstTextBaseline, spacing: 4) {
                            Text(rung.weight > 0 ? fmt(rung.weight) : "BW")
                                .font(Theme.rounded(13, .semibold))
                                .monospacedDigit()
                                .foregroundStyle(Theme.textPrimary)
                            if let detail = rung.detail {
                                Text(detail)
                                    .font(Theme.rounded(11))
                                    .monospacedDigit()
                                    .foregroundStyle(Theme.textSecondary)
                                    .lineLimit(1)
                            }
                        }
                        .frame(width: 102, alignment: .leading)
                    }
                    if let note = rung.note {
                        Text(note)
                            .font(.system(size: 10.5))
                            .foregroundStyle(rung.noteHot ? Theme.textSecondary : Theme.textTertiary)
                            .padding(.leading, 25)
                    }
                }
                .opacity(isDone ? 0.45 : 1)
                .padding(.vertical, 4)
                .contentShape(Rectangle())
                .onTapGesture {
                    // A rung IS a set: checking it starts the prescribed
                    // rest. Only once the session is live; before that the
                    // plan is a document, not an instrument.
                    guard armed else { return }
                    let nowDone = progress.toggle(token)
                    let next = nextPointer()
                    LiveActivityController.shared.setPlanLine(next)
                    if nowDone {
                        let rest = rung.restSeconds ?? Self.parseRestSeconds(lift.rest) ?? 120
                        progress.startRest(seconds: rest, thenLine: next)
                    }
                }
            }
        }
    }

    /// The first thing not yet done, in program order: the lock screen's NEXT.
    private func nextPointer() -> String? {
        guard let lifts = store.plan?.lifts else { return nil }
        for (i, lift) in lifts.enumerated() {
            let rungs = buildRungs(lift)
            if rungs.isEmpty {
                if !progress.isDone(SessionProgress.lift(i)) {
                    let parts = [lift.name, lift.scheme].compactMap { $0 }
                    return parts.isEmpty ? nil : parts.joined(separator: " · ")
                }
            } else {
                for (j, rung) in rungs.enumerated()
                where !progress.isDone(SessionProgress.rung(i, j)) {
                    var line = lift.name.map { "\($0) " } ?? ""
                    line += rung.weight > 0 ? fmt(rung.weight) : "BW"
                    if let detail = rung.detail { line += " \(detail)" }
                    return line
                }
            }
        }
        return "all sets done"
    }

    private func bar(fraction: Double, tone: RungTone) -> some View {
        GeometryReader { geo in
            let width = max(6, geo.size.width * min(max(fraction, 0), 1))
            ZStack(alignment: .leading) {
                Capsule().fill(Theme.barTrack)
                switch tone {
                case .maybe:
                    Capsule()
                        .strokeBorder(Theme.barMaybe, lineWidth: 1)
                        .frame(width: width)
                case .pr:
                    Capsule().fill(Theme.accent).frame(width: width)
                case .work:
                    Capsule().fill(Theme.barWork).frame(width: width)
                case .backoff:
                    Capsule().fill(Theme.barBackoff).frame(width: width)
                case .ramp:
                    Capsule().fill(Theme.barRamp).frame(width: width)
                }
            }
        }
        .frame(height: 6)
    }

    private func fmt(_ value: Double) -> String {
        value.truncatingRemainder(dividingBy: 1) == 0
            ? String(Int(value))
            : String(format: "%.1f", value)
    }

    /// "2x8" reads as shorthand; "2×8" reads as typography. Only the x
    /// between digits is a multiplication sign.
    private func pretty(_ scheme: String) -> String {
        scheme.replacingOccurrences(
            of: "(?<=\\d)x(?=\\d)", with: "×", options: .regularExpression)
    }

    // ── Quiet sections ───────────────────────────────────────────────

    private func label(_ text: String) -> some View {
        Text(text)
            .font(Theme.sectionLabel())
            .kerning(1.4)
            .foregroundStyle(Theme.textTertiary)
    }

    /// Notes and reminders: base layer, same left edge as the card's
    /// content, no container. They are margin notes, not sessions.
    private func quietSection(_ title: String, items: [String]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            label(title)
                .padding(.bottom, 2)
            ForEach(items, id: \.self) { item in
                HStack(alignment: .firstTextBaseline, spacing: 9) {
                    Circle()
                        .fill(Theme.textTertiary)
                        .frame(width: 3, height: 3)
                        .offset(y: -3)
                    Text(item)
                        .font(.system(size: 13.5))
                        .lineSpacing(2)
                        .foregroundStyle(Theme.textSecondary)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 18)
        .padding(.top, 8)
    }

    private func restBlock(_ plan: Plan) -> some View {
        VStack(spacing: 12) {
            Image(systemName: "moon.fill")
                .font(.system(size: 30, weight: .light))
                .foregroundStyle(Theme.textTertiary)
                .padding(.bottom, 2)
            Text("No training today")
                .font(.system(.title2, design: .rounded).weight(.semibold))
                .foregroundStyle(Theme.textPrimary)
            if let notes = plan.session_notes, !notes.isEmpty {
                ForEach(notes, id: \.self) { note in
                    Text(note)
                        .font(.subheadline)
                        .lineSpacing(2)
                        .foregroundStyle(Theme.textSecondary)
                        .multilineTextAlignment(.center)
                }
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 18)
        .padding(.top, 70)
    }

    private func freshness(_ plan: Plan) -> some View {
        Group {
            if let generated = plan.generated_at,
               let date = ISO8601DateFormatter().date(from: generated) {
                Text("Plan from \(date.formatted(.relative(presentation: .named)))")
            } else if store.loading {
                Text("Refreshing…")
            }
        }
        .font(.caption)
        .foregroundStyle(Theme.textTertiary)
        .frame(maxWidth: .infinity, alignment: .center)
        .padding(.top, 8)
    }

    private var emptyState: some View {
        VStack(spacing: 10) {
            Image(systemName: "list.clipboard")
                .font(.system(size: 30, weight: .light))
                .foregroundStyle(Theme.textTertiary)
            Text(store.error ?? "No plan yet")
                .font(.system(.title3, design: .rounded).weight(.semibold))
                .foregroundStyle(Theme.textPrimary)
            Text("Ask your Claude session for today's plan and it lands here.")
                .font(.subheadline)
                .foregroundStyle(Theme.textSecondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 280)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 140)
    }
}
