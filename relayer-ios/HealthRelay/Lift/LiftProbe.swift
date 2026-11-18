// Diagnostics: the background-upload transport test. Before lift clips pick
// a path for good, this answers one question with real numbers: which way
// does a 50 MB body reach the Mac from a LOCKED phone through a background
// session, the ts.net host (https :8443) or the tailnet IP (http :8791)?
//
// One synthetic 50 MB file (random bytes, so no link can compress it) is
// written ahead (when Diagnostics opens), then two background uploads go to
// POST /lift-video/probe, which the daemon streams to nowhere and answers
// { bytes, ms }. "Lock the phone now" shows only once BOTH tasks exist: a
// task created after the lock would be discretionary and the verdict
// meaningless (each run records whether that happened anyway). Each
// transport's state is persisted, so the result is there when he unlocks
// the phone, even if iOS relaunched the app in the background to deliver it.
// The file is deleted once both runs have settled.

import Foundation
import SwiftUI

final class LiftProbe: ObservableObject {
    static let shared = LiftProbe()
    static let size: Int64 = 50 * 1_000_000
    static let fileName = "probe-50mb.bin"

    enum State: String, Codable { case idle, waiting, uploading, ok, failed }

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

        var seconds: Double? {
            guard let a = startedAt, let b = finishedAt else { return nil }
            return b.timeIntervalSince(a)
        }
        var live: Bool { state == .waiting || state == .uploading }
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
    }

    func run(_ t: LiftTransport) -> Run { runs[t] ?? Run() }

    var running: Bool { preparing || runs.values.contains(where: \.live) }

    /// Write the test file ahead (Diagnostics on screen), so Start creates
    /// both tasks at once and "lock now" follows immediately.
    func prepare() {
        guard !Demo.active else { return }
        let file = self.file
        fileQueue.async { _ = Self.ensureFile(file) }
    }

    /// The file if needed (off main), then both uploads, created back to back.
    func start() {
        guard !running, !Demo.active else { return }
        rlog("lift probe: start")
        preparing = true
        let file = self.file
        fileQueue.async {
            let ok = Self.ensureFile(file)
            DispatchQueue.main.async {
                self.preparing = false
                guard ok else {
                    for t in LiftTransport.allCases {
                        self.runs[t] = Run(state: .failed, error: "Could not write the 50 MB test file")
                    }
                    return self.persist()
                }
                for t in LiftTransport.allCases { self.launch(t) }
                self.persist()
                self.settleIfDone()
                DispatchQueue.main.asyncAfter(deadline: .now() + Self.stall + 1) { self.reconcile() }
            }
        }
    }

    private func launch(_ t: LiftTransport) {
        var r = Run(state: .waiting, startedAt: Date())
        guard let url = Settings.shared.liftURL("/lift-video/probe", via: t) else {
            r.state = .failed
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
    }

    /// A background session never fails on "no route" or an unresolvable
    /// name: it waits for connectivity, up to the session's day-long cap.
    /// For a test that is a non-answer, so a path whose LIVE task has not
    /// sent a byte in two minutes is called failed (and cancelled).
    static let stall: TimeInterval = 120

    /// Clear both rows (and stop anything still running): the Stop button.
    func reset() {
        for t in LiftTransport.allCases { LiftTransfer.shared.cancel(tag: "probe:\(t.rawValue)") }
        runs = [:]
        persist()
        removeFile()
    }

    /// On foreground, on a timer after start, on socket reconnect: progress
    /// from the live tasks (a suspended app gets no callbacks, so the saved
    /// numbers are stale), then the verdicts. Waits until the session has
    /// replayed what finished while the app was gone, so a finished run is
    /// never called lost.
    func reconcile() {
        guard !Demo.active, running, !preparing else { return }
        LiftTransfer.shared.whenSettled {
            LiftTransfer.shared.tasks { snap in
                for t in LiftTransport.allCases {
                    guard var r = self.runs[t], r.live else { continue }
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
                        r.error = "Lost: the app was closed from the app switcher, which cancels background uploads"
                    }
                    self.runs[t] = r
                }
                self.persist()
                self.settleIfDone()
            }
        }
    }

    // ── from LiftTransfer (main) ─────────────────────────────────────

    private var lastPersist = Date.distantPast

    func progress(_ t: LiftTransport, task: Int, sent: Int64, total: Int64) {
        var r = run(t)
        guard r.live, r.taskId == task else { return }
        r.state = .uploading
        r.sent = sent
        if total > 0 { r.total = total }
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
        guard r.taskId == task, r.live || (r.state == .failed && o.error == nil && o.status == 200) else { return }
        r.finishedAt = Date()
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
        settleIfDone()
    }

    /// Both runs settled: the test file goes, and if the path lift clips use
    /// failed while the other passed, clips switch to the one that passed.
    private func settleIfDone() {
        guard !preparing, !runs.isEmpty, !runs.values.contains(where: \.live) else { return }
        removeFile()
        let current = Settings.shared.liftTransport
        guard run(current).state == .failed,
              let winner = LiftTransport.allCases.first(where: { $0 != current && run($0).state == .ok && !run($0).background })
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
    /// HR_DEMO_PROBE=mixed|running|ok: the Diagnostics row's states.
    static func demo(_ mode: String) -> [LiftTransport: Run] {
        let t0 = Date().addingTimeInterval(-95)
        switch mode {
        case "running":
            return [.host: Run(state: .uploading, sent: 31_400_000, startedAt: t0),
                    .tailnet: Run(state: .waiting, startedAt: t0)]
        case "ok":
            return [.host: Run(state: .ok, sent: size, startedAt: t0, finishedAt: t0.addingTimeInterval(11.4), serverMs: 10_872, serverBytes: size),
                    .tailnet: Run(state: .ok, sent: size, startedAt: t0, finishedAt: t0.addingTimeInterval(6.2), serverMs: 5_918, serverBytes: size)]
        default:
            return [.host: Run(state: .failed, sent: 0, startedAt: t0, finishedAt: t0.addingTimeInterval(4.1),
                               error: "A server with the specified hostname could not be found."),
                    .tailnet: Run(state: .ok, sent: size, startedAt: t0, finishedAt: t0.addingTimeInterval(6.2), serverMs: 5_918, serverBytes: size)]
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
    }
}
