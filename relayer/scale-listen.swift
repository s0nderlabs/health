// scale-listen: macOS passive BLE -> healthd dumb pipe for the Xiaomi S400.
//
// Scans (never connects) for MiBeacon advertisements: service data under
// UUID 0xFE95. Each frame whose product id is a known S400 id (or whose
// peripheral matches scale.peripheral_id) is POSTed RAW (hex) to healthd's
// live listener at POST /scale-adv. Decryption, parsing, and the weigh-in
// collapse all happen daemon-side (src/scale.ts); this binary holds no key.
// Identical frames (same bytes = same frame counter) are sent once per 60 s.
// A frame is forgotten (posted again on its next advertisement) ONLY when the
// daemon answered 2xx with JSON {accepted:false, reason:"no_key"}: the bindkey
// is still loading at boot, so the same frame decodes once it lands. Every
// other reject (mac_mismatch, decrypt_failed, replay, ...) is permanent for
// that frame and stays suppressed, or a neighbour's S400 would be re-posted on
// every advertisement. A 4xx and a 401 stay suppressed (re-posting fixes
// neither). A transport failure or 5xx stays suppressed too: the frame already
// sits (once, deduped by frame hex) in the retry buffer. (listenerRemembers in
// src/scale.ts is the same rule, line for line.)
//
// Build: scripts/build-scale.sh   Run: bin/scale-listen
// Config: reads live.port/live.bind/live.token and the optional scale block
// (product_id, peripheral_id) from ~/.config/health/config.json
// (HEALTH_SCALE_URL / HEALTH_SCALE_TOKEN override for testing).

import CoreBluetooth
import Foundation

func log(_ msg: String) {
    let ts = ISO8601DateFormatter().string(from: Date())
    FileHandle.standardError.write("scale-listen: \(ts) \(msg)\n".data(using: .utf8)!)
}

// Product ids the reference parser maps to MJTZC01YM (Smart Scale S400).
let S400_PRODUCT_IDS: Set<UInt16> = [0x30D9, 0x3BD5, 0x48CF, 0x4FC2]
let MIBEACON_UUID = CBUUID(string: "FE95")
let DEDUPE_SECONDS: TimeInterval = 60

// ── Config ──────────────────────────────────────────────────────────

struct Config {
    let url: URL
    let token: String
    let productIds: Set<UInt16>
    let peripheralId: UUID?

    static func parseProductId(_ v: Any?) -> UInt16? {
        if let n = v as? Int, n > 0, n <= 0xFFFF { return UInt16(n) }
        if let s = v as? String {
            let t = s.trimmingCharacters(in: .whitespaces).lowercased()
            let n = t.hasPrefix("0x") ? Int(t.dropFirst(2), radix: 16) : Int(t)
            if let n = n, n > 0, n <= 0xFFFF { return UInt16(n) }
        }
        return nil
    }

    static func load() -> Config {
        let path = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".config/health/config.json")
        let json = (try? Data(contentsOf: path)).flatMap {
            try? JSONSerialization.jsonObject(with: $0) as? [String: Any]
        } ?? [:]
        let scale = json["scale"] as? [String: Any] ?? [:]
        var ids = S400_PRODUCT_IDS
        if let extra = parseProductId(scale["product_id"]) { ids.insert(extra) }
        let pid = (scale["peripheral_id"] as? String).flatMap { UUID(uuidString: $0) }

        if let urlStr = ProcessInfo.processInfo.environment["HEALTH_SCALE_URL"],
           let token = ProcessInfo.processInfo.environment["HEALTH_SCALE_TOKEN"],
           let url = URL(string: urlStr) {
            return Config(url: url, token: token, productIds: ids, peripheralId: pid)
        }
        guard let live = json["live"] as? [String: Any],
              let token = live["token"] as? String, !token.isEmpty
        else {
            log("no live.token in ~/.config/health/config.json (start healthd once to generate it)")
            exit(1)
        }
        let port = live["port"] as? Int ?? 8790
        var host = live["bind"] as? String ?? "127.0.0.1"
        if host.isEmpty || host == "0.0.0.0" || host == "::" { host = "127.0.0.1" }
        return Config(url: URL(string: "http://\(host):\(port)/scale-adv")!,
                      token: token, productIds: ids, peripheralId: pid)
    }
}

// ── HTTP leg ────────────────────────────────────────────────────────

final class Poster {
    private let config: Config
    private let session: URLSession
    // Frames that failed to post (daemon restarting): retried, then dropped.
    // The daemon trusts the original receive time for up to 10 minutes. One
    // slot per distinct frame: a frame already buffered is never added twice.
    private var pending: [(hex: String, body: Data, at: Date, outcome: ((PostOutcome) -> Void)?)] = []
    private var failures = 0
    private var unauthorizedLoggedAt = Date.distantPast

