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
            "device": deviceName ?? "unknown", "caps": ["release"],
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
    // Only bind devices matching this name fragment. Defaulting to any nearby
    // 0x180D broadcaster would stream a STRANGER'S heart rate into the archive
    // the first time the band is slow to advertise at a gym.
    private let deviceFilter = ProcessInfo.processInfo.environment["HEALTH_RELAY_DEVICE"] ?? "WHOOP"

    init(socket: SocketLeg) {
        self.socket = socket
        super.init()
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

    private func startScan() {
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
        guard peripheral == nil else { return }
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
    if type == "release" { ble.release() }
}
log("up (daemon: \(config.url.absoluteString))")
RunLoop.main.run()
