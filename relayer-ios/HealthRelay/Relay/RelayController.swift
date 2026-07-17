// The hub: owns both legs, runs the CLIENT side of the daemon's arbitration
// (the daemon decides who holds the band; this class obeys), publishes state
// for the UI, and carries the phone-only surfaces (intent taps, steps batches,
// plan-updated pushes).
//
// Arbitration contract (daemon -> phone):
//   standdown        release the band but stay ARMED: a pending connect to
//                    the remembered band waits silently (the band only
//                    advertises when the mac loses it), so walking out of the
//                    mac's range hands the feed over without opening the app
//   resume           take the band back (direct reconnect, no scan needed)
//   pause {seconds}  radio truly silent for a probe window; a standdown or
//                    resume verdict follows. The whole window runs inside a
//                    UIKit background task: without it, iOS suspends the
//                    radio-silent app in seconds and the verdict never
//                    arrives (no BLE wake source), orphaning the feed until
//                    the next foreground. If the window expires with no
//                    verdict, we self-resume before suspension.

import Foundation
import Combine
import UIKit

// Not @MainActor: both legs are pinned to the main queue by construction
// (CBCentralManager queue .main, URLSession delegateQueue .main), so every
// delegate callback and every @Published mutation is already on main.
final class RelayController: ObservableObject, SocketLegDelegate, BleLegDelegate {
    enum ServerMode: Equatable {
        case active
        case standdown
        case paused
        /// Yield: the band is surrendered to an external app (Strava). Radio
        /// fully off, nothing armed, and CRUCIALLY no capture-first fallback:
        /// a dead socket must not re-grab the band mid-recording.
        case disarmed
    }

    @Published var socketConnected = false
    @Published var mode: ServerMode = .active
    @Published var blePhase: BleLeg.Phase = .off
    @Published var bandConnected = false
    @Published var bandName: String?
    @Published var bpm: Int?
    @Published var lastFrameAt: Date?
    @Published var lastAck: String?
    /// Daemon-assigned dual-hold role: "standby" while the mac writes and
    /// this phone shadows as the hot spare; nil/"primary" otherwise.
    @Published var role: String?

    /// Set by the app: fired when the daemon pushes plan_updated OR when the
    /// socket reconnects (a push may have been missed while it was down).
    var onPlanUpdated: (() -> Void)?
    /// Set by StepsCourier: fired when the daemon acks a steps batch.
    var onStepsAck: (() -> Void)?

    private let socket = SocketLeg()
    private let ble = BleLeg()
    private var pauseSafety: DispatchWorkItem?
    private var pauseTask: UIBackgroundTaskIdentifier = .invalid
    private var frames = 0

    init() {
        socket.delegate = self
        ble.delegate = self
        // Power state feeds the daemon's dual-up gate: a hot-standby BLE
        // connection at home is only worth holding on wall power or a
        // comfortable charge.
        UIDevice.current.isBatteryMonitoringEnabled = true
        for name in [UIDevice.batteryLevelDidChangeNotification,
                     UIDevice.batteryStateDidChangeNotification] {
            NotificationCenter.default.addObserver(
                forName: name, object: nil, queue: .main
            ) { [weak self] _ in self?.sendBattery() }
        }
    }

    private func sendBattery() {
        let level = UIDevice.current.batteryLevel
        guard level >= 0 else { return } // -1 = unknown (simulator)
        let state = UIDevice.current.batteryState
        socket.sendJSON([
            "type": "battery",
            "level": Double(level),
            "charging": state == .charging || state == .full,
        ])
    }

    func start() {
        guard Settings.shared.configured else { return }
        socket.start()
        // A persisted yield outranks capture-first: coming up armed here
        // would grab the band Strava is recording from. The hello reply
        // corrects either way (disarm refreshes it; ok/standdown clears it).
        if YieldState.active {
            rlog("start: persisted yield active; staying disarmed until the daemon says otherwise")
            applyMode(.disarmed)
            return
        }
        YieldState.clear() // an expired window must not linger
        // Capture-first: BLE comes up before the daemon's verdict arrives, so
        // a dead tailnet link never costs frames (the socket buffer holds ~10
        // minutes). If the mac owns the band, hello answers standdown and the
        // radio goes right back off.
        applyMode(.active)
    }

