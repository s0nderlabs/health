// The Food tab's state: today's meals from the daemon, plus a PERSISTED
// outbox so a capture is never lost. A meal photo or a quick-text item goes
// to disk first, then POSTs to the daemon (POST /meal, idempotent on the
// client id); it leaves the outbox only on a 200. No tailnet at the hawker
// stall, app killed mid-upload, daemon restarting: the entry waits and goes
// out on the next connect, still stamped with when it was eaten.
//
// Estimation happens in Claude's session (the daemon raises meal.logged); the
// daemon pushes meals_updated when an estimate lands and this store refetches.
// Photos are rendered through UIGraphicsImageRenderer before upload: that
// bakes the orientation into the pixels and carries NO metadata (no GPS, no
// device, no timestamp), and the daemon strips again on its side anyway.

import Foundation
import SwiftUI
import UIKit
import UserNotifications

// ── wire types (GET /meals) ───────────────────────────────────────

struct FoodDay: Codable, Equatable {
    let date: String
    let today: String
    let meals: [FoodMeal]
    let totals: FoodTotals
    let complete: Bool?
    let targets: FoodTargets
    let baseline: FoodBaseline
    let weight: FoodWeight?
    /// WHOOP burn and, once calibrated, the energy balance. Optional on the
    /// wire: older daemons send none and the tab simply shows no energy row.
    /// Decoded LOSSY (see init(from:) below): a malformed energy object drops
    /// only the energy row, never the whole day.
    var energy: FoodEnergy? = nil
}

extension FoodDay {
    /// Every field as synthesized, except energy: a present-but-malformed
    /// object (a missing key, a type drift in a future daemon) becomes nil.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        date = try c.decode(String.self, forKey: .date)
        today = try c.decode(String.self, forKey: .today)
        meals = try c.decode([FoodMeal].self, forKey: .meals)
        totals = try c.decode(FoodTotals.self, forKey: .totals)
        complete = try c.decodeIfPresent(Bool.self, forKey: .complete)
        targets = try c.decode(FoodTargets.self, forKey: .targets)
        baseline = try c.decode(FoodBaseline.self, forKey: .baseline)
        weight = try c.decodeIfPresent(FoodWeight.self, forKey: .weight)
        energy = (try? c.decodeIfPresent(FoodEnergy.self, forKey: .energy)) ?? nil
    }
}

struct FoodMeal: Codable, Equatable, Identifiable {
    let id: Int
    let source: String // app | chat
    let status: String // pending | estimated
    let eaten_at: String
    let label: String?
    let note: String?
    let confidence: String?
    let revision: Int
    let kcal: Double?
    let kcal_lo: Double?
    let kcal_hi: Double?
    let protein_g: Double?
    let fix_text: String?
    let items: [FoodItem]
    let photos: [FoodPhoto]

    var pending: Bool { status == "pending" }
    var title: String { label ?? note ?? "Meal" }
}

struct FoodItem: Codable, Equatable {
    let name: String
    let grams: Double?
    let kcal: Double
    let kcal_lo: Double
    let kcal_hi: Double
    let protein_g: Double
    let preset_slug: String?
}

struct FoodPhoto: Codable, Equatable {
    let n: Int
    let url: String?
    let thumb_url: String?
}

struct FoodTotals: Codable, Equatable {
    let kcal: Double
    let kcal_lo: Double
    let kcal_hi: Double
    let protein_g: Double
    let estimated: Int
    let pending: Int
}

struct FoodTargets: Codable, Equatable {
    let protein_g: Double
    let kcal: Double?
    /// The budget was accepted while the baseline was provisional (a
    /// confounder window open). Optional: older daemons omit it.
    var kcal_provisional: Bool? = nil
}

