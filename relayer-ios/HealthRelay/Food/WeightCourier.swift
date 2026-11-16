// HealthKit weigh-in courier: body mass + body fat % from Apple Health to the
// daemon, where the food log's baseline fits a weight trend against logged
// intake. The scale (Xiaomi S400 via Xiaomi Home) writes into Health; this
// reads it the same way StepsCourier reads WHOOP steps.
//
// Same ack-gated anchor discipline as steps: both anchors advance only after
// the daemon confirms the batch (body_mass_ack), so a batch lost to a dead
// socket or a killed app is re-queried, and the daemon dedupes by UUID.
// HealthKit deletions (a sample removed in Health) are forwarded too.
//
// WHOOP's own entries are EXCLUDED: the WHOOP app can write the profile
// weight into Health, and a constant typed-in number would flatten the trend.

import Foundation
import HealthKit

private let WEIGHT_BATCH_LIMIT = 2000

final class WeightCourier: ObservableObject {
    @Published var lastSyncAt: Date?
    @Published var denied = false

    private let store = HKHealthStore()
    private let massType = HKQuantityType(.bodyMass)
    private let fatType = HKQuantityType(.bodyFatPercentage)
    private weak var relay: RelayController?
    private var observerStarted = false
    private var inFlight = false
    private var moreToDrain = false
    private var pendingAnchors: [String: HKQueryAnchor] = [:]
    private var batchGen = 0

    func attach(_ relay: RelayController) {
        self.relay = relay
        relay.onBodyMassAck = { [weak self] in self?.acked() }
    }

    func startIfAuthorized() {
        guard HKHealthStore.isHealthDataAvailable() else { return }
        store.requestAuthorization(toShare: [], read: [massType, fatType]) { [weak self] granted, _ in
            DispatchQueue.main.async {
                guard let self = self else { return }
                guard granted else {
                    self.denied = true
                    return
                }
                self.startObserving()
                self.syncNow()
            }
        }
    }

    private func startObserving() {
        guard !observerStarted else { return }
        observerStarted = true
        for type in [massType, fatType] {
            let q = HKObserverQuery(sampleType: type, predicate: nil) { [weak self] _, done, _ in
                DispatchQueue.main.async { self?.syncNow() }
                done()
            }
            store.execute(q)
            // A weigh-in is a once-a-day event; immediate delivery keeps the
            // morning number flowing without waiting on the hourly batch.
            store.enableBackgroundDelivery(for: type, frequency: .immediate) { ok, err in
                if !ok { rlog("weight background delivery unavailable: \(err?.localizedDescription ?? "unknown")") }
            }
        }
    }

    func syncNow() {
        guard HKHealthStore.isHealthDataAvailable(), !inFlight, relay != nil else { return }
        // Query both types, then send one combined batch.
        var collected: [(kind: String, samples: [HKQuantitySample], raw: Int, deleted: [String], anchor: HKQueryAnchor?)] = []
        let group = DispatchGroup()
        let lock = NSLock()
        for (kind, type) in [("mass", massType), ("fat", fatType)] {
            group.enter()
            let q = HKAnchoredObjectQuery(
                type: type, predicate: nil, anchor: Self.loadAnchor(kind), limit: WEIGHT_BATCH_LIMIT
            ) { _, samples, deleted, newAnchor, error in
                if let error = error { rlog("weight query (\(kind)) failed: \(error.localizedDescription)") }
                let all = (samples as? [HKQuantitySample]) ?? []
                let qs = all.filter { !isWhoopSource($0.sourceRevision.source) }
                lock.lock()
                // `raw` (pre-filter) decides paging: a full page that held WHOOP
                // entries is still a full page.
                collected.append((kind, error == nil ? qs : [], error == nil ? all.count : 0,
                                  (deleted ?? []).map { $0.uuid.uuidString }, error == nil ? newAnchor : nil))
                lock.unlock()
                group.leave()
            }
            store.execute(q)
        }
        group.notify(queue: .main) { [weak self] in
            self?.dispatch(collected)
        }
    }

    private func dispatch(_ collected: [(kind: String, samples: [HKQuantitySample], raw: Int, deleted: [String], anchor: HKQueryAnchor?)]) {
        guard !inFlight else { return }
        let iso = ISO8601DateFormatter()
        var payload: [[String: Any]] = []
        var deleted: [String] = []
        for c in collected {
            let unit: HKUnit = c.kind == "mass" ? .gramUnit(with: .kilo) : .percent()
            for s in c.samples {
                payload.append([
                    "uuid": s.uuid.uuidString,
                    "ts": iso.string(from: s.startDate),
                    "kind": c.kind,
                    "value": s.quantity.doubleValue(for: unit), // kg, or a 0-1 fraction
                    "source": s.sourceRevision.source.name,
                ])
            }
            deleted += c.deleted
        }
        let anchors = collected.reduce(into: [String: HKQueryAnchor]()) { acc, c in
            if let a = c.anchor { acc[c.kind] = a }
        }
        let fullPage = collected.contains { $0.raw >= WEIGHT_BATCH_LIMIT }
        if payload.isEmpty && deleted.isEmpty {
            anchors.forEach { Self.saveAnchor($0.value, $0.key) }
            if fullPage { syncNow() } // an all-WHOOP page: keep paging
            return
        }
        pendingAnchors = anchors
        moreToDrain = fullPage
        inFlight = true
        batchGen += 1
        let gen = batchGen
        relay?.sendBodyMass(payload, deleted: deleted)
        lastSyncAt = Date()
        rlog("weight: sent \(payload.count) samples + \(deleted.count) deletions, awaiting ack")
        // A send into a dead socket never acks; un-stick after a while so the
        // next observer wakeup or foreground can re-query (anchor unchanged).
        DispatchQueue.main.asyncAfter(deadline: .now() + 60) { [weak self] in
            guard let self = self, self.inFlight, self.batchGen == gen else { return }
            self.inFlight = false
            self.pendingAnchors = [:]
        }
    }

    private func acked() {
        guard inFlight else { return }
        inFlight = false
        pendingAnchors.forEach { Self.saveAnchor($0.value, $0.key) }
        pendingAnchors = [:]
        if moreToDrain {
            moreToDrain = false
            syncNow()
        }
    }


    private static func key(_ kind: String) -> String { "weight_anchor_\(kind)_v1" }

    private static func loadAnchor(_ kind: String) -> HKQueryAnchor? {
        guard let data = UserDefaults.standard.data(forKey: key(kind)) else { return nil }
        return try? NSKeyedUnarchiver.unarchivedObject(ofClass: HKQueryAnchor.self, from: data)
    }

    private static func saveAnchor(_ anchor: HKQueryAnchor, _ kind: String) {
        guard let data = try? NSKeyedArchiver.archivedData(withRootObject: anchor, requiringSecureCoding: true) else { return }
        UserDefaults.standard.set(data, forKey: key(kind))
    }
}
