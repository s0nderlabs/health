// Set-by-set session state: which rungs are done, and the rest countdown.
// Scoped to ONE plan day (keyed by the plan's date): checking off Friday's
// deadlift ladder can never bleed into Saturday. The Live Activity mirrors
// both the pointer and the rest timer; a local notification pings when rest
// is over so the locked phone still coaches.

import Foundation
import UserNotifications

/// Without this, iOS silently swallows the rest-over ping whenever the app
/// is foregrounded: exactly the moment you're staring at the plan between
/// sets. Banner + sound, always.
final class RestNotificationDelegate: NSObject, UNUserNotificationCenterDelegate {
    static let shared = RestNotificationDelegate()

    func install() {
        UNUserNotificationCenter.current().delegate = self
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        // Banner only: foreground audio is RestChime's job (its playback
        // session beats the mute switch, which notification sound cannot),
        // and two sounds for one expiry would be noise.
        completionHandler([.banner])
    }
}

final class SessionProgress: ObservableObject {
    static let shared = SessionProgress()

    @Published private(set) var done: Set<String> = []
    @Published private(set) var restEndsAt: Date?
    @Published private(set) var restLabel: String?
    /// The plan is a document until the session starts; then it's an
    /// instrument. Checkboxes and rest timers exist only while this is true.
    @Published private(set) var sessionActive = false

    private var planKey = ""
    private static let storeKey = "session_progress_v1"
    private static let restNoteId = "rest-timer"
    /// When the scene last became active; distantPast until first activation.
    private var sceneActivatedAt = Date.distantPast

    /// Stamped by the app on every scene activation, so the chime can tell
    /// a watched crossing from a return AFTER the notification already rang.
    func noteSceneActive() {
        sceneActivatedAt = Date()
    }

    /// Tokens: "L2" = whole lift at index 2, "L2R4" = rung 4 of lift 2.
    static func lift(_ i: Int) -> String { "L\(i)" }
    static func rung(_ i: Int, _ j: Int) -> String { "L\(i)R\(j)" }

    func attach(planKey: String) {
        guard !planKey.isEmpty, planKey != self.planKey else { return }
        self.planKey = planKey
        let all = UserDefaults.standard.dictionary(forKey: Self.storeKey) as? [String: [String]] ?? [:]
        done = Set(all[planKey] ?? [])
    }

    func isDone(_ token: String) -> Bool { done.contains(token) }

    func beginSession() {
        sessionActive = true
    }

    /// Disarm, keep the checkmarks: they are the day's record.
    func endSession() {
        sessionActive = false
        cancelRest()
    }

    /// Toggle a token; returns true when it just became done.
    @discardableResult
    func toggle(_ token: String) -> Bool {
        let nowDone: Bool
        if done.contains(token) {
            done.remove(token)
            nowDone = false
        } else {
            done.insert(token)
            nowDone = true
        }
        // Only today's key survives: yesterday's checkmarks are history, not state.
        UserDefaults.standard.set([planKey: Array(done)], forKey: Self.storeKey)
        return nowDone
    }

    // ── Rest timer ───────────────────────────────────────────────────

    func startRest(seconds: TimeInterval, thenLine: String?) {
        guard seconds > 0 else { return }
        let ends = Date().addingTimeInterval(seconds)
        restEndsAt = ends
        restLabel = thenLine
        LiveActivityController.shared.startRest(seconds: seconds, thenLine: thenLine)
        scheduleRestNotification(at: ends, thenLine: thenLine)
    }

    func cancelRest() {
        guard restEndsAt != nil else { return }
        restEndsAt = nil
        restLabel = nil
        LiveActivityController.shared.clearRest()
        UNUserNotificationCenter.current()
            .removePendingNotificationRequests(withIdentifiers: [Self.restNoteId])
    }

    /// Called by the UI's ticker when the countdown crosses zero.
    func restExpiredIfNeeded() {
        if let ends = restEndsAt, ends <= Date() {
            restEndsAt = nil
            restLabel = nil
            LiveActivityController.shared.clearRest()
            // Chime only for a crossing the app actually watched: fresh
            // (not a return minutes later) AND the scene was already active
            // before the countdown hit zero. A background expiry sounds via
            // the notification; opening the app right after it must not
            // ring the same rest twice.
            if Date().timeIntervalSince(ends) <= 3, sceneActivatedAt < ends {
                RestChime.play()
            }
        }
    }

    private func scheduleRestNotification(at date: Date, thenLine: String?) {
        guard !Demo.active else { return }
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
            guard granted else { return }
            let content = UNMutableNotificationContent()
            content.title = "Rest over"
            content.body = thenLine.map { "Next: \($0)" } ?? "Back to the bar."
            content.sound = RestChime.notificationSound
            // Cuts through a gym Focus/DND. It does not beat the mute
            // switch: locked + muted still degrades to vibration.
            content.interruptionLevel = .timeSensitive
            let trigger = UNTimeIntervalNotificationTrigger(
                timeInterval: max(1, date.timeIntervalSinceNow), repeats: false)
            center.removePendingNotificationRequests(withIdentifiers: [Self.restNoteId])
            center.add(UNNotificationRequest(
                identifier: Self.restNoteId, content: content, trigger: trigger))
        }
    }
}
