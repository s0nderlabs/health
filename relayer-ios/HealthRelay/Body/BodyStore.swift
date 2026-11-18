// The Body tab's state: one GET /body payload from the daemon (latest
// weigh-in, the 7-day average and its trend, the latest S400 reading's body
// composition and its 4-compartment split for the figure, the goal and its
// ghost, the confounder windows, and 30 days of weigh-ins, excluded ones
// included). Display only: the phone never weighs anything in here, it shows
// what the daemon decided.
//
// Mirrors FoodStore's read path: the same Settings helper and token, a cached
// copy for the cold open, a 404 that names the fix (an older daemon), and
// demo payloads for the simulator. Every section decodes LOSSY: a malformed
// section (a future daemon's type drift) drops only that section.

import Foundation
import SwiftUI

// ── wire types (GET /body) ────────────────────────────────────────

struct BodyPage: Codable, Equatable {
    var latest: BodyLatest? = nil
    var avg7: BodyAvg7? = nil
    var trend: BodyTrend? = nil
    /// Exactly day.body (the same contract GET /meals carries).
    var metrics: FoodBody? = nil
    /// The figure: metrics' reading split into mineral, protein, water, fat
    /// (bottom-up), each with its basis, note and 7-day series.
    var compartments: [BodyCompartment] = []
    /// Weight minus the four, or over_kg when they add up to more.
    var unassigned: BodyUnassigned? = nil
    var goal: BodyGoal? = nil
    /// The weight at the goal's target fat % holding TODAY's lean mass (the
    /// figure's own S400 reading, weight x (1 - its fat)): the goal card's
    /// main number and the figure's ghost outline. The scan-based weight
    /// stays in goal.derived as the reference.
    var goal_ghost: BodyGoalGhost? = nil
    var confounders: [BodyConfounder] = []
    /// provisional | collecting | ready (kept as a string).
    var baseline_status: String? = nil
    var history: [BodyHistoryRow] = []

    init(latest: BodyLatest? = nil, avg7: BodyAvg7? = nil, trend: BodyTrend? = nil, metrics: FoodBody? = nil,
         compartments: [BodyCompartment] = [], unassigned: BodyUnassigned? = nil,
         goal: BodyGoal? = nil, goal_ghost: BodyGoalGhost? = nil, confounders: [BodyConfounder] = [],
         baseline_status: String? = nil, history: [BodyHistoryRow] = []) {
        self.latest = latest
        self.avg7 = avg7
        self.trend = trend
        self.metrics = metrics
        self.compartments = compartments
        self.unassigned = unassigned
        self.goal = goal
        self.goal_ghost = goal_ghost
        self.confounders = confounders
        self.baseline_status = baseline_status
        self.history = history
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        latest = (try? c.decodeIfPresent(BodyLatest.self, forKey: .latest)) ?? nil
        avg7 = (try? c.decodeIfPresent(BodyAvg7.self, forKey: .avg7)) ?? nil
        trend = (try? c.decodeIfPresent(BodyTrend.self, forKey: .trend)) ?? nil
        metrics = (try? c.decodeIfPresent(FoodBody.self, forKey: .metrics)) ?? nil
        compartments = ((try? c.decodeIfPresent([Lossy<BodyCompartment>].self, forKey: .compartments)) ?? nil)?.compactMap(\.value) ?? []
        unassigned = (try? c.decodeIfPresent(BodyUnassigned.self, forKey: .unassigned)) ?? nil
        goal = (try? c.decodeIfPresent(BodyGoal.self, forKey: .goal)) ?? nil
        goal_ghost = (try? c.decodeIfPresent(BodyGoalGhost.self, forKey: .goal_ghost)) ?? nil
        confounders = ((try? c.decodeIfPresent([Lossy<BodyConfounder>].self, forKey: .confounders)) ?? nil)?.compactMap(\.value) ?? []
        baseline_status = (try? c.decodeIfPresent(String.self, forKey: .baseline_status)) ?? nil
        history = ((try? c.decodeIfPresent([Lossy<BodyHistoryRow>].self, forKey: .history)) ?? nil)?.compactMap(\.value) ?? []
    }