    init(config: Config) {
        self.config = config
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 5
        cfg.timeoutIntervalForResource = 10
        session = URLSession(configuration: cfg)
        Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in self?.retry() }
    }

    /// outcome .keyPending = the daemon answered no_key (bindkey loading):
    /// the caller forgets the frame. Every other outcome keeps it deduped.
    func send(frameHex: String, rssi: Int, at: Date, outcome: @escaping (PostOutcome) -> Void) {
        let obj: [String: Any] = [
            "frame_hex": frameHex,
            "rssi": rssi,
            "ts": Int(at.timeIntervalSince1970 * 1000),
        ]
        guard let body = try? JSONSerialization.data(withJSONObject: obj) else { return outcome(.refused) }
        post(frameHex, body, at: at, outcome: outcome)
    }

    private func post(_ hex: String, _ body: Data, at: Date, outcome: ((PostOutcome) -> Void)? = nil) {
        var req = URLRequest(url: config.url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(config.token)", forHTTPHeaderField: "Authorization")
        req.httpBody = body
        session.dataTask(with: req) { [weak self] data, resp, err in
            DispatchQueue.main.async {
                guard let self = self else { return }
                let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
                let json = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
                let result = classify(err: err, code: code, accepted: json?["accepted"] as? Bool,
                                      reason: json?["reason"] as? String)
                if result == .failed {
                    self.failures += 1
                    if self.failures == 1 || self.failures % 50 == 0 {
                        log("post failed (\(err?.localizedDescription ?? "HTTP \(code)")); buffering")
                    }
                    if self.pending.count < 64, !self.pending.contains(where: { $0.hex == hex }) {
                        self.pending.append((hex, body, at, outcome))
                    }
                } else {
                    if self.failures > 0 { log("daemon reachable again") }
                    self.failures = 0
                    if result == .unauthorized, Date().timeIntervalSince(self.unauthorizedLoggedAt) >= 60 {
                        self.unauthorizedLoggedAt = Date()
                        log("daemon rejected the token (401): re-read config by restarting")
                    }
                }
                outcome?(result)
            }
        }.resume()
    }

    private func retry() {
        let now = Date()
        let batch = pending.filter { now.timeIntervalSince($0.at) < 9 * 60 }
        pending.removeAll()
        for item in batch { post(item.hex, item.body, at: item.at, outcome: item.outcome) }
    }
}

/// .keyPending is the ONLY outcome that forgets a frame (see the header).
enum PostOutcome { case accepted, refused, keyPending, unauthorized, failed }

/// The dedupe contract. listenerRemembers in src/scale.ts is the same rule,
/// line for line (it returns false exactly where this returns .keyPending),
/// and a test pins the reason string below in this source.
func classify(err: Error?, code: Int, accepted: Bool?, reason: String?) -> PostOutcome {
    if err != nil || code == 0 || code >= 500 { return .failed }
    if code == 401 { return .unauthorized }
    if (200..<300).contains(code) {
        if accepted == false && reason == "no_key" { return .keyPending }
        return accepted == false ? .refused : .accepted
    }
    return .refused
}

// ── BLE leg (scan only, never connect) ──────────────────────────────

final class Scanner: NSObject, CBCentralManagerDelegate {
    private var central: CBCentralManager!
    private let config: Config
    private let poster: Poster
    private var seen: [String: Date] = [:]
    private var announced = Set<UUID>()

    init(config: Config, poster: Poster) {
        self.config = config
        self.poster = poster
        super.init()
        central = CBCentralManager(delegate: self, queue: .main)
        Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in self?.prune() }
    }

    func centralManagerDidUpdateState(_ c: CBCentralManager) {
        switch c.state {
        case .poweredOn:
            // nil services: MiBeacon puts FE95 in SERVICE DATA, which a
            // service-UUID scan filter is not guaranteed to match. The
            // filtering below is cheap.
            c.scanForPeripherals(withServices: nil,
                                 options: [CBCentralManagerScanOptionAllowDuplicatesKey: true])
            log("scanning (passive, allow duplicates)")
        case .unauthorized:
            log("bluetooth permission DENIED: grant it in System Settings > Privacy & Security > Bluetooth")
        default:
            log("bluetooth state: \(c.state.rawValue) (waiting)")
        }
    }

    func centralManager(_ c: CBCentralManager, didDiscover p: CBPeripheral,
                        advertisementData ad: [String: Any], rssi: NSNumber) {
        guard let sd = ad[CBAdvertisementDataServiceDataKey] as? [CBUUID: Data],
              let frame = sd[MIBEACON_UUID], frame.count >= 5
        else { return }
        let bytes = [UInt8](frame)
        let productId = UInt16(bytes[2]) | (UInt16(bytes[3]) << 8)
        let byId = config.peripheralId.map { $0 == p.identifier } ?? false
        guard config.productIds.contains(productId) || byId else { return }
        if !announced.contains(p.identifier) {
            announced.insert(p.identifier)
            // Not secret: a per-Mac CoreBluetooth UUID; set scale.peripheral_id to pin it.
            log(String(format: "S400 seen: peripheral %@ product 0x%04X", p.identifier.uuidString, productId))
        }
        let hex = bytes.map { String(format: "%02x", $0) }.joined()
        let now = Date()
        if let at = seen[hex], now.timeIntervalSince(at) < DEDUPE_SECONDS { return }
        seen[hex] = now // suppresses copies while the post is in flight
        poster.send(frameHex: hex, rssi: rssi.intValue, at: now) { [weak self] outcome in
            // Only a frame the daemon could not decode YET (no_key at boot)
            // is posted again on its next advertisement. Any other reject is
            // permanent for this frame; a failed post sits in the retry
            // buffer; a 401 is not fixed by re-posting.
            if outcome == .keyPending, self?.seen[hex] == now { self?.seen[hex] = nil }
        }
    }

    private func prune() {
        let now = Date()
        seen = seen.filter { now.timeIntervalSince($0.value) < DEDUPE_SECONDS }
    }
}

// ── Main ────────────────────────────────────────────────────────────

let config = Config.load()
let poster = Poster(config: config)
let scanner = Scanner(config: config, poster: poster)
log("up (daemon: \(config.url.absoluteString))")
RunLoop.main.run()
