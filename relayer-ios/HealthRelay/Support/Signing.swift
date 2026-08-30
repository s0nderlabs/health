// The sideload clock. A free-team (personal) signing profile lives seven
// days from the moment Xcode minted it, then iOS refuses to launch the app
// with no warning at all: "health Is No Longer Available". The profile is
// embedded in the bundle, so the app can read its own death date and count
// down to it, in the UI, in a notification the day before, and up to the
// daemon so `/health status` reports the real expiry instead of guessing off
// when the phone was last seen.

import Foundation
import UserNotifications

enum Signing {
    struct Profile {
        let expiresAt: Date
        let name: String?
        let team: String?
    }

    /// The embedded profile, read once. nil on simulator and App Store builds
    /// (no embedded.mobileprovision), and on a bundle we could not parse.
    static let profile: Profile? = load()

    /// The date the app stops launching. Demo builds can fake it with
    /// HR_DEMO_SIGNED_HOURS=<n> (hours from now) so every countdown face can
    /// be screenshotted on the simulator, where no profile exists.
    static var expiresAt: Date? {
        if Demo.active,
           let raw = ProcessInfo.processInfo.environment["HR_DEMO_SIGNED_HOURS"],
           let hours = Double(raw) {
            return demoAnchor.addingTimeInterval(hours * 3600)
        }
        return profile?.expiresAt
    }

    /// Fixed at first read so a demo countdown ticks like a real one.
    private static let demoAnchor = Date()

    static var appVersion: String {
        let info = Bundle.main.infoDictionary
        let short = info?["CFBundleShortVersionString"] as? String ?? "0"
        let build = info?["CFBundleVersion"] as? String ?? "0"
        return "\(short) (\(build))"
    }

    /// Seconds left, negative once expired; nil when unknown.
    static func remaining(at now: Date = Date()) -> TimeInterval? {
        expiresAt.map { $0.timeIntervalSince(now) }
    }

    enum Urgency: Comparable {
        case calm      // more than two days
        case soon      // within two days
        case critical  // within twelve hours, or already gone
    }

    static func urgency(at now: Date = Date()) -> Urgency? {
        guard let left = remaining(at: now) else { return nil }
        if left <= 12 * 3600 { return .critical }
        if left <= 2 * 86_400 { return .soon }
        return .calm
    }

    /// "3d 2h", "5h 12m", "38m", or "expired". Coarse on purpose: this is a
    /// glance, and the notification carries the exact time.
    static func countdown(at now: Date = Date()) -> String? {
        guard let left = remaining(at: now) else { return nil }
        if left <= 0 { return "expired" }
        let minutes = Int((left / 60).rounded(.up))
        let days = minutes / 1440
        let hours = (minutes % 1440) / 60
        let mins = minutes % 60
        if days > 0 { return "\(days)d \(hours)h" }
        if hours > 0 { return "\(hours)h \(mins)m" }
        return "\(mins)m"
    }

    /// The full sentence for the Live tab's whisper line.
    static func line(at now: Date = Date()) -> String? {
        guard let text = countdown(at: now) else { return nil }
        if text == "expired" { return "App signature expired · reinstall from Xcode" }
        return "Signed for \(text) more"
    }

    static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    /// What rides up in the socket hello so the daemon knows the real date.
    static var signedUntilISO: String? {
        expiresAt.map { iso.string(from: $0) }
    }

    // ── Pre-expiry notifications ─────────────────────────────────────

    private static let noteIds = ["signing-expiry-24h", "signing-expiry-3h"]

    /// Arm "the app dies tomorrow" and "the app dies in three hours" pings.
    /// Idempotent (fixed identifiers) and re-run on every foreground, so a
    /// fresh install re-arms for its own new date. A notification is the
    /// only thing that can reach him when the app is not open, and a
    /// silently dead sideload has already cost a workout once.
    static func scheduleExpiryNotifications(now: Date = Date()) {
        guard !Demo.active, let expires = expiresAt else { return }
        let center = UNUserNotificationCenter.current()
        // Never be the one to raise the system permission prompt: iOS asks
        // exactly once per install, and a "Don't Allow" at a context-free
        // moment (first launch, settings sheet still open) would also kill
        // the rest-over notification. The rest timer asks, in context; this
        // clock only rides along once permission exists.
        center.getNotificationSettings { settings in
            guard settings.authorizationStatus == .authorized
                || settings.authorizationStatus == .provisional else { return }
            DispatchQueue.main.async { arm(center: center, expires: expires, now: now) }
        }
    }

    private static func arm(center: UNUserNotificationCenter, expires: Date, now: Date) {
        center.removePendingNotificationRequests(withIdentifiers: noteIds)
        let leads: [(id: String, lead: TimeInterval, body: String)] = [
            (noteIds[0], 24 * 3600, "The health app's signature expires tomorrow at %@. Plug in and reinstall from Xcode before then or it stops launching."),
            (noteIds[1], 3 * 3600, "Three hours left on the health app's signature (%@). Reinstall from Xcode now."),
        ]
        let clock = DateFormatter()
        clock.dateFormat = "EEE HH:mm"
        let when = clock.string(from: expires)
        for item in leads {
            let fireAt = expires.addingTimeInterval(-item.lead)
            guard fireAt > now else { continue }
            let content = UNMutableNotificationContent()
            content.title = "Sideload clock"
            content.body = String(format: item.body, when)
            content.sound = .default
            let trigger = UNTimeIntervalNotificationTrigger(
                timeInterval: max(1, fireAt.timeIntervalSince(now)), repeats: false)
            center.add(UNNotificationRequest(identifier: item.id, content: content, trigger: trigger))
        }
    }

    // ── Reading the embedded profile ─────────────────────────────────

    private static func load() -> Profile? {
        guard let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
              let data = try? Data(contentsOf: url) else { return nil }
        return parse(data)
    }

    /// The file is a CMS (PKCS#7) envelope around an XML plist. Rather than
    /// verify the signature (Security.framework's CMS API is macOS-only), cut
    /// the plist out by its markers and let PropertyListSerialization read it;
    /// iOS already verified the signature or the app would not be running.
    static func parse(_ data: Data) -> Profile? {
        guard let open = data.range(of: Data("<plist".utf8)),
              let close = data.range(of: Data("</plist>".utf8), in: open.upperBound..<data.endIndex)
        else { return nil }
        let slice = data.subdata(in: open.lowerBound..<close.upperBound)
        guard let plist = try? PropertyListSerialization.propertyList(from: slice, format: nil),
              let dict = plist as? [String: Any],
              let expires = dict["ExpirationDate"] as? Date
        else { return nil }
        return Profile(
            expiresAt: expires,
            name: dict["Name"] as? String,
            team: (dict["TeamName"] as? String))
    }
}