struct FoodBaseline: Codable, Equatable {
    let ready: Bool
    let complete_days: Int
    let days_needed: Int
    let weigh_ins: Int
    let weigh_ins_needed: Int
    /// provisional (a confounder window is open: no budget suggested) |
    /// collecting | ready. Optional: older daemons omit it.
    var status: String? = nil
    /// While provisional: the binding window's last day (YYYY-MM-DD).
    var provisional_until: String? = nil
}

struct FoodWeight: Codable, Equatable {
    let kg: Double
    let at: String
    let fat_pct: Double?
}

/// day.energy (daemon contract). balance = intake - burn * factor, so a
/// negative balance is a deficit. balance_* are null while uncalibrated or
/// with no burn; so_far marks today's in-progress cycle (never projected).
struct FoodEnergy: Codable, Equatable {
    let burn_kcal: Double?
    let calibrated: Bool
    let factor: Double?
    let balance_kcal: Double?
    let balance_lo: Double?
    let balance_hi: Double?
    let so_far: Bool
    let coverage: String // full | partial | none (kept as a string: unknown values never break decoding)
    let note: String?
    /// The factor was fitted while a confounder window was open. Additive to
    /// the contract: older daemons omit it.
    var provisional: Bool? = nil
}

// ── outbox ────────────────────────────────────────────────────────

struct OutboxEntry: Codable, Identifiable, Equatable {
    enum Kind: String, Codable { case meal, fix }
    let id: String // = client_id: the daemon dedupes retries on it
    let kind: Kind
    let createdAt: Date
    var note: String?
    var photoFile: String? // file name under the outbox dir
    var mealId: Int? // fix only
    var attempts = 0
    var lastError: String?
}

final class FoodStore: ObservableObject {
    @Published var day: FoodDay?
    @Published var outbox: [OutboxEntry] = []
    @Published var error: String?
    @Published var loading = false
    @Published var fetchedAt: Date?

    private var flushing = false
    private var retry: DispatchWorkItem?
    /// meal id -> last seen revision, to spot an estimate landing.
    private var seenRevisions: [Int: Int] = [:]
    /// Decoded photos by daemon path. NSCache evicts under memory pressure
    /// and caps the total, so a relay that lives in the background for days
    /// never hoards full-size bitmaps.
    private let images: NSCache<NSString, UIImage> = {
        let c = NSCache<NSString, UIImage>()
        c.totalCostLimit = 48 * 1024 * 1024
        return c
    }()
    private var imageWaiters: [String: [(UIImage?) -> Void]] = [:]

    private static let cacheKey = "food_day_cache_v1"
    private static let maxEdge: CGFloat = 1568

