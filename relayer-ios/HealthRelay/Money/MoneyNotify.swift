// Money notifications, phone side: the Shortcuts action "Log Money
// Notification" (an App Intent, runs without opening the app) plus a
// persisted outbox. A Shortcuts "notification received" automation hands the
// bank / wallet notification to this action; the app sends it to the daemon
// (POST /money-notif) through its own tailnet tunnel, so it works with iCloud
// Private Relay on, the token never sits inside a shortcut, and a send that
// fails waits here until the next connection (Shortcuts itself cannot retry).
//
// Privacy: anything that looks like a one-time code is dropped HERE, before
// it touches the outbox file, mirroring the daemon's gate. Finance text only
// ever goes to the user's own Mac.

import AppIntents
import Foundation
import UIKit

struct LogMoneyNotificationIntent: AppIntent {
    static var title: LocalizedStringResource = "Log Money Notification"
    static var description = IntentDescription(
        "Forward a bank or wallet notification to your health daemon on your Mac.")
    static var openAppWhenRun = false

    @Parameter(title: "App", description: "The app that posted the notification, e.g. SeaBank")
    var app: String

    @Parameter(title: "Title", default: "")
    var notificationTitle: String

    @Parameter(title: "Body")
    var body: String

    func perform() async throws -> some IntentResult {
        let queued = MoneyOutbox.shared.enqueue(app: app, title: notificationTitle, body: body)
        if queued {
            // Give the send a moment while iOS keeps us alive; whatever does
            // not make it stays queued for the next foreground / socket up.
            await MoneyOutbox.shared.flushAndWait(seconds: 15)
        }
        return .result()
    }
}

final class MoneyOutbox {
    static let shared = MoneyOutbox()

    struct Entry: Codable {
        let id: String // client_id: the daemon dedupes retries on it
        let app: String
        let title: String
        let body: String
        let ts: Date
    }

    private let queue = DispatchQueue(label: "money-outbox")
    private var entries: [Entry] = []
    private var flushing = false

    private var file: URL {
        FoodStore.dir.appendingPathComponent("money-outbox.json")
    }

    private init() {
        try? FileManager.default.createDirectory(at: FoodStore.dir, withIntermediateDirectories: true)
        if let data = try? Data(contentsOf: file),
           let saved = try? JSONDecoder().decode([Entry].self, from: data) {
            entries = saved
        }
    }

    var pendingCount: Int { queue.sync { entries.count } }

    /// Returns false when the notification was dropped (OTP / empty).
    @discardableResult
    func enqueue(app: String, title: String, body: String) -> Bool {
        let a = app.trimmingCharacters(in: .whitespacesAndNewlines)
        let b = body.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !a.isEmpty, !b.isEmpty else { return false }
        if Self.looksLikeOtp(title + "\n" + b, app: a) {
            rlog("money: dropped a verification-code notification from \(a)")
            return false
        }
        let e = Entry(id: UUID().uuidString, app: String(a.prefix(60)), title: String(title.prefix(200)),
                      body: String(b.prefix(2000)), ts: Date())
        queue.sync {
            entries.append(e)
            persist()
        }
        return true
    }

    func flush() {
        Task { await flushAndWait(seconds: 30) }
    }

    /// Send queued entries oldest first until done, a failure, or the deadline.
    func flushAndWait(seconds: Double) async {
        let start = Date()
        guard queue.sync(execute: { () -> Bool in
            if flushing { return false }
            flushing = true
            return true
        }) else { return }
        defer { queue.sync { flushing = false } }
        while Date().timeIntervalSince(start) < seconds {
            guard let next = queue.sync(execute: { entries.first }) else { return }
            let outcome = await send(next)
            switch outcome {
            case .sent, .rejected:
                // 200 (stored / duplicate / dropped / ignored) or a 400 that a
                // retry can never fix: either way it leaves the queue.
                queue.sync {
                    entries.removeAll { $0.id == next.id }
                    persist()
                }
            case .failed:
                return // keep it; next trigger retries
            }
        }
    }

    private enum Outcome { case sent, rejected, failed }

    private func send(_ e: Entry) async -> Outcome {
        guard let url = Settings.shared.foodURL(path: "/money-notif") else { return .failed }
        var req = URLRequest(url: url, timeoutInterval: 20)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        let iso = ISO8601DateFormatter()
        req.httpBody = try? JSONSerialization.data(withJSONObject: [
            "app": e.app, "title": e.title, "body": e.body,
            "ts": iso.string(from: e.ts), "client_id": e.id, "via": "app",
        ])
        return await withCheckedContinuation { cont in
            Settings.shared.send(req) { _, response, err in
                if err != nil { return cont.resume(returning: .failed) }
                switch (response as? HTTPURLResponse)?.statusCode ?? 0 {
                case 200: cont.resume(returning: .sent)
                case 400: cont.resume(returning: .rejected)
                default: cont.resume(returning: .failed)
                }
            }
        }
    }

    private func persist() {
        if let data = try? JSONEncoder().encode(entries) {
            try? data.write(to: file, options: [.atomic, .completeFileProtection])
        }
    }

    /// Mirror of the daemon's gate (src/money.ts otpVerdict), the "drop"
    /// half only: OTP language always drops; a code word next to a short
    /// number drops unless the text is clearly a transaction (the daemon
    /// then redacts those digits before storing). Errs toward dropping.
    static func looksLikeOtp(_ text: String, app: String = "") -> Bool {
        let strong = #"\b(otp|one[- ]?time (password|code|pin)|verification|verifikasi|kode\s+(rahasia|aktivasi|masuk|keamanan|unik)|security code|passcode|login code|sign[- ]?in code|auth(entication)? code|jangan\s+(berikan|bagikan|sebarkan)|do not share|don'?t share|never share|rahasiakan)\b"#
        let weak = #"\b(kode|code|pin|token)\b[^\n]{0,40}\b\d{4,8}\b|\b\d{4,8}\b[^\n]{0,40}\b(kode|code|pin|token)\b"#
        let amount = #"(rp\.?|idr|\$|usd[ct]?)\s*\d|\d[\d.,]*\s*(idr|rupiah|usd[ct]?)\b"#
        let verb = #"\b(paid|pay(ment)?|received|purchase|bought|pembayaran|bayar|dibayar|membayar|pembelian|beli|transfer|diterima|masuk|terima|berhasil|order)\b"#
        func has(_ p: String) -> Bool { text.range(of: p, options: [.regularExpression, .caseInsensitive]) != nil }
        if has(strong) { return true }
        // Crypto wallets: "received 5000 TOKEN" is a transfer, not a code
        // (same exemption as the daemon's appClass 'crypto').
        let wallet = #"tangem|metamask|trust ?wallet|phantom|rabby|ledger|trezor|okx wallet|bitget wallet|coinbase wallet"#
        if app.range(of: wallet, options: [.regularExpression, .caseInsensitive]) != nil { return false }
        if has(weak) { return !(has(amount) && has(verb)) }
        return false
    }
}
