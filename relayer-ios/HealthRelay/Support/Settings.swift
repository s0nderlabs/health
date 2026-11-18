// One-time setup state: where the daemon lives and how to prove we belong.
// Host is not a secret (UserDefaults); the token is (Keychain).

import Foundation
import Combine

/// DEBUG demo flag (HR_DEMO=1): static, so no init-order dependency.
enum Demo {
    static let active = ProcessInfo.processInfo.environment["HR_DEMO"] != nil
}

/// The two ways a lift clip can reach the Mac (see Settings.liftURL).
enum LiftTransport: String, CaseIterable, Codable {
    case host, tailnet

    var title: String { self == .host ? "Tailscale host" : "Tailnet IP" }
    var detail: String { self == .host ? "https :8443" : "http :\(Settings.liftTailnetPort)" }
}

final class Settings: ObservableObject {
    static let shared = Settings()

    /// Tailnet hostname:port of the daemon's serve proxy,
    /// e.g. "your-mac.your-tailnet.ts.net:8443".
    @Published var host: String {
        didSet { UserDefaults.standard.set(host, forKey: "daemon_host") }
    }

    @Published var token: String {
        didSet { Keychain.set(token, for: "daemon_token") }
    }

    /// BLE name filter for the band (matches the mac relayer's default).
    @Published var deviceFilter: String {
        didSet { UserDefaults.standard.set(deviceFilter, forKey: "device_filter") }
    }

    /// The Mac's tailnet IPv4 (`tailscale ip -4`). Set: every daemon request
    /// dials it through the in-app tunnel and `host` is never resolved, so
    /// iCloud Private Relay or any other resolver cannot misroute it. Empty:
    /// the plain hostname path (also the rollback lever).
    @Published var tailnetIP: String {
        didSet { UserDefaults.standard.set(tailnetIP, forKey: "daemon_ip") }
    }

    /// Where tailnetIP came from: "auto" (learned from Tailscale DNS, boot
    /// may refresh it), "manual" (typed or deliberately cleared, never
    /// overwritten), "" (never set).
    @Published var tailnetIPSource: String {
        didSet { UserDefaults.standard.set(tailnetIPSource, forKey: "daemon_ip_source") }
    }

    /// The path lift clips take to the Mac, when chosen (the Diagnostics
    /// picker, "Use this path", or the probe adopting the path that passed).
    /// nil = not chosen: see liftTransport.
    @Published var liftTransportChoice: LiftTransport? {
        didSet {
            guard !Demo.active else { return } // screenshots never leave a choice behind
            UserDefaults.standard.set(liftTransportChoice?.rawValue, forKey: "lift_transport")
        }
    }

    /// Which path lift clips take. Unchosen, it is the tailnet IP whenever
    /// one is set: the ts.net name is resolved by the SYSTEM for a background
    /// upload (the in-app tunnel cannot carry it), and iCloud Private Relay
    /// breaks exactly that resolution (the Sep 2026 outage), where it would
    /// wait silently for a day. The host path is the fallback with no IP.
    var liftTransport: LiftTransport {
        get {
            liftTransportChoice ?? (TailnetTunnel.Route.isTailnetIP(tailnetIP.trimmingCharacters(in: .whitespaces)) ? .tailnet : .host)
        }
        set { liftTransportChoice = newValue }
    }

    /// The daemon's tailnet-only plain-HTTP listener (lift uploads only).
    static let liftTailnetPort = 8791

    private init() {
        liftTransportChoice = UserDefaults.standard.string(forKey: "lift_transport").flatMap(LiftTransport.init(rawValue:))
        host = UserDefaults.standard.string(forKey: "daemon_host") ?? ""
        token = Keychain.get("daemon_token") ?? ""
        deviceFilter = UserDefaults.standard.string(forKey: "device_filter") ?? "WHOOP"
        tailnetIP = UserDefaults.standard.string(forKey: "daemon_ip") ?? ""
        tailnetIPSource = UserDefaults.standard.string(forKey: "daemon_ip_source") ?? ""
    }

    var configured: Bool { !host.isEmpty && !token.isEmpty }

    var tailnetRoute: TailnetTunnel.Route? { .tailnet(host: host, ip: tailnetIP) }

    /// The bare, lower-cased name in `host` (the tunnel route's own parse),
    /// for the quad-100 lookup.
    var hostName: String? { Self.hostName(host) }

    static func hostName(_ host: String) -> String? { TailnetTunnel.Route.name(of: host) }

