// scale-listen: macOS passive BLE -> healthd dumb pipe for the Xiaomi S400.
//
// Scans (never connects) for MiBeacon advertisements: service data under
// UUID 0xFE95. Each frame whose product id is a known S400 id (or whose
// peripheral matches scale.peripheral_id) is POSTed RAW (hex) to healthd's
// live listener at POST /scale-adv. Decryption, parsing, and the weigh-in
// collapse all happen daemon-side (src/scale.ts); this binary holds no key.
// Identical frames (same bytes = same frame counter) are sent once per 60 s.
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
    // The daemon trusts the original receive time for up to 10 minutes.
    private var pending: [(body: Data, at: Date)] = []
    private var failures = 0

    init(config: Config) {
        self.config = config
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 5
        cfg.timeoutIntervalForResource = 10
        session = URLSession(configuration: cfg)
        Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in self?.retry() }
    }

    func send(frameHex: String, rssi: Int, at: Date) {
        let obj: [String: Any] = [
            "frame_hex": frameHex,
            "rssi": rssi,
            "ts": Int(at.timeIntervalSince1970 * 1000),
        ]
        guard let body = try? JSONSerialization.data(withJSONObject: obj) else { return }
        post(body, at: at)
    }

    private func post(_ body: Data, at: Date) {
        var req = URLRequest(url: config.url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(config.token)", forHTTPHeaderField: "Authorization")
        req.httpBody = body
        session.dataTask(with: req) { [weak self] _, resp, err in
            DispatchQueue.main.async {
                guard let self = self else { return }
                let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
                if err != nil || code == 0 || code >= 500 {
                    self.failures += 1
                    if self.failures == 1 || self.failures % 50 == 0 {
                        log("post failed (\(err?.localizedDescription ?? "HTTP \(code)")); buffering")
                    }
                    if self.pending.count < 64 { self.pending.append((body, at)) }
                } else {
                    if self.failures > 0 { log("daemon reachable again") }
                    self.failures = 0
                    if code == 401 { log("daemon rejected the token (401): re-read config by restarting") }
                }
            }
        }.resume()
    }

    private func retry() {
        let now = Date()
        let batch = pending.filter { now.timeIntervalSince($0.at) < 9 * 60 }
        pending.removeAll()
        for item in batch { post(item.body, at: item.at) }
    }
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
        seen[hex] = now
        poster.send(frameHex: hex, rssi: rssi.intValue, at: now)
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
