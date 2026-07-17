// BLE leg: subscribes to the band's Broadcast Heart Rate (0x180D/0x2A37) and
// hands raw notification bytes up. Ported from the mac relayer with the iOS
// additions: background mode (service-filtered scans keep working with the
// screen locked), state restoration (iOS relaunches the app on BLE events
// after a jetsam kill), and a radio switch driven by the daemon's
// arbitration. The load-bearing iOS trick is the PENDING CONNECT: once the
// band is known, `central.connect` with no timeout is a standing order that
// survives app suspension and wakes the app the moment the band advertises.
// It is how a locked phone reacquires after a drop, and how a parked phone
// silently takes over when the user walks out of the mac's range.

import CoreBluetooth
import Foundation

let HR_SERVICE = CBUUID(string: "180D")
let HR_MEASUREMENT = CBUUID(string: "2A37")

protocol BleLegDelegate: AnyObject {
    func bleFrame(_ raw: Data)
    func bleStatus(connected: Bool, device: String?)
    func blePhase(_ phase: BleLeg.Phase)
    /// iOS relaunched us for a BLE event (state restoration). The socket does
    /// not start on background relaunches by itself; the controller uses this
    /// to bring it up so the daemon's verdict (disarm during a yield!) can land.
    func bleDidRestore()
}

/// Persisted yield verdict, readable before any controller exists (the state-
/// restoration path runs first and must not re-arm a yielded radio).
enum YieldState {
    private static let key = "disarmed_until"
    static var disarmedUntil: Date? {
        let t = UserDefaults.standard.double(forKey: key)
        return t > 0 ? Date(timeIntervalSince1970: t) : nil
    }
    static var active: Bool {
        guard let until = disarmedUntil else { return false }
        return until > Date()
    }
    static func set(untilMs: Double) {
        UserDefaults.standard.set(untilMs / 1000, forKey: key)
    }
    static func clear() {
        UserDefaults.standard.removeObject(forKey: key)
    }
}