    /// Nothing weighed yet (or nothing the daemon could read).
    var isEmpty: Bool { latest == nil && history.isEmpty && metrics == nil }

    /// The counted readings, oldest first: the sparkline's points.
    var countedSeries: [Double] { history.filter { $0.excluded == nil }.reversed().compactMap(\.kg) }
}

struct BodyLatest: Codable, Equatable {
    let measured_at: String
    let kg: Double
    let fat_pct: Double?
    /// device | raw | provisional | calibrated (the fat's own basis).
    var fat_basis: String? = nil
    let source: String?
}

struct BodyAvg7: Codable, Equatable {
    let kg: Double
    let n: Int
    /// The reading the 7 days run up to (latest). Absent from older daemons.
    var anchored_at: String? = nil
}

struct BodyTrend: Codable, Equatable {
    let delta_kg: Double
    let prev_avg_kg: Double
}

struct BodyGoal: Codable, Equatable {
    let target_bf_pct: Double
    let milestone_kg: Double?
    let lean_mass_ref_kg: Double
    let lean_mass_ref_source: String?
    let derived: Derived

    struct Derived: Codable, Equatable {
        let weight_at_target_kg: Double
        let weight_at_target_on_creatine_kg: Double?
        let latest_kg: Double?
        let to_milestone_kg: Double?
        let note: String?
    }
}

struct BodyConfounder: Codable, Equatable {
    let kind: String
    let label: String
    let sentence: String
    let window_to: String
    /// active | closed
    let status: String
}

struct BodyHistoryRow: Codable, Equatable {
    let measured_at: String
    /// Null on a row that may not be his ("possible other person", or "not
    /// his" by the friend rule or by hand): the daemon never sends someone
    /// else's weight to the phone.
    let kg: Double?
    let fat_pct: Double?
    var fat_basis: String? = nil
    let source: String?
    let excluded: String?
    /// Shared by two sources' copies of ONE weigh-in (the same instant).
    let pair_key: String?
}

/// One band of the figure: water / fat / protein (% x kg) or mineral (bone).
struct BodyCompartment: Codable, Equatable, Identifiable {
    let key: String
    let label: String
    let kg: Double
    /// % of the reading's weight.
    let pct: Double
    let basis: String
    let note: String?
    var series: [BodySeriesPoint] = []

    var id: String { key }

    init(key: String, label: String, kg: Double, pct: Double, basis: String, note: String?, series: [BodySeriesPoint] = []) {
        self.key = key
        self.label = label
        self.kg = kg
        self.pct = pct
        self.basis = basis
        self.note = note
        self.series = series
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = try c.decode(String.self, forKey: .key)
        label = try c.decode(String.self, forKey: .label)
        kg = try c.decode(Double.self, forKey: .kg)
        pct = try c.decode(Double.self, forKey: .pct)
        basis = try c.decode(String.self, forKey: .basis)
        note = (try? c.decodeIfPresent(String.self, forKey: .note)) ?? nil
        series = ((try? c.decodeIfPresent([Lossy<BodySeriesPoint>].self, forKey: .series)) ?? nil)?.compactMap(\.value) ?? []
    }
}

struct BodySeriesPoint: Codable, Equatable {
    let measured_at: String
    let kg: Double
}

struct BodyUnassigned: Codable, Equatable {
    let kg: Double
    let pct: Double
    /// The four add up to this much MORE than the weight (calibrated fat
    /// over the formula fat water and protein were built on).
    let over_kg: Double
}

struct BodyGoalGhost: Codable, Equatable {
    let kg: Double
    let lean_kg: Double
    /// "scale" (today's S400 lean mass) on current daemons.
    let lean_basis: String
    /// Where that lean mass came from ("S400, calibrated").
    var lean_source: String? = nil
}