    static var dir: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("food", isDirectory: true)
    }

    private static var outboxFile: URL { dir.appendingPathComponent("outbox.json") }
    static func photoURL(_ name: String) -> URL { dir.appendingPathComponent(name) }

    init() {
        try? FileManager.default.createDirectory(at: Self.dir, withIntermediateDirectories: true)
        if let data = try? Data(contentsOf: Self.outboxFile),
           let saved = try? JSONDecoder().decode([OutboxEntry].self, from: data) {
            outbox = saved
        }
        // Cached day only if it is still today: yesterday's ring at 08:00 is a lie.
        if let data = UserDefaults.standard.data(forKey: Self.cacheKey),
           let cached = try? JSONDecoder().decode(FoodDay.self, from: data),
           cached.date == Self.localFoodDay() {
            day = cached
            for m in cached.meals { seenRevisions[m.id] = m.revision }
        }
    }

    /// The phone's guess at the food day (04:00 rollover), only for the cache
    /// check; the daemon's `today` is authoritative once fetched.
    static func localFoodDay(_ date: Date = Date()) -> String {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.locale = Locale(identifier: "en_US_POSIX")
        return f.string(from: date.addingTimeInterval(-4 * 3600))
    }

    // ── reads ───────────────────────────────────────────────────────

    func refresh() {
        guard !Demo.active, let url = Settings.shared.foodURL(path: "/meals") else { return }
        loading = true
        Settings.shared.fetch(url) { [weak self] data, response, err in
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.loading = false
                if let err = err {
                    self.error = "Food log unreachable: \(err.localizedDescription)"
                    return
                }
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                guard status == 200, let data = data,
                      let decoded = try? JSONDecoder().decode(FoodDay.self, from: data) else {
                    self.error = status == 404
                        ? "This daemon has no food log yet (update the health plugin)."
                        : "Food log read failed (\(status))."
                    return
                }
                self.noticeEstimates(decoded)
                self.day = decoded
                self.fetchedAt = Date()
                self.error = nil
                UserDefaults.standard.set(data, forKey: Self.cacheKey)
            }
        }
    }

    /// An estimate landed (a meal's revision went up) while the app is in the
    /// background: one local notification with the number, so he does not
    /// have to reopen the app to see it.
    private func noticeEstimates(_ fresh: FoodDay) {
        defer { for m in fresh.meals { seenRevisions[m.id] = m.revision } }
        guard UIApplication.shared.applicationState != .active else { return }
        for m in fresh.meals where !m.pending {
            guard let before = seenRevisions[m.id], m.revision > before else { continue }
            let content = UNMutableNotificationContent()
            content.title = m.title
            content.body = "\(FoodFormat.kcalLine(m.kcal, m.kcal_lo, m.kcal_hi)) · \(FoodFormat.grams(m.protein_g)) protein"
            content.sound = nil
            let req = UNNotificationRequest(identifier: "meal-\(m.id)-\(m.revision)", content: content, trigger: nil)
            UNUserNotificationCenter.current().add(req)
        }
    }

    /// A meal photo (thumb or full), fetched through the tunnel once and kept
    /// in memory. Daemon photo URLs are immutable per (meal, n), so no expiry.
    func image(for path: String, completion: @escaping (UIImage?) -> Void) {
        if let hit = images.object(forKey: path as NSString) {
            completion(hit)
            return
        }
        if Demo.active {
            completion(DemoFood.image(path))
            return
        }
        if imageWaiters[path] != nil {
            imageWaiters[path]?.append(completion)
            return
        }
        imageWaiters[path] = [completion]
        guard let url = Settings.shared.foodURL(path: path) else {
            finishImage(path, nil)
            return
        }
        Settings.shared.fetch(url) { [weak self] data, response, _ in
            let ok = (response as? HTTPURLResponse)?.statusCode == 200
            let img = ok ? data.flatMap { UIImage(data: $0) } : nil
            DispatchQueue.main.async { self?.finishImage(path, img) }
        }
    }

    private func finishImage(_ path: String, _ img: UIImage?) {
        if let img = img {
            let cost = Int(img.size.width * img.size.height * img.scale * img.scale * 4)
            images.setObject(img, forKey: path as NSString, cost: cost)
        }
        let waiters = imageWaiters.removeValue(forKey: path) ?? []
        waiters.forEach { $0(img) }
    }

    // ── writes (via the outbox) ─────────────────────────────────────

    /// A capture: photo and/or one-line note. Lands in the outbox first.
    func log(photo: UIImage?, note: String?) {
        let id = UUID().uuidString
        var entry = OutboxEntry(id: id, kind: .meal, createdAt: Date())
        let trimmed = note?.trimmingCharacters(in: .whitespacesAndNewlines)
        entry.note = (trimmed?.isEmpty ?? true) ? nil : trimmed
        if let photo = photo {
            let name = "\(id).jpg"
            do {
                guard let jpeg = Self.prepare(photo) else { throw CocoaError(.fileWriteUnknown) }
                try jpeg.write(to: Self.photoURL(name), options: .atomic)
                entry.photoFile = name
            } catch {
                // Never lose a capture silently: say so (a note, if any, still goes).
                rlog("food: could not stage photo: \(error.localizedDescription)")
                self.error = "Couldn't save that photo on the phone (\(error.localizedDescription)). Try again, or type what you had."
            }
        }
        guard entry.note != nil || entry.photoFile != nil else { return }
        outbox.append(entry)
        persistOutbox()
        Self.askNotificationsOnce()
        flush()
    }

    /// A correction line for an existing meal (raises meal.amended daemon-side).
    func fix(mealId: Int, text: String) {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        var entry = OutboxEntry(id: UUID().uuidString, kind: .fix, createdAt: Date())
        entry.mealId = mealId
        entry.note = t
        outbox.append(entry)
        persistOutbox()
        flush()
    }

    /// Drop a stuck entry by hand (swipe in the list).
    func discard(_ id: String) {
        if let e = outbox.first(where: { $0.id == id }), let f = e.photoFile {
            try? FileManager.default.removeItem(at: Self.photoURL(f))
        }
        outbox.removeAll { $0.id == id }
        persistOutbox()
    }

    /// Send everything queued, oldest first, one at a time. Safe to call
    /// from any trigger (capture, socket connect, foreground, timer).
    func flush() {
        guard !Demo.active, !flushing, let next = outbox.first, Settings.shared.configured else { return }
        flushing = true
        retry?.cancel()
        // Finish the upload even if he pockets the phone right after the shot.
        var bg: UIBackgroundTaskIdentifier = .invalid
        bg = UIApplication.shared.beginBackgroundTask(withName: "food-upload") {
            UIApplication.shared.endBackgroundTask(bg)
            bg = .invalid
        }
        send(next) { [weak self] outcome in
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.flushing = false
                switch outcome {
                case .sent:
                    self.discard(next.id)
                    self.refresh()
                    self.flush()
                case .rejected(let why):
                    // The daemon refused the entry itself (400): retrying can
                    // never succeed, so drop it and say why.
                    self.error = "A queued \(next.kind == .fix ? "fix" : "meal") was refused: \(why)"
                    self.discard(next.id)
                    self.flush()
                case .failed(let why):
                    if let i = self.outbox.firstIndex(where: { $0.id == next.id }) {
                        self.outbox[i].attempts += 1
                        self.outbox[i].lastError = why
                        self.persistOutbox()
                    }
                    self.scheduleRetry()
                }
                if bg != .invalid {
                    UIApplication.shared.endBackgroundTask(bg)
                    bg = .invalid
                }
            }
        }
    }

    private func scheduleRetry() {
        retry?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.flush() }
        retry = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 20, execute: work)
    }

    private enum Outcome { case sent, rejected(String), failed(String) }

    private func send(_ e: OutboxEntry, done: @escaping (Outcome) -> Void) {
        let path = e.kind == .fix ? "/meal/fix" : "/meal"
        guard let url = Settings.shared.foodURL(path: path) else {
            done(.failed("not configured"))
            return
        }
        var body: [String: Any] = [:]
        switch e.kind {
        case .meal:
            body["client_id"] = e.id
            body["captured_at"] = ISO8601DateFormatter().string(from: e.createdAt)
            if let note = e.note { body["note"] = note }
            if let f = e.photoFile {
                guard let data = try? Data(contentsOf: Self.photoURL(f)) else {
                    done(.rejected("photo file missing"))
                    return
                }
                body["photo"] = data.base64EncodedString()
            }
        case .fix:
            body["meal_id"] = e.mealId ?? 0
            body["text"] = e.note ?? ""
        }
        var req = URLRequest(url: url, timeoutInterval: 60)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        Settings.shared.send(req) { data, response, err in
            if let err = err {
                done(.failed(err.localizedDescription))
                return
            }
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            switch status {
            case 200: done(.sent)
            case 400:
                let msg = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }?["error"] as? String
                done(.rejected(msg ?? "bad request"))
            default: done(.failed("HTTP \(status)"))
            }
        }
    }

    private func persistOutbox() {
        if let data = try? JSONEncoder().encode(outbox) {
            try? data.write(to: Self.outboxFile, options: .atomic)
        }
    }

    /// Long edge capped at the daemon's 1568, orientation baked, zero metadata.
    static func prepare(_ image: UIImage) -> Data? {
        let size = image.size
        let scale = min(1, maxEdge / max(size.width, size.height))
        let target = CGSize(width: (size.width * scale).rounded(), height: (size.height * scale).rounded())
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let rendered = UIGraphicsImageRenderer(size: target, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: target))
        }
        return rendered.jpegData(compressionQuality: 0.72)
    }

    private static func askNotificationsOnce() {
        let key = "food_notif_asked_v1"
        guard !UserDefaults.standard.bool(forKey: key) else { return }
        UserDefaults.standard.set(true, forKey: key)
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }
}