    func restart() {
        pauseSafety?.cancel()
        endPauseTask()
        socket.stop()
        ble.reset() // settings may now name a different band
        start()
    }

    /// Foreground nudge (scenePhase active): give a long-stale pending
    /// connect a chance to trade itself for a fresh scan. Also the reliable
    /// wake for a suspended-through-expiry yield: the daemon's rearm push
    /// lands on a dead socket, so the expiry check must live here.
    func kick() {
        if mode == .disarmed && !YieldState.active {
            rlog("yield window expired while suspended; resuming capture")
            YieldState.clear()
            applyMode(.active)
            return
        }
        ble.kick()
    }

    func sendIntent(_ activity: String) {
        socket.sendJSON(["type": "intent", "activity": activity])
    }

    /// One-tap yield toggle (the "give the band to Strava" button). A
    /// physical switch: minutes 0 = INDEFINITE, on until tapped off, so no
    /// timer can ever re-arm us mid-recording. The daemon's disarm/rearm
    /// pushes drive the actual state change; the ack is tap feedback only.
    func requestYield(minutes: Int = 0) {
        socket.sendJSON(["type": "yield_request", "minutes": minutes])
    }

    func requestReclaim() {
        socket.sendJSON(["type": "reclaim_request"])
    }

    /// The reclaim tap, socket-aware: with the daemon reachable it asks (the
    /// rearm push flips state); without it, reclaim LOCALLY so a yielded
    /// phone away from the tailnet is never stranded dark. If the daemon is
    /// still yielded when the socket returns, its hello verdict re-disarms:
    /// the daemon stays the source of truth.
    func reclaimTapped() {
        if socketConnected {
            requestReclaim()
        } else {
            rlog("reclaim tapped with no daemon; reclaiming locally")
            YieldState.clear()
            applyMode(.active)
            lastAck = "reclaimed locally (daemon unreachable)"
        }
    }

    func sendSteps(_ samples: [[String: Any]], deleted: [String] = []) {
        guard !samples.isEmpty || !deleted.isEmpty else { return }
        socket.sendJSON(["type": "steps", "samples": samples, "deleted": deleted])
    }

    private func applyMode(_ newMode: ServerMode) {
        // The one radio chokepoint enforces the yield invariant: NOTHING may
        // arm while a persisted yield is active (a stale pauseSafety timer, a
        // future code path). Callers that intend to arm must clear YieldState
        // first (rearm/ok/local reclaim all do).
        var applied = newMode
        if newMode == .active && YieldState.active {
            rlog("applyMode(.active) vetoed by active yield; staying disarmed")
            applied = .disarmed
        }
        if mode == .paused && applied != .paused { endPauseTask() }
        mode = applied
        guard Settings.shared.configured else {
            ble.apply(.off)
            return
        }
        switch applied {
        case .active:
            ble.apply(.on)
        case .standdown:
            // Parked, not dead: BleLeg keeps a pending connect armed on the
            // remembered band. While the mac holds it the band never
            // advertises, so this sits silent; the moment the band frees
            // (walked out of range, mac relayer died) the connect fires,
            // wakes the app, and capture resumes without a foreground.
            ble.apply(.on)
        case .paused:
            // Truly silent: the probe window is the mac's exclusive shot at
            // the band, so no pending connect either (it would win the race
            // instantly, since the freed band is right on our wrist).
            ble.apply(.off)
        case .disarmed:
            // Yield: same radio-off primitive as pause, but with no
            // self-resume of any kind; only a daemon verdict or the persisted
            // window expiring brings capture back.
            ble.apply(.off)
        }
    }

