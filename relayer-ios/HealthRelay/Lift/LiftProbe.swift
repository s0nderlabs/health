// Diagnostics: the background-upload transport test. Before lift clips pick
// a path for good, this answers one question with real numbers: which way
// does a 50 MB body reach the Mac from a LOCKED phone through a background
// session, the ts.net host (https :8443) or the tailnet IP (http :8791)?
//
// One synthetic 50 MB file (random bytes, so no link can compress it) is
// written ahead (when Diagnostics opens), then two background uploads go to
// POST /lift-video/probe, which the daemon streams to nowhere and answers
// { bytes, ms }.
//
// ONE AFTER THE OTHER (Nov 18 2026): run side by side, the two shared the
// uplink and the times said nothing about the paths (home Wi-Fi: host
// 26.8 s, tailnet 56.5 s, which was just the split). Now 1 of 2 (Tailscale
// host) goes alone, and 2 of 2 (tailnet IP) starts only once 1 of 2 has
// settled, OK or failed.
//
// 2 of 2 is created ONLY while the app is in the foreground. A task created
// with the app in the background is discretionary whatever the config says
// (iOS may hold it for Wi-Fi and a charger), so its time would be
// meaningless. If 1 of 2 settles while the phone is locked (the delegate
// call arrives with the app in the background), 2 of 2 is marked held and
// its row says so; it starts on the next foreground (scene active ->
// reconcile). Rejected: creating both up front with the second suspended
// and resuming it from the delegate callback, because that resume would
// still happen in the background (the same discretionary treatment, plus
// the background resume rate limiter); and any delay is a guess, not a gate.
//
// "Lock the phone now" shows only once the running task exists: a task
// created after the lock would be discretionary and the verdict meaningless
// (each run records whether that happened anyway). Each transport's state is
// persisted, so the result is there when he unlocks the phone, even if iOS
// relaunched the app in the background to deliver it. The file is deleted
// once both runs have settled.

import Foundation
import SwiftUI
import UIKit

final class LiftProbe: ObservableObject {
    static let shared = LiftProbe()
    static let size: Int64 = 50 * 1_000_000
    static let fileName = "probe-50mb.bin"

    /// queued: no task yet, this run goes after the one ahead of it settles.
    /// waiting: task created, no byte sent yet. An unknown value (a newer
    /// build's) decodes as idle, see the tolerant decode below.
    enum State: String, Codable { case idle, queued, waiting, uploading, ok, failed }

    /// The order the paths go in: 1 of 2, then 2 of 2.
    static let order: [LiftTransport] = [.host, .tailnet]
    /// 1-based position of a path in the run.
    static func position(_ t: LiftTransport) -> Int { (order.firstIndex(of: t) ?? 0) + 1 }
    /// Where a path ran (or runs) in the sequence: the stored order, else its
    /// fixed position. Results from before the sequential probe have none.
    func slot(_ t: LiftTransport) -> Int { run(t).order ?? Self.position(t) }
    private static var fileError: String { "Could not write the \(size / 1_000_000) MB test file" }

    struct Run: Codable, Equatable {
        var state: State = .idle
        var sent: Int64 = 0
        var total: Int64 = LiftProbe.size
        var startedAt: Date?
        var finishedAt: Date?
        var serverMs: Int?
        var serverBytes: Int64?
        var error: String?
        /// The session task of this run; outcomes from any other are stale.
        var taskId: Int?
        /// Created with the app in the background (iOS may have deferred it).
        var background = false
        /// 1 or 2: where this path ran in the sequence. nil on results saved
        /// before the probe went sequential (both ran at once).
        var order: Int?
        /// Its turn came while the app was in the background, so it waited
        /// for the app to be opened before its task was created.
        var held = false
        /// The app went to the background (phone locked or switched away)
        /// while this run's upload was in flight. Only then does an OK prove
        /// locked-phone sending: 2 of 2 often starts and finishes with the app
        /// open. nil on results saved before this field existed.
        var sawBackground: Bool?