// ── formatting (shared by the views and notifications) ─────────────

enum FoodFormat {
    // Built once: formatters are expensive and these run on every render.
    private static let number: NumberFormatter = {
        let f = NumberFormatter()
        f.numberStyle = .decimal
        f.maximumFractionDigits = 0
        // One grouping everywhere: "1,335 kcal" here, in chat, and in the
        // daemon's text. A device-locale "1.090" reads as one-point-oh-nine.
        f.locale = Locale(identifier: "en_US_POSIX")
        f.usesGroupingSeparator = true
        f.groupingSeparator = ","
        f.groupingSize = 3
        return f
    }()

    private static let isoFractional: ISO8601DateFormatter = {
        let p = ISO8601DateFormatter()
        p.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return p
    }()

    private static let isoPlain = ISO8601DateFormatter()

    private static let clock: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm"
        return f
    }()

    static func int(_ v: Double?) -> String {
        guard let v = v else { return "?" }
        return number.string(from: NSNumber(value: v.rounded())) ?? "\(Int(v))"
    }

    static func grams(_ v: Double?) -> String { "\(int(v)) g" }

    /// "2026-12-13" -> "Dec 13" (nil for anything else).
    static func monthDay(_ day: String) -> String? {
        let p = day.split(separator: "-").compactMap { Int($0) }
        guard p.count == 3, (1...12).contains(p[1]), (1...31).contains(p[2]) else { return nil }
        let months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
        return "\(months[p[1] - 1]) \(p[2])"
    }

    /// "−450" / "+200" / "0": a signed kcal balance with a true minus (U+2212).
    static func signed(_ v: Double) -> String {
        let r = v.rounded()
        if r == 0 { return "0" }
        return (r < 0 ? "\u{2212}" : "+") + int(abs(r))
    }

    /// The balance band: "±180" when lo/hi sit symmetric around the balance
    /// (within 10 kcal), else the honest span "−630 to −270".
    static func band(_ v: Double, _ lo: Double?, _ hi: Double?) -> String? {
        guard let lo = lo, let hi = hi, hi.rounded() != lo.rounded() else { return nil }
        if abs((hi - v) - (v - lo)) <= 10 { return "\u{00B1}" + int((hi - lo) / 2) }
        return "\(signed(lo)) to \(signed(hi))"
    }

    static func kcalLine(_ k: Double?, _ lo: Double?, _ hi: Double?) -> String {
        guard let k = k else { return "? kcal" }
        if let lo = lo, let hi = hi, lo.rounded() != hi.rounded() {
            return "\(int(k)) kcal (\(int(lo))–\(int(hi)))"
        }
        return "\(int(k)) kcal"
    }

    static func range(_ lo: Double?, _ hi: Double?) -> String? {
        guard let lo = lo, let hi = hi, lo.rounded() != hi.rounded() else { return nil }
        return "\(int(lo))–\(int(hi))"
    }

    /// "23:30" from the daemon's ISO timestamp, in the phone's zone.
    static func time(_ iso: String) -> String {
        guard let date = isoFractional.date(from: iso) ?? isoPlain.date(from: iso) else { return "" }
        return clock.string(from: date)
    }
}
