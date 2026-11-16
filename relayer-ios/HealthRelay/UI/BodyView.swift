// The Body tab (Nov 16 2026, his call; polished the same evening to his
// locked direction): the scale's side of the story, in one scroll. Top to
// bottom: the latest counted weigh-in with the 7-day average and its trend
// (only when both weeks have 3+ counted readings) over a small sparkline,
// an open confounder flagged right there; the composition FIGURE (the hero:
// the latest S400 reading as four compartments, the goal as a ghost
// outline); the body metrics (every value wears its basis); the goal
// (target fat % is checked against a scan, never the scale) and the
// confounder windows bending the trend; then 30 days of weigh-ins, the
// excluded ones dimmed with their reason kept readable and the two
// sources' copies of one weigh-in grouped as a pair.
//
// Less text on the page: every card keeps at most one short line of words.
// Footnotes, method, basis explanations and the goal ghost's math live
// behind a small (i) per card that opens a sheet; every card carries its
// title and (i) inside it, on one right edge. Coral means FAT on this tab
// (the figure's band, its row, its detail): "now" marks are bone white, and
// provisional or confounder states are neutral. Display only. Every text
// size follows Dynamic Type (BodyFont, capped at xxxLarge); Reduce Motion
// drops every movement.

import SwiftUI

struct BodyView: View {
    @ObservedObject var store: BodyStore
    @Environment(\.dynamicTypeSize) private var dts
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var scrollTarget: String?
    @State private var info: BodyInfo?