extension BodyGoal {
    /// The scan, short, for the goal card's reference line: "InBody Oct"
    /// from "InBody scan 2026-10-05", the source itself (capitalised, cut)
    /// when it names no known scanner, "Scan" when none is recorded.
    var scanLabel: String {
        let src = (lean_mass_ref_source ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if src.isEmpty { return "Scan" }
        let lower = src.lowercased()
        let brand: String? = lower.contains("inbody") ? "InBody" : lower.contains("dexa") || lower.contains("dxa") ? "DEXA" : nil
        guard let brand else {
            let cut = src.count > 22 ? String(src.prefix(21)) + "\u{2026}" : src
            return cut.prefix(1).uppercased() + cut.dropFirst()
        }
        return Self.month(in: src).map { "\(brand) \($0)" } ?? brand
    }

    /// The month a source names, short ("Oct"): an ISO date or a month word.
    private static func month(in s: String) -> String? {
        let names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
        if let r = s.range(of: #"\b\d{4}-(\d{2})"#, options: .regularExpression) {
            let mm = s[r].suffix(2)
            if let m = Int(mm), (1...12).contains(m) { return names[m - 1] }
        }
        let full = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"]
        for word in s.split(whereSeparator: { !$0.isLetter }).map({ $0.lowercased() }) {
            if let i = full.firstIndex(where: { $0 == word || $0.prefix(3) == word || (word == "sept" && $0 == "september") }) {
                return names[i]
            }
        }
        return nil
    }
}

/// day.body (daemon contract): the latest weigh-in's body composition. The
/// daemon orders metrics; the first two (visceral, muscle) are the headline.
struct FoodBody: Codable, Equatable {
    let measured_at: String
    let kg: Double
    let metrics: [FoodBodyMetric]

    init(measured_at: String, kg: Double, metrics: [FoodBodyMetric]) {
        self.measured_at = measured_at
        self.kg = kg
        self.metrics = metrics
    }

    /// One bad metric (a null value from a future daemon, a missing key)
    /// drops only that metric, never the card.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        measured_at = try c.decode(String.self, forKey: .measured_at)
        kg = try c.decode(Double.self, forKey: .kg)
        metrics = try c.decode([Lossy<FoodBodyMetric>].self, forKey: .metrics).compactMap(\.value)
    }
}

struct FoodBodyMetric: Codable, Equatable {
    let key: String
    let label: String
    let value: Double
    let unit: String
    /// formula | provisional | calibrated (kept as a string: an unknown
    /// basis never breaks decoding, it just shows as written).
    let basis: String
    let note: String?
}

/// Decodes T or nothing, so one bad array element cannot fail the array.
struct Lossy<T: Decodable>: Decodable {
    let value: T?
    init(from decoder: Decoder) throws { value = try? T(from: decoder) }
}

// ── store ─────────────────────────────────────────────────────────

final class BodyStore: ObservableObject {
    @Published var page: BodyPage?
    @Published var error: String?
    @Published var loading = false
    @Published var fetchedAt: Date?

    private static let cacheKey = "body_page_cache_v1"

    init() {
        // Weigh-ins carry their own dates on screen, so any cached page is
        // honest on a cold open until the fetch lands.
        if !Demo.active,
           let data = UserDefaults.standard.data(forKey: Self.cacheKey),
           let cached = try? JSONDecoder().decode(BodyPage.self, from: data) {
            page = cached
        }
    }

    func refresh() {
        guard !Demo.active, let url = Settings.shared.foodURL(path: "/body") else { return }
        loading = true
        Settings.shared.fetch(url) { [weak self] data, response, err in
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.loading = false
                if let err = err {
                    self.error = "Body data unreachable: \(err.localizedDescription)"
                    return
                }
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                guard status == 200, let data = data,
                      let decoded = try? JSONDecoder().decode(BodyPage.self, from: data) else {
                    self.error = status == 404
                        ? "This daemon has no Body view yet (update the health plugin)."
                        : "Body read failed (\(status))."
                    return
                }
                self.page = decoded
                self.fetchedAt = Date()
                self.error = nil
                UserDefaults.standard.set(data, forKey: Self.cacheKey)
            }
        }
    }
}

// ── formatting (Body tab, on FoodFormat's shared parsers and clock) ──

