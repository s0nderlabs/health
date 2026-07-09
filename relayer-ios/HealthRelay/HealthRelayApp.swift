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
                        plan.refresh()
                        steps.syncNow()
                        relay.kick() // trade a long-stale pending connect for a scan
                        // Foreground is the only moment iOS lets us arm the
                        // lock-screen pulse card; every open re-arms it.
                        LiveActivityController.shared.ensurePulse()
                        LiveActivityController.shared.syncSessionState()
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
            PlanView(store: plan, onStartSession: startTodaySession)
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
        // The demo plan is a real Day 1 shape: 8 lifts in locked order,
        // structured AMRAP + back-offs, so every row type renders.
        let sample = """
        {
          "generated_at": "\(generated)",
          "date": "\(today)",
          "title": "Day 1 · Full Body 8s",
          "cycle": 2, "week": 1, "day": 1,
          "rest": false,
          "recovery_note": "Recovery 74%, green. Full volume as written. AMRAPs at RIR 2-3, you train solo.",
          "warmup": [
            "Light cardio 3-5 min",
            "McGill Big 3: Bird Dog 1x8/side, Side Plank 1x20s/side, Curl-Up 1x5",
            "Hip mobility 2 min",
            "Glute bridges 2x10"
          ],
          "lifts": [
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
          ],
          "session_notes": ["Bar speed rules: if the last working set grinds, that is fatigue talking, not weakness."],
          "reminders": ["5g creatine on waking", "Liquid chalk", "Black coffee sips between sets"]
        }
        """
        if let data = sample.data(using: .utf8),
           let decoded = try? JSONDecoder().decode(Plan.self, from: data) {
            plan.plan = decoded
        }
        // HR_DEMO_PROGRESS=1: a mid-session snapshot for screenshots: squat
        // ramp checked off, rest running toward the working sets.
        if ProcessInfo.processInfo.environment["HR_DEMO_PROGRESS"] != nil {
            let sp = SessionProgress.shared
            sp.attach(planKey: today)
            sp.beginSession()
            for token in [SessionProgress.lift(0), SessionProgress.lift(1),
                          SessionProgress.rung(2, 0), SessionProgress.rung(2, 1),
                          SessionProgress.rung(2, 2)] where !sp.isDone(token) {
                sp.toggle(token)
            }
            sp.startRest(seconds: 143, thenLine: "Squat 65 ×8 · 2 sets")
        }
    }
}
#endif
