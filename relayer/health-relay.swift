// health-relay: macOS BLE -> healthd dumb pipe.
//
// Subscribes to the WHOOP band's Broadcast Heart Rate (standard BLE Heart
// Rate service 0x180D / measurement characteristic 0x2A37) and forwards every
// notification RAW (base64) over a WebSocket to healthd's live ingest. All
// interpretation happens daemon-side (src/hrparse.ts); this binary only moves
// bytes. Reconnects both legs forever; buffers frames in memory while the
// socket is down and flushes on reconnect.
//
// Build: scripts/build-relayer.sh   Run: bin/health-relay
// Config: reads live.port/live.token from ~/.config/health/config.json
// (HEALTH_RELAY_URL / HEALTH_RELAY_TOKEN override for testing).

import CoreBluetooth
import Foundation

func log(_ msg: String) {
    let ts = ISO8601DateFormatter().string(from: Date())
    FileHandle.standardError.write("health-relay: \(ts) \(msg)\n".data(using: .utf8)!)
}

// ── Config ──────────────────────────────────────────────────────────

struct Config {
    let url: URL
    let token: String

    static func load() -> Config {
        if let urlStr = ProcessInfo.processInfo.environment["HEALTH_RELAY_URL"],
           let token = ProcessInfo.processInfo.environment["HEALTH_RELAY_TOKEN"],
           let url = URL(string: urlStr) {
            return Config(url: url, token: token)
        }
        let path = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".config/health/config.json")
        guard let data = try? Data(contentsOf: path),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let live = json["live"] as? [String: Any],
              let token = live["token"] as? String, !token.isEmpty
        else {
            log("no live.token in ~/.config/health/config.json (start healthd once to generate it)")
            exit(1)
        }
        let port = live["port"] as? Int ?? 8790
        return Config(url: URL(string: "ws://127.0.0.1:\(port)/stream")!, token: token)
    }
}

// ── WebSocket leg ───────────────────────────────────────────────────

final class SocketLeg: NSObject, URLSessionWebSocketDelegate {
    private let config: Config
    private var session: URLSession?
    private var task: URLSessionWebSocketTask?
    private var connected = false
    private var backoff: TimeInterval = 1
    private var buffer: [String] = [] // frames queued while down (~10 min cap)
    private let bufferCap = 600
    private var deviceName: String?
    /// Daemon arbitration commands (today just 'release' for dual-up races).
    var onCommand: ((String) -> Void)?

    init(config: Config) {
        self.config = config
        super.init()
    }

    func connect() {
        var comps = URLComponents(url: config.url, resolvingAgainstBaseURL: false)!
        comps.queryItems = [URLQueryItem(name: "token", value: config.token)]
        // One session per attempt, invalidated in dropAndRetry: URLSession
        // retains its delegate, so never invalidating leaks a session (and a
        // retain on self) per reconnect.
        let s = URLSession(configuration: .default, delegate: self, delegateQueue: .main)
        session = s
        let t = s.webSocketTask(with: comps.url!)
        task = t
        t.resume()
        receiveLoop(t)
    }

    func urlSession(_ s: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didOpenWithProtocol proto: String?) {
        guard webSocketTask === task else { return } // stale attempt
        connected = true
        backoff = 1
        log("socket up (\(config.url.absoluteString))")
        sendJSON([
            "type": "hello", "source": "mac",
            "device": deviceName ?? "unknown", "caps": ["release", "disarm"],
        ])
        flush()
        schedulePing(webSocketTask)
    }

    func urlSession(_ s: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didCloseWith code: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        dropAndRetry("closed (\(code.rawValue))")
    }

    func urlSession(_ s: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error = error { dropAndRetry("errored: \(error.localizedDescription)") }
    }

    private func receiveLoop(_ t: URLSessionWebSocketTask) {
        t.receive { [weak self] result in
            guard let self = self, self.task === t else { return }
            switch result {
            case .success(let message):
                if case .string(let text) = message,
                   let data = text.data(using: .utf8),
                   let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let type = json["type"] as? String {
                    self.onCommand?(type)
                }
                self.receiveLoop(t)
            case .failure(let err):
                self.dropAndRetry("receive failed: \(err.localizedDescription)")
            }
        }
    }

