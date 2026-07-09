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

    private init() {
        host = UserDefaults.standard.string(forKey: "daemon_host") ?? ""
        token = Keychain.get("daemon_token") ?? ""
        deviceFilter = UserDefaults.standard.string(forKey: "device_filter") ?? "WHOOP"
    }

    var configured: Bool { !host.isEmpty && !token.isEmpty }

    var streamURL: URL? {
        guard configured,
              var comps = URLComponents(string: "wss://\(host)/stream")
        else { return nil }
        comps.queryItems = [URLQueryItem(name: "token", value: token)]
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
