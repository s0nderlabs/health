// The widget extension: renders the Live Activity's two faces on the lock
// screen. Same design system as the app (Theme.swift is compiled in). No
// looping animations here: WidgetKit renders snapshots, so the heart is
// still and the timer ticks because iOS itself renders timer text.

import ActivityKit
import SwiftUI
import WidgetKit

@main
struct HealthRelayWidgets: WidgetBundle {
    var body: some Widget {
        PulseActivityWidget()
    }
}

struct PulseActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: PulseAttributes.self) { context in
            LockScreenCard(state: context.state)
                .activityBackgroundTint(Color(red: 0.11, green: 0.102, blue: 0.094).opacity(0.66))
                .activitySystemActionForegroundColor(Theme.textPrimary)
        } dynamicIsland: { context in
            // The iPhone 12 has no island; this is the minimal required face
            // for devices that do.
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    bpmCompact(context.state)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    if let started = context.state.startedAt {
                        Text(timerInterval: started...Date(timeIntervalSinceNow: 8 * 3600), countsDown: false)
                            .monospacedDigit()
                            .foregroundStyle(Theme.textPrimary)
                    }
                }
            } compactLeading: {
                Image(systemName: "heart.fill").foregroundStyle(Theme.accent)
            } compactTrailing: {
                Text(context.state.bpm.map(String.init) ?? "--")
                    .monospacedDigit()
                    .foregroundStyle(Theme.accent)
            } minimal: {
                Image(systemName: "heart.fill").foregroundStyle(Theme.accent)
            }
        }
    }

    private func bpmCompact(_ state: PulseAttributes.ContentState) -> some View {
        HStack(spacing: 4) {
            Image(systemName: "heart.fill").foregroundStyle(Theme.accent)
            Text(state.bpm.map(String.init) ?? "--")
                .monospacedDigit()
                .foregroundStyle(Theme.accent)
        }
    }
}

struct LockScreenCard: View {
    let state: PulseAttributes.ContentState

    var body: some View {
        if state.sessionActive {
            sessionFace
        } else {
            pulseFace
        }
    }

    // ── Pulse face: one quiet row ────────────────────────────────────

    private var pulseFace: some View {
        HStack(spacing: 10) {
            mark
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(state.bpm.map(String.init) ?? "--")
                    .font(.system(size: 30, weight: .bold, design: .rounded))
                    .monospacedDigit()
                    .foregroundStyle(Theme.accent)
                Image(systemName: "heart.fill")
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.accent.opacity(0.85))
                Text("bpm")
                    .font(.system(size: 12.5, weight: .medium, design: .rounded))
                    .foregroundStyle(Theme.textSecondary)
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 2) {
                Text(state.stateLine)
                    .font(.system(size: 12.5, weight: .medium, design: .rounded))
                    .foregroundStyle(Theme.textSecondary)
                Text("live")
                    .font(.system(size: 10.5))
                    .foregroundStyle(Theme.textTertiary)
            }
        }
        .padding(.horizontal, 17)
        .padding(.vertical, 13)
    }

    // ── Session face: the between-sets glance ────────────────────────

    private var sessionFace: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 9) {
                mark
                Text(state.title.uppercased())
                    .font(.system(size: 12, weight: .semibold, design: .rounded))
                    .kerning(0.9)
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(1)
                Spacer(minLength: 8)
                if let started = state.startedAt {
                    Text(timerInterval: started...Date(timeIntervalSinceNow: 8 * 3600), countsDown: false)
                        .font(.system(size: 22, weight: .semibold, design: .rounded))
                        .monospacedDigit()
                        .foregroundStyle(Theme.textPrimary)
                        .frame(maxWidth: 76, alignment: .trailing)
                }
            }
            HStack(alignment: .lastTextBaseline) {
                HStack(alignment: .firstTextBaseline, spacing: 7) {
                    Text(state.bpm.map(String.init) ?? "--")
                        .font(.system(size: 48, weight: .bold, design: .rounded))
                        .monospacedDigit()
                        .foregroundStyle(Theme.accent)
                    Image(systemName: "heart.fill")
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.accent.opacity(0.85))
                    Text("bpm")
                        .font(.system(size: 14, weight: .medium, design: .rounded))
                        .foregroundStyle(Theme.textSecondary)
                }
                Spacer()
                if let zone = state.zone, zone > 0 {
                    Text("zone \(zone)")
                        .font(.system(size: 12, weight: .semibold, design: .rounded))
                        .foregroundStyle(Theme.textPrimary)
                        .padding(.horizontal, 11)
                        .padding(.vertical, 4)
                        .background(Color.white.opacity(0.09), in: Capsule())
                }
            }
            .padding(.top, 8)
            HStack(spacing: 8) {
                if let rest = state.restEndsAt, rest > Date() {
                    // The rest countdown: iOS ticks this text itself.
                    Text("REST")
                        .font(.system(size: 9.5, weight: .bold))
                        .kerning(1.1)
                        .foregroundStyle(Theme.textTertiary)
                    Text(timerInterval: Date()...rest, countsDown: true)
                        .font(.system(size: 15, weight: .semibold, design: .rounded))
                        .monospacedDigit()
                        .foregroundStyle(Theme.textPrimary)
                        .frame(maxWidth: 52, alignment: .leading)
                    if let then = state.restLabel {
                        Text("then \(then)")
                            .font(.system(size: 12.5, weight: .medium, design: .rounded))
                            .foregroundStyle(Theme.textSecondary)
                            .lineLimit(1)
                    }
                } else {
                    Text("NEXT")
                        .font(.system(size: 9.5, weight: .bold))
                        .kerning(1.1)
                        .foregroundStyle(Theme.textTertiary)
                    Text(state.planLine ?? "listen to the body")
                        .font(.system(size: 13, weight: .medium, design: .rounded))
                        .foregroundStyle(Theme.textSecondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 8)
                Button(intent: EndSessionIntent()) {
                    Text("End")
                        .font(.system(size: 12, weight: .semibold, design: .rounded))
                        .foregroundStyle(Theme.textSecondary)
                        .padding(.horizontal, 13)
                        .padding(.vertical, 5)
                        .background(Color.white.opacity(0.09), in: Capsule())
                }
                .buttonStyle(.plain)
            }
            .padding(.top, 11)
            .overlay(alignment: .top) {
                Rectangle().fill(Theme.hairline).frame(height: 1).offset(y: 5)
            }
        }
        .padding(.horizontal, 17)
        .padding(.vertical, 15)
    }

    private var mark: some View {
        Image(systemName: "waveform.path.ecg")
            .font(.system(size: 14, weight: .semibold))
            .foregroundStyle(Theme.accent)
    }
}
