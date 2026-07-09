// Owns the lock-screen Live Activity from the app side. iOS only lets an app
// START an activity while foregrounded (push-to-start needs paid APNs), so
// foreground moments arm the pulse card; after that, the background BLE
// runloop keeps it honest.
//
// Concurrency contract: this class owns the AUTHORITATIVE ContentState.
// Every mutator runs on the main queue (PlanView gestures, the BLE delegate,
// scenePhase are all main by construction), mutates `state` synchronously,
// and enqueues a full-snapshot push on a SERIAL task chain. Reading
// activity.content.state per-mutation was a read-modify-write race: two
// same-turn mutators (setPlanLine + startRest on a set check-off) captured
// the same base state and the late apply clobbered the early one, dropping
// the rest countdown. The lock-screen End button runs in-process but outside
// this class; it posts .hrSessionEnded, and foreground sync re-adopts the
// activity's truth whenever the app comes back.

import ActivityKit
import Foundation

extension Notification.Name {
    static let hrSessionEnded = Notification.Name("hr.session.ended")
}

final class LiveActivityController {
    static let shared = LiveActivityController()

    private var state = PulseAttributes.ContentState(
        bpm: nil, zone: nil, sessionActive: false, startedAt: nil,
        title: "Live", planLine: nil, stateLine: "waiting for the band",
        restEndsAt: nil, restLabel: nil)
    private var pipeline: Task<Void, Never>?
    private var lastPush = Date.distantPast
    private var lastZone: Int?

    private init() {
        NotificationCenter.default.addObserver(
            forName: .hrSessionEnded, object: nil, queue: .main
        ) { [weak self] _ in
            self?.sessionEndedFromLockScreen()
        }
    }

    private var current: Activity<PulseAttributes>? {
        Activity<PulseAttributes>.activities.first
    }

    /// Serialize full-snapshot applies so the last mutation always wins.
    private func push() {
        guard let activity = current else { return }
        let snapshot = state
        let previous = pipeline
        pipeline = Task {
            await previous?.value
            await activity.update(ActivityContent(state: snapshot, staleDate: nil))
        }
    }

    /// Arm the pulse card. Called on every app-foreground; a no-op when an
    /// activity is already up or activities are disabled in Settings.
    func ensurePulse() {
        guard !Demo.active, Settings.shared.configured else { return }
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        if let activity = current {
            // Adopt the activity's truth (the End button may have demoted it
            // while we weren't looking) before pushing anything new.
            state = activity.content.state
            return
        }
        state = PulseAttributes.ContentState(
            bpm: nil, zone: nil, sessionActive: false, startedAt: nil,
            title: "Live", planLine: nil, stateLine: "waiting for the band",
            restEndsAt: nil, restLabel: nil)
        _ = try? Activity.request(
            attributes: PulseAttributes(),
            content: .init(state: state, staleDate: nil))
    }

    /// Intent tap: the card grows into the session face.
    func startSession(title: String, planLine: String?) {
        guard !Demo.active else { return }
        state.sessionActive = true
        state.startedAt = Date()
        state.title = title
        state.planLine = planLine
        state.restEndsAt = nil
        state.restLabel = nil
        if current != nil {
            push()
        } else {
            guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
            state.stateLine = "phone has the band"
            _ = try? Activity.request(
                attributes: PulseAttributes(),
                content: .init(state: state, staleDate: nil))
        }
    }

    /// Live frames land here (already on main). Throttled to ~10s unless the
    /// zone changes; the lock screen shows trend, not telemetry.
    func update(bpm: Int?) {
        guard !Demo.active, current != nil else { return }
        let zone = bpm.map(HrZones.zone(for:))
        let now = Date()
        if now.timeIntervalSince(lastPush) < 10 && zone == lastZone { return }
        lastPush = now
        lastZone = zone
        state.bpm = bpm
        state.zone = zone
        state.stateLine = bpm == nil ? "signal quiet" : "phone has the band"
        push()
    }

    /// The between-sets rest countdown, mirrored to the lock screen.
    func startRest(seconds: TimeInterval, thenLine: String?) {
        guard !Demo.active, current != nil else { return }
        state.restEndsAt = Date().addingTimeInterval(seconds)
        state.restLabel = thenLine
        if let line = thenLine { state.planLine = line }
        push()
    }

    func clearRest() {
        guard !Demo.active, current != nil else { return }
        guard state.restEndsAt != nil else { return }
        state.restEndsAt = nil
        state.restLabel = nil
        push()
    }

    /// Completion tracking moves the pointer; the lock screen follows.
    func setPlanLine(_ line: String?) {
        guard !Demo.active, current != nil else { return }
        guard state.planLine != line else { return }
        state.planLine = line
        push()
    }

    /// Mac took the band back. A running SESSION is over (you're home), so
    /// it ends. The PULSE card survives with an honest state line: iOS won't
    /// let a background app re-arm an activity, so keeping it alive is the
    /// only way BPM can reappear when you walk out of the Mac's range.
    func macTookBand() {
        guard !Demo.active else { return }
        state.bpm = nil
        state.zone = nil
        state.stateLine = "Mac has the band"
        state.restEndsAt = nil
        state.restLabel = nil
        if state.sessionActive {
            state.sessionActive = false
            state.startedAt = nil
            state.title = "Live"
            state.planLine = nil
            guard let activity = current else { return }
            let snapshot = state
            let previous = pipeline
            pipeline = Task {
                await previous?.value
                await activity.end(
                    ActivityContent(state: snapshot, staleDate: nil),
                    dismissalPolicy: .immediate)
            }
        } else {
            push()
        }
    }

    /// The lock screen's End button demoted the activity in its own flow;
    /// bring our authoritative state and the session machine along.
    private func sessionEndedFromLockScreen() {
        guard !Demo.active else { return }
        state.sessionActive = false
        state.startedAt = nil
        state.title = "Live"
        state.planLine = nil
        state.restEndsAt = nil
        state.restLabel = nil
        SessionProgress.shared.endSession()
    }

    /// Foreground reconciliation: adopt whatever the activity says now.
    func syncSessionState() {
        guard !Demo.active else { return }
        guard let activity = current else { return }
        state = activity.content.state
        if !state.sessionActive && SessionProgress.shared.sessionActive {
            SessionProgress.shared.endSession()
        }
    }
}
