// HealthKit steps courier: reads WHOOP-recorded step samples from Apple
// Health and forwards new ones to the daemon. WHOOP's cloud API has no steps
// endpoint at all; the WHOOP app writing into HealthKit is the only sanctioned
// path to daily movement. Read-only, filtered to WHOOP as the source: the
// iPhone's own pedometer and any other app are deliberately ignored (one
// sensor, tracked consistently against itself).
//
// Delivery cadence is iOS's call: background wakeups for step data batch
// roughly hourly.
//
// Anchor is ACK-GATED: the persisted anchor advances only after the daemon
// confirms the batch (steps_ack). If a batch is queried but never delivered
// (daemon asleep, tailnet down, app killed mid-send), the anchor stays put and
// the next query re-fetches those samples; the daemon dedupes by UUID. This is
// what makes "nothing is lost" true even though the outbound socket buffer is
// in-memory and lossy. HealthKit deletions (a source revising a value deletes
// the old UUID + inserts a new one) are forwarded too, so a re-synced hour
// cannot double-count.

import Foundation
import HealthKit

// Batch size cap: the daemon rejects a steps message over 5000 samples, and a
// first sync can span months. Querying with this limit pages the history one
// bounded batch per round-trip, each committed on its own ack.
private let STEPS_BATCH_LIMIT = 4000

// Plain class; HealthKit callbacks arrive on background queues, so every
// @Published mutation hops to main explicitly.
final class StepsCourier: ObservableObject {
    enum State: Equatable {
        case idle
        case unavailable // no HealthKit on this device
        case denied
        case noWhoopSource // authorized, but WHOOP has never written steps
        case active
    }

    @Published var state: State = .idle
    @Published var lastSyncAt: Date?
    @Published var lastBatchCount = 0

    private let store = HKHealthStore()
    private let stepType = HKQuantityType(.stepCount)
    private var observerStarted = false
    private weak var relay: RelayController?

    // Anchor awaiting the daemon's ack; committed in stepsAcked(), never before.
    private var pendingAnchor: HKQueryAnchor?
    private var inFlight = false // a batch is out awaiting ack; don't double-query
    private var moreToDrain = false // last batch hit the limit: page again on ack
    private var whoopSources: Set<HKSource> = []

    private static let anchorKey = "steps_anchor_v1"

    func attach(_ relay: RelayController) {
        self.relay = relay
        relay.onStepsAck = { [weak self] in self?.stepsAcked() }
    }

    func startIfAuthorized() {
        guard HKHealthStore.isHealthDataAvailable() else {
            state = .unavailable
            return
        }
        // Read authorization status is not queryable (privacy by design), so
        // just request: the dialog shows once, ever.
        store.requestAuthorization(toShare: [], read: [stepType]) { [weak self] granted, _ in
            DispatchQueue.main.async {
                guard let self = self else { return }
                guard granted else {
                    self.state = .denied
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
        let query = HKObserverQuery(sampleType: stepType, predicate: nil) { [weak self] _, done, _ in
            DispatchQueue.main.async { self?.syncNow() }
            done() // must complete, or iOS throttles future wakeups
        }
        store.execute(query)
        store.enableBackgroundDelivery(for: stepType, frequency: .hourly) { ok, err in
            if !ok { rlog("steps background delivery unavailable: \(err?.localizedDescription ?? "unknown")") }
        }
    }

    func syncNow() {
        guard HKHealthStore.isHealthDataAvailable() else { return }
        // Resolve WHOOP as a source first; without it there is nothing to relay.
        // A batch is already out awaiting ack; the ack path drains the rest,
        // so a second observer wakeup must not start a parallel query.
        guard !inFlight else { return }
        let sourceQuery = HKSourceQuery(sampleType: stepType, samplePredicate: nil) { [weak self] _, sources, _ in
            DispatchQueue.main.async {
                guard let self = self else { return }
                let whoop = (sources ?? []).filter {
                    $0.bundleIdentifier.lowercased().contains("whoop")
                        || $0.name.lowercased().contains("whoop")
                }
                guard !whoop.isEmpty else {
                    if self.state != .active { self.state = .noWhoopSource }
                    return
                }
                self.whoopSources = whoop
                self.runAnchoredQuery()
            }
        }
        store.execute(sourceQuery)
    }

    private func runAnchoredQuery() {
        guard !inFlight, !whoopSources.isEmpty else { return }
        let predicate = HKQuery.predicateForObjects(from: whoopSources)
        let query = HKAnchoredObjectQuery(
            type: stepType,
            predicate: predicate,
            anchor: Self.loadAnchor(),
            limit: STEPS_BATCH_LIMIT
        ) { [weak self] _, samples, deleted, newAnchor, error in
            DispatchQueue.main.async {
                guard let self = self else { return }
                if let error = error {
                    rlog("steps query failed: \(error.localizedDescription)")
                    return
                }
                self.state = .active
                let quantities = (samples as? [HKQuantitySample]) ?? []
                let deletedUuids = (deleted ?? []).map { $0.uuid.uuidString }
                // Nothing new AND nothing deleted: commit the anchor directly
                // (no round-trip needed) and stop.
                if quantities.isEmpty && deletedUuids.isEmpty {
                    Self.saveAnchor(newAnchor)
                    return
                }
                let iso = ISO8601DateFormatter()
                let payload: [[String: Any]] = quantities.map {
                    [
                        "uuid": $0.uuid.uuidString,
                        "start": iso.string(from: $0.startDate),
                        "end": iso.string(from: $0.endDate),
                        "count": Int($0.quantity.doubleValue(for: .count()).rounded()),
                    ]
                }
                // Anchor is held, NOT saved, until the daemon acks this batch.
                self.pendingAnchor = newAnchor
                self.moreToDrain = quantities.count >= STEPS_BATCH_LIMIT
                self.inFlight = true
                self.relay?.sendSteps(payload, deleted: deletedUuids)
                self.lastSyncAt = Date()
                self.lastBatchCount = payload.count
                rlog("steps: sent \(payload.count) samples + \(deletedUuids.count) deletions, awaiting ack")
            }
        }
        store.execute(query)
    }

    /// Daemon confirmed the batch: NOW it is safe to advance the anchor. If the
    /// batch filled the limit there may be more history to page.
    private func stepsAcked() {
        guard inFlight else { return }
        inFlight = false
        if let a = pendingAnchor { Self.saveAnchor(a) }
        pendingAnchor = nil
        if moreToDrain {
            moreToDrain = false
            runAnchoredQuery()
        }
    }

    private static func loadAnchor() -> HKQueryAnchor? {
        guard let data = UserDefaults.standard.data(forKey: anchorKey) else { return nil }
        return try? NSKeyedUnarchiver.unarchivedObject(ofClass: HKQueryAnchor.self, from: data)
    }

    private static func saveAnchor(_ anchor: HKQueryAnchor?) {
        guard let anchor = anchor,
              let data = try? NSKeyedArchiver.archivedData(withRootObject: anchor, requiringSecureCoding: true)
        else { return }
        UserDefaults.standard.set(data, forKey: anchorKey)
    }
}