extension FoodFormat {
    private static let monthDayClock: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "MMM d, HH:mm"
        f.locale = Locale(identifier: "en_US_POSIX")
        return f
    }()

    static func bodyDate(_ iso: String) -> Date? { date(iso) }

    /// A weigh-in stamp: "07:05" today, "Nov 15, 07:05" on any other day (an
    /// old reading must never pass for this morning's).
    static func weighIn(_ iso: String, now: Date = Date()) -> String {
        guard let date = bodyDate(iso) else { return "" }
        return Calendar.current.isDate(date, inSameDayAs: now) ? time(date) : monthDayClock.string(from: date)
    }

    /// A history row's stamp: always the day too ("Nov 16, 06:05").
    static func weighInDay(_ iso: String) -> String {
        guard let date = bodyDate(iso) else { return "" }
        return monthDayClock.string(from: date)
    }

    /// The Body card footer: the daemon's per-metric notes are bare ("1 pair",
    /// "4 pairs, +/-0.4 kg", "weight-derived, no impedance"), so each line
    /// names its metric(s): metrics sharing the exact same note share a line
    /// ("Visceral fat, BMR: weight-derived, no impedance"), in the daemon's
    /// order. Never merged on a fragment, never joined into one run-on.
    static func bodyNoteLines(_ metrics: [FoodBodyMetric]) -> [String] {
        var order: [String] = []
        var labels: [String: [String]] = [:]
        for m in metrics {
            guard let n = m.note?.trimmingCharacters(in: .whitespaces), !n.isEmpty else { continue }
            if labels[n] == nil { order.append(n) }
            labels[n, default: []].append(m.label)
        }
        return order.map { "\(labels[$0]!.joined(separator: ", ")): \($0)" }
    }

    /// A body metric's number: kg and % to one decimal ("55.3", "20.0"), or
    /// two when the daemon sent two (bone, "2.98": the chat shows the same),
    /// kcal grouped and whole ("1,620"), anything else whole when it is
    /// whole ("7") and one decimal when it is not ("23.1").
    static func bodyValue(_ v: Double, unit: String) -> String {
        switch unit {
        case "kg", "%":
            let two = (v * 100).rounded() / 100
            return abs(two * 10 - (two * 10).rounded()) > 1e-6 ? String(format: "%.2f", two) : String(format: "%.1f", v)
        case "kcal": return int(v)
        default:
            let one = (v * 10).rounded() / 10
            return one == one.rounded() ? int(one) : String(format: "%.1f", one)
        }
    }

    /// "71.3" (one decimal, the scale's honest resolution on screen).
    static func kg(_ v: Double) -> String { String(format: "%.1f", v) }

    /// "−0.7" / "+0.4" / "0.0" with a true minus (U+2212).
    static func signedKg(_ v: Double) -> String {
        let r = (v * 10).rounded() / 10
        if r == 0 { return "0.0" }
        return sign(r) + String(format: "%.1f", abs(r))
    }

    /// "S400 BLE" -> "S400", "Xiaomi Home" -> "Xiaomi"; anything else as sent.
    static func shortSource(_ s: String?) -> String {
        switch s {
        case "S400 BLE": return "S400"
        case "Xiaomi Home": return "Xiaomi"
        case nil: return "unknown"
        default: return s!
        }
    }

    /// What a basis tag says. "calibrated" alone reads like validated
    /// accuracy; it means the S400 formula mapped to Xiaomi Home's readings
    /// of the same weigh-ins (another scale's estimate, not a scan).
    static func basisTag(_ basis: String) -> String {
        basis == "calibrated" ? "cal. to Xiaomi" : basis
    }

    /// VoiceOver's word for a basis.
    static func basisSpoken(_ basis: String) -> String {
        basis == "calibrated" ? "calibrated to Xiaomi Home" : basis
    }

    /// A history fat's own basis, short, for S400 rows: "(cal.)",
    /// "(prov.)", "(formula)". A device value (Xiaomi Home) carries none:
    /// the source pill already names it.
    static func fatBasisSuffix(_ basis: String?) -> String {
        switch basis {
        case "calibrated": return " (cal.)"
        case "provisional": return " (prov.)"
        case "raw": return " (formula)"
        default: return ""
        }
    }

    /// The daemon's exclusion reasons, short: "test: before the first
    /// fasted weigh-in on ..." -> "test", "repeat: a morning reading already
    /// counts today" -> "repeat"; the others are already short and a hand
    /// reason shows as written.
    static func exclusion(_ reason: String) -> String {
        if reason.hasPrefix("test:") { return "test" }
        if reason.hasPrefix("repeat") { return "repeat" }
        return reason
    }
}