    private var k: CGFloat { BodyFont.scale(dts) }
    private func fr(_ size: CGFloat, _ weight: Font.Weight = .medium) -> Font { Theme.rounded(size * k, weight) }
    private func ft(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font { .system(size: size * k, weight: weight) }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    header.id("body.anchor.top")
                    if let p = store.page, !p.isEmpty {
                        if let latest = p.latest {
                            latestCard(latest, p).id("body.anchor.latest")
                        }
                        if let m = p.metrics, !p.compartments.isEmpty {
                            BodyFigureCard(page: p, composition: m, info: $info).id("body.anchor.figure")
                        }
                        if let m = p.metrics, !m.metrics.isEmpty {
                            bodyCard(m, figure: !p.compartments.isEmpty).id("body.anchor.metrics")
                        }
                    } else if store.page == nil, let err = store.error {
                        errorCard(err)
                    } else {
                        emptyCard
                    }
                    if let err = store.error, store.page != nil {
                        // A cached page with a failed refresh: the page stays,
                        // the reason sits quietly under it.
                        Text(err)
                            .font(ft(12.5))
                            .foregroundStyle(Theme.textTertiary)
                            .padding(.horizontal, 2)
                            .accessibilityIdentifier("body.error")
                    }
                    if let p = store.page {
                        if let g = p.goal {
                            goalCard(g, ghost: p.goal_ghost).id("body.anchor.goal")
                        }
                        confoundersSection(p).id("body.anchor.confounders")
                        if !p.history.isEmpty {
                            historySection(p.history).id("body.anchor.history")
                        }
                    }
                    Color.clear.frame(height: 1).id("body.anchor.bottom")
                }
                .padding(.horizontal, 20)
                .padding(.top, 12)
                .padding(.bottom, 110)
            }
            .onAppear {
                guard Demo.active else { return }
                let env = ProcessInfo.processInfo.environment
                // Screenshot / UI-test hook: HR_DEMO_BODY_SCROLL=latest|figure|
                // legend|metrics|goal|confounders|history|bottom parks that
                // section (legend: the figure's lower half with its tiles and
                // an open detail).
                if let anchor = env["HR_DEMO_BODY_SCROLL"] {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                        switch anchor {
                        case "bottom": proxy.scrollTo("body.anchor.bottom", anchor: .bottom)
                        case "legend": proxy.scrollTo("body.anchor.legend", anchor: UnitPoint(x: 0.5, y: 0.42))
                        default: proxy.scrollTo("body.anchor.\(anchor)", anchor: .top)
                        }
                    }
                }
                // HR_DEMO_BODY_INFO=latest|figure|metrics|goal|confounders|
                // history opens that card's (i) sheet.
                if let key = env["HR_DEMO_BODY_INFO"], let p = store.page {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { info = BodyInfo.make(key, p) }
                }
            }
            .onChange(of: scrollTarget) { _, target in
                guard let target else { return }
                withAnimation(reduceMotion ? nil : .timingCurve(0.23, 1, 0.32, 1, duration: 0.45)) { proxy.scrollTo(target, anchor: .top) }
                scrollTarget = nil
            }
        }
        .scrollIndicators(.hidden)
        .background(AmbientBackground())
        .refreshable { store.refresh() }
        .onAppear { store.refresh() }
        .sheet(item: $info) { i in
            BodyInfoSheet(info: i)
        }
    }

    // ── header ───────────────────────────────────────────────────────

    private var header: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text("Body")
                .font(.system(size: 30 * k, weight: .bold, design: .rounded))
                .foregroundStyle(Theme.textPrimary)
            Text(subtitle)
                .font(fr(14))
                .foregroundStyle(Theme.textSecondary)
        }
        .padding(.top, 4)
    }

    private var subtitle: String {
        guard let p = store.page else {
            if store.loading { return "Loading…" }
            return store.error != nil ? "Body data unavailable" : "Weigh-ins"
        }
        let n = p.history.filter { $0.excluded == nil }.count
        return n == 0 ? "No weigh-ins yet" : "\(n) counted weigh-in\(n == 1 ? "" : "s") \u{00B7} 30 days"
    }

    private var emptyCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(store.loading ? "Loading…" : "No weigh-ins yet.")
                .font(ft(15, .semibold))
                .foregroundStyle(Theme.textPrimary)
            Text("Step on the scale in the morning, before you eat.")
                .font(ft(13.5))
                .lineSpacing(2)
                .foregroundStyle(Theme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(20)
        .glassCard(strong: true)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("body.empty")
    }

    /// No page at all and the read failed: say THAT, never "weigh yourself".
    private func errorCard(_ err: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: "exclamationmark.triangle")
                    .font(ft(13, .semibold))
                    .foregroundStyle(Theme.accent.opacity(0.9))
                Text("Can't read body data.")
                    .font(ft(15, .semibold))
                    .foregroundStyle(Theme.textPrimary)
            }
            Text(err)
                .font(ft(13.5))
                .lineSpacing(2)
                .foregroundStyle(Theme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            Text("Your weigh-ins are safe on the Mac; pull down to retry.")
                .font(ft(12.5))
                .foregroundStyle(Theme.textTertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(20)
        .glassCard(strong: true)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("body.unavailable")
    }

    // ── latest + 7-day ───────────────────────────────────────────────

    /// avg7 runs up to the latest COUNTED reading, which can be days old
    /// (a trip, a run of excluded readings): then it is said, never passed
    /// off as this week.
    private func staleDay(_ a: BodyAvg7?, _ l: BodyLatest) -> String? {
        let iso = a?.anchored_at ?? l.measured_at
        guard let d = FoodFormat.bodyDate(iso) else { return nil }
        let cal = Calendar.current
        let today = cal.startOfDay(for: Date())
        let yesterday = cal.date(byAdding: .day, value: -1, to: today) ?? today
        if d >= yesterday { return nil }
        let f = DateFormatter()
        f.dateFormat = "MMM d"
        f.locale = Locale(identifier: "en_US_POSIX")
        return f.string(from: d)
    }

    /// The latest fat's basis as the card's tag (Xiaomi's own value: none,
    /// the source already names it).
    private func fatTag(_ basis: String?) -> String? {
        switch basis {
        case "calibrated": return "calibrated"
        case "provisional": return "provisional"
        case "raw": return "formula"
        default: return nil
        }
    }

    private func latestCard(_ l: BodyLatest, _ p: BodyPage) -> some View {
        let stale = staleDay(p.avg7, l)
        return VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .center, spacing: 8) {
                label("LATEST")
                Spacer(minLength: 8)
                Text("\(FoodFormat.shortSource(l.source)) \u{00B7} \(FoodFormat.weighIn(l.measured_at))")
                    .font(fr(11.5))
                    .monospacedDigit()
                    .foregroundStyle(Theme.textTertiary)
                    .lineLimit(1)
                    .accessibilityIdentifier("body.latest.time")
                InfoButton(key: "latest", what: "the latest weigh-in") { info = BodyInfo.make("latest", p) }
            }
            // The weight and the 7-day average side by side, or stacked at
            // the largest text sizes (never a wrapped number).
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .top, spacing: 16) {
                    latestValue(l)
                    Spacer(minLength: 0)
                    avgBlock(p.avg7, stale: stale, alignment: .trailing)
                }
                VStack(alignment: .leading, spacing: 12) {
                    latestValue(l)
                    avgBlock(p.avg7, stale: stale, alignment: .leading)
                }
            }
            let series = p.countedSeries
            if series.count >= 2 {
                Sparkline(values: series, decimals: 1, floor: 1.0, unit: "kg")
                    .frame(height: 40)
                    .accessibilityElement()
                    .accessibilityLabel(sparkAccessibility(series))
                    .accessibilityIdentifier("body.sparkline")
            }
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .center, spacing: 10) {
                    trendLine(p, stale: stale)
                    Spacer(minLength: 4)
                    confounderFlag(p)
                }
                VStack(alignment: .leading, spacing: 8) {
                    trendLine(p, stale: stale)
                    confounderFlag(p)
                }
            }
        }
        .padding(18)
        .glassCard(strong: true)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("body.latest")
    }

    private func latestValue(_ l: BodyLatest) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text(FoodFormat.kg(l.kg))
                    .font(Theme.heroNumber(44 * k))
                    .monospacedDigit()
                    .foregroundStyle(Theme.textPrimary)
                Text("kg")
                    .font(fr(16))
                    .foregroundStyle(Theme.textSecondary)
            }
            .lineLimit(1)
            .fixedSize()
            if let f = l.fat_pct {
                HStack(alignment: .firstTextBaseline, spacing: 0) {
                    Text("\(String(format: "%.1f", f))% fat")
                        .font(fr(12.5))
                        .monospacedDigit()
                        .foregroundStyle(Theme.textSecondary)
                        .lineLimit(1)
                        .fixedSize()
                    if let tag = fatTag(l.fat_basis) { BasisTag(basis: tag, dot: true) }
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Latest \(FoodFormat.kg(l.kg)) kg\(l.fat_pct.map { ", \(String(format: "%.1f", $0))% fat\(FoodFormat.fatBasisSuffix(l.fat_basis)), trend only" } ?? "")")
        .accessibilityIdentifier("body.latest.value")
    }

    private func sparkAccessibility(_ s: [Double]) -> String {
        guard let first = s.first, let last = s.last else { return "Counted weigh-ins, last 30 days" }
        return "Counted weigh-ins, last 30 days: from \(FoodFormat.kg(first)) to \(FoodFormat.kg(last)) kg, change \(FoodFormat.signedKg(last - first)) kg"
    }

    private func avgBlock(_ a: BodyAvg7?, stale: String?, alignment: HorizontalAlignment) -> some View {
        VStack(alignment: alignment, spacing: 3) {
            label(stale.map { "7-DAY AVG TO \($0.uppercased())" } ?? "7-DAY AVG")
                .fixedSize()
            if let a = a {
                HStack(alignment: .firstTextBaseline, spacing: 3) {
                    Text(FoodFormat.kg(a.kg))
                        .font(fr(22, .semibold))
                        .monospacedDigit()
                        .foregroundStyle(stale == nil ? Theme.textPrimary : Theme.textSecondary)
                    Text("kg")
                        .font(fr(12))
                        .foregroundStyle(Theme.textSecondary)
                }
                .lineLimit(1)
                .fixedSize()
                Text(stale == nil ? "\(a.n) readings" : "\(a.n) readings, none since")
                    .font(fr(11.5))
                    .foregroundStyle(Theme.textTertiary)
            } else {
                Text("needs 3")
                    .font(fr(13))
                    .foregroundStyle(Theme.textTertiary)
            }
        }
        .padding(.top, 6)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(a.map { "7-day average \(FoodFormat.kg($0.kg)) kg over \($0.n) readings\(stale.map { ", up to \($0), none since" } ?? "")" } ?? "7-day average needs 3 readings")
        .accessibilityIdentifier("body.avg7")
    }

    @ViewBuilder
    private func trendLine(_ p: BodyPage, stale: String?) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 7) {
            if let t = p.trend {
                Image(systemName: t.delta_kg < 0 ? "arrow.down.right" : t.delta_kg > 0 ? "arrow.up.right" : "arrow.right")
                    .font(ft(11, .semibold))
                    .foregroundStyle(Theme.textSecondary)
                Text("\(FoodFormat.signedKg(t.delta_kg)) kg vs the week before (\(FoodFormat.kg(t.prev_avg_kg)))\(stale.map { ", to \($0)" } ?? "")")
                    .font(ft(12.5))
                    .monospacedDigit()
                    .foregroundStyle(Theme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                Image(systemName: "chart.line.uptrend.xyaxis")
                    .font(ft(11, .semibold))
                    .foregroundStyle(Theme.textTertiary)
                Text("Trend needs 3+ readings in both weeks")
                    .font(ft(12.5))
                    .foregroundStyle(Theme.textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("body.trend")
    }

    /// An open confounder bends the number right above it: flagged there as
    /// a small chip (its name and window end), tappable down to the windows.
    @ViewBuilder
    private func confounderFlag(_ p: BodyPage) -> some View {
        let active = p.confounders.filter { $0.status == "active" }
        if let first = active.first {
            let to = FoodFormat.monthDay(first.window_to) ?? first.window_to
            Button { scrollTarget = "body.anchor.confounders" } label: {
                HStack(spacing: 5) {
                    Image(systemName: Self.confounderSymbol(first.kind))
                        .font(ft(10, .semibold))
                        .foregroundStyle(Theme.textSecondary)
                    Text("\(Self.confounderTitle(first.kind)) ~\(to)\(active.count > 1 ? " +\(active.count - 1)" : "")")
                        .font(fr(11.5, .semibold))
                        .foregroundStyle(Theme.textPrimary.opacity(0.85))
                        .lineLimit(1)
                        .fixedSize()
                }
                .padding(.horizontal, 9)
                .padding(.vertical, 5)
                .glassCapsule()
                .contentShape(Capsule())
            }
            .buttonStyle(PressScale())
            .accessibilityLabel(first.label.prefix(1).uppercased() + first.label.dropFirst() + (active.count > 1 ? " (+\(active.count - 1) more)" : ""))
            .accessibilityHint("Shows the confounder windows")
            .accessibilityIdentifier("body.trend.confounder")
        }
    }

    // ── body metrics ─────────────────────────────────────────────────

    /// The latest S400 weigh-in's composition, display only. The daemon
    /// orders the metrics: the first two (visceral, muscle) are the headline,
    /// the rest sit in a quiet two-column grid. Every value wears its basis
    /// (formula / provisional / cal. to Xiaomi) so a formula estimate never
    /// reads as a measurement; the per-metric notes and what "calibrated"
    /// is calibrated against sit in the (i) sheet.
    /// The four the figure's legend already shows (fat, water, protein,
    /// mineral as bone): one home per number, so they leave this card
    /// whenever the figure is on the page.
    static let onFigure: Set<String> = ["fat_pct", "water_pct", "protein_pct", "bone_kg"]

    private func bodyCard(_ b: FoodBody, figure: Bool) -> some View {
        let head = Array(b.metrics.prefix(2))
        let rest = Array(b.metrics.dropFirst(2)).filter { !figure || !Self.onFigure.contains($0.key) }
        let rows = stride(from: 0, to: rest.count, by: 2).map { Array(rest[$0..<min($0 + 2, rest.count)]) }
        return VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .center) {
                label("BODY METRICS")
                Spacer(minLength: 8)
                InfoButton(key: "metrics", what: "body metrics") {
                    if let p = store.page { info = BodyInfo.make("metrics", p) }
                }
            }
            HStack(alignment: .top, spacing: 14) {
                ForEach(head, id: \.key) { m in
                    bodyHero(m).frame(maxWidth: .infinity, alignment: .leading)
                }
                if head.count == 1 { Spacer(minLength: 0).frame(maxWidth: .infinity) }
            }
            if !rows.isEmpty {
                Rectangle().fill(Theme.hairline).frame(height: 1)
                Grid(alignment: .topLeading, horizontalSpacing: 14, verticalSpacing: 12) {
                    ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                        GridRow {
                            ForEach(row, id: \.key) { m in
                                bodyCell(m).frame(maxWidth: .infinity, alignment: .leading)
                            }
                            if row.count == 1 { Color.clear.frame(height: 0).gridCellUnsizedAxes([.vertical]) }
                        }
                    }
                }
            }
        }
        .padding(18)
        .glassCard()
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("body.card")
    }

    private func bodyHero(_ m: FoodBodyMetric) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(m.label.uppercased())
                .font(Theme.sectionLabel(10 * k))
                .kerning(1.3)
                .foregroundStyle(Theme.textTertiary)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text(FoodFormat.bodyValue(m.value, unit: m.unit))
                    .font(fr(26, .semibold))
                    .monospacedDigit()
                    .foregroundStyle(Theme.textPrimary)
                if !m.unit.isEmpty {
                    Text(m.unit)
                        .font(fr(13))
                        .foregroundStyle(Theme.textSecondary)
                }
            }
            BasisTag(basis: m.basis)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(bodyAccessibility(m))
        .accessibilityIdentifier("body.metric.\(m.key)")
    }

    private func bodyCell(_ m: FoodBodyMetric) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(m.label)
                .font(ft(11.5))
                .foregroundStyle(Theme.textTertiary)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
            HStack(alignment: .firstTextBaseline, spacing: 3) {
                Text(FoodFormat.bodyValue(m.value, unit: m.unit))
                    .font(fr(16, .semibold))
                    .monospacedDigit()
                    .foregroundStyle(Theme.textPrimary)
                if !m.unit.isEmpty {
                    Text(m.unit)
                        .font(fr(11))
                        .foregroundStyle(Theme.textSecondary)
                }
                BasisTag(basis: m.basis, dot: true)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(bodyAccessibility(m))
        .accessibilityIdentifier("body.metric.\(m.key)")
    }

    private func bodyAccessibility(_ m: FoodBodyMetric) -> String {
        let unit = m.unit.isEmpty ? "" : " \(m.unit)"
        return "\(m.label) \(FoodFormat.bodyValue(m.value, unit: m.unit))\(unit), \(FoodFormat.basisSpoken(m.basis))"
    }

    // ── goal ─────────────────────────────────────────────────────────

    /// `ghost`: the target fat % at today's lean mass, when the reading has
    /// a lean mass (the daemon sends null otherwise).
    private func goalCard(_ g: BodyGoal, ghost: BodyGoalGhost?) -> some View {
        let d = g.derived
        let target = BodyText.percent(g.target_bf_pct)
        return VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .center, spacing: 8) {
                label("GOAL")
                Spacer(minLength: 8)
                InfoButton(key: "goal", what: "the goal") {
                    if let p = store.page { info = BodyInfo.make("goal", p) }
                }
            }
            // The weight at the target, two ways, each named by its lean
            // mass: TODAY's (the S400 reading, the main number, the same as
            // the figure's outline) and the scan's (the reference until a
            // new scan). Why they differ, the creatine variant and the scan
            // note live in the (i) sheet.
            goalPrimary(g, ghost: ghost, target: target)
            if ghost != nil { goalReference(g, target: target) }
            // Left to right like the bar under it: the milestone, what is
            // left to it. The milestone header wears its bar tick; the quiet
            // dot is the main number's; the bright dot is "now".
            HStack(alignment: .top, spacing: 12) {
                if let ms = g.milestone_kg {
                    goalStat("MILESTONE", FoodFormat.kg(ms), "kg", mark: .milestone)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                if let left = d.to_milestone_kg {
                    goalStat(left > 0 ? "TO GO" : "REACHED", FoodFormat.kg(abs(left)), left > 0 ? "kg" : "kg under", mark: nil)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("body.goal.milestone")
            if let ms = g.milestone_kg, let latest = d.latest_kg {
                MilestoneBar(latest: latest, milestone: ms, target: ghost?.kg ?? d.weight_at_target_kg)
                    .frame(height: 30 * max(1, k * 0.9))
                    .accessibilityHidden(true)
            }
        }
        .padding(18)
        .glassCard()
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("body.goal")
    }

    /// "15% at today's lean mass (scale): ~65.9 kg", the quiet dot of the
    /// bar beside it. With no lean mass on the reading, the scan's weight
    /// takes the line, named as the scan's.
    private func goalPrimary(_ g: BodyGoal, ghost: BodyGoalGhost?, target: String) -> some View {
        let what = ghost != nil ? "\(target)% at today's lean mass (scale)" : "\(target)% at \(g.scanLabel) lean"
        let kg = "~\(FoodFormat.kg(ghost?.kg ?? g.derived.weight_at_target_kg)) kg"
        return HStack(alignment: .firstTextBaseline, spacing: 6) {
            GoalMark.target.view
                .alignmentGuide(.firstTextBaseline) { d in d[.bottom] }
            (Text("\(what): ").font(ft(13)).foregroundColor(Theme.textSecondary)
                + Text(kg).font(fr(17, .semibold)).foregroundColor(Theme.textPrimary))
                .monospacedDigit()
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(what): \(kg)")
        .accessibilityIdentifier("body.goal.primary")
    }

    /// "InBody Oct lean: 58.0 kg, ~68.2 kg at 15%": the scan's lean mass and
    /// the weight it gives, the reference until a new scan.
    private func goalReference(_ g: BodyGoal, target: String) -> some View {
        let line = "\(g.scanLabel) lean: \(FoodFormat.kg(g.lean_mass_ref_kg)) kg, ~\(FoodFormat.kg(g.derived.weight_at_target_kg)) kg at \(target)%"
        return Text(line)
            .font(ft(12))
            .monospacedDigit()
            .foregroundStyle(Theme.textTertiary)
            .lineLimit(2)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.top, -8)
            .accessibilityLabel(line)
            .accessibilityIdentifier("body.goal.reference")
    }

    private func goalStat(_ title: String, _ value: String, _ unit: String, mark: GoalMark?) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .center, spacing: 5) {
                if let mark { mark.view }
                label(title)
            }
            HStack(alignment: .firstTextBaseline, spacing: 3) {
                Text(value)
                    .font(fr(20, .semibold))
                    .monospacedDigit()
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                Text(unit)
                    .font(fr(11.5))
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(1)
            }
        }
    }

    // ── confounders ─────────────────────────────────────────────────

    private func confoundersSection(_ p: BodyPage) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            cardHeader("CONFOUNDERS", key: "confounders", what: "confounders") { info = BodyInfo.make("confounders", p) }
            if p.confounders.isEmpty {
                Text("No windows open.")
                    .font(ft(13))
                    .foregroundStyle(Theme.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 18)
                    .padding(.vertical, 12)
            }
            ForEach(Array(p.confounders.enumerated()), id: \.offset) { i, c in
                if i > 0 { divider }
                confounderRow(c)
            }
            divider
            baselineRow(p.baseline_status)
        }
        .padding(.bottom, 4)
        .glassCard()
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("body.confounders")
    }

    /// A card's title and (i), inside the card, on the same edge as every
    /// other card's.
    private func cardHeader(_ title: String, key: String, what: String, action: @escaping () -> Void) -> some View {
        HStack(alignment: .center, spacing: 8) {
            label(title)
            Spacer(minLength: 8)
            InfoButton(key: key, what: what, action: action)
        }
        .padding(.horizontal, 18)
        .padding(.top, 18)
        .padding(.bottom, 6)
    }

    private var divider: some View {
        Rectangle().fill(Theme.hairline).frame(height: 1).padding(.leading, 18)
    }

    /// A glyph per confounder kind, neutral: the window bends the trend, it
    /// is not a warning.
    static func confounderSymbol(_ kind: String) -> String {
        switch kind {
        case "creatine_start": return "pills"
        case "intake_step_down": return "fork.knife"
        case "travel": return "airplane"
        default: return "calendar"
        }
    }

    /// A human title for a confounder kind (the daemon's label carries the
    /// window and the effect).
    static func confounderTitle(_ kind: String) -> String {
        switch kind {
        case "creatine_start": return "Creatine"
        case "intake_step_down": return "Intake step-down"
        default:
            let s = kind.replacingOccurrences(of: "_", with: " ")
            return s.prefix(1).uppercased() + s.dropFirst()
        }
    }

    /// The effect half of the daemon's label ("creatine saturation through
    /// ~Dec 13, weight trend inflated" -> "Weight trend inflated"), or nil.
    static func confounderEffect(_ label: String) -> String? {
        guard let comma = label.firstIndex(of: ",") else { return nil }
        let e = label[label.index(after: comma)...].trimmingCharacters(in: .whitespaces)
        return e.isEmpty ? nil : e.prefix(1).uppercased() + e.dropFirst()
    }

    private func confounderRow(_ c: BodyConfounder) -> some View {
        let active = c.status == "active"
        let to = FoodFormat.monthDay(c.window_to) ?? c.window_to
        return VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline) {
                Text(Self.confounderTitle(c.kind))
                    .font(ft(14, .semibold))
                    .foregroundStyle(active ? Theme.textPrimary : Theme.textSecondary)
                Spacer(minLength: 8)
                Text(active ? "through ~\(to)" : "closed \(to)")
                    .font(fr(11.5, .semibold))
                    .monospacedDigit()
                    .foregroundStyle(active ? Theme.textSecondary : Theme.textTertiary)
            }
            if active, let effect = Self.confounderEffect(c.label) {
                Text(effect)
                    .font(ft(12.5))
                    .foregroundStyle(Theme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(Self.confounderTitle(c.kind)), \(active ? "through ~\(to)" : "closed \(to)"). \(c.sentence)")
        .accessibilityIdentifier("body.confounder.\(c.kind)")
    }

    /// The baseline's state as the card's last row, in the same quiet
    /// words as a closed window (what it means sits in the (i) sheet).
    private func baselineRow(_ status: String?) -> some View {
        let word = status ?? "unknown"
        return HStack(alignment: .firstTextBaseline) {
            Text("Baseline")
                .font(ft(14, .semibold))
                .foregroundStyle(Theme.textSecondary)
            Spacer(minLength: 8)
            Text(word)
                .font(fr(11.5, .semibold))
                .foregroundStyle(status == "ready" ? Theme.textSecondary : Theme.textTertiary)
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 12)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Baseline \(word)")
        .accessibilityIdentifier("body.baseline")
    }

    // ── history ──────────────────────────────────────────────────────

    /// Rows in the daemon's order (newest first; a pair counted copy
    /// first); consecutive rows sharing a pair_key are ONE weigh-in from two
    /// sources and render as one group.
    private func groups(_ rows: [BodyHistoryRow]) -> [[BodyHistoryRow]] {
        var out: [[BodyHistoryRow]] = []
        for r in rows {
            if let k = r.pair_key, let last = out.last?.first, last.pair_key == k {
                out[out.count - 1].append(r)
            } else {
                out.append([r])
            }
        }
        return out
    }

    private func historySection(_ rows: [BodyHistoryRow]) -> some View {
        let gs = groups(rows)
        return VStack(alignment: .leading, spacing: 0) {
            cardHeader("WEIGH-INS \u{00B7} 30 DAYS", key: "history", what: "weigh-ins") {
                if let p = store.page { info = BodyInfo.make("history", p) }
            }
            ForEach(Array(gs.enumerated()), id: \.offset) { i, g in
                if i > 0 { divider }
                if g.count > 1 {
                    pairGroup(g)
                } else {
                    historyRow(g[0], inPair: false)
                }
            }
        }
        .padding(.bottom, 6)
        .glassCard()
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("body.history")
    }

    private func pairGroup(_ g: [BodyHistoryRow]) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                Image(systemName: "link")
                    .font(ft(10, .semibold))
                Text("1 WEIGH-IN \u{00B7} \(g.count) SOURCES")
                    .font(Theme.sectionLabel(10 * k))
                    .kerning(1.0)
            }
            .foregroundStyle(Theme.textSecondary)
            .padding(.leading, 18)
            .padding(.top, 10)
            HStack(spacing: 0) {
                // The bracket that ties the two copies together.
                RoundedRectangle(cornerRadius: 1)
                    .fill(Theme.textTertiary.opacity(0.6))
                    .frame(width: 2)
                    .padding(.vertical, 12)
                    .padding(.leading, 18)
                VStack(spacing: 0) {
                    ForEach(Array(g.enumerated()), id: \.offset) { _, r in
                        historyRow(r, inPair: true)
                    }
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("body.history.pair")
    }

    private func historyRow(_ r: BodyHistoryRow, inPair: Bool) -> some View {
        let counted = r.excluded == nil
        // Excluded rows dim their VALUES only (tertiary); the reason, the
        // one thing the row is there to say, stays at secondary contrast.
        let value = counted ? Theme.textPrimary : Theme.textTertiary
        let fat = r.fat_pct.map { "\(String(format: "%.1f", $0))% fat\(FoodFormat.fatBasisSuffix(r.fat_basis))" }
        return HStack(alignment: .firstTextBaseline, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(FoodFormat.weighInDay(r.measured_at))
                    .font(fr(13.5, counted ? .semibold : .medium))
                    .monospacedDigit()
                    .foregroundStyle(value)
                    .lineLimit(1)
                if let why = r.excluded {
                    HStack(alignment: .firstTextBaseline, spacing: 4) {
                        Image(systemName: "minus.circle")
                            .font(ft(10, .semibold))
                        Text(Self.shortReason(why))
                            .font(ft(11.5))
                            .lineLimit(2)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .foregroundStyle(Theme.textSecondary)
                } else {
                    Text("counts")
                        .font(ft(11.5, .medium))
                        .foregroundStyle(Theme.textSecondary)
                }
            }
            Spacer(minLength: 6)
            Text(FoodFormat.shortSource(r.source))
                .font(fr(10.5, .semibold))
                .foregroundStyle(counted ? Theme.textSecondary : Theme.textTertiary)
                .lineLimit(1)
                .fixedSize()
                .padding(.horizontal, 6)
                .padding(.vertical, 1.5)
                .overlay(Capsule().strokeBorder(Color.white.opacity(0.14), lineWidth: 1))
            VStack(alignment: .trailing, spacing: 2) {
                if let kg = r.kg {
                    Text("\(FoodFormat.kg(kg)) kg")
                        .font(fr(14.5, .semibold))
                        .monospacedDigit()
                        .foregroundStyle(value)
                        .lineLimit(1)
                        .fixedSize()
                    Text(fat ?? "no fat")
                        .font(fr(11.5))
                        .monospacedDigit()
                        .foregroundStyle(Theme.textTertiary)
                        .lineLimit(1)
                        .fixedSize()
                } else {
                    // Someone else's weigh-in: the daemon never sends the
                    // numbers; say so instead of a blank.
                    Text("not you?")
                        .font(fr(13, .semibold))
                        .foregroundStyle(Theme.textTertiary)
                        .lineLimit(1)
                        .fixedSize()
                    Text("values hidden")
                        .font(fr(11.5))
                        .foregroundStyle(Theme.textTertiary)
                        .lineLimit(1)
                        .fixedSize()
                }
            }
            .frame(minWidth: 70 * k, alignment: .trailing)
        }
        .padding(.leading, inPair ? 12 : 18)
        .padding(.trailing, 18)
        .padding(.vertical, 10)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(rowAccessibility(r, fat: fat))
        .accessibilityIdentifier(counted ? "body.history.row" : "body.history.row.excluded")
    }

    /// A row's reason as printed: the exclusion, short; the pair's grouping
    /// already says "same weigh-in", so that copy reads "other source".
    static func shortReason(_ why: String) -> String {
        let s = FoodFormat.exclusion(why)
        return s == "same weigh-in, other source" ? "other source" : s
    }

    private func rowAccessibility(_ r: BodyHistoryRow, fat: String?) -> String {
        let values = r.kg.map { "\(FoodFormat.kg($0)) kg\(fat.map { ", \($0)" } ?? "")" } ?? "values hidden"
        return "\(FoodFormat.weighInDay(r.measured_at)), \(values), \(FoodFormat.shortSource(r.source)), \(r.excluded.map { "excluded: \(FoodFormat.exclusion($0))" } ?? "counts")"
    }

    // ── chrome ───────────────────────────────────────────────────────

    private func label(_ s: String) -> some View {
        Text(s)
            .font(Theme.sectionLabel(10 * k))
            .kerning(1.3)
            .foregroundStyle(Theme.textTertiary)
            .lineLimit(1)
    }
}