    // Generation-safe: the chain carries the task it was scheduled for and
    // dies with it, so reconnects cannot accumulate parallel ping chains.
    private func schedulePing(_ t: URLSessionWebSocketTask) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 20) { [weak self] in
            guard let self = self, self.connected, self.task === t else { return }
            t.sendPing { err in
                if let err = err { self.dropAndRetry("ping failed: \(err.localizedDescription)") }
                else { self.schedulePing(t) }
            }
        }
    }

    private func dropAndRetry(_ why: String) {
        guard task != nil else { return }
        log("socket down: \(why), retrying in \(Int(backoff))s")
        connected = false
        task?.cancel()
        task = nil
        session?.invalidateAndCancel()
        session = nil
        let delay = backoff
        backoff = min(backoff * 2, 30)
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            self?.connect()
        }
    }

    func setDevice(_ name: String?) { deviceName = name }

    func sendJSON(_ obj: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: obj),
              let text = String(data: data, encoding: .utf8) else { return }
        send(text)
    }

    private func send(_ text: String) {
        guard connected, let t = task else {
            enqueue(text)
            return
        }
        t.send(.string(text)) { [weak self] err in
            if let err = err {
                self?.enqueue(text)
                self?.dropAndRetry("send failed: \(err.localizedDescription)")
            }
        }
    }

    private func enqueue(_ text: String) {
        buffer.append(text)
        if buffer.count > bufferCap { buffer.removeFirst(buffer.count - bufferCap) }
    }

    private func flush() {
        guard !buffer.isEmpty else { return }
        log("flushing \(buffer.count) buffered frames")
        let pending = buffer
        buffer.removeAll()
        for text in pending { send(text) }
    }
}

// ── BLE leg ─────────────────────────────────────────────────────────

let HR_SERVICE = CBUUID(string: "180D")
let HR_MEASUREMENT = CBUUID(string: "2A37")

