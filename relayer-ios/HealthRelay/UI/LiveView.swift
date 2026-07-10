// The Live screen: one hero (the current state of the live signal), glass
// chrome above, one capsule CTA below. Every state of the relay machine has a
// deliberate face; "streaming" earns the accent, everything else stays calm.

import SwiftUI

struct LiveView: View {
    @ObservedObject var relay: RelayController
    @ObservedObject var plan: PlanStore
    @ObservedObject private var la = LiveActivityController.shared
    var onSettings: () -> Void = {}
    @State private var showIntent = false

    var body: some View {
        VStack(spacing: 0) {
            statusRow
                .padding(.horizontal, 20)
                .padding(.top, 10)

            Spacer()

            hero
                .frame(maxWidth: .infinity)
                .padding(.horizontal, 24)

            Spacer()

            if let ack = relay.lastAck {
                Text(ack)
                    .font(.footnote)
                    .foregroundStyle(Theme.textTertiary)
                    .padding(.bottom, 10)
                    .transition(.opacity)
            }

            Group {
                if la.sessionUp {
                    sessionBar
                        .transition(.opacity.combined(with: .move(edge: .bottom)))
                } else {
                    startButton
                        .transition(.opacity)
                }
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 12)
        }
        .background(AmbientBackground())
        .sheet(isPresented: $showIntent) {
            IntentSheet(relay: relay, plan: plan)
        }
        .animation(.easeOut(duration: 0.3), value: relay.lastAck)
        .animation(.easeOut(duration: 0.35), value: la.sessionUp)
        .onAppear {
            // Screenshot hook: HR_DEMO_SHEET=1 opens the intent sheet.
            if Demo.active, ProcessInfo.processInfo.environment["HR_DEMO_SHEET"] != nil {
                showIntent = true
            }
        }
    }

    // ── The bottom slot: CTA at rest, instrument while a session runs ─

    private var startButton: some View {
        Button {
            showIntent = true
        } label: {
            HStack(spacing: 9) {
                Image(systemName: "play.fill")
                    .font(.system(size: 13, weight: .semibold))
                Text("Start a session")
                    .font(.system(.headline, design: .rounded))
            }
            .frame(maxWidth: .infinity)
            .frame(height: 56)
        }
        // Matte accent plane: no gradient, no glow, one confident fill.
        .background(Theme.accent, in: Capsule())
        .foregroundStyle(Theme.accentInk)
    }

