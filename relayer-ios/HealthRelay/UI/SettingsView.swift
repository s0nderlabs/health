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
    @State private var draftIP = Settings.shared.tailnetIP
    @State private var draftSource = Settings.shared.tailnetIPSource
    /// The host name draftIP was learned for. An auto IP belongs to that
    /// name only; Save drops it if the host now names a different machine.
    @State private var draftIPFor = Settings.shared.hostName
    @State private var finding = false
    @State private var findFailed = false

    /// Empty is fine (hostname path); anything else must be a tailnet address.
    private var draftIPValid: Bool {
        let ip = draftIP.trimmingCharacters(in: .whitespaces)
        return ip.isEmpty || TailnetTunnel.Route.isTailnetIP(ip)
    }

    /// Typing marks the value manual, so boot never overwrites it (clearing
    /// included: an empty manual field is the hostname-path rollback).
    private var ipBinding: Binding<String> {
        Binding(get: { draftIP }, set: {
            draftIP = $0
            draftSource = "manual"
            findFailed = false
        })
    }

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
                    HStack {
                        // Not .decimalPad: some locales put a comma there.
                        TextField("Auto (asks Tailscale)", text: ipBinding)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .keyboardType(.numbersAndPunctuation)
                        Button("Find") { findIP() }
                            .buttonStyle(.borderless)
                            .disabled(finding || Settings.hostName(draftHost) == nil)
                    }
                } header: {
                    Text("Daemon")
                } footer: {
                    Text(daemonFooter)
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
                        : "A free-team signature lives seven days, then iOS refuses to launch the app. Auto re-sign renews it when the phone is unlocked at home on Wi-Fi; if it has not by the last day, you get a phone and Mac notification. Manual fallback: scripts/build-phone.sh install.")
                }

                Section {
                    Button("Save & reconnect") {
                        let host = draftHost.trimmingCharacters(in: .whitespaces)
                        var ip = draftIP.trimmingCharacters(in: .whitespaces)
                        var source = draftSource
                        // An auto IP learned for another name would splice
                        // the new name's TLS to the old Mac: drop it and let
                        // the learn below find the right one.
                        if source != "manual", Settings.hostName(host) != draftIPFor {
                            ip = ""
                            source = ""
                        }
                        settings.host = host
                        settings.token = draftToken.trimmingCharacters(in: .whitespaces)
                        settings.tailnetIP = ip
                        settings.tailnetIPSource = source
                        settings.deviceFilter = draftFilter.trimmingCharacters(in: .whitespaces).isEmpty
                            ? "WHOOP"
                            : draftFilter.trimmingCharacters(in: .whitespaces)
                        relay.restart()
                        // A first-run sheet or an emptied auto field would
                        // otherwise wait for the next foreground to learn.
                        relay.learnTailnetIP(force: true)
                        steps.startIfAuthorized()
                        dismiss()
                    }
                    .disabled(draftHost.isEmpty || draftToken.isEmpty || !draftIPValid)
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

    private var daemonFooter: String {
        if !draftIPValid { return "Tailnet IP must be a 100.64.0.0/10 address, or empty." }
        if findFailed {
            return "No verified answer: Tailscale DNS was silent or the Mac did not respond at that IP. Is Tailscale on? You can type the IP from the Mac (tailscale ip -4)."
        }
        return "The tailnet address of your Mac's health daemon (tailscale serve on port 8443) and the live token from ~/.config/health/config.json. With the Mac's tailnet IP the app skips DNS, so iCloud Private Relay can stay on. Empty = old hostname path."
    }

    /// Asks Tailscale's own resolver, never the system one (see Quad100).
    /// The same verified learn as the app's (quad-100 answer, then a
    /// /healthz probe through the tunnel), so only a proven IP lands here.
    private func findIP() {
        let host = draftHost
        guard let name = Settings.hostName(host) else { return }
        finding = true
        findFailed = false
        Quad100.discover(host: host) { ip in
            finding = false
            if let ip = ip {
                draftIP = ip
                draftSource = "auto"
                draftIPFor = name
            } else {
                findFailed = true
            }
        }
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
