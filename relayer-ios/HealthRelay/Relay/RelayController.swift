// The hub: owns both legs, runs the CLIENT side of the daemon's arbitration
// (the daemon decides who holds the band; this class obeys), publishes state
// for the UI, and carries the phone-only surfaces (intent taps, steps batches,
// plan-updated pushes).
//
// Arbitration contract (daemon -> phone):
//   standdown        radio off, keep the socket, wait
//   resume           scan again
//   pause {seconds}  radio off for a probe window; a standdown or resume
//                    verdict follows. If neither arrives (socket died mid-
//                    probe), a safety timer resumes scanning.

import Foundation
import Combine

// Not @MainActor: both legs are pinned to the main queue by construction
// (CBCentralManager queue .main, URLSession delegateQueue .main), so every
// delegate callback and every @Published mutation is already on main.
final class RelayController: ObservableObject, SocketLegDelegate, BleLegDelegate {
    enum ServerMode: Equatable {
        case active
        case standdown
        case paused
    }

    @Published var socketConnected = false
    @Published var mode: ServerMode = .active
    @Published var blePhase: BleLeg.Phase = .off
    @Published var bandConnected = false
    @Published var bandName: String?
    @Published var bpm: Int?
    @Published var lastFrameAt: Date?
    @Published var lastAck: String?

    /// Set by the app: fired when the daemon pushes plan_updated OR when the
    /// socket reconnects (a push may have been missed while it was down).
    var onPlanUpdated: (() -> Void)?
    /// Set by StepsCourier: fired when the daemon acks a steps batch.
    var onStepsAck: (() -> Void)?

    private let socket = SocketLeg()
    private let ble = BleLeg()
    private var pauseSafety: DispatchWorkItem?
    private var frames = 0

    init() {
        socket.delegate = self
        ble.delegate = self
    }

    func start() {
        guard Settings.shared.configured else { return }
        socket.start()
        // Capture-first: BLE comes up before the daemon's verdict arrives, so
        // a dead tailnet link never costs frames (the socket buffer holds ~10
        // minutes). If the mac owns the band, hello answers standdown and the
        // radio goes right back off.
        applyMode(.active)
    }

    func restart() {
        pauseSafety?.cancel()
        socket.stop()
        ble.setEnabled(false)
        start()
    }

    func sendIntent(_ activity: String) {
        socket.sendJSON(["type": "intent", "activity": activity])
    }

    func sendSteps(_ samples: [[String: Any]], deleted: [String] = []) {
        guard !samples.isEmpty || !deleted.isEmpty else { return }
        socket.sendJSON(["type": "steps", "samples": samples, "deleted": deleted])
    }

    private func applyMode(_ newMode: ServerMode) {
        mode = newMode
        ble.setEnabled(newMode == .active && Settings.shared.configured)
    }

    // ── SocketLegDelegate ────────────────────────────────────────────
    // Demo guards: in HR_DEMO the real legs still exist (the simulator's
    // Bluetooth reports dead, the socket can't connect); their callbacks must
    // not stomp the driven state.

    func socketDidConnect() {
        guard !Demo.active else { return }
        socketConnected = true
        // A plan_updated push only reaches CURRENTLY-connected relayers, so a
        // plan rewritten during a socket blip would be missed while the app
        // stays foregrounded (scenePhase never re-fires). Reconcile on connect.
        onPlanUpdated?()
    }

    func socketDidDisconnect(reason: String) {
        guard !Demo.active else { return }
        socketConnected = false
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
            applyMode(.active)
        case "standdown":
            pauseSafety?.cancel()
            rlog("daemon: standdown (mac owns the band)")
            applyMode(.standdown)
            // Home: the mac streams now; the session (if any) is over.
            LiveActivityController.shared.macTookBand()
            SessionProgress.shared.endSession()
        case "resume":
            pauseSafety?.cancel()
            rlog("daemon: resume")
            applyMode(.active)
        case "pause":
            let seconds = (payload["seconds"] as? Double) ?? 25
            rlog("daemon: pause \(seconds)s (mac reacquire probe)")
            applyMode(.paused)
            // Safety: if the verdict never lands, scanning must come back.
            pauseSafety?.cancel()
            let work = DispatchWorkItem { [weak self] in
                guard let self = self, self.mode == .paused else { return }
                rlog("no verdict after the pause window; resuming capture")
                self.applyMode(.active)
            }
            pauseSafety = work
            DispatchQueue.main.asyncAfter(deadline: .now() + seconds + 20, execute: work)
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
        default:
            break
        }
    }

    // ── BleLegDelegate ───────────────────────────────────────────────

    func bleFrame(_ raw: Data) {
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