final class BleLeg: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
    enum Phase: Equatable {
        case off // standdown/pause: radio deliberately idle
        case waitingBluetooth // powered off / unauthorized
        case scanning
        case connecting(String)
        case streaming(String)
    }

    /// What the controller wants from the radio:
    /// on  = hold the band whenever it is obtainable (pending connect + scan)
    /// off = radio silent NOW, but REMEMBER the band so the next `on` can
    ///       re-arm a direct connect without a scan (pause probes)
    enum RadioMode { case off, on }

    weak var delegate: BleLegDelegate?

    private var central: CBCentralManager!
    private var peripheral: CBPeripheral?
    private var discovered: [CBPeripheral] = []
    private var pickTimer: DispatchWorkItem?
    // Each connect attempt gets a generation; stale timeout closures from an
    // earlier attempt must never cancel a fresh in-progress connection.
    private var connectGeneration = 0
    private var lastNotifyAt = Date.distantPast
    private var radioMode: RadioMode = .off
    private var anchorArmedAt = Date.distantPast

    override init() {
        super.init()
        central = CBCentralManager(
            delegate: self,
            queue: .main,
            // Restoration: after iOS kills the app under memory pressure, a
            // BLE event on this identifier relaunches it with state intact.
            options: [CBCentralManagerOptionRestoreIdentifierKey: "health-relay-central"]
        )
        // Subscribed-but-silent watchdog: a wedged notify stream (discovery
        // half-failed, band rebooted) recovers by rescanning.
        Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            guard let self = self, self.radioMode == .on,
                  let p = self.peripheral, p.state == .connected else { return }
            if Date().timeIntervalSince(self.lastNotifyAt) > 60 {
                rlog("no HR notifications for 60s while connected, resetting BLE")
                self.resetAndRescan(p)
            }
        }
    }

    /// Arbitration switch. Off silences the radio NOW (releases the band, no
    /// scan, so the mac can take the broadcast slot) but keeps the band
    /// reference for the next `on`. Idempotent.
    func apply(_ mode: RadioMode) {
        radioMode = mode
        pickTimer?.cancel()
        connectGeneration += 1
        guard central.state == .poweredOn else {
            if mode == .off { delegate?.blePhase(.off) }
            return // centralManagerDidUpdateState engages when the radio is up
        }
        switch mode {
        case .off:
            central.stopScan()
            if let p = peripheral, p.state != .disconnected {
                central.cancelPeripheralConnection(p)
            }
            delegate?.blePhase(.off)
        case .on:
            engage()
        }
    }

    /// Full teardown including the remembered band (settings changed; the
    /// device filter may now name a different band).
    func reset() {
        apply(.off)
        peripheral = nil
        discovered.removeAll()
    }

    /// Get the band. A remembered reference gets a DIRECT pending connect: it
    /// never times out, survives app suspension, and wakes the app the moment
    /// the band advertises (= the mac lost it, or we walked out of the mac's
    /// range carrying it). That pending connect is the background lifeline;
    /// scanning is only for first contact.
    private func engage() {
        guard radioMode == .on, central.state == .poweredOn else { return }
        if let p = peripheral {
            guard matchesFilter(p.name) else {
                peripheral = nil
                startScan()
                return
            }
            switch p.state {
            case .connected:
                return // already streaming (or discovery is in flight)
            case .connecting:
                delegate?.blePhase(.connecting(p.name ?? "band"))
                return // pending connect already armed
            default:
                rlog("arming pending connect to \(p.name ?? "unnamed")")
                anchorArmedAt = Date()
                central.connect(p)
                delegate?.blePhase(.connecting(p.name ?? "band"))
                return
            }
        }
        startScan()
    }

    /// Dual-up: drop a live connection NOW; didDisconnect re-arms the pending
    /// connect (the radio stays on), so we immediately re-enter the race for
    /// the band's post-drop advertising window alongside the mac.
    func release() {
        guard radioMode == .on, let p = peripheral, p.state == .connected else { return }
        rlog("release: dropping the band for the dual-up race")
        central.cancelPeripheralConnection(p)
    }

    /// Foreground nudge: a pending connect that has sat unanswered for a long
    /// time may point at a rotated identifier; trade it for a fresh scan
    /// (which would also find the band if it were simply out of range).
    func kick() {
        guard radioMode == .on, let p = peripheral, p.state == .connecting,
              Date().timeIntervalSince(anchorArmedAt) > 60 else { return }
        rlog("pending connect stale after \(Int(Date().timeIntervalSince(anchorArmedAt)))s, rescanning")
        resetAndRescan(p)
    }

    func centralManagerDidUpdateState(_ c: CBCentralManager) {
        switch c.state {
        case .poweredOn:
            if radioMode == .on { engage() }
        case .unauthorized:
            rlog("bluetooth permission DENIED: grant it in Settings > Privacy > Bluetooth")
            delegate?.blePhase(.waitingBluetooth)
        default:
            // Power-off/reset invalidates peripherals WITHOUT firing
            // didDisconnect; holding the stale reference would block every
            // future startScan and wedge the relayer permanently.
            rlog("bluetooth state: \(c.state.rawValue) (waiting)")
            if peripheral != nil {
                peripheral = nil
                delegate?.bleStatus(connected: false, device: nil)
            }
            delegate?.blePhase(.waitingBluetooth)
        }
    }

    /// iOS relaunch path: re-adopt what the system preserved for us. A
    /// restored .connecting peripheral is a pending-connect anchor that
    /// survived the jetsam; leave it armed.
    func centralManager(_ c: CBCentralManager, willRestoreState dict: [String: Any]) {
        let restored = (dict[CBCentralManagerRestoredStatePeripheralsKey] as? [CBPeripheral]) ?? []
        defer { delegate?.bleDidRestore() } // socket must come up even in background
        guard let p = restored.first(where: { matchesFilter($0.name) }) else { return }
        // A yield outranks restoration: if the system relaunched us holding
        // (or hunting) the band while a persisted disarm is active, that grab
        // is exactly what the yield exists to prevent: DROP it, stay dark.
        // (The restored anchor may have already won the race at the OS level:
        // a suspended pending connect fires on the freed band; canceling here
        // frees it again within the wake window.)
        if YieldState.active {
            rlog("restored \(p.name ?? "unnamed") during an active yield; dropping it (radio stays off)")
            radioMode = .off
            c.cancelPeripheralConnection(p)
            delegate?.blePhase(.off)
            return
        }
        rlog("restored \(p.name ?? "unnamed") from system state (\(p.state.rawValue))")
        radioMode = .on
        peripheral = p
        p.delegate = self
        anchorArmedAt = Date()
        if p.state == .connected {
            delegate?.bleStatus(connected: true, device: p.name)
            delegate?.blePhase(.streaming(p.name ?? "band"))
            p.discoverServices([HR_SERVICE]) // re-arm notify if needed
        } else if p.state == .connecting {
            delegate?.blePhase(.connecting(p.name ?? "band"))
        }
        // Any other state resolves through centralManagerDidUpdateState.
    }

    private func matchesFilter(_ name: String?) -> Bool {
        (name ?? "").uppercased().contains(Settings.shared.deviceFilter.uppercased())
    }

    private func resetAndRescan(_ p: CBPeripheral) {
        central.cancelPeripheralConnection(p)
        peripheral = nil
        delegate?.bleStatus(connected: false, device: nil)
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.startScan() }
    }

    private func startScan() {
        guard radioMode == .on, central.state == .poweredOn, peripheral == nil else { return }
        rlog("scanning for \(Settings.shared.deviceFilter) (is Broadcast HR on in the WHOOP app?)")
        delegate?.blePhase(.scanning)
        discovered.removeAll()
        // The service filter is mandatory for background scanning on iOS;
        // it is also the right filter in the foreground.
        central.scanForPeripherals(withServices: [HR_SERVICE])
        pickTimer?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.pickAndConnect() }
        pickTimer = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 4, execute: work)
    }

    private func pickAndConnect() {
        guard radioMode == .on, peripheral == nil else { return }
        let matches = discovered.filter { matchesFilter($0.name) }
        guard let pick = matches.first else {
            if !discovered.isEmpty {
                let seen = discovered.map { $0.name ?? "unnamed" }.joined(separator: ", ")
                rlog("no \(Settings.shared.deviceFilter) device found (ignoring: \(seen)); still scanning")
            }
            let work = DispatchWorkItem { [weak self] in self?.pickAndConnect() }
            pickTimer = work
            DispatchQueue.main.asyncAfter(deadline: .now() + 4, execute: work)
            return
        }
        central.stopScan()
        peripheral = pick
        pick.delegate = self
        connectGeneration += 1
        let gen = connectGeneration
        rlog("connecting to \(pick.name ?? "unnamed")")
        delegate?.blePhase(.connecting(pick.name ?? "band"))
        central.connect(pick)
        // CoreBluetooth's connect never times out on its own; a band that
        // vanished after discovery would wedge the relayer forever.
        DispatchQueue.main.asyncAfter(deadline: .now() + 15) { [weak self] in
            guard let self = self, self.connectGeneration == gen,
                  let p = self.peripheral, p.state != .connected else { return }
            rlog("connect timed out, rescanning")
            self.resetAndRescan(p)
        }
    }

    func centralManager(_ c: CBCentralManager, didDiscover p: CBPeripheral,
                        advertisementData: [String: Any], rssi: NSNumber) {
        if !discovered.contains(where: { $0.identifier == p.identifier }) {
            rlog("found \(p.name ?? "unnamed") rssi \(rssi)")
            discovered.append(p)
        }
    }

    func centralManager(_ c: CBCentralManager, didConnect p: CBPeripheral) {
        rlog("connected to \(p.name ?? "unnamed")")
        central.stopScan()
        delegate?.bleStatus(connected: true, device: p.name)
        p.discoverServices([HR_SERVICE])
    }

    func centralManager(_ c: CBCentralManager, didFailToConnect p: CBPeripheral, error: Error?) {
        rlog("connect failed: \(error?.localizedDescription ?? "unknown")")
        connectGeneration += 1 // invalidate the pending connect-timeout
        peripheral = nil
        // Scan immediately: in the background this callback IS the wake
        // window, and a delayed timer may never fire before suspension.
        startScan()
    }

    func centralManager(_ c: CBCentralManager, didDisconnectPeripheral p: CBPeripheral, error: Error?) {
        rlog("band disconnected\(error != nil ? " (\(error!.localizedDescription))" : "")")
        connectGeneration += 1
        delegate?.bleStatus(connected: false, device: nil)
        // Keep the reference. If the radio should be on, re-arm a pending
        // connect inside the disconnect wake window: it persists through
        // suspension and fires when the band is back in range. The old
        // rescan path needed live timers the suspended app doesn't get.
        // Identifier check: resetAndRescan drops a wedged band on purpose
        // (peripheral = nil before the cancel lands); never resurrect it.
        guard radioMode == .on, peripheral?.identifier == p.identifier else { return }
        rlog("re-arming pending connect to \(p.name ?? "unnamed")")
        anchorArmedAt = Date()
        delegate?.blePhase(.connecting(p.name ?? "band"))
        // ~50ms defer, NOT synchronous: an immediate connect inside
        // didDisconnect can wedge CoreBluetooth into a phantom .connecting
        // with no real pending connection (Apple forums, hard-confirmed).
        // Still comfortably inside the wake window a suspended app gets.
        let gen = connectGeneration
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
            guard let self = self, self.connectGeneration == gen,
                  self.radioMode == .on, let cur = self.peripheral,
                  cur.identifier == p.identifier, cur.state == .disconnected else { return }
            self.central.connect(cur)
        }
    }

    // Discovery/subscription failures after a successful connect must never
    // guard-return silently: peripheral would stay non-nil and block every
    // future startScan. Every failure path resets and rescans.
    func peripheral(_ p: CBPeripheral, didDiscoverServices error: Error?) {
        guard error == nil, let svc = p.services?.first(where: { $0.uuid == HR_SERVICE }) else {
            rlog("service discovery failed (\(error?.localizedDescription ?? "no HR service")), resetting")
            resetAndRescan(p)
            return
        }
        p.discoverCharacteristics([HR_MEASUREMENT], for: svc)
    }

    func peripheral(_ p: CBPeripheral, didDiscoverCharacteristicsFor svc: CBService, error: Error?) {
        guard error == nil, let ch = svc.characteristics?.first(where: { $0.uuid == HR_MEASUREMENT }) else {
            rlog("characteristic discovery failed (\(error?.localizedDescription ?? "no 2A37")), resetting")
            resetAndRescan(p)
            return
        }
        p.setNotifyValue(true, for: ch)
        lastNotifyAt = Date() // arm the silence watchdog from subscribe time
        rlog("subscribed to Heart Rate Measurement, streaming")
        delegate?.blePhase(.streaming(p.name ?? "band"))
    }

    func peripheral(_ p: CBPeripheral, didUpdateNotificationStateFor ch: CBCharacteristic, error: Error?) {
        if let error = error {
            rlog("notify subscription failed (\(error.localizedDescription)), resetting")
            resetAndRescan(p)
        }
    }

    func peripheral(_ p: CBPeripheral, didUpdateValueFor ch: CBCharacteristic, error: Error?) {
        guard error == nil, let data = ch.value else { return }
        lastNotifyAt = Date()
        delegate?.bleFrame(data)
    }
}