// ── the (i) sheets ────────────────────────────────────────────────────

/// What one card's (i) opens: a title and a few short sections, every
/// footnote, method and basis note the card itself no longer prints.
struct BodyInfo: Identifiable, Equatable {
    struct Section: Equatable {
        let title: String
        let lines: [String]
    }

    let id: String
    let title: String
    let sections: [Section]

    static func make(_ key: String, _ p: BodyPage) -> BodyInfo? {
        switch key {
        case "latest": return latest(p)
        case "figure": return p.metrics.map { figure(p, $0) }
        case "metrics": return p.metrics.map(metrics)
        case "goal": return p.goal.map { goal($0, p.goal_ghost) }
        case "confounders": return confounders(p)
        case "history": return history(p)
        default: return nil
        }
    }

    static func latest(_ p: BodyPage) -> BodyInfo {
        var s: [Section] = [
            Section(title: "7-day average", lines: [
                "The mean of the counted weigh-ins in the 7 days up to the latest one. One morning reading counts per day.",
                "The trend compares it with the 7 days before, and shows only when both weeks have 3 or more counted readings.",
            ]),
            Section(title: "Fat %", lines: [
                "The scale's fat % is an estimate from a bioimpedance formula. Read it as a trend only, never as a goal check.",
            ]),
        ]
        if p.countedSeries.count >= 2 {
            s.append(Section(title: "The line", lines: ["Every counted weigh-in of the last 30 days, oldest to newest, with its high and low at the right."]))
        }
        if p.confounders.contains(where: { $0.status == "active" }) {
            s.append(Section(title: "Flag", lines: ["An open confounder window bends this trend. Tap the flag to see it."]))
        }
        return BodyInfo(id: "latest", title: "Latest weigh-in", sections: s)
    }