    /// While a session runs the CTA's job is done: the same slot becomes the
    /// session instrument (what's running, for how long, one quiet exit),
    /// mirroring the lock screen's session face. The accent stays on the live
    /// signal (the dot); End never wears it.
    private var sessionBar: some View {
        HStack(spacing: 10) {
            SessionDot()
            VStack(alignment: .leading, spacing: 1) {
                Text("SESSION")
                    .font(.system(size: 9, weight: .bold))
                    .kerning(1.1)
                    .foregroundStyle(Theme.textTertiary)
                Text(la.sessionTitle ?? "Session")
                    .font(Theme.rounded(15, .semibold))
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer(minLength: 8)
            if let started = la.sessionStartedAt {
                Text(started, style: .timer)
                    .font(Theme.rounded(15, .semibold))
                    .monospacedDigit()
                    .foregroundStyle(Theme.textPrimary)
            }
            Button(action: { LiveActivityController.shared.endSession() }) {
                HStack(spacing: 5) {
                    Image(systemName: "stop.fill")
                        .font(.system(size: 9, weight: .bold))
                    Text("End")
                        .font(Theme.rounded(12.5, .semibold))
                }
                .padding(.horizontal, 13)
                .frame(height: 28)
            }
            .background(Color.white.opacity(0.055), in: Capsule())
            .overlay(Capsule().strokeBorder(Theme.hairline, lineWidth: 1))
            .foregroundStyle(Theme.textSecondary)
        }
        .padding(.leading, 18)
        .padding(.trailing, 14)
        .frame(height: 56)
        .glassCapsule()
    }

    /// The live dot: quiet proof the session clock is running.
    private struct SessionDot: View {
        @State private var pulse = false
        var body: some View {
            Circle()
                .fill(Theme.accent)
                .frame(width: 7, height: 7)
                .opacity(pulse ? 1.0 : 0.35)
                .animation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true), value: pulse)
                .onAppear { pulse = true }
        }
    }

    // ── Glass chrome: link + band chips, one settings circle ─────────

    private var statusRow: some View {
        HStack(spacing: 8) {
            chip(
                on: relay.socketConnected,
                label: relay.socketConnected ? "Daemon" : "No daemon"
            )
            .layoutPriority(1)
            chip(
                on: relay.bandConnected,
                label: relay.bandConnected ? (relay.bandName ?? "Band") : "No band"
            )
            Spacer(minLength: 8)
            Button(action: onSettings) {
                Image(systemName: "gearshape")
                    .font(.system(size: 14))
                    .foregroundStyle(Theme.textSecondary)
                    .frame(width: 32, height: 32)
                    .glassCapsule()
                    .contentShape(Circle())
            }
        }
    }

    private func chip(on: Bool, label: String) -> some View {
        HStack(spacing: 7) {
            Circle()
                .fill(on ? Theme.okDim : Theme.textTertiary)
                .frame(width: 6, height: 6)
            Text(label)
                .font(Theme.rounded(12.5))
                .foregroundStyle(Theme.textSecondary)
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .padding(.horizontal, 13)
        .frame(height: 32)
        .glassCapsule()
    }

    // ── The hero: one face per state ─────────────────────────────────

    @ViewBuilder
    private var hero: some View {
        if !Settings.shared.configured && !Demo.active {
            heroMessage(
                icon: "gearshape",
                title: "Not set up yet",
                sub: "Add your daemon address and token in Settings."
            )
        } else {
            switch relay.mode {
            case .standdown:
                heroMessage(
                    icon: "desktopcomputer",
                    title: "Mac has the band",
                    sub: "Standing by. The moment you leave its range, this phone takes over."
                )
            case .paused:
                heroMessage(
                    icon: "arrow.left.arrow.right",
                    title: "Handing off",
                    sub: "Giving the Mac a moment to take the band back."
                )
            case .active:
                activeHero
            }
        }
    }

    @ViewBuilder
    private var activeHero: some View {
        switch relay.blePhase {
        case .streaming where relay.bpm != nil:
            streamingHero
        case .streaming, .connecting:
            heroMessage(
                icon: "dot.radiowaves.left.and.right",
                title: "Connecting",
                sub: relay.bandName ?? "Reaching the band"
            )
        case .scanning:
            heroMessage(
                icon: "magnifyingglass",
                title: "Scanning",
                sub: "Looking for \(Settings.shared.deviceFilter). Broadcast Heart Rate must be on in the WHOOP app."
            )
        case .waitingBluetooth:
            heroMessage(
                icon: "exclamationmark.triangle",
                title: "Bluetooth is off",
                sub: "Turn on Bluetooth (and allow it for this app) to hear the band."
            )
        case .off:
            heroMessage(
                icon: "moon",
                title: "Radio idle",
                sub: relay.socketConnected ? "Waiting for the daemon's go." : "Reconnecting to your Mac."
            )
        }
    }

    private var streamingHero: some View {
        VStack(spacing: 4) {
            Text("\(relay.bpm ?? 0)")
                .font(Theme.heroNumber(148))
                .monospacedDigit()
                .foregroundStyle(Theme.accent)
                .contentTransition(.numericText())
                .animation(.easeOut(duration: 0.35), value: relay.bpm)

            HStack(spacing: 7) {
                // The pulse proves the number is ALIVE, at the heart's own
                // cadence. Identity is keyed to a bpm bucket so the looping
                // animation is rebuilt when the rate meaningfully changes or
                // the signal drops and returns; otherwise repeatForever keeps
                // the first cadence it ever saw.
                HeartBeat(bpm: relay.bpm ?? 60)
                    .id(max(relay.bpm ?? 60, 40) / 5)
                Text("bpm")
                    .font(.system(.subheadline, design: .rounded).weight(.medium))
                    .foregroundStyle(Theme.textSecondary)
            }

            if let at = relay.lastFrameAt, Date().timeIntervalSince(at) > 5 {
                Text("signal quiet \(Int(Date().timeIntervalSince(at)))s")
                    .font(.caption)
                    .foregroundStyle(Theme.textTertiary)
                    .padding(.top, 6)
            } else if relay.role == "standby" {
                // Dual hold: the mac writes the record; this stream is the
                // hot spare that takes over the instant the mac goes quiet.
                Text("standby · Mac is live")
                    .font(.caption)
                    .foregroundStyle(Theme.textTertiary)
                    .padding(.top, 6)
            }
        }
    }

    private struct HeartBeat: View {
        let bpm: Int
        @State private var pulse = false

        var body: some View {
            Image(systemName: "heart.fill")
                .font(.system(size: 13))
                .foregroundStyle(Theme.accent.opacity(0.85))
                .scaleEffect(pulse ? 1.0 : 0.82)
                .animation(
                    .easeOut(duration: 60.0 / Double(max(bpm, 40)))
                    .repeatForever(autoreverses: true),
                    value: pulse
                )
                .onAppear { pulse = true }
        }
    }

    private func heroMessage(icon: String, title: String, sub: String) -> some View {
        VStack(spacing: 10) {
            Image(systemName: icon)
                .font(.system(size: 30, weight: .light))
                .foregroundStyle(Theme.textTertiary)
                .padding(.bottom, 2)
            Text(title)
                .font(.system(.title2, design: .rounded).weight(.semibold))
                .foregroundStyle(Theme.textPrimary)
            Text(sub)
                .font(.subheadline)
                .foregroundStyle(Theme.textSecondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 280)
        }
    }
}

