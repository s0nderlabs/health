// HealthRelay: the iPhone leg of the health plugin. BLE dumb pipe for the
// band's Broadcast HR, HealthKit steps courier, workout-intent trigger, and
// the /gym plan in your pocket. All interpretation happens daemon-side.

import SwiftUI

@main
struct HealthRelayApp: App {
    @StateObject private var relay = RelayController()
    @StateObject private var steps = StepsCourier()
    @StateObject private var plan = PlanStore()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView(relay: relay, steps: steps, plan: plan)
                .preferredColorScheme(.dark)
                .tint(Theme.accent)
                .onAppear { boot() }
                .onChange(of: scenePhase) { _, phase in
                    if phase == .active {
                        SessionProgress.shared.noteSceneActive()
                        plan.refresh()
                        steps.syncNow()
                        relay.kick() // trade a long-stale pending connect for a scan
                        // Foreground is the only moment iOS lets us arm the
                        // lock-screen pulse card; every open re-arms it.
                        LiveActivityController.shared.ensurePulse()
                        LiveActivityController.shared.syncSessionState()
                        // Re-armed every open: a fresh install carries a
                        // fresh death date and the old pings must follow it.
                        Signing.scheduleExpiryNotifications()
                    }
                }
        }
    }

    private func boot() {
        RestNotificationDelegate.shared.install()
        relay.onPlanUpdated = { plan.refresh() }
        #if DEBUG
        if ProcessInfo.processInfo.environment["HR_DEMO"] != nil {
            DemoDriver.shared.drive(relay: relay, plan: plan)
            return
        }
        #endif
        guard Settings.shared.configured else { return }
        relay.start()
        steps.attach(relay)
        steps.startIfAuthorized()
        plan.refresh()
    }
}

struct RootView: View {
    @ObservedObject var relay: RelayController
    @ObservedObject var steps: StepsCourier
    @ObservedObject var plan: PlanStore
    @ObservedObject private var progress = SessionProgress.shared
    @State private var showSettings = false
    @State private var tab = ProcessInfo.processInfo.environment["HR_DEMO_TAB"] == "plan" ? 1 : 0

    var body: some View {
        TabView(selection: $tab) {
            LiveView(relay: relay, plan: plan, onSettings: { showSettings = true })
                .tabItem { Label("Live", systemImage: "waveform.path.ecg") }
                .tag(0)
            PlanView(store: plan, onStartSession: startTodaySession, onEndSession: endTodaySession)
                .tabItem { Label("Plan", systemImage: "list.bullet.rectangle") }
                .tag(1)
        }
        .background(Theme.ground.ignoresSafeArea())
        .overlay(alignment: .bottom) {
            // The rest countdown floats above the tab pill on both tabs.
            if let ends = progress.restEndsAt {
                RestPill(ends: ends, label: progress.restLabel) {
                    progress.cancelRest()
                }
                .padding(.bottom, 98)
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(.easeOut(duration: 0.3), value: progress.restEndsAt)
        .sheet(isPresented: $showSettings) {
            SettingsView(relay: relay, steps: steps)
        }
        .onAppear {
            if !Settings.shared.configured && !Demo.active { showSettings = true }
            // Screenshot hook: HR_DEMO_SETTINGS=1 opens the settings sheet.
            if Demo.active, ProcessInfo.processInfo.environment["HR_DEMO_SETTINGS"] != nil {
                showSettings = true
            }
        }
    }

    /// The Plan tab's Start capsule: same cascade as the intent sheet's
    /// coral card. Claude learns, the lock screen transforms, the plan arms.
    private func startTodaySession() {
        guard let today = plan.plan, today.rest != true, let title = today.title else { return }
        relay.sendIntent(title)
        LiveActivityController.shared.startSession(
            title: title, planLine: PlanLines.firstLine(today))
        SessionProgress.shared.beginSession()
    }

    /// In-app End: mirror of the lock screen's End button.
    private func endTodaySession() {
        LiveActivityController.shared.endSession()
    }
}

/// The between-sets companion: a glass capsule counting down the prescribed
/// rest, with what comes next. Mirrored on the lock screen by the Live
/// Activity; this is the in-app face.
struct RestPill: View {
    let ends: Date
    let label: String?
    var cancel: () -> Void
    @State private var now = Date()
    private let tick = Timer.publish(every: 0.5, on: .main, in: .common).autoconnect()

    var body: some View {
        HStack(spacing: 9) {
            Text("REST")
                .font(.system(size: 10, weight: .bold))
                .kerning(1.1)
                .foregroundStyle(Theme.textTertiary)
            Text(remaining)
                .font(Theme.rounded(17, .semibold))
                .monospacedDigit()
                .foregroundStyle(Theme.textPrimary)
            if let label = label {
                Text("then \(label)")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(1)
                    .frame(maxWidth: 170, alignment: .leading)
            }
            Button(action: cancel) {
                Image(systemName: "xmark")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Theme.textTertiary)
                    .frame(width: 28, height: 28)
                    .contentShape(Circle())
            }
        }
        .padding(.leading, 16)
        .padding(.trailing, 5)
        .frame(height: 44)
        .glassCapsule()
        .onReceive(tick) { time in
            now = time
            SessionProgress.shared.restExpiredIfNeeded()
        }
    }

    private var remaining: String {
        let left = max(0, Int(ends.timeIntervalSince(now).rounded()))
        return String(format: "%d:%02d", left / 60, left % 60)
    }
}

#if DEBUG
/// Simulator-only demo state so the UI can be seen (and screenshotted) with
/// realistic content before any daemon or band is in reach. HR_DEMO=1.
final class DemoDriver {
    static let shared = DemoDriver()
    private var timer: Timer?
    private var bpm = 128.0