#if DEBUG
// ── demo (simulator only, synthetic numbers: nobody's real body) ─────

enum DemoBody {
    /// HR_DEMO_BODY=error: no cached page and the daemon answered 404.
    static let errorText = "This daemon has no Body view yet (update the health plugin)."

    /// HR_DEMO_BODY=full|formula|stale|empty|malformed|shell-goal|shell-<pct>.
    /// Every payload goes through the real wire decoder, so the demo renders
    /// what a daemon would.
    static func page(_ mode: String) -> BodyPage? {
        let obj: [String: Any]
        switch mode {
        case "error":
            return nil
        case "empty":
            obj = ["latest": NSNull(), "avg7": NSNull(), "trend": NSNull(), "metrics": NSNull(), "compartments": [],
                   "unassigned": NSNull(), "goal": NSNull(), "goal_ghost": NSNull(),
                   "confounders": [], "baseline_status": "collecting", "history": []]
        case "formula":
            obj = full(formula: true)
        case "stale":
            // Nothing counted for 12 days (a trip): the avg and trend are old.
            var o = full(formula: false)
            o["latest"] = ["measured_at": at(12, 6, 10), "kg": 72.2, "fat_pct": 22.1, "fat_basis": "device", "source": "Xiaomi Home"]
            o["avg7"] = ["kg": 72.3, "n": 5, "anchored_at": at(12, 6, 10)]
            o["trend"] = NSNull()
            // day.body only looks back 7 days: no composition either.
            o["metrics"] = NSNull()
            o["compartments"] = []
            o["unassigned"] = NSNull()
            o["goal_ghost"] = NSNull()
            // goal.derived reads latestWeight(): the same stale reading.
            var g = o["goal"] as! [String: Any]
            var d = g["derived"] as! [String: Any]
            d["latest_kg"] = 72.2
            d["to_milestone_kg"] = 2.2
            g["derived"] = d
            o["goal"] = g
            o["history"] = (o["history"] as! [[String: Any]]).filter { ($0["measured_at"] as! String) <= at(12, 6, 10) }
            obj = o
        case "malformed":
            // A broken metrics object, one broken compartment and one broken
            // history row: only those drop.
            var o = full(formula: false)
            o["metrics"] = ["measured_at": 7, "kg": "71.2"]
            var c = o["compartments"] as! [[String: Any]]
            c[0]["kg"] = "heavy"
            o["compartments"] = c
            var h = o["history"] as! [[String: Any]]
            h.insert(["measured_at": at(0, 5, 50), "kg": "heavy"], at: 0)
            o["history"] = h
            obj = o
        case let m where m.hasPrefix("shell-"):
            // The same body at another fat %: the same lean mass (56.0 kg,
            // the same water, protein and mineral), only the fat and so the
            // weight moved. shell-goal is the goal's 15%; shell-30, shell-10
            // the figure's extremes.
            let pct = m == "shell-goal" ? 15 : Double(m.dropFirst(6)) ?? 15
            obj = atFat(full(formula: false), pct: pct)
        default:
            obj = full(formula: false)
        }
        guard let data = try? JSONSerialization.data(withJSONObject: obj) else { return nil }
        return try? JSONDecoder().decode(BodyPage.self, from: data)
    }

    /// Local wall-clock `daysAgo` days back at hh:mm, as the daemon's ISO.
    private static func at(_ daysAgo: Int, _ h: Int, _ m: Int) -> String {
        var c = Calendar.current.dateComponents([.year, .month, .day], from: Date())
        c.hour = h
        c.minute = m
        let d = Calendar.current.date(from: c) ?? Date()
        let shifted = Calendar.current.date(byAdding: .day, value: -daysAgo, to: d) ?? d
        return ISO8601DateFormatter().string(from: shifted)
    }

    private static func day(_ daysAhead: Int) -> String {
        let d = Calendar.current.date(byAdding: .day, value: daysAhead, to: Date()) ?? Date()
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.locale = Locale(identifier: "en_US_POSIX")
        return f.string(from: d)
    }

