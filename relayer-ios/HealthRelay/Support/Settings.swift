// One-time setup state: where the daemon lives and how to prove we belong.
// Host is not a secret (UserDefaults); the token is (Keychain).

import Foundation
import Combine

/// DEBUG demo flag (HR_DEMO=1): static, so no init-order dependency.
enum Demo {
    static let active = ProcessInfo.processInfo.environment["HR_DEMO"] != nil
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

    private init() {
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

    var planURL: URL? {
        guard configured,
              var comps = URLComponents(string: "https://\(host)/plan")
        else { return nil }
        comps.queryItems = [URLQueryItem(name: "token", value: token)]
        return comps.url
    }
}