        /// An OK that proves the upload carries on with the phone locked.
        /// Results from before the sequential probe (order == nil) ran both
        /// paths while he locked the phone, so they keep their old meaning.
        var provedLocked: Bool {
            state == .ok && !background && (sawBackground ?? (order == nil))
        }

        var seconds: Double? {
            guard let a = startedAt, let b = finishedAt else { return nil }
            return b.timeIntervalSince(a)
        }
        /// A task exists and has not reported.
        var inFlight: Bool { state == .waiting || state == .uploading }
        /// Not settled: in flight, or queued behind the run ahead of it.
        var live: Bool { inFlight || state == .queued }
    }

    @Published private(set) var runs: [LiftTransport: Run] = [:]
    @Published private(set) var preparing = false

    private static let key = "lift_probe_v1"
    private var file: URL { LiftStore.dir.appendingPathComponent(Self.fileName) }
    /// Writes and deletes of the test file, one at a time.
    private let fileQueue = DispatchQueue(label: "health.lift-probe-file", qos: .userInitiated)

    private init() {
        if let data = UserDefaults.standard.data(forKey: Self.key),
           let saved = try? JSONDecoder().decode([String: Run].self, from: data) {
            for (k, v) in saved { if let t = LiftTransport(rawValue: k) { runs[t] = v } }
        }
        #if DEBUG
        if Demo.active, let mode = ProcessInfo.processInfo.environment["HR_DEMO_PROBE"] {
            runs = Self.demo(mode)
            // As after a real run: the path that passed is the one in use.
            Settings.shared.liftTransportChoice = .tailnet
        }
        #endif
        if !Demo.active, !runs.values.contains(where: \.live) { removeFile() }
        // Leaving the foreground mid-upload is what a locked-phone pass needs.
        NotificationCenter.default.addObserver(
            forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main
        ) { [weak self] _ in self?.markBackgrounded() }
    }

    /// Every upload in flight now has the app in the background.
    private func markBackgrounded() {
        var changed = false
        for (t, r) in runs where r.inFlight && r.sawBackground != true {
            runs[t]?.sawBackground = true
            changed = true
        }
        if changed { persist() }
    }

    func run(_ t: LiftTransport) -> Run { runs[t] ?? Run() }

    var running: Bool { preparing || runs.values.contains(where: \.live) }

    /// Write the test file ahead (Diagnostics on screen), so Start creates
    /// the first task at once and "lock now" follows immediately.
    func prepare() {
        guard !Demo.active else { return }
        let file = self.file
        fileQueue.async { _ = Self.ensureFile(file) }
    }

    /// The file if needed (off main), then 1 of 2; 2 of 2 waits its turn.
    func start() {
        guard !running, !Demo.active else { return }
        rlog("lift probe: start (sequential)")
        preparing = true
        let file = self.file
        fileQueue.async {
            let ok = Self.ensureFile(file)
            DispatchQueue.main.async {
                self.preparing = false
                guard ok else {
                    for t in Self.order {
                        self.runs[t] = Run(state: .failed, finishedAt: Date(), error: Self.fileError, order: Self.position(t))
                    }
                    return self.persist()
                }
                self.runs = [:]
                for t in Self.order.dropFirst() { self.runs[t] = Run(state: .queued, order: Self.position(t)) }
                if let first = Self.order.first { self.launch(first) }
                self.persist()
                // 1 of 2 may have failed on the spot (no URL): 2 of 2 goes now.
                self.advance()
            }
        }
    }