// ── Intent sheet: today's session in ONE tap, anything else in two ──────

struct IntentSheet: View {
    @ObservedObject var relay: RelayController
    @ObservedObject var plan: PlanStore
    @Environment(\.dismiss) private var dismiss
    @State private var custom = ""

    private let presets = ["Lifting", "Run", "Cycling", "Tennis", "Walk", "Stretch"]
    private let columns = [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)]

    /// Today's plan title, only when the plan IS today's and not a rest day.
    /// A stale plan must never label tomorrow's session.
    private var todayTitle: String? {
        guard let p = plan.plan, p.rest != true,
              let date = p.date, let title = p.title, !title.isEmpty else { return nil }
        let fmt = DateFormatter()
        fmt.dateFormat = "yyyy-MM-dd"
        return fmt.string(from: Date()) == date ? title : nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Starting now")
                .font(.system(.title3, design: .rounded).weight(.semibold))
                .foregroundStyle(Theme.textPrimary)
                .padding(.top, 22)

            if let title = todayTitle {
                Button {
                    send(title)
                } label: {
                    HStack(spacing: 14) {
                        ZStack {
                            Circle().fill(Theme.accentInk.opacity(0.14))
                            Image(systemName: "play.fill")
                                .font(.system(size: 12, weight: .bold))
                        }
                        .frame(width: 36, height: 36)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("TODAY'S SESSION")
                                .font(.system(size: 10, weight: .bold))
                                .kerning(1.2)
                                .opacity(0.62)
                            Text(title)
                                .font(.system(size: 18, weight: .bold, design: .rounded))
                                .lineLimit(1)
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 17)
                    .padding(.vertical, 15)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .background(Theme.accent, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                .foregroundStyle(Theme.accentInk)

                Text("OR SOMETHING ELSE")
                    .font(Theme.sectionLabel(10))
                    .kerning(1.4)
                    .foregroundStyle(Theme.textTertiary)
                    .padding(.leading, 4)
                    .padding(.bottom, -6)
            }

            LazyVGrid(columns: columns, spacing: 10) {
                ForEach(presets, id: \.self) { activity in
                    Button {
                        send(activity)
                    } label: {
                        Text(activity)
                            .font(Theme.rounded(15.5))
                            .frame(maxWidth: .infinity)
                            .frame(height: 48)
                    }
                    .background(Color.white.opacity(0.055), in: Capsule())
                    .overlay(Capsule().strokeBorder(Theme.hairline, lineWidth: 1))
                    .foregroundStyle(Theme.textPrimary)
                }
            }

            HStack(spacing: 10) {
                TextField("Something else", text: $custom)
                    .textFieldStyle(.plain)
                    .padding(.horizontal, 18)
                    .frame(height: 48)
                    .background(Color.white.opacity(0.055), in: Capsule())
                    .overlay(Capsule().strokeBorder(Theme.hairline, lineWidth: 1))
                    .foregroundStyle(Theme.textPrimary)
                Button {
                    guard !custom.trimmingCharacters(in: .whitespaces).isEmpty else { return }
                    send(custom)
                } label: {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 16, weight: .semibold))
                        .frame(width: 48, height: 48)
                }
                .background(Color.white.opacity(0.08), in: Circle())
                .overlay(Circle().strokeBorder(Theme.hairline, lineWidth: 1))
                .foregroundStyle(Theme.textSecondary)
            }

            Spacer()
        }
        .padding(.horizontal, 20)
        .presentationDetents([.medium])
        .presentationBackground(.ultraThinMaterial)
        .presentationDragIndicator(.visible)
    }

    private func send(_ activity: String) {
        let name = activity.trimmingCharacters(in: .whitespaces)
        relay.sendIntent(name)
        let isTodaySession = name == todayTitle
        LiveActivityController.shared.startSession(
            title: name,
            planLine: isTodaySession ? PlanLines.firstLine(plan.plan) : nil)
        // Only today's gym session arms the plan; a run is not a checklist.
        if isTodaySession { SessionProgress.shared.beginSession() }
        dismiss()
    }
}