    // A pause with the screen locked is lethal without this: radio off means
    // no BLE wake source, iOS suspends us in seconds, and the daemon's
    // resume verdict lands on a socket nobody is reading.
    private func beginPauseTask() {
        endPauseTask()
        pauseTask = UIApplication.shared.beginBackgroundTask(withName: "band-pause-probe") { [weak self] in
            guard let self = self else { return }
            if self.mode == .paused {
                rlog("background window expiring mid-pause; self-resuming capture")
                self.pauseSafety?.cancel()
                self.applyMode(.active) // also ends the task
            } else {
                self.endPauseTask()
            }
        }
    }

    private func endPauseTask() {
        guard pauseTask != .invalid else { return }
        UIApplication.shared.endBackgroundTask(pauseTask)
        pauseTask = .invalid
    }

    // ── SocketLegDelegate ────────────────────────────────────────────
    // Demo guards: in HR_DEMO the real legs still exist (the simulator's
    // Bluetooth reports dead, the socket can't connect); their callbacks must
    // not stomp the driven state.

    func socketDidConnect() {
        guard !Demo.active else { return }
        socketConnected = true
        sendBattery() // hello carries caps; this completes the dual-up gate
        // A plan_updated push only reaches CURRENTLY-connected relayers, so a
        // plan rewritten during a socket blip would be missed while the app
        // stays foregrounded (scenePhase never re-fires). Reconcile on connect.
        onPlanUpdated?()
    }

    func socketDidDisconnect(reason: String) {
        guard !Demo.active else { return }
        socketConnected = false
        // A disarmed leg MUST NOT capture-first: the socket dying is the
        // expected next event after a disarm (radio off -> iOS suspends us),
        // and resuming here would grab the band right out of Strava's hands.
        // The persisted window is the authority; it expiring restores
        // capture-first on the next wake.
        if mode == .disarmed {
            if YieldState.active {
                rlog("socket lost while disarmed (yield active); staying dark")
                return
            }
            rlog("socket lost while disarmed but the yield window has expired; resuming capture")
            YieldState.clear()
            applyMode(.active)
            return
        }
        // No daemon means no arbitration: if we were parked in standdown or
        // paused, the verdict source is gone. Capture-first applies again.
        if mode != .active {
            rlog("socket lost while \(mode == .paused ? "paused" : "standing down"); resuming capture")
            pauseSafety?.cancel()
            applyMode(.active)
        }
    }