    /// The next queued path, once every path ahead of it has settled. Only
    /// with the app in the foreground (see the header): from the background
    /// it is marked held and waits for the next foreground's reconcile.
    private var startingNext = false
    private func advance() {
        guard !preparing, !startingNext,
              let next = Self.order.first(where: { run($0).state == .queued })
        else { return settleIfDone() }
        let ahead = Self.order.prefix(while: { $0 != next })
        guard !ahead.contains(where: { run($0).live }) else { return }
        guard UIApplication.shared.applicationState == .active else {
            return markHeld(next, "its turn came with the app in the background")
        }
        startingNext = true
        let file = self.file
        fileQueue.async {
            // Normally a stat: the file stays while any run is unsettled.
            let ok = Self.ensureFile(file)
            DispatchQueue.main.async {
                self.startingNext = false
                // Stopped (or already started) meanwhile: nothing to do.
                guard self.run(next).state == .queued else { return }
                // The app may have gone to the background during the file
                // step: 2 of 2 is only ever created in the foreground.
                guard UIApplication.shared.applicationState == .active else {
                    return self.markHeld(next, "the app left the foreground before its start")
                }
                if ok {
                    self.launch(next)
                } else {
                    var r = self.run(next)
                    r.state = .failed
                    r.finishedAt = Date()
                    r.error = Self.fileError
                    self.runs[next] = r
                }
                self.persist()
                self.advance()
            }
        }
    }

    /// Its turn came with the app not in the foreground: it waits for the
    /// next foreground's reconcile (a background start would be deferred).
    private func markHeld(_ t: LiftTransport, _ why: String) {
        guard !run(t).held else { return }
        runs[t]?.held = true
        rlog("lift probe: \(t.rawValue) held: \(why)")
        persist()
    }

    private func launch(_ t: LiftTransport) {
        let prior = run(t)
        var r = Run(state: .waiting, startedAt: Date(), order: slot(t), held: prior.held)
        guard let url = Settings.shared.liftURL("/lift-video/probe", via: t) else {
            r.state = .failed
            r.finishedAt = Date()
            r.error = Settings.shared.liftUnreachableReason(t)
            runs[t] = r
            return
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/octet-stream", forHTTPHeaderField: "content-type")
        rlog("lift probe: \(t.rawValue) -> \(url.host ?? "?"):\(url.port ?? 0)")
        let sub = LiftTransfer.shared.upload(req, file: file, tag: "probe:\(t.rawValue)")
        r.taskId = sub.id
        r.background = sub.background
        runs[t] = r
        // The stall verdict for this task (a suspended app gets the same
        // check from the next foreground's reconcile).
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.stall + 1) { self.reconcile() }
    }

    /// A background session never fails on "no route" or an unresolvable
    /// name: it waits for connectivity, up to the session's day-long cap.
    /// For a test that is a non-answer, so a path whose LIVE task has not
    /// sent a byte in two minutes is called failed (and cancelled).
    static let stall: TimeInterval = 120

    /// Clear both rows (and stop anything still running): the Stop button.
    func reset() {
        for t in Self.order { LiftTransfer.shared.cancel(tag: "probe:\(t.rawValue)") }
        runs = [:]
        persist()
        removeFile()
    }

    /// On foreground, on a timer after start, on socket reconnect: progress
    /// from the live tasks (a suspended app gets no callbacks, so the saved
    /// numbers are stale), then the verdicts. Waits until the session has
    /// replayed what finished while the app was gone, so a finished run is
    /// never called lost. Then a held 2 of 2 starts, if the app is open.
    func reconcile() {
        guard !Demo.active, running, !preparing else { return }
        LiftTransfer.shared.whenSettled {
            LiftTransfer.shared.tasks { snap in
                for t in Self.order {
                    guard var r = self.runs[t], r.inFlight else { continue }
                    let tag = "probe:\(t.rawValue)"
                    if let task = snap.task(tag, id: r.taskId) {
                        r.taskId = task.taskIdentifier
                        // Finished: its outcome is on the way; no verdict.
                        if task.state != .completed {
                            let sent = task.countOfBytesSent
                            if sent > 0 {
                                r.state = .uploading
                                r.sent = max(r.sent, sent)
                                if task.countOfBytesExpectedToSend > 0 { r.total = task.countOfBytesExpectedToSend }
                            } else if r.sent == 0, let at = r.startedAt, Date().timeIntervalSince(at) >= Self.stall {
                                r.state = .failed
                                r.finishedAt = Date()
                                r.error = "No byte sent in 2 min: iOS is still waiting for a route to this address"
                                task.cancel()
                            }
                        }
                    } else if !snap.known(tag) {
                        r.state = .failed
                        r.finishedAt = Date()
                        r.error = "Lost: the app was closed from the app switcher, which cancels background uploads"
                    }
                    self.runs[t] = r
                }
                self.persist()
                self.advance()
            }
        }
    }