    static func figure(_ p: BodyPage, _ m: FoodBody) -> BodyInfo {
        var s: [Section] = []
        s.append(Section(title: "This reading", lines: [
            BodyText.readingNote(m, p.latest) ?? "The newest S400 reading, \(FoodFormat.weighIn(m.measured_at)).",
            "Tap a band or its row for its 7-day trend: your counted S400 mornings and this reading.",
        ]))
        s.append(Section(title: "Four compartments", lines: [
            "Water, fat and protein are their % times the weight; mineral is the bone mass. They fill the body from the feet up like levels of a liquid, cut by area, so each band's painted size is its share of the weight; what they do not account for is left unfilled at the top.",
            BodyText.unassignedExplainer(p, overKg: p.unassigned?.over_kg ?? 0),
        ]))
        let basis = p.compartments.reversed().map { c -> String in
            let note = (c.note ?? "").trimmingCharacters(in: .whitespaces)
            return "\(c.label): \(FoodFormat.basisTag(c.basis))\(note.isEmpty ? "" : ", \(note)")"
        }
        if !basis.isEmpty { s.append(Section(title: "Basis", lines: basis)) }
        if let g = p.goal_ghost, m.kg > 0, g.kg < m.kg {
            let target = BodyText.percent(p.goal?.target_bf_pct ?? 15)
            let lean = g.lean_basis == "scan"
                ? "the goal's \(FoodFormat.kg(g.lean_kg)) kg lean mass (\(g.lean_source ?? "scan"))"
                : "today's \(FoodFormat.kg(g.lean_kg)) kg lean mass (\(g.lean_source ?? "scale"))"
            s.append(Section(title: "Goal outline", lines: [
                "\(target)% fat at \(lean) = ~\(FoodFormat.kg(g.kg)) kg, the goal card's main number.",
                "A shape cue: narrowed side to side so its area is \(FoodFormat.kg(g.kg)) / \(FoodFormat.kg(m.kg)) of today's, the same area-for-mass rule as the bands (a lighter body is not a shorter one). The dimmed rim is the gap.",
            ]))
        }
        return BodyInfo(id: "figure", title: "Composition", sections: s)
    }