    private static func metric(_ key: String, _ label: String, _ v: Double, _ unit: String, _ basis: String, _ note: String? = nil) -> [String: Any] {
        ["key": key, "label": label, "value": v, "unit": unit, "basis": basis, "note": note.map { $0 as Any } ?? NSNull()]
    }

    /// The composition's reading: the 06:40 repeat at 71.2 kg. day.body takes
    /// the NEWEST S400 reading that is his (a repeat still is), so on a live
    /// daemon the card can describe a later weigh-in than the latest one
    /// that counts (06:05, 71.3). The demo shows that state honestly, with
    /// the 06:40 reading's OWN fat everywhere it appears (its history row,
    /// the figure, the metrics), never the 06:05 reading's.
    private static let readingKg = 71.2
    private static let formulaFat = 21.7
    private static let calibratedFat = 21.3

    /// EXACT dayBody() shapes for the synthetic 71.2 kg reading at 06:40.
    private static func metricList(formula: Bool) -> [[String: Any]] {
        formula ? [
            metric("visceral", "Visceral fat", 12, "", "formula", "weight-derived, no impedance"),
            metric("muscle_kg", "Muscle", 52.9, "kg", "formula"),
            metric("fat_pct", "Body fat", formulaFat, "%", "formula"),
            metric("water_pct", "Water", 53.7, "%", "formula"),
            metric("protein_pct", "Protein", 20.6, "%", "formula", "guessed formula"),
            metric("bone_kg", "Bone", 2.84, "kg", "formula"),
            metric("smm_kg", "Skeletal muscle", 30.7, "kg", "formula", "a smaller part of Muscle"),
            metric("lean_kg", "Lean mass", 55.8, "kg", "formula"),
            metric("bmr_kcal", "BMR", 1500, "kcal", "formula", "weight-derived, no impedance"),
        ] : [
            metric("visceral", "Visceral fat", 11, "", "provisional", "1 pair, weight-derived, no impedance"),
            metric("muscle_kg", "Muscle", 53.4, "kg", "calibrated", "4 pairs, +/-0.4 kg"),
            metric("fat_pct", "Body fat", calibratedFat, "%", "calibrated", "5 pairs, +/-0.3 pt"),
            metric("water_pct", "Water", 53.7, "%", "formula", "from formula fat 21.7%"),
            metric("protein_pct", "Protein", 20.6, "%", "formula", "guessed formula, from formula fat 21.7%"),
            metric("bone_kg", "Bone", 2.84, "kg", "formula"),
            metric("smm_kg", "Skeletal muscle", 30.7, "kg", "formula", "a smaller part of Muscle"),
            metric("lean_kg", "Lean mass", 56.0, "kg", "calibrated", "from calibrated fat"),
            metric("bmr_kcal", "BMR", 1500, "kcal", "formula", "weight-derived, no impedance"),
        ]
    }

    private static func r1(_ v: Double) -> Double { (v * 10).rounded() / 10 }
    private static func r2(_ v: Double) -> Double { (v * 100).rounded() / 100 }

    /// The daemon's split (bodyview.ts), mirrored for the demo only: % x kg
    /// for water / fat / protein, bone as mineral, bottom-up, with a 7-day
    /// series of small synthetic drifts ending on the reading itself.
    private static func compartments(_ list: [[String: Any]], kg: Double) -> (parts: [[String: Any]], unassigned: [String: Any]) {
        let spec: [(String, String, String)] = [("mineral", "Mineral", "bone_kg"), ("protein", "Protein", "protein_pct"),
                                                ("water", "Water", "water_pct"), ("fat", "Fat", "fat_pct")]
        // Days back for the series points (the last is the reading itself).
        let days = [7, 6, 5, 4, 3, 2, 1, 0]
        let drift: [String: [Double]] = [
            "fat": [0.5, 0.45, 0.4, 0.3, 0.3, 0.2, 0.1, 0], "water": [0.2, 0.3, 0.1, 0.2, 0.0, 0.1, 0.1, 0],
            "protein": [-0.1, 0.0, -0.1, 0.0, 0.0, 0.1, 0.0, 0], "mineral": [0, 0, 0.01, 0, 0, 0.01, 0, 0],
        ]
        var parts: [[String: Any]] = []
        var sum = 0.0
        for (key, label, mk) in spec {
            guard let m = list.first(where: { ($0["key"] as! String) == mk }) else { continue }
            let v = m["value"] as! Double
            let kgv = mk == "bone_kg" ? v : v / 100 * kg
            sum += kgv
            let series: [[String: Any]] = zip(days, drift[key]!).map { d, dx in
                let t = d == 0 ? at(0, 6, 40) : at(d, 6, 5)
                return ["measured_at": t, "kg": key == "mineral" ? r2(kgv + dx) : r1(kgv + dx)]
            }
            parts.append(["key": key, "label": label, "kg": key == "mineral" ? r2(kgv) : r1(kgv), "pct": r1(kgv / kg * 100),
                          "basis": m["basis"]!, "note": m["note"]!, "series": series])
        }
        let rest = kg - sum
        return (parts, ["kg": r2(max(0, rest)), "pct": r1(max(0, rest) / kg * 100), "over_kg": r2(max(0, -rest))])
    }