    // ── from LiftTransfer (main) ─────────────────────────────────────

    private var lastPersist = Date.distantPast

    func progress(_ t: LiftTransport, task: Int, sent: Int64, total: Int64) {
        var r = run(t)
        guard r.inFlight, r.taskId == task else { return }
        r.state = .uploading
        r.sent = sent
        if total > 0 { r.total = total }
        // Only a real background state: Control Center, a banner or the app
        // switcher make the app .inactive without the phone being locked.
        if UIApplication.shared.applicationState == .background { r.sawBackground = true }
        runs[t] = r
        // Progress is for the eyes; persist it only now and then.
        if Date().timeIntervalSince(lastPersist) > 2 { persist() }
    }

    func finished(_ t: LiftTransport, task: Int, _ o: LiftTransfer.Outcome) {
        rlog("lift probe: \(t.rawValue) task \(task) finished status=\(o.status ?? 0) error=\(o.error?.localizedDescription ?? "none")")
        var r = run(t)
        // Another run's task (Stop, Run again), or an outcome after a verdict
        // that is not a success (the stall cancel lands here). A real 200
        // still wins over an earlier "stalled"/"lost" call.
        guard r.taskId == task, r.inFlight || (r.state == .failed && o.error == nil && o.status == 200) else { return }
        r.finishedAt = Date()
        if UIApplication.shared.applicationState == .background { r.sawBackground = true }
        if o.error == nil, o.status == 200 {
            r.state = .ok
            r.sent = r.total
            r.serverMs = (o.json?["ms"] as? NSNumber)?.intValue
            r.serverBytes = (o.json?["bytes"] as? NSNumber)?.int64Value
            r.error = nil
        } else {
            r.state = .failed
            r.error = o.errorText
        }
        runs[t] = r
        persist()
        // Its turn is over: the next path goes (now, or held if the app is
        // in the background).
        advance()
    }

    /// Both runs settled: the test file goes, and if the path lift clips use
    /// failed while the other passed, clips switch to the one that passed.
    private func settleIfDone() {
        guard !preparing, !runs.isEmpty, !runs.values.contains(where: \.live) else { return }
        removeFile()
        let current = Settings.shared.liftTransport
        guard run(current).state == .failed,
              let winner = Self.order.first(where: { $0 != current && run($0).state == .ok && !run($0).background })
        else { return }
        rlog("lift probe: \(current.rawValue) failed, \(winner.rawValue) passed: lift clips now go via \(winner.rawValue)")
        Settings.shared.liftTransport = winner
    }

    private func removeFile() {
        let file = self.file
        fileQueue.async { try? FileManager.default.removeItem(at: file) }
    }

    private func persist() {
        lastPersist = Date()
        guard !Demo.active else { return }
        let dict = Dictionary(uniqueKeysWithValues: runs.map { ($0.key.rawValue, $0.value) })
        if let data = try? JSONEncoder().encode(dict) { UserDefaults.standard.set(data, forKey: Self.key) }
    }

