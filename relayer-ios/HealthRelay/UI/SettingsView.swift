// One-time setup + quiet operational readouts. A utility form, not a hero
// screen: everything stays at the base layer.

import SwiftUI

struct SettingsView: View {
    @ObservedObject var settings = Settings.shared
    @ObservedObject var relay: RelayController
    @ObservedObject var steps: StepsCourier
    @Environment(\.dismiss) private var dismiss
    @State private var draftHost = Settings.shared.host
    @State private var draftToken = Settings.shared.token
    @State private var draftFilter = Settings.shared.deviceFilter

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("your-mac.your-tailnet.ts.net:8443", text: $draftHost)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                    SecureField("Daemon token", text: $draftToken)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: {
                    Text("Daemon")
                } footer: {
                    Text("The tailnet address of your Mac's health daemon (tailscale serve on port 8443) and the live token from ~/.config/health/config.json.")
                }

                Section {
                    TextField("WHOOP", text: $draftFilter)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                } header: {
                    Text("Band name filter")
                } footer: {
                    Text("Only devices whose Bluetooth name contains this are ever bound. Keeps a stranger's heart-rate strap out of your archive.")
                }

                Section("Steps") {
                    LabeledContent("Source", value: stepsStateText)
                    if let at = steps.lastSyncAt {
                        LabeledContent("Last sync", value: at.formatted(.relative(presentation: .named)))
                        LabeledContent("Last batch", value: "\(steps.lastBatchCount) samples")
                    }
                    Button("Sync now") { steps.syncNow() }
                }

                Section {
                    LabeledContent("Version", value: Signing.appVersion)
                    if let expires = Signing.expiresAt {
                        LabeledContent("Signed until") {
                            Text(expires.formatted(date: .abbreviated, time: .shortened))
                        }
                        // Only the countdown ticks; a TimelineView around
                        // both rows would fuse them into one Form cell.
                        TimelineView(.periodic(from: .now, by: 60)) { context in
                            LabeledContent("Countdown") {
                                Text(Signing.countdown(at: context.date) ?? "")
                                    .monospacedDigit()
                                    .foregroundStyle(signingTint(at: context.date))
                            }
                        }
                    } else {
                        LabeledContent("Signed until", value: "No profile embedded")
                    }
                } header: {
                    Text("Sideload clock")
                } footer: {
                    Text(Signing.expiresAt == nil
                        ? "Simulator or store builds carry no provisioning profile, so there is nothing to count down."
                        : "A free-team signature lives seven days from when Xcode minted it, then iOS refuses to launch the app. You get a notification the day before and three hours out. Reinstall from Xcode (scripts/build-phone.sh install, cable in) to reset the clock.")
                }

                Section {
                    Button("Save & reconnect") {
                        settings.host = draftHost.trimmingCharacters(in: .whitespaces)
                        settings.token = draftToken.trimmingCharacters(in: .whitespaces)
                        settings.deviceFilter = draftFilter.trimmingCharacters(in: .whitespaces).isEmpty
                            ? "WHOOP"
                            : draftFilter.trimmingCharacters(in: .whitespaces)
                        relay.restart()
                        steps.startIfAuthorized()
                        dismiss()
                    }
                    .disabled(draftHost.isEmpty || draftToken.isEmpty)
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .preferredColorScheme(.dark)
    }

    private func signingTint(at now: Date) -> Color {
        switch Signing.urgency(at: now) {
        case .critical: return Theme.accent
        case .soon: return .primary
        default: return .secondary
        }
    }

    private var stepsStateText: String {
        switch steps.state {
        case .idle: return "Waiting"
        case .unavailable: return "HealthKit unavailable"
        case .denied: return "Denied in Health app"
        case .noWhoopSource: return "WHOOP not writing steps yet"
        case .active: return "WHOOP via Apple Health"
        }
    }
}
