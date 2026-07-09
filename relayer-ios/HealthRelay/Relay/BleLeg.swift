// BLE leg: subscribes to the band's Broadcast Heart Rate (0x180D/0x2A37) and
// hands raw notification bytes up. Ported from the mac relayer with the iOS
// additions: background mode (service-filtered scans keep working with the
// screen locked), state restoration (iOS relaunches the app on BLE events
// after a jetsam kill), and an on/off switch driven by the daemon's
// arbitration (standdown = radio fully off so the mac can own the band).

import CoreBluetooth
import Foundation

let HR_SERVICE = CBUUID(string: "180D")
let HR_MEASUREMENT = CBUUID(string: "2A37")

protocol BleLegDelegate: AnyObject {
    func bleFrame(_ raw: Data)
    func bleStatus(connected: Bool, device: String?)
    func blePhase(_ phase: BleLeg.Phase)
}

final class BleLeg: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
    enum Phase: Equatable {
        case off // standdown/pause: radio deliberately idle
        case waitingBluetooth // powered off / unauthorized
        case scanning
        case connecting(String)
        case streaming(String)
    }

    weak var delegate: BleLegDelegate?

    private var central: CBCentralManager!
    private var peripheral: CBPeripheral?
    private var discovered: [CBPeripheral] = []
    private var pickTimer: DispatchWorkItem?
    // Each connect attempt gets a generation; stale timeout closures from an
    // earlier attempt must never cancel a fresh in-progress connection.
    private var connectGeneration = 0
    private var lastNotifyAt = Date.distantPast
    private var enabled = false

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
            guard let self = self, self.enabled,
                  let p = self.peripheral, p.state == .connected else { return }
            if Date().timeIntervalSince(self.lastNotifyAt) > 60 {
                rlog("no HR notifications for 60s while connected, resetting BLE")
                self.resetAndRescan(p)
            }
        }
    }

    /// Arbitration switch. Off = stop scanning AND release the band, so the
    /// mac relayer can take the broadcast slot.
    func setEnabled(_ on: Bool) {
        guard on != enabled else { return }
        enabled = on
        if on {
            startScan()
        } else {
            pickTimer?.cancel()
            connectGeneration += 1
            central.stopScan()
            if let p = peripheral {
                central.cancelPeripheralConnection(p)
                peripheral = nil
                delegate?.bleStatus(connected: false, device: nil)
            }
            delegate?.blePhase(.off)
        }
    }

    func centralManagerDidUpdateState(_ c: CBCentralManager) {
        switch c.state {
        case .poweredOn:
            if enabled { startScan() }
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

    /// iOS relaunch path: re-adopt what the system preserved for us.
    func centralManager(_ c: CBCentralManager, willRestoreState dict: [String: Any]) {
        let restored = (dict[CBCentralManagerRestoredStatePeripheralsKey] as? [CBPeripheral]) ?? []
        guard let p = restored.first(where: { matchesFilter($0.name) }) else { return }
        rlog("restored \(p.name ?? "unnamed") from system state")
        enabled = true
        peripheral = p
        p.delegate = self
        if p.state == .connected {
            delegate?.bleStatus(connected: true, device: p.name)
            delegate?.blePhase(.streaming(p.name ?? "band"))
            p.discoverServices([HR_SERVICE]) // re-arm notify if needed
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
        guard enabled, central.state == .poweredOn, peripheral == nil else { return }
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
        guard enabled, peripheral == nil else { return }
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
        delegate?.bleStatus(connected: true, device: p.name)
        p.discoverServices([HR_SERVICE])
    }

    func centralManager(_ c: CBCentralManager, didFailToConnect p: CBPeripheral, error: Error?) {
        rlog("connect failed: \(error?.localizedDescription ?? "unknown")")
        connectGeneration += 1 // invalidate the pending connect-timeout
        peripheral = nil
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.startScan() }
    }

    func centralManager(_ c: CBCentralManager, didDisconnectPeripheral p: CBPeripheral, error: Error?) {
        rlog("band disconnected\(error != nil ? " (\(error!.localizedDescription))" : "")")
        connectGeneration += 1
        delegate?.bleStatus(connected: false, device: nil)
        peripheral = nil
        guard enabled else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.startScan() }
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