    /// 50 MB of random bytes (a 1 MB random block, 50 times), written once.
    private static func ensureFile(_ url: URL) -> Bool {
        if LiftMedia.fileSize(url) == size { return true }
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        var block = Data(count: 1_000_000)
        let ok = block.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 1_000_000, $0.baseAddress!) } == errSecSuccess
        guard ok, FileManager.default.createFile(atPath: url.path, contents: nil),
              let h = try? FileHandle(forWritingTo: url) else { return false }
        defer { try? h.close() }
        for _ in 0..<50 {
            guard (try? h.write(contentsOf: block)) != nil else { return false }
        }
        return true
    }

    #if DEBUG
    /// HR_DEMO_PROBE=mixed|running|sequential|held|ok|legacy: the
    /// Diagnostics rows' states. running = 1 of 2 sending, 2 of 2 next;
    /// sequential = 1 of 2 OK, 2 of 2 sending; held = 2 of 2 waiting for
    /// the app; legacy = a result saved before the probe went sequential.
    static func demo(_ mode: String) -> [LiftTransport: Run] {
        let t0 = Date().addingTimeInterval(-95)
        let hostDone = t0.addingTimeInterval(11.4)
        let hostOK = Run(state: .ok, sent: size, startedAt: t0, finishedAt: hostDone, serverMs: 10_872, serverBytes: size, order: 1)
        switch mode {
        case "running":
            return [.host: Run(state: .uploading, sent: 31_400_000, startedAt: t0, order: 1),
                    .tailnet: Run(state: .queued, order: 2)]
        case "sequential":
            return [.host: hostOK,
                    .tailnet: Run(state: .uploading, sent: 18_900_000, startedAt: hostDone, order: 2)]
        case "held":
            return [.host: hostOK, .tailnet: Run(state: .queued, order: 2, held: true)]
        case "ok":
            return [.host: hostOK,
                    .tailnet: Run(state: .ok, sent: size, startedAt: hostDone, finishedAt: hostDone.addingTimeInterval(6.2), serverMs: 5_918, serverBytes: size, order: 2, sawBackground: true)]
        case "legacy":
            return [.host: Run(state: .ok, sent: size, startedAt: t0, finishedAt: t0.addingTimeInterval(26.8), serverMs: 26_310, serverBytes: size),
                    .tailnet: Run(state: .ok, sent: size, startedAt: t0, finishedAt: t0.addingTimeInterval(56.5), serverMs: 55_904, serverBytes: size)]
        default:
            return [.host: Run(state: .failed, sent: 0, startedAt: t0, finishedAt: t0.addingTimeInterval(4.1),
                               error: "A server with the specified hostname could not be found.", order: 1),
                    .tailnet: Run(state: .ok, sent: size, startedAt: t0.addingTimeInterval(4.1), finishedAt: t0.addingTimeInterval(10.3), serverMs: 5_918, serverBytes: size, order: 2)]
        }
    }
    #endif
}

extension LiftProbe.Run {
    /// Tolerant decode: a run saved by a build without a field still reads.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        state = (try? c.decodeIfPresent(LiftProbe.State.self, forKey: .state)) ?? .idle
        sent = try c.decodeIfPresent(Int64.self, forKey: .sent) ?? 0
        total = try c.decodeIfPresent(Int64.self, forKey: .total) ?? LiftProbe.size
        startedAt = try c.decodeIfPresent(Date.self, forKey: .startedAt)
        finishedAt = try c.decodeIfPresent(Date.self, forKey: .finishedAt)
        serverMs = try c.decodeIfPresent(Int.self, forKey: .serverMs)
        serverBytes = try c.decodeIfPresent(Int64.self, forKey: .serverBytes)
        error = try c.decodeIfPresent(String.self, forKey: .error)
        taskId = try c.decodeIfPresent(Int.self, forKey: .taskId)
        background = try c.decodeIfPresent(Bool.self, forKey: .background) ?? false
        order = try c.decodeIfPresent(Int.self, forKey: .order)
        held = try c.decodeIfPresent(Bool.self, forKey: .held) ?? false
        sawBackground = try c.decodeIfPresent(Bool.self, forKey: .sawBackground)
    }
}