    /// Build every daemon session (socket, plan, route) from this. The URLs
    /// below stay hostname-based by design: with a route the name only feeds
    /// SNI, the cert check and the CONNECT line, never a resolver.
    func sessionConfiguration() -> URLSessionConfiguration {
        let cfg = TailnetTunnel.shared.configuration(route: tailnetRoute)
        // URLSession's default is 7 days, which killed the mac relay's
        // WebSocket at exactly 604800 s. The socket is meant to live forever.
        cfg.timeoutIntervalForResource = 60 * 60 * 24 * 365
        return cfg
    }

    /// One daemon GET (plan, route) on the current route.
    func fetch(_ url: URL, completion: @escaping (Data?, URLResponse?, Error?) -> Void) {
        TailnetTunnel.fetch(url, configuration: sessionConfiguration(), completion: completion)
    }

    var streamURL: URL? {
        guard configured,
              var comps = URLComponents(string: "wss://\(host)/stream")
        else { return nil }
        comps.queryItems = [URLQueryItem(name: "token", value: token)]
        return comps.url
    }

    /// A route file (GPX) the daemon serves from its routes directory.
    func routeURL(file: String) -> URL? {
        guard configured,
              var comps = URLComponents(string: "https://\(host)/route")
        else { return nil }
        comps.queryItems = [
            URLQueryItem(name: "file", value: file),
            URLQueryItem(name: "token", value: token),
        ]
        return comps.url
    }

    /// A food-log route (/meals, /meal, /meal/fix, or a photo path the daemon
    /// handed out like "/meal-photo?meal=3&n=0&thumb=1"), token attached.
    func foodURL(path: String) -> URL? {
        guard configured, var comps = URLComponents(string: "https://\(host)\(path)") else { return nil }
        comps.queryItems = (comps.queryItems ?? []) + [URLQueryItem(name: "token", value: token)]
        return comps.url
    }

    /// One daemon request with a body (POST /meal) on the current route.
    func send(_ request: URLRequest, completion: @escaping (Data?, URLResponse?, Error?) -> Void) {
        TailnetTunnel.send(request, configuration: sessionConfiguration(), completion: completion)
    }

    /// POST /lift-video and /lift-video/probe, token attached, on one
    /// transport. These go through a BACKGROUND URLSession, which runs in a
    /// system daemon outside this app: the in-app tunnel (TailnetTunnel)
    /// cannot carry it. So `.host` is the plain hostname path (the system
    /// resolves the ts.net name, which iCloud Private Relay can break) and
    /// `.tailnet` dials the Mac's tailnet IP directly over plain HTTP (no
    /// name to resolve; WireGuard encrypts the tailnet hop).
    func liftURL(_ path: String, via transport: LiftTransport) -> URL? {
        var token = self.token, host = self.host, ip = tailnetIP, port = Self.liftTailnetPort
        #if DEBUG && targetEnvironment(simulator)
        // Simulator transport tests against a throwaway sink on the Mac
        // (never the live daemon): HR_LIFT_HOST / _IP / _PORT / _TOKEN.
        // Simulator only: scripts/build-phone.sh builds the phone in Debug.
        let env = ProcessInfo.processInfo.environment
        token = env["HR_LIFT_TOKEN"] ?? token
        host = env["HR_LIFT_HOST"] ?? host
        ip = env["HR_LIFT_IP"] ?? ip
        port = env["HR_LIFT_PORT"].flatMap(Int.init) ?? port
        let transport = env["HR_LIFT_TRANSPORT"].flatMap(LiftTransport.init(rawValue:)) ?? transport
        #endif
        guard !token.isEmpty else { return nil }
        let base: String
        switch transport {
        case .host:
            guard !host.isEmpty else { return nil }
            base = "https://\(host)"
        case .tailnet:
            ip = ip.trimmingCharacters(in: .whitespaces)
            guard TailnetTunnel.Route.isTailnetIP(ip) else { return nil }
            base = "http://\(ip):\(port)"
        }
        guard var comps = URLComponents(string: base + path) else { return nil }
        comps.queryItems = [URLQueryItem(name: "token", value: token)]
        return comps.url
    }

    /// Why liftURL(via:) has no URL, in the words a clip row or a probe row
    /// shows.
    func liftUnreachableReason(_ transport: LiftTransport) -> String {
        if token.isEmpty { return "Daemon not configured" }
        switch transport {
        case .host: return host.isEmpty ? "Daemon host not set" : "Daemon host is not a valid address"
        case .tailnet: return "No tailnet IP (Settings, Daemon, Find)"
        }
    }

    var planURL: URL? {
        guard configured,
              var comps = URLComponents(string: "https://\(host)/plan")
        else { return nil }
        comps.queryItems = [URLQueryItem(name: "token", value: token)]
        return comps.url
    }
}
