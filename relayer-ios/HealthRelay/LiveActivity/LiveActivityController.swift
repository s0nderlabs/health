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
// this class; it posts .hrSessionEnded, which is the ONLY path that may end a
// session from the card side. Foreground sync adopts the card's state only
// while the session machine is cold: the card is a display, not an authority,
// and a dead or lagging card must never disarm a live session.

import ActivityKit
import Foundation

extension Notification.Name {
    static let hrSessionEnded = Notification.Name("hr.session.ended")
}

final class LiveActivityController: ObservableObject {
    static let shared = LiveActivityController()

    // Observable mirror of the card's session face, for in-app UI (the Live
    // tab's bottom control transforms while a session runs). Display truth
    // only: the session MACHINE stays SessionProgress; every mutator below
    // runs on main by construction.
    @Published private(set) var sessionUp = false
    @Published private(set) var sessionTitle: String?
    @Published private(set) var sessionStartedAt: Date?

    private func mirrorSession() {
        sessionUp = state.sessionActive
        sessionTitle = state.sessionActive ? state.title : nil
        sessionStartedAt = state.sessionActive ? state.startedAt : nil
    }

    /// Simulator-only screenshot hook: drive the session mirror directly.
    func demoSession(title: String, startedAt: Date) {
        guard Demo.active else { return }
        sessionUp = true
        sessionTitle = title
        sessionStartedAt = startedAt
    }

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

    /// Only a LIVE card counts. iOS hard-ends every Live Activity at the ~8h
    /// system cap, and the corpse lingers in .activities (and on the lock
    /// screen for hours) silently swallowing updates. Treating a corpse as
    /// "the card" froze the lock screen at the gym AND let its stale
    /// sessionActive=false veto a real session (Jul 10).
    private var current: Activity<PulseAttributes>? {
        Activity<PulseAttributes>.activities.first { $0.activityState == .active }
    }

    /// Dismiss anything the system already ended so a fresh card can take
    /// the slot. Ending an ended activity is a safe no-op server-side; the
    /// point is clearing it off the lock screen and out of .activities.
    private func reapDeadActivities() {
        for activity in Activity<PulseAttributes>.activities
        where activity.activityState != .active {
            Task { await activity.end(nil, dismissalPolicy: .immediate) }
        }
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

    /// Arm the pulse card. Called on every app-foreground; a no-op when a
    /// LIVE activity is already up or activities are disabled in Settings.
    func ensurePulse() {
        guard !Demo.active, Settings.shared.configured else { return }
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        reapDeadActivities()
        if let activity = current {
            // Adopt the live card's truth (the End button may have demoted
            // it while we weren't looking) UNLESS this process owns a live
            // session: then our snapshot is the authority and the card only
            // lags it (an in-flight update must never clobber the machine).
            if !SessionProgress.shared.sessionActive {
                state = activity.content.state
                mirrorSession()
            }
            return
        }
        // No live card. If a session is armed, re-request wearing the
        // session face (the 8h cap can kill the card mid-workout); else
        // start from the quiet pulse default.
        if !SessionProgress.shared.sessionActive {
            state = PulseAttributes.ContentState(
                bpm: nil, zone: nil, sessionActive: false, startedAt: nil,
                title: "Live", planLine: nil, stateLine: "waiting for the band",
                restEndsAt: nil, restLabel: nil)
        }
        _ = try? Activity.request(
            attributes: PulseAttributes(),
            content: .init(state: state, staleDate: nil))
        mirrorSession()
    }

    /// Intent tap: the card grows into the session face.
    func startSession(title: String, planLine: String?) {
        guard !Demo.active else { return }
        reapDeadActivities()
        state.sessionActive = true
        state.startedAt = Date()
        state.title = title
        state.planLine = planLine
        state.restEndsAt = nil
        state.restLabel = nil
        if current != nil {
            push()
        } else if ActivityAuthorizationInfo().areActivitiesEnabled {
            state.stateLine = "phone has the band"
            _ = try? Activity.request(
                attributes: PulseAttributes(),
                content: .init(state: state, staleDate: nil))
        }
        // Unconditional: the in-app session UI (Live bar + Plan End) must
        // track the machine even when Live Activities are disabled and no
        // card can exist; an early return here left the two tabs
        // contradicting each other for the whole session.
        mirrorSession()
    }

    /// Daemon-assigned role while streaming: standby = the mac is the writer
    /// and this phone is the dual-hold hot spare. Display truth only.
    var standby = false

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
        state.stateLine = bpm == nil
            ? "signal quiet"
            : (standby ? "standby · Mac is live" : "phone has the band")
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
            // Mirror BEFORE the card guard: a corpse mid-session must not
            // strand the in-app session bar on a machine that already ended.
            mirrorSession()
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
        mirrorSession()
    }

    /// In-app End: the same demotion as the lock-screen End button, but we
    /// own the card update here (the intent path updates the activity itself).
    /// The card drops to the pulse face; checkmarks stay as the day's record.
    func endSession() {
        guard !Demo.active else { return }
        state.sessionActive = false
        state.startedAt = nil
        state.title = "Live"
        state.planLine = nil
        state.restEndsAt = nil
        state.restLabel = nil
        push()
        SessionProgress.shared.endSession()
        mirrorSession()
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
        mirrorSession()
    }

    /// Foreground reconciliation. The card is a DISPLAY of the session
    /// machine, never an authority over it, in EITHER direction: it must not
    /// disarm a session this process armed (the gym revert bug), and it must
    /// not arm one either. The intent sheet builds a session-face card for a
    /// Run without arming the plan, so card-face + cold machine does NOT
    /// imply a lost gym session. Adopt for display continuity only while the
    /// machine is cold; the End button has its own explicit path.
    func syncSessionState() {
        guard !Demo.active else { return }
        guard let activity = current else { return }
        if !SessionProgress.shared.sessionActive {
            state = activity.content.state
            mirrorSession()
        }
    }
}
