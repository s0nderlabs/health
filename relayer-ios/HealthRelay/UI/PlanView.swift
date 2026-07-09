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
    @State private var expanded: Set<Int>
    @State private var seededExpansion = false

    private var armed: Bool { progress.sessionActive }

    init(store: PlanStore, onStartSession: @escaping () -> Void = {}) {
        self.store = store
        self.onStartSession = onStartSession
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
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if let plan = store.plan {
                    header(plan)
                    if let note = plan.recovery_note, !note.isEmpty {
                        guardrailCard(note)
                    }
                    if plan.rest == true {
                        restCard(plan)
                    } else {
                        if let warmup = plan.warmup, !warmup.isEmpty {
                            quietCard("WARMUP", items: warmup)
                        }
                        if let lifts = plan.lifts, !lifts.isEmpty {
                            sessionCard(lifts)
                        }
                        if let notes = plan.session_notes, !notes.isEmpty {
                            quietCard("NOTES", items: notes)
                        }
                    }
                    if let reminders = plan.reminders, !reminders.isEmpty {
                        quietCard("REMINDERS", items: reminders)
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
        .refreshable { store.refresh() }
        .onAppear {
            seedExpansion()
            attachProgress()
        }
        .onChange(of: store.plan?.generated_at) { _, _ in
            seededExpansion = false
            seedExpansion()
            attachProgress()
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

    private func guardrailCard(_ note: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "moon.fill")
                .font(.system(size: 13))
                .foregroundStyle(Theme.textTertiary)
                .padding(.top, 2)
            Text(note)
                .font(.footnote)
                .lineSpacing(2)
                .foregroundStyle(Theme.textSecondary)
            Spacer(minLength: 0)
        }
        .padding(16)
        .glassCard()
    }

    // ── The session: ordered rows, expandable ladders ────────────────

    private func sessionCard(_ lifts: [Plan.Lift]) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                label(armed
                    ? "SESSION · LIVE"
                    : (lifts.count == 1 ? "SESSION" : "SESSION · \(lifts.count) LIFTS · IN ORDER"))
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
                }
            }
            .padding(.bottom, 4)
            ForEach(Array(lifts.enumerated()), id: \.offset) { index, lift in
                liftRow(lift, index: index)
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
        // A lone working-set rung would just repeat the row above it; only
        // lifts with a ramp, an AMRAP, or back-offs have anything to expand.
        let hasLadder = !(lift.ladder ?? "").isEmpty
        if !hasLadder && lift.amrap == nil && (lift.backoff ?? []).isEmpty { return [] }

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
        //    beyond) the working weight, as it does on test days.
        if let weight = lift.weight_kg, weight > 0 {
            let ladderMax = rungs.map(\.weight).max() ?? 0
            if weight > ladderMax {
                rungs.append(Rung(
                    weight: weight,
                    detail: workDetail(lift.scheme),
                    note: nil, noteHot: false, tone: .work,
                    restSeconds: Self.parseRestSeconds(lift.rest)))
            }
        }

        // 3. AMRAP as its own rung at the working weight.
        if let amrap = lift.amrap, let weight = lift.weight_kg, weight > 0 {
            var noteParts: [String] = []
            if let rir = amrap.rir, !rir.isEmpty { noteParts.append("RIR \(rir)") }
            if let target = amrap.target, !target.isEmpty { noteParts.append("target \(target)") }
            rungs.append(Rung(
                weight: weight,
                detail: "AMRAP",
                note: noteParts.isEmpty ? nil : noteParts.joined(separator: " · "),
                noteHot: true, tone: .work,
                restSeconds: Self.parseRestSeconds(lift.rest)))
        }

        // 4. Back-off rungs.
        for backoff in lift.backoff ?? [] {
            guard let weight = backoff.weight_kg, weight > 0 else { continue }
            var noteParts = ["back-off"]
            if let rest = backoff.rest, !rest.isEmpty { noteParts.append(rest) }
            if let note = backoff.note, !note.isEmpty { noteParts.append(note) }
            rungs.append(Rung(
                weight: weight,
                detail: backoff.sets.map { $0.replacingOccurrences(of: "x", with: "×") },
                note: noteParts.joined(separator: " · "),
                noteHot: false, tone: .backoff,
                restSeconds: Self.parseRestSeconds(backoff.rest ?? lift.rest)))
        }

        return rungs
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
        let maxWeight = rungs.map(\.weight).max() ?? 1
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
                            Text(fmt(rung.weight))
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
                    var line = "\(lift.name.map { "\($0) " } ?? "")\(fmt(rung.weight))"
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

    private func quietCard(_ title: String, items: [String]) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            label(title)
                .padding(.bottom, 1)
            ForEach(items, id: \.self) { item in
                HStack(alignment: .firstTextBaseline, spacing: 9) {
                    Circle()
                        .fill(Theme.textTertiary)
                        .frame(width: 3, height: 3)
                        .offset(y: -3)
                    Text(item)
                        .font(.system(size: 14))
                        .lineSpacing(2)
                        .foregroundStyle(Theme.textSecondary)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 18)
        .padding(.vertical, 16)
        .glassCard()
    }

    private func restCard(_ plan: Plan) -> some View {
        VStack(spacing: 12) {
            Image(systemName: "moon.fill")
                .font(.system(size: 30, weight: .light))
                .foregroundStyle(Theme.textTertiary)
                .padding(.bottom, 2)
            Text("No gym today")
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
        .padding(.vertical, 40)
        .glassCard()
        .padding(.top, 6)
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