    func drive(relay: RelayController, plan: PlanStore) {
        relay.socketConnected = true
        relay.bandConnected = true
        relay.bandName = "WHOOP 5B01348592"
        relay.blePhase = .streaming("WHOOP 5B01348592")
        relay.mode = .active
        // HR_DEMO_YIELD=1: the yielded face (band surrendered to Strava).
        if ProcessInfo.processInfo.environment["HR_DEMO_YIELD"] != nil {
            relay.mode = .disarmed
            relay.bandConnected = false
            relay.bandName = nil
            relay.blePhase = .off
            relay.bpm = nil
            return
        }
        // Timer fires on the main run loop; published mutations stay on main.
        timer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [self] _ in
            bpm += Double.random(in: -2.5...2.7)
            bpm = min(max(bpm, 122), 168)
            relay.bpm = Int(bpm)
            relay.lastFrameAt = Date()
        }
        let dateFmt = DateFormatter()
        dateFmt.dateFormat = "yyyy-MM-dd"
        let today = dateFmt.string(from: Date())
        let generated = ISO8601DateFormatter().string(from: Date().addingTimeInterval(-720))
        // HR_DEMO_RIDE=easy|quality|long: the ride half of the day.
        // easy = Monday 2 h before Day 1; quality = Tuesday 4x8 before Day 2;
        // long = Saturday ride-only with a route + clock (lifts empty).
        let rideMode = ProcessInfo.processInfo.environment["HR_DEMO_RIDE"] ?? ""
        let rideBlock: String
        switch rideMode {
        case "easy":
            rideBlock = """
              "ride": {
                "slot": "05:00", "kind": "easy",
                "title": "Easy 2 h, the first of the new weekday length",
                "duration_min": 120, "venue": "your call, easy roads",
                "structure": [
                  {"order": 1, "name": "Whole ride",
                   "detail": "2 h continuous, Z1 into low Z2. Nowhere near 144.",
                   "target": "full comfortable sentences the entire time"}
                ],
                "hr_readout": "Z2 ceiling 144, but this ride should sit well under it. LTHR 156 is the anchor. Talk test is primary, HR is secondary, do not police the bpm.",
                "cues": [
                  "if hour one does not feel too easy, it is too hard",
                  "this ends ~07:00 against a 14:00 squat. The ride yields to the lift.",
                  "optional: run the three-state talk test, comfortable vs yes-but vs no"
                ],
                "notes": "First 2 h weekday ride, stepped up from 50 min on Aug 26."
              },
            """
        case "quality":
            rideBlock = """
              "ride": {
                "slot": "05:00", "kind": "quality",
                "title": "4 × 8 min, Sudirman",
                "duration_min": 70, "venue": "Sudirman, Bundaran Senayan to Bundaran HI",
                "segments": ["6200488 northbound 4,883.5 m", "6200491 southbound 4,856.7 m"],
                "structure": [
                  {"order": 1, "name": "Transit", "detail": "7.86 km easy, ~20 min. Soft, so the reps are the only load."},
                  {"order": 2, "name": "Rep 1", "detail": "8:00 Senayan to HI, northbound", "target": "self-graded maximal tolerable, this rep sets the ceiling"},
                  {"order": 3, "name": "Recovery", "detail": "out-and-back: 2:00 away, u-turn, 2:00 back", "rest": "4 min"},
                  {"order": 4, "name": "Rep 2", "detail": "8:00 HI to Senayan, southbound", "target": "breath, not speed, going south"},
                  {"order": 5, "name": "Recovery", "detail": "out-and-back", "rest": "4 min"},
                  {"order": 6, "name": "Rep 3", "detail": "8:00 northbound", "target": "compare to rep 1, same direction"},
                  {"order": 7, "name": "Recovery", "detail": "out-and-back", "rest": "4 min"},
                  {"order": 8, "name": "Rep 4", "detail": "8:00 southbound", "target": "compare to rep 2. Empty the tank only in the last minute."},
                  {"order": 9, "name": "Transit home", "detail": "easy spin"}
                ],
                "hr_readout": "151-159 sustained is the target. 164 is the demonstrated blow-up line, 142 is too easy by your own grade. HR lags 30-60 s, pace the first 2 min off breathing.",
                "cues": ["rep 1 sets the ceiling", "three words at most", "the roundabout caps the rep: 8:00 or the roundabout, whichever comes first"],
                "notes": "Never ride into roundabout traffic at speed."
              },
            """
        case "long":
            rideBlock = """
              "ride": {
                "slot": "05:30", "kind": "long",
                "title": "Long ride, build Saturday 1 of 3",
                "duration_min": 210, "venue": "Binloop out to Sudirman and back",
                "structure": [
                  {"order": 1, "name": "Hour one", "detail": "Z1 into low Z2. Should feel too easy.", "target": "that feeling is the plan, not a mistake"},
                  {"order": 2, "name": "Middle", "detail": "steady Z2, 132-144. No chasing riders, no sprinting lights."},
                  {"order": 3, "name": "Last hour", "detail": "hold the same effort as the heat arrives. Slower speed at the same effort is correct."}
                ],
                "hr_readout": "Z2 is 132-144. Touching 148 is the top of your real range, not a failure. Sustaining 150+ for hours is the TBK mistake.",
                "cues": ["stop only to refill", "drink every 15 min, big swallows", "full comfortable sentences = Z2, whatever the screen says"],
                "route": {"file": "demo-route.gpx", "name": "CFD Sudirman loop"},
                "timeline": [
                  {"at": "05:30", "kind": "note", "what": "Roll out, both bottles full"},
                  {"at": "06:15", "kind": "gel", "what": "Gel 1 (EJ)"},
                  {"at": "06:30", "kind": "drink", "what": "First bottle should be empty"},
                  {"at": "07:00", "kind": "gel", "what": "Gel 2 (EJ)"},
                  {"at": "07:20", "kind": "cp", "what": "Refill: Lawson Bendungan Hilir", "km": 28.5},
                  {"at": "07:45", "kind": "gel", "what": "Gel 3 (Beta Fuel)"},
                  {"at": "08:30", "kind": "gel", "what": "Gel 4 (EJ)"},
                  {"at": "09:00", "kind": "note", "what": "Home. Eat sitting up, not lying flat."}
                ]
              },
            """
        default:
            rideBlock = ""
        }
        let isLong = rideMode == "long"
        let warmupJSON = """
          [
            "Light cardio 3-5 min",
            "McGill Big 3: Bird Dog 1x8/side, Side Plank 1x20s/side, Curl-Up 1x5",
            "Hip mobility 2 min",
            "Glute bridges 2x10"
          ]
        """
        // The demo lifts are a real Day 1 shape: 8 lifts in locked order,
        // structured AMRAP + back-offs, so every row type renders.
        let liftsJSON = """
          [
            {"order": 1, "name": "Pullup", "weight_kg": 0, "scheme": "5x2",
             "notes": "grease-the-groove, submax doubles ~1 RIR, never to failure"},
            {"order": 2, "name": "Lat Pulldown", "weight_kg": 45, "scheme": "2x10-12",
             "notes": "pronated grip, first cut if the session runs long"},
            {"order": 3, "name": "Squat", "weight_kg": 65, "scheme": "2x8 + AMRAP",
             "ladder": "20x8 (60s) / 40x5 (60s) / 55x3 (90s)",
             "amrap": {"rir": "2-3", "target": ">=10"},
             "backoff": [{"weight_kg": 55, "sets": "1x8", "rest": "2-3 min"}],
             "rest": "90s-2min working sets",
             "notes": "high-bar"},
            {"order": 4, "name": "Bench, paused", "weight_kg": 42.5, "scheme": "2x8 + AMRAP",
             "ladder": "20x8 (60s) / 35x5 (90s)",
             "amrap": {"rir": "2-3"},
             "backoff": [{"weight_kg": 32.5, "sets": "1x8"}],
             "rest": "90s-2min",
             "notes": "1-2s dead-stop on chest"},
            {"order": 5, "name": "Deadlift", "weight_kg": 100, "scheme": "4x3",
             "ladder": "20x8 (60s) / 60x5 (90s) / 85x2 (2min)",
             "rest": "3-4 min",
             "notes": "mixed grip fixed: right pronated, left supinated, slack pull every rep"},
            {"order": 6, "name": "Cable Row", "weight_kg": 40, "scheme": "4x8",
             "rest": "60-90s"},
            {"order": 7, "name": "OHP", "weight_kg": 30, "scheme": "3x6",
             "notes": "strict, no leg drive"},
            {"order": 8, "name": "Lateral Raise", "weight_kg": 6, "scheme": "2x8-10",
             "notes": "strict tempo 2-0-2-1, the one isolation exception"}
          ]
        """
        let tailJSON = isLong ? """
          "session_notes": ["Rung one of three build Saturdays before the Audax 150. Distance is your call."],
          "reminders": ["Flat kit on the bike", "Plain water in both bottles"]
        """ : """
          "session_notes": ["Bar speed rules: if the last working set grinds, that is fatigue talking, not weakness."],
          "reminders": ["5g creatine on waking", "Liquid chalk", "Black coffee sips between sets"]
        """
        let title = isLong
            ? "Saturday · long ride"
            : (rideMode == "quality" ? "Day 2 · Full Body 6s, plus the 4×8" : "Day 1 · Full Body 8s")
        // HR_DEMO_RECOVERY=amber|red swaps the coach's margin note so every
        // band colour can be screenshotted.
        let recoveryNote: String
        switch ProcessInfo.processInfo.environment["HR_DEMO_RECOVERY"] {
        case "amber":
            recoveryNote = "Recovery 51%, amber on 5h02m sleep. Top set to a single on any grind, and the farmer carry is the first thing cut."
        case "red":
            recoveryNote = "Recovery 22%, red. Surface the number, your call. If you go, the AMRAP is off and everything is RIR 3."
        default:
            recoveryNote = isLong
                ? "Recovery 68%, green. Hour one too easy is the whole plan."
                : "Recovery 74%, green. Full volume as written. AMRAPs at RIR 2-3, you train solo."
        }
        let sample = """
        {
          "generated_at": "\(generated)",
          "date": "\(today)",
          "title": "\(title)",
          "cycle": 2, "week": 1, "day": \(isLong ? 0 : 1),
          "rest": false,
          "recovery_note": "\(recoveryNote)",
          "warmup": \(isLong ? "[]" : warmupJSON),
          \(rideBlock)
          "lifts": \(isLong ? "[]" : liftsJSON),
          \(tailJSON)
        }
        """
        if let data = sample.data(using: .utf8),
           let decoded = try? JSONDecoder().decode(Plan.self, from: data) {
            plan.plan = decoded
        }
        // HR_DEMO_SESSION=1: the Live tab's running-session face (the bottom
        // slot transformed into the session instrument).
        if ProcessInfo.processInfo.environment["HR_DEMO_SESSION"] != nil {
            LiveActivityController.shared.demoSession(
                title: "Day 1 · Full Body 8s",
                startedAt: Date().addingTimeInterval(-1543))
        }
        // HR_DEMO_ARMED=1: session just started, nothing checked yet: the
        // clean armed face with every circle empty.
        if ProcessInfo.processInfo.environment["HR_DEMO_ARMED"] != nil {
            let sp = SessionProgress.shared
            sp.attach(planKey: "\(today)|\(generated)")
            sp.beginSession()
        }
        // HR_DEMO_PROGRESS=1: a mid-session snapshot for screenshots: squat
        // ramp checked off, rest running toward the working sets.
        if ProcessInfo.processInfo.environment["HR_DEMO_PROGRESS"] != nil {
            let sp = SessionProgress.shared
            // Same composite key PlanView.attachProgress builds; a bare date
            // here would land the demo checkmarks under a key nobody reads.
            sp.attach(planKey: "\(today)|\(generated)")
            sp.beginSession()
            // Pullup 5x2 and Lat Pulldown 2x10-12 expand into per-set rungs
            // now, so "done" means their rung tokens, not the lift tokens.
            let done = (0..<5).map { SessionProgress.rung(0, $0) }
                + (0..<2).map { SessionProgress.rung(1, $0) }
                + (0..<3).map { SessionProgress.rung(2, $0) }
            for token in done where !sp.isDone(token) {
                sp.toggle(token)
            }
            sp.startRest(seconds: 143, thenLine: "Squat 65 ×8 · 1/2")
        }
    }
}
#endif