    func socketCommand(_ type: String, payload: [String: Any]) {
        guard !Demo.active else { return }
        switch type {
        case "ok":
            // Also the rearm backstop: a hello answered 'ok' means no yield
            // is active, so any persisted disarm is stale.
            YieldState.clear()
            applyMode(.active)
        case "standdown":
            pauseSafety?.cancel()
            YieldState.clear() // daemon verdicts outrank a stale yield
            rlog("daemon: standdown (mac owns the band)")
            applyMode(.standdown)
            role = nil
            LiveActivityController.shared.standby = false
            // Home: the mac streams now; the session (if any) is over.
            LiveActivityController.shared.macTookBand()
            SessionProgress.shared.endSession()
        case "resume":
            pauseSafety?.cancel()
            YieldState.clear()
            rlog("daemon: resume")
            applyMode(.active)
        case "disarm":
            // Yield: the user gave the band to an external app. Persist the
            // window FIRST: if iOS suspends/relaunches us mid-yield, the
            // restoration path and start() must both see it.
            pauseSafety?.cancel()
            if let until = payload["until"] as? Double { YieldState.set(untilMs: until) }
            rlog("daemon: disarm (yield): band surrendered")
            applyMode(.disarmed)
            role = nil
            LiveActivityController.shared.standby = false
            LiveActivityController.shared.bandYielded()
            SessionProgress.shared.endSession()
        case "rearm":
            pauseSafety?.cancel()
            YieldState.clear()
            rlog("daemon: rearm (yield over)")
            applyMode(.active)
        case "release":
            // Dual-up race: let the band go; the anchor re-arms on disconnect
            // and races the mac into the advertising window. Mode is untouched:
            // whoever wins (ideally both) settles through frames + arbitration.
            rlog("daemon: release (dual-up)")
            ble.release()
        case "role":
            let role = (payload["role"] as? String) ?? "primary"
            rlog("daemon: role \(role)")
            self.role = role
            LiveActivityController.shared.standby = role == "standby"
        case "pause":
            let seconds = (payload["seconds"] as? Double) ?? 25
            rlog("daemon: pause \(seconds)s (mac reacquire probe)")
            beginPauseTask() // keep us runnable for the whole probe window
            applyMode(.paused)
            // Safety: if the verdict never lands, capture must come back.
            // Kept inside the ~30s background grant (the daemon's verdict is
            // due at seconds + one arb tick); the task's expiration handler
            // is the harder backstop.
            pauseSafety?.cancel()
            let work = DispatchWorkItem { [weak self] in
                guard let self = self, self.mode == .paused else { return }
                rlog("no verdict after the pause window; resuming capture")
                self.applyMode(.active)
            }
            pauseSafety = work
            DispatchQueue.main.asyncAfter(deadline: .now() + seconds + 8, execute: work)
        case "plan_updated":
            rlog("daemon: plan updated")
            onPlanUpdated?()
        case "steps_ack":
            let added = (payload["added"] as? Int) ?? 0
            let removed = (payload["deleted"] as? Int) ?? 0
            lastAck = removed > 0 ? "steps synced (\(added) new, \(removed) revised)" : "steps synced (\(added) new)"
            onStepsAck?() // commit the anchor + drain any remaining pages

        case "intent_ack":
            let activity = (payload["activity"] as? String) ?? ""
            lastAck = "intent logged: \(activity)"
        case "yield_ack":
            lastAck = "band yielded until you reclaim: pair it in Strava now"
        case "reclaim_ack":
            lastAck = "reclaimed: hunting the band"
        default:
            break
        }
    }

    // ── BleLegDelegate ───────────────────────────────────────────────

    /// iOS relaunched us for a BLE event (state restoration): boot() never
    /// runs on a background relaunch, so bring the socket up here. During a
    /// yield this is load-bearing: the hello reaches the daemon inside the
    /// wake window and its disarm verdict keeps the radio dark.
    func bleDidRestore() {
        guard !Demo.active, Settings.shared.configured else { return }
        if YieldState.active && mode != .disarmed { applyMode(.disarmed) }
        socket.start()
    }

    func bleFrame(_ raw: Data) {
        // A frame while parked means the standdown anchor fired: the band
        // left the mac and this phone caught it. Promote locally, capture-
        // first; the daemon confirms with a resume on its next tick.
        if mode == .standdown {
            rlog("parked anchor fired; capture resumed")
            mode = .active
        }
        socket.sendJSON([
            "type": "hr",
            "ts": Int(Date().timeIntervalSince1970 * 1000),
            "raw": raw.base64EncodedString(),
        ])
        frames += 1
        if let parsed = HrLocal.parse(raw), parsed.contact != false {
            bpm = parsed.bpm
            lastFrameAt = Date()
            LiveActivityController.shared.update(bpm: parsed.bpm)
        }
    }

    func bleStatus(connected: Bool, device: String?) {
        guard !Demo.active else { return }
        bandConnected = connected
        if connected { bandName = device }
        if !connected {
            bpm = nil
            LiveActivityController.shared.update(bpm: nil)
        }
        socket.setDevice(device)
        var status: [String: Any] = ["type": "status", "connected": connected]
        if let device = device { status["device"] = device }
        socket.sendJSON(status)
    }

    func blePhase(_ phase: BleLeg.Phase) {
        guard !Demo.active else { return }
        blePhase = phase
    }
}