final class BleLeg: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
    private var central: CBCentralManager!
    private var peripheral: CBPeripheral?
    private let socket: SocketLeg
    private var discovered: [CBPeripheral] = []
    private var connectTimer: DispatchWorkItem?
    // Each connect attempt gets a generation; stale timeout closures from an
    // earlier attempt must never cancel a fresh in-progress connection.
    private var connectGeneration = 0
    private var lastNotifyAt = Date.distantPast
    // Yield: the daemon surrendered the band to an external receiver
    // (Strava). While disarmed: no scan, no connect, nothing armed. Cleared
    // by 'rearm' OR by a hello reply of 'ok' (the reconnect backstop: a
    // one-shot rearm can miss a leg whose socket was down at reclaim).
    private var disarmed = false
    // Launch gate: a relay (re)started MID-YIELD must not race Strava for a
    // blip-freed band in the seconds before the daemon's verdict arrives.
    // Scanning holds until the first inbound daemon message; a 5s timeout
    // preserves capture-first when the daemon is down UNLESS the persisted
    // flag says we were disarmed: then the gate fails CLOSED (dark) until an
    // explicit ok/rearm, because grabbing the band is the one unrecoverable
    // wrong move mid-recording.
    private var awaitingVerdict = true
    private static let disarmFlag = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".claude/channels/health/relay.disarmed")
    // Only bind devices matching this name fragment. Defaulting to any nearby
    // 0x180D broadcaster would stream a STRANGER'S heart rate into the archive
    // the first time the band is slow to advertise at a gym.
    private let deviceFilter = ProcessInfo.processInfo.environment["HEALTH_RELAY_DEVICE"] ?? "WHOOP"

    init(socket: SocketLeg) {
        self.socket = socket
        super.init()
        // A yield survives our own restarts: the flag written at disarm makes
        // a relaunched relay come up dark until the daemon says otherwise.
        disarmed = FileManager.default.fileExists(atPath: Self.disarmFlag.path)
        if disarmed { log("restored disarmed state (yield) from flag; staying dark until ok/rearm") }
        central = CBCentralManager(delegate: self, queue: .main)
        // Subscribed-but-silent watchdog: a wedged notify stream (discovery
        // half-failed, band rebooted) recovers by rescanning.
        Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            guard let self = self, let p = self.peripheral, p.state == .connected else { return }
            if Date().timeIntervalSince(self.lastNotifyAt) > 60 {
                log("no HR notifications for 60s while connected, resetting BLE")
                self.resetAndRescan(p)
            }
        }
    }

    func centralManagerDidUpdateState(_ c: CBCentralManager) {
        switch c.state {
        case .poweredOn:
            startScan()
        case .unauthorized:
            log("bluetooth permission DENIED: grant it in System Settings > Privacy & Security > Bluetooth")
        default:
            // Power-off/reset invalidates peripherals WITHOUT firing
            // didDisconnect; holding the stale reference would block every
            // future startScan and wedge the relayer permanently.
            log("bluetooth state: \(c.state.rawValue) (waiting)")
            if peripheral != nil {
                peripheral = nil
                socket.sendJSON(["type": "status", "connected": false])
            }
        }
    }

    private func resetAndRescan(_ p: CBPeripheral) {
        central.cancelPeripheralConnection(p)
        peripheral = nil
        socket.sendJSON(["type": "status", "connected": false])
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.startScan() }
    }

    /// Dual-up: drop the band NOW and rescan; the scan is the mac's standing
    /// entry in the race for the band's post-drop advertising window (the
    /// phone races with its pending connect).
    func release() {
        guard let p = peripheral, p.state == .connected else { return }
        log("release: dropping the band for the dual-up race")
        resetAndRescan(p)
    }

    /// Yield: drop the band and go fully idle so an external receiver
    /// (Strava) can discover and pair it. Unlike release, nothing keeps
    /// hunting: no scan, no reconnect, until rearm().
    func disarm() {
        try? Data().write(to: Self.disarmFlag) // idempotent; refresh even if already disarmed
        guard !disarmed else { return }
        disarmed = true
        connectGeneration += 1 // kill any pending connect-timeout closure
        connectTimer?.cancel()
        central.stopScan()
        if let p = peripheral {
            central.cancelPeripheralConnection(p)
            peripheral = nil
            socket.sendJSON(["type": "status", "connected": false])
        }
        log("disarm: band surrendered (yield); idle until rearm")
    }

    /// Yield over (or an 'ok' hello reply while disarmed): resume hunting.
    func rearm() {
        try? FileManager.default.removeItem(at: Self.disarmFlag)
        guard disarmed else { return }
        disarmed = false
        log("rearm: yield over, hunting the band again")
        startScan()
    }

    /// First daemon message (any type) or the 5s launch timeout: the verdict
    /// is in (or is not coming). If nothing above vetoed, start hunting.
    func verdictArrived(_ why: String) {
        guard awaitingVerdict else { return }
        awaitingVerdict = false
        if !disarmed { log("launch gate released (\(why))") }
        startScan()
    }

    private func startScan() {
        guard !disarmed, !awaitingVerdict else { return }
        guard central.state == .poweredOn else { return }
        guard peripheral == nil else { return }
        log("scanning for \(deviceFilter) broadcasting Heart Rate (is Broadcast HR on in the WHOOP app?)")
        discovered.removeAll()
        central.scanForPeripherals(withServices: [HR_SERVICE])
        connectTimer?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.pickAndConnect() }
        connectTimer = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 4, execute: work)
    }

    private func pickAndConnect() {
        guard !disarmed, peripheral == nil else { return }
        let matches = discovered.filter {
            ($0.name ?? "").uppercased().contains(deviceFilter.uppercased())
        }
        guard let pick = matches.first else {
            if !discovered.isEmpty {
                let seen = discovered.map { $0.name ?? "unnamed" }.joined(separator: ", ")
                log("no \(deviceFilter) device found (ignoring: \(seen)); still scanning")
            }
            let work = DispatchWorkItem { [weak self] in self?.pickAndConnect() }
            connectTimer = work
            DispatchQueue.main.asyncAfter(deadline: .now() + 4, execute: work)
            return
        }
        central.stopScan()
        peripheral = pick
        pick.delegate = self
        connectGeneration += 1
        let gen = connectGeneration
        log("connecting to \(pick.name ?? "unnamed") [\(pick.identifier)]")
        central.connect(pick)
        // CoreBluetooth's connect never times out on its own; a band that
        // vanished after discovery would wedge the relayer forever.
        DispatchQueue.main.asyncAfter(deadline: .now() + 15) { [weak self] in
            guard let self = self, self.connectGeneration == gen,
                  let p = self.peripheral, p.state != .connected else { return }
            log("connect timed out, rescanning")
            self.resetAndRescan(p)
        }
    }

    func centralManager(_ c: CBCentralManager, didDiscover p: CBPeripheral,
                        advertisementData: [String: Any], rssi: NSNumber) {
        if !discovered.contains(where: { $0.identifier == p.identifier }) {
            log("found \(p.name ?? "unnamed") [\(p.identifier)] rssi \(rssi)")
            discovered.append(p)
        }
    }

    func centralManager(_ c: CBCentralManager, didConnect p: CBPeripheral) {
        if disarmed {
            // A connect that raced the disarm (in flight when it landed):
            // adopting it would hold the band Strava is waiting for.
            log("connect completed while disarmed; dropping the band")
            c.cancelPeripheralConnection(p)
            peripheral = nil
            return
        }
        log("connected to \(p.name ?? "unnamed")")
        socket.setDevice(p.name)
        socket.sendJSON(["type": "status", "connected": true, "device": p.name ?? "unnamed"])
        p.discoverServices([HR_SERVICE])
    }

    func centralManager(_ c: CBCentralManager, didFailToConnect p: CBPeripheral, error: Error?) {
        log("connect failed: \(error?.localizedDescription ?? "unknown")")
        connectGeneration += 1 // invalidate the pending connect-timeout
        peripheral = nil
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.startScan() }
    }

    func centralManager(_ c: CBCentralManager, didDisconnectPeripheral p: CBPeripheral, error: Error?) {
        log("band disconnected\(error != nil ? " (\(error!.localizedDescription))" : "")")
        connectGeneration += 1
        socket.sendJSON(["type": "status", "connected": false])
        peripheral = nil
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.startScan() }
    }

    // Discovery/subscription failures after a successful connect previously
    // guard-returned silently, leaving peripheral non-nil and startScan
    // blocked forever. Every failure path now resets and rescans.
    func peripheral(_ p: CBPeripheral, didDiscoverServices error: Error?) {
        guard error == nil, let svc = p.services?.first(where: { $0.uuid == HR_SERVICE }) else {
            log("service discovery failed (\(error?.localizedDescription ?? "no HR service")), resetting")
            resetAndRescan(p)
            return
        }
        p.discoverCharacteristics([HR_MEASUREMENT], for: svc)
    }

    func peripheral(_ p: CBPeripheral, didDiscoverCharacteristicsFor svc: CBService, error: Error?) {
        guard error == nil, let ch = svc.characteristics?.first(where: { $0.uuid == HR_MEASUREMENT }) else {
            log("characteristic discovery failed (\(error?.localizedDescription ?? "no 2A37")), resetting")
            resetAndRescan(p)
            return
        }
        p.setNotifyValue(true, for: ch)
        lastNotifyAt = Date() // arm the silence watchdog from subscribe time
        log("subscribed to Heart Rate Measurement, streaming")
    }

    func peripheral(_ p: CBPeripheral, didUpdateNotificationStateFor ch: CBCharacteristic, error: Error?) {
        if let error = error {
            log("notify subscription failed (\(error.localizedDescription)), resetting")
            resetAndRescan(p)
        }
    }

    func peripheral(_ p: CBPeripheral, didUpdateValueFor ch: CBCharacteristic, error: Error?) {
        guard error == nil, let data = ch.value else { return }
        lastNotifyAt = Date()
        socket.sendJSON([
            "type": "hr",
            "ts": Int(Date().timeIntervalSince1970 * 1000),
            "raw": data.base64EncodedString(),
        ])
    }
}

// ── Main ────────────────────────────────────────────────────────────

let config = Config.load()
let socket = SocketLeg(config: config)
socket.connect()
let ble = BleLeg(socket: socket)
socket.onCommand = { type in
    switch type {
    case "release": ble.release()
    case "disarm": ble.disarm()
    // 'ok' is the hello reply when no yield is active: it doubles as the
    // ensure-armed backstop for a leg that missed the one-shot rearm
    // (rearm() is a no-op unless disarmed, so this never disturbs normal runs).
    case "rearm", "ok": ble.rearm()
    default: break
    }
    // Whatever the daemon said, the verdict is in: the launch gate can lift
    // (disarm above already vetoed scanning if that was the verdict).
    ble.verdictArrived("daemon verdict: \(type)")
}
DispatchQueue.main.asyncAfter(deadline: .now() + 5) {
    ble.verdictArrived("timeout, daemon unreachable; capture-first")
}
log("up (daemon: \(config.url.absoluteString))")
RunLoop.main.run()