    /// `o` rewritten for the same lean mass at `pct` fat: the weight is the
    /// lean mass / (1 - pct), fat its share, the other three keep their kg
    /// (their % follow), the 06:40 reading and its history row move with it.
    private static func atFat(_ o: [String: Any], pct: Double) -> [String: Any] {
        var o = o
        let leanKg = 56.0
        let kg = r1(leanKg / (1 - pct / 100))
        var parts = o["compartments"] as! [[String: Any]]
        var sum = 0.0
        for i in parts.indices {
            let key = parts[i]["key"] as! String
            var v = parts[i]["kg"] as! Double
            if key == "fat" {
                let nv = r1(kg * pct / 100)
                let dv = nv - v
                parts[i]["series"] = (parts[i]["series"] as! [[String: Any]]).map { var q = $0; q["kg"] = r1((q["kg"] as! Double) + dv); return q }
                v = nv
                parts[i]["kg"] = v
            }
            parts[i]["pct"] = r1(v / kg * 100)
            sum += v
        }
        o["compartments"] = parts
        let rest = kg - sum
        o["unassigned"] = ["kg": r2(max(0, rest)), "pct": r1(max(0, rest) / kg * 100), "over_kg": r2(max(0, -rest))]
        var met = o["metrics"] as! [String: Any]
        met["kg"] = kg
        met["metrics"] = (met["metrics"] as! [[String: Any]]).map { m -> [String: Any] in
            var m = m
            switch m["key"] as! String {
            case "fat_pct": m["value"] = pct
            case "water_pct": m["value"] = r1((parts.first { ($0["key"] as! String) == "water" }!["kg"] as! Double) / kg * 100)
            case "protein_pct": m["value"] = r1((parts.first { ($0["key"] as! String) == "protein" }!["kg"] as! Double) / kg * 100)
            default: break
            }
            return m
        }
        o["metrics"] = met
        var h = o["history"] as! [[String: Any]]
        h[0]["kg"] = kg
        h[0]["fat_pct"] = pct
        o["history"] = h
        return o
    }

    private static func row(_ daysAgo: Int, _ h: Int, _ m: Int, _ kg: Double?, _ fat: Double?, _ source: String,
                            _ excluded: String? = nil, paired: Bool = false) -> [String: Any] {
        let ts = at(daysAgo, h, m)
        let basis: Any = fat == nil ? NSNull() : source == "S400 BLE" ? "calibrated" : "device"
        return ["measured_at": ts, "kg": kg.map { $0 as Any } ?? NSNull(), "fat_pct": fat.map { $0 as Any } ?? NSNull(),
                "fat_basis": basis, "source": source,
                "excluded": excluded.map { $0 as Any } ?? NSNull(), "pair_key": paired ? ts : NSNull()]
    }

