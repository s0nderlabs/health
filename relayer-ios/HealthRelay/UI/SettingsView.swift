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
    @ObservedObject private var probe = LiftProbe.shared
    /// The Diagnostics section: hidden until five quick taps on Version, then
    /// kept (the test's result must still be here after he locks the phone).
    @State private var diagnostics = Demo.active
        ? ProcessInfo.processInfo.environment["HR_DEMO_DIAG"] != nil // tests start hidden
        : UserDefaults.standard.bool(forKey: "diagnostics_revealed")
    @State private var versionTaps: [Date] = []

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
            ScrollViewReader { proxy in
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
                        .contentShape(Rectangle())
                        .onTapGesture(perform: tapVersion)
                        .accessibilityIdentifier("settings.version")
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

                if diagnostics {
                    diagnosticsSection
                        .id("diagnostics")
                        .onAppear { probe.prepare() }
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
            .onAppear {
                #if DEBUG && targetEnvironment(simulator)
                // Simulator transport test against a throwaway sink (see
                // Settings.liftURL's HR_LIFT_* overrides). Never on the phone.
                if ProcessInfo.processInfo.environment["HR_LIFT_PROBE_AUTOSTART"] != nil {
                    rlog("lift probe: autostart (running=\(probe.running))")
                    probe.start()
                }
                #endif
                // Screenshot hook: HR_DEMO_DIAG=scroll parks Diagnostics in view.
                if Demo.active, ProcessInfo.processInfo.environment["HR_DEMO_DIAG"] == "scroll" {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
                        proxy.scrollTo("diagnostics", anchor: .top)
                    }
                }
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

    // ── Diagnostics ──────────────────────────────────────────────────

    /// Five taps on Version inside three seconds.
    private func tapVersion() {
        let now = Date()
        versionTaps = versionTaps.filter { now.timeIntervalSince($0) < 3 } + [now]
        guard versionTaps.count >= 5, !diagnostics else { return }
        versionTaps = []
        if !Demo.active { UserDefaults.standard.set(true, forKey: "diagnostics_revealed") }
        withAnimation { diagnostics = true }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }

    private var diagnosticsSection: some View {
        Section {
            VStack(alignment: .leading, spacing: 4) {
                Text("Background upload test")
                Text(probeHint)
                    .font(.footnote)
                    .foregroundStyle(probe.running ? Color.primary : Color.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.vertical, 2)
            ForEach(LiftProbe.order, id: \.self) { t in
                probeRow(t)
            }
            if probe.running {
                Button(probe.preparing ? "Writing the 50 MB test file…" : "Stop test", role: .destructive) {
                    probe.reset()
                }
                .disabled(probe.preparing)
                .accessibilityIdentifier("diag.probe.stop")
            } else {
                Button(probe.runs.isEmpty ? "Start test" : "Run again") { probe.start() }
                    .accessibilityIdentifier("diag.probe.start")
            }
            Picker("Lift clips go via", selection: $settings.liftTransport) {
                ForEach(LiftTransport.allCases, id: \.self) { t in
                    Text(t.title).tag(t)
                }
            }
            // A setting, not an action: the value stays neutral so it never
            // reads like the accent buttons above it.
            .tint(.secondary)
            .accessibilityIdentifier("diag.transport")
        } header: {
            Text("Diagnostics")
        } footer: {
            Text("Lift clips upload through iOS's background transfer service, which runs outside this app, so they cannot use the in-app tunnel. Tailscale host resolves the ts.net name (iCloud Private Relay can break that); Tailnet IP dials the Mac directly over plain HTTP inside WireGuard. Pick the one that passed.")
        }
    }

    /// "Lock now" only once the running upload exists: a task created after
    /// the lock is one iOS may defer, which would make the test meaningless.
    /// The paths go one after the other, so the hint says which one is on.
    private var probeHint: String {
        if probe.preparing { return "Getting ready. Keep the app open for a moment." }
        let n = LiftProbe.order.count
        if let t = LiftProbe.order.first(where: { probe.run($0).inFlight }) {
            let at = probe.slot(t)
            if at < n, LiftProbe.order.contains(where: { probe.run($0).state == .queued }) {
                return "Sending \(at) of \(n). Lock the phone now and leave it. The next path starts when this one finishes, or, if the phone is still locked then, when you next open the app."
            }
            return "Sending \(at) of \(n). Lock the phone now and leave it: that is the test. The result waits here."
        }
        if let t = LiftProbe.order.first(where: { probe.run($0).state == .queued }) {
            return "Starting \(probe.slot(t)) of \(n). Lock the phone again once it says Sending."
        }
        return "Sends 50 MB to the Mac over each path, one after the other so they never share the link, through a background session. Start it, then lock the phone when this says so."
    }

    private func probeRow(_ t: LiftTransport) -> some View {
        let r = probe.run(t)
        // "1 of 2": where this path goes in the run. A result saved before the
        // probe went sequential has no order (both ran at once): no prefix.
        let n = LiftProbe.order.count
        let pos = (r.order ?? (r.state == .idle ? LiftProbe.position(t) : nil)).map { "\($0) of \(n) · " } ?? ""
        let ahead = LiftProbe.order.prefix(while: { $0 != t }).last
        let status: (text: String, color: Color) = {
            switch r.state {
            case .idle: return ("Not run", .secondary)
            case .queued: return (r.held ? "Waiting" : "Next", .secondary)
            case .waiting: return ("Waiting", .secondary)
            case .uploading: return ("\(Int((Double(r.sent) / Double(max(r.total, 1)) * 100).rounded(.down)))%", .primary)
            case .ok: return ("OK", Theme.okDim)
            // Not the accent: that colour is for actions (Run again).
            case .failed: return ("Failed", .secondary)
            }
        }()
        let detail: String = pos + {
            switch r.state {
            case .idle, .waiting: return t.detail
            case .queued:
                if r.held { return "\(t.detail) · waiting to start, open the app" }
                let first = ahead.map { "\(probe.slot($0)) of \(n)" } ?? "the one before"
                return "\(t.detail) · starts when \(first) finishes"
            case .uploading: return "\(t.detail) · \(LiftFormat.progress(r.sent, of: r.total))"
            case .ok:
                var parts = [t.detail, LiftFormat.size(r.serverBytes ?? r.total)]
                if let s = r.seconds { parts[1] += String(format: " in %.1f s", s) }
                if let ms = r.serverMs { parts.append("server \(FoodFormat.int(Double(ms))) ms") }
                return parts.joined(separator: " · ")
            case .failed: return "\(t.detail) · \(r.error ?? "unknown error")"
            }
        }()
            + (r.held && r.state != .queued ? " · started once the app was open" : "")
            + (r.background ? " · started with the app in the background, so iOS may have deferred it: run again" : "")
        let selected = settings.liftTransport == t
        let info = VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline) {
                Text(t.title)
                Spacer()
                if r.state == .waiting || r.state == .uploading {
                    ProgressView().controlSize(.mini).padding(.trailing, 4)
                }
                if r.state == .ok {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.okDim)
                }
                if r.state == .failed {
                    Image(systemName: "xmark.circle")
                        .font(.system(size: 13))
                        .foregroundStyle(.secondary)
                }
                Text(status.text)
                    .monospacedDigit()
                    .foregroundStyle(status.color)
            }
            Text(detail)
                .font(.footnote)
                .monospacedDigit()
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("diag.probe.\(t.rawValue)")
        return VStack(alignment: .leading, spacing: 3) {
            info
            if selected {
                Text("Lift clips go this way")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else if r.state == .ok {
                // The path that passed, one tap from being the one clips use.
                Button("Use this path") { settings.liftTransport = t }
                    .font(.footnote.weight(.semibold))
                    .buttonStyle(.borderless)
                    .padding(.top, 2)
                    .accessibilityIdentifier("diag.probe.use.\(t.rawValue)")
            }
        }
        .padding(.vertical, 2)
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