    static func metrics(_ m: FoodBody) -> BodyInfo {
        var s: [Section] = []
        let notes = FoodFormat.bodyNoteLines(m.metrics)
        if !notes.isEmpty { s.append(Section(title: "Per metric", lines: notes)) }
        var tags: [String] = ["formula: a Mi Scale formula estimate from weight and impedance, no pair yet."]
        if m.metrics.contains(where: { $0.basis == "calibrated" || $0.basis == "provisional" }) {
            tags.append("cal. to Xiaomi: the S400 formula mapped to Xiaomi Home's readings of the same weigh-ins (3+ pairs). Another scale's estimate, not a scan.")
            tags.append("provisional: the same mapping from only 1 or 2 pairs, so still rough.")
        }
        s.append(Section(title: "Tags", lines: tags))
        let built = m.metrics.filter { ($0.note ?? "").contains("from formula fat") }.map(\.label)
        if !built.isEmpty, let fat = m.metrics.first(where: { $0.key == "fat_pct" }), fat.basis != "formula" {
            s.append(Section(title: "Two fat numbers", lines: [
                "Body fat shows the \(fat.basis) value; \(built.joined(separator: " and ")) \(built.count == 1 ? "is" : "are") built on the formula fat before calibration.",
            ]))
        }
        s.append(Section(title: "Reading", lines: ["S400 \u{00B7} \(FoodFormat.kg(m.kg)) kg \u{00B7} \(FoodFormat.weighIn(m.measured_at)). Fat % is trend only."]))
        return BodyInfo(id: "metrics", title: "Body metrics", sections: s)
    }