    /// The rich page: a paired S400 + Xiaomi weigh-in this morning, a later
    /// repeat that the composition comes from, mixed bases on the card (or
    /// formula only), every exclusion reason in the history (the "possible
    /// other person" row masked, as the daemon sends it), an active creatine
    /// window and a closed one.
    private static func full(formula: Bool) -> [String: Any] {
        let s4 = "S400 BLE", xi = "Xiaomi Home"
        let history: [[String: Any]] = [
            row(0, 6, 40, readingKg, formula ? formulaFat : calibratedFat, s4, "repeat: a morning reading already counts today"),
            row(0, 6, 5, 71.3, 21.4, s4, paired: true),
            row(0, 6, 5, 71.3, 21.6, xi, "same weigh-in, other source", paired: true),
            row(1, 19, 30, 72.6, 21.9, xi, "not a morning reading"),
            row(1, 6, 10, 71.4, 21.5, s4),
            row(2, 7, 45, 72.0, 21.7, s4, "after a meal"),
            row(2, 6, 0, 71.6, 21.5, s4),
            row(3, 6, 20, nil, nil, s4, "possible other person"),
            row(3, 6, 15, 71.5, 21.6, s4),
            row(4, 6, 30, 71.8, 21.7, s4, "possible replay"),
            row(4, 6, 5, 71.8, 21.7, s4),
            row(5, 6, 5, 71.7, 21.6, s4),
            row(6, 6, 0, 71.9, 21.8, xi),
            row(8, 6, 10, 72.3, 22.0, xi),
            row(9, 6, 5, 72.1, 22.0, xi),
            row(10, 6, 0, 72.5, 22.1, xi),
            row(11, 6, 10, 72.2, 22.1, xi),
            row(12, 6, 5, 72.4, 22.2, xi),
            row(13, 21, 0, 72.8, 22.3, xi, "test: before the first fasted weigh-in on Mon 3 Nov"),
        ]
        let list = metricList(formula: formula)
        let split = compartments(list, kg: readingKg)
        return [
            "latest": ["measured_at": at(0, 6, 5), "kg": 71.3, "fat_pct": formula ? 21.7 : 21.4,
                       "fat_basis": formula ? "raw" : "calibrated", "source": s4],
            "avg7": ["kg": 71.6, "n": 7, "anchored_at": at(0, 6, 5)],
            "trend": ["delta_kg": -0.7, "prev_avg_kg": 72.3],
            "metrics": ["measured_at": at(0, 6, 40), "kg": readingKg, "metrics": list],
            "compartments": split.parts,
            "unassigned": split.unassigned,
            "goal": [
                "target_bf_pct": 15, "milestone_kg": 70, "lean_mass_ref_kg": 58, "lean_mass_ref_source": "InBody scan 2026-10-05",
                "set_at": at(5, 12, 0),
                "derived": [
                    "weight_at_target_kg": 68.2, "weight_at_target_on_creatine_kg": 69.2, "latest_kg": 71.3,
                    "to_milestone_kg": 1.3,
                    "note": "At 15% fat holding 58 kg lean mass (InBody scan 2026-10-05). The scale's fat % is a TREND only, never a goal check: the goal is checked against a body-composition scan.",
                ],
            ],
            // bodyview.ts: 15% at TODAY's lean mass, the figure's own
            // reading's lean_kg (formula 55.8 / 0.85, calibrated 56.0 / 0.85).
            "goal_ghost": ["kg": formula ? 65.6 : 65.9, "lean_kg": formula ? 55.8 : 56.0, "lean_basis": "scale",
                           "lean_source": formula ? "S400, formula" : "S400, calibrated"],
            "confounders": [
                ["kind": "creatine_start", "label": "creatine saturation through ~\(FoodFormat.monthDay(day(24)) ?? ""), weight trend inflated",
                 "sentence": "Creatine since \(FoodFormat.monthDay(day(-4)) ?? "") (synthetic): expect about +1 to 2 kg of water in the muscles while it saturates, so the scale trend reads high through ~\(FoodFormat.monthDay(day(24)) ?? "").",
                 "window_to": day(24), "status": "active"],
                ["kind": "travel", "label": "travel through ~\(FoodFormat.monthDay(day(-9)) ?? "")",
                 "sentence": "Travel since \(FoodFormat.monthDay(day(-16)) ?? ""): window closed \(FoodFormat.monthDay(day(-9)) ?? ""), so it no longer bends the trend.",
                 "window_to": day(-9), "status": "closed"],
            ],
            "baseline_status": "provisional",
            "history": history,
        ]
    }
}
#endif