    static func goal(_ g: BodyGoal, _ ghost: BodyGoalGhost? = nil) -> BodyInfo {
        let target = BodyText.percent(g.target_bf_pct)
        let scan = "\(target)% body fat holding \(FoodFormat.kg(g.lean_mass_ref_kg)) kg lean mass\(g.lean_mass_ref_source.map { " (\($0))" } ?? ""): about \(FoodFormat.kg(g.derived.weight_at_target_kg)) kg\(g.derived.weight_at_target_on_creatine_kg.map { ", ~\(FoodFormat.kg($0)) kg while on creatine" } ?? "")."
        var s: [Section] = []
        if let ghost {
            s.append(Section(title: "Today's lean mass (scale)", lines: [
                "\(target)% body fat holding today's \(FoodFormat.kg(ghost.lean_kg)) kg lean mass (\(ghost.lean_source ?? "S400")): about \(FoodFormat.kg(ghost.kg)) kg. The main number, and the figure's goal outline.",
                "The lean mass is the latest S400 reading's weight x (1 - its fat %): a formula estimate, not a measurement. It moves as you gain muscle (and as the fat estimate moves), so this number moves with it.",
            ]))
            s.append(Section(title: "The scan (reference)", lines: [
                scan,
                "The scan measured the lean mass, so it stays the reference until a new scan. The two numbers differ because the two lean masses do: they answer the same question from two sources, not two goals.",
            ]))
        } else {
            s.append(Section(title: "Target", lines: [
                scan,
                "The latest S400 reading has no lean mass, so the card uses the scan's.",
            ]))
        }
        s.append(Section(title: "Checking it", lines: [
            "Body fat is checked against a scan, not the scale: the scale's fat % is trend only.",
        ]))
        if let ms = g.milestone_kg {
            s.append(Section(title: "Milestone", lines: [
                "\(FoodFormat.kg(ms)) kg on the way. The bar runs from the main number at \(target)% (the quiet dot, left) to the latest weigh-in (the bright dot, \"now\"), the milestone ticked.",
            ]))
        }
        return BodyInfo(id: "goal", title: "Goal", sections: s)
    }

    static func confounders(_ p: BodyPage) -> BodyInfo {
        var s: [Section] = []
        for c in p.confounders {
            s.append(Section(title: BodyView.confounderTitle(c.kind), lines: [c.sentence]))
        }
        let base: String
        switch p.baseline_status {
        case "ready": base = "Ready: enough clean weigh-ins to read the trend at face value."
        case "collecting": base = "Collecting: not enough clean weigh-ins yet to set a baseline."
        default: base = "Provisional: the baseline is still settling; read small moves loosely."
        }
        s.append(Section(title: "Baseline", lines: [base]))
        s.append(Section(title: "Windows", lines: ["A confounder (creatine, an intake change, travel) bends the scale trend for a while. Its window says until when."]))
        return BodyInfo(id: "confounders", title: "Confounders", sections: s)
    }

    static func history(_ p: BodyPage) -> BodyInfo {
        BodyInfo(id: "history", title: "Weigh-ins", sections: [
            Section(title: "What counts", lines: [
                "One morning reading a day, before you eat. Everything else stays in the list, dimmed, with its reason.",
            ]),
            Section(title: "Reasons", lines: [
                "repeat: a morning reading already counts that day.",
                "same weigh-in, other source: the S400 and Xiaomi Home saw the same step-on; one copy counts.",
                "same weigh-in, re-measured: the S400 measured one step-on twice within a minute; the fuller reading counts.",
                "not a morning reading: outside 03:30 to 09:00.",
                "after a meal: a meal was logged before it that morning.",
                "possible other person: far from your last counted weigh-ins. Its values are hidden here.",
                "not his (weight outlier): over 4 kg from your recent weigh-ins, so filed as someone else's. Its values are hidden here; if it was you, say so and it counts.",
                "(by hand): you set that reason yourself, and the rules never change it.",
                "possible replay: identical to the previous reading in both weight and fat.",
                "test: before the first fasted weigh-in date.",
            ]),
        ])
    }
}

/// The small (i) on a card: opens that card's sheet.
struct InfoButton: View {
    let key: String
    let what: String
    let action: () -> Void
    @Environment(\.dynamicTypeSize) private var dts

    var body: some View {
        Button(action: action) {
            Image(systemName: "info.circle")
                .font(.system(size: 14 * BodyFont.scale(dts), weight: .regular))
                .foregroundStyle(Theme.textTertiary)
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(PressScale())
        // A 44 pt target around the 14 pt glyph; the negative padding keeps
        // the glyph where a 28 pt box put it (its edge 6 pt past the card's
        // content edge), so the layout does not move.
        .padding(.vertical, -14)
        .padding(.leading, -8)
        .padding(.trailing, -14)
        .accessibilityLabel("About \(what)")
        .accessibilityIdentifier("body.info.\(key)")
    }
}

struct BodyInfoSheet: View {
    let info: BodyInfo
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var dts

    var body: some View {
        let k = BodyFont.scale(dts)
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline) {
                Text(info.title)
                    .font(.system(size: 22 * k, weight: .bold, design: .rounded))
                    .foregroundStyle(Theme.textPrimary)
                    .accessibilityIdentifier("body.infosheet.title")
                Spacer(minLength: 8)
                Button("Done") { dismiss() }
                    .font(Theme.rounded(15 * k, .semibold))
                    .foregroundStyle(Theme.textPrimary)
                    .accessibilityIdentifier("body.infosheet.done")
            }
            .padding(.horizontal, 22)
            .padding(.top, 24)
            .padding(.bottom, 14)
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    ForEach(Array(info.sections.enumerated()), id: \.offset) { _, s in
                        VStack(alignment: .leading, spacing: 7) {
                            Text(s.title.uppercased())
                                .font(Theme.sectionLabel(10 * k))
                                .kerning(1.3)
                                .foregroundStyle(Theme.textTertiary)
                            ForEach(Array(s.lines.enumerated()), id: \.offset) { _, line in
                                Text(line)
                                    .font(.system(size: 14.5 * k))
                                    .lineSpacing(3)
                                    .foregroundStyle(Theme.textSecondary)
                                    .fixedSize(horizontal: false, vertical: true)
                                    .accessibilityIdentifier("body.infosheet.line")
                            }
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 22)
                .padding(.bottom, 30)
            }
            .scrollIndicators(.hidden)
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .presentationCornerRadius(28)
        .presentationBackground(Color(red: 0.105, green: 0.099, blue: 0.094))
        .preferredColorScheme(.dark)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("body.infosheet")
    }
}

/// A body value's provenance, said quietly as text (no capsule: a page of
/// pills shouts). Formula is the quiet default; calibrated a NEUTRAL step up
/// that says what it is calibrated to ("cal. to Xiaomi": another scale,
/// never validated accuracy); provisional the same tone with a dotted
/// underline, still settling. Never a hue: coral is fat's on this tab.
/// `dot` prefixes " · " when it trails a value on the same line.
struct BasisTag: View {
    let basis: String
    var dot: Bool = false
    @Environment(\.dynamicTypeSize) private var dts

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 0) {
            if dot {
                Text(" \u{00B7} ")
                    .foregroundStyle(Theme.textTertiary)
            }
            Text(FoodFormat.basisTag(basis))
                .foregroundStyle(basis == "formula" || basis == "raw" ? Theme.textTertiary : Theme.textSecondary)
                .underline(basis == "provisional", pattern: .dot, color: Theme.textSecondary.opacity(0.7))
        }
        .font(Theme.rounded(10.5 * BodyFont.scale(dts), .medium))
        .lineLimit(1)
        .fixedSize()
    }
}

/// A quiet line, oldest to newest, the newest point lit, with its range
/// written at the right (max over min) so the slope never claims more than
/// the numbers. `floor` is the smallest span drawn full height: day-to-day
/// noise under it stays flat. The "now" dot is bone white with a soft halo
/// unless the line IS one compartment (the figure's detail passes its hue).
struct Sparkline: View {
    let values: [Double]
    var decimals: Int = 1
    var floor: Double = 1.0
    var unit: String = "kg"
    var dot: Color = Theme.textPrimary
    @Environment(\.dynamicTypeSize) private var dts

    var body: some View {
        let lo = values.min() ?? 0
        let hi = values.max() ?? 1
        let fmt = "%.\(decimals)f"
        HStack(alignment: .center, spacing: 8) {
            GeometryReader { geo in
                let span = max(hi - lo, floor)
                let mid = (hi + lo) / 2
                let w = geo.size.width - 6
                let h = geo.size.height - 6
                let pts: [CGPoint] = values.enumerated().map { i, v in
                    CGPoint(x: 3 + w * CGFloat(i) / CGFloat(max(values.count - 1, 1)),
                            y: 3 + h * (0.5 - CGFloat((v - mid) / span)))
                }
                ZStack {
                    Path { p in
                        guard let first = pts.first else { return }
                        p.move(to: first)
                        for pt in pts.dropFirst() { p.addLine(to: pt) }
                    }
                    .stroke(Theme.textSecondary.opacity(0.7), style: StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round))
                    if let last = pts.last {
                        NowDot(color: dot, size: 6)
                            .position(last)
                    }
                }
            }
            VStack(alignment: .trailing, spacing: 0) {
                Text(String(format: fmt, hi))
                Spacer(minLength: 0)
                Text(String(format: fmt, lo))
            }
            .font(Theme.rounded(10 * BodyFont.scale(dts)))
            .monospacedDigit()
            .foregroundStyle(Theme.textTertiary)
            .fixedSize(horizontal: true, vertical: false)
            .accessibilityHidden(true)
        }
    }
}

/// The bright "now" point: bone white (never coral, which is fat's), with a
/// soft halo so it reads as the present, not as data of a compartment.
struct NowDot: View {
    var color: Color = Theme.textPrimary
    var size: CGFloat = 8

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: size, height: size)
            .background(Circle().fill(color.opacity(0.18)).frame(width: size * 2.2, height: size * 2.2))
    }
}

/// The goal bar's marks, each worn by its column header too: the quiet dot
/// is the weight at the target, the tick the milestone.
enum GoalMark {
    case target, milestone

    @ViewBuilder
    var view: some View {
        switch self {
        case .target: Circle().fill(Theme.textTertiary).frame(width: 6, height: 6)
        case .milestone: Rectangle().fill(Theme.textSecondary).frame(width: 1.5, height: 9)
        }
    }
}

/// Where the latest weigh-in (the bright dot, labelled "now") sits between
/// the weight at the target fat % (the quiet dot, left) and a little above
/// the latest, the milestone ticked. The two marks match their column
/// headers; the numbers live in the columns only.
struct MilestoneBar: View {
    let latest: Double
    let milestone: Double
    let target: Double
    @Environment(\.dynamicTypeSize) private var dts

    var body: some View {
        GeometryReader { geo in
            let lo = min(target, milestone, latest) - 0.5
            let hi = max(latest, milestone) + 1.0
            let x = { (v: Double) -> CGFloat in 5 + (geo.size.width - 10) * CGFloat((v - lo) / (hi - lo)) }
            let y: CGFloat = 8
            ZStack(alignment: .topLeading) {
                Capsule().fill(Theme.barTrack).frame(height: 4).position(x: geo.size.width / 2, y: y)
                Capsule()
                    .fill(Theme.barRamp)
                    .frame(width: max(0, x(latest) - x(target)), height: 4)
                    .position(x: (x(latest) + x(target)) / 2, y: y)
                GoalMark.milestone.view.scaleEffect(y: 12 / 9).position(x: x(milestone), y: y)
                GoalMark.target.view.position(x: x(target), y: y)
                NowDot(size: 9).position(x: x(latest), y: y)
                Text("now")
                    .font(Theme.rounded(10.5 * BodyFont.scale(dts), .medium))
                    .foregroundStyle(Theme.textSecondary)
                    .fixedSize()
                    .position(x: min(max(x(latest), 14), geo.size.width - 14), y: y + 15 * max(1, BodyFont.scale(dts) * 0.9))
            }
        }
    }
}
