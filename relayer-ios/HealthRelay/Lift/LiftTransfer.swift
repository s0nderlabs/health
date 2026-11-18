// The ONE background URLSession behind lift clips and the transport probe.
//
// A lift clip is hundreds of MB and he pockets the phone the moment he racks
// the bar, so the upload must not depend on this app staying alive. A
// background session hands every uploadTask(fromFile:) to the system's
// transfer daemon: it keeps sending while the app is suspended, locked or
// even killed by iOS, and relaunches the app in the background when it has
// news (sessionSendsLaunchEvents). Only a FILE can be uploaded this way,
// which is why clips are exported/copied into the container first.
//
// Tasks are tagged in taskDescription ("probe:host", "clip:<client_id>"), so
// a relaunch can match finished tasks back to their owner with no in-memory
// state. Owners: LiftProbe (Diagnostics) and LiftStore (the clips queue).

import Foundation
import UIKit

final class LiftTransfer: NSObject, URLSessionDataDelegate {
    static let shared = LiftTransfer()
    static let identifier = "com.s0nderlabs.HealthRelay.lift-upload"

    /// iOS's "all events delivered, you may snapshot and suspend" callback,
    /// handed over by the app delegate on a background relaunch.
    var backgroundCompletion: (() -> Void)?

    /// Response bodies by task id, touched on the delegate queue only.
    private var bodies: [Int: Data] = [:]
    private let delegateQueue: OperationQueue = {
        let q = OperationQueue()
        q.maxConcurrentOperationCount = 1
        q.name = "health.lift-transfer"
        return q
    }()

    lazy var session: URLSession = {
        let cfg = URLSessionConfiguration.background(withIdentifier: Self.identifier)
        // Not discretionary: the system must not wait for Wi-Fi and a
        // charger. The upload starts now, on whatever link the phone has.
        // This only holds for tasks created while the app is in the
        // FOREGROUND; iOS makes any task created in the background
        // discretionary regardless (see upload(), Submitted.background).
        cfg.isDiscretionary = false
        cfg.sessionSendsLaunchEvents = true
        // Two clips at a time per host; the rest wait inside the session.
        cfg.httpMaximumConnectionsPerHost = 2
        // A clip queued in a dead zone may wait a while; a day is the cap.
        cfg.timeoutIntervalForResource = 24 * 3600
        cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
        cfg.httpCookieStorage = nil
        cfg.urlCache = nil
        return URLSession(configuration: cfg, delegate: self, delegateQueue: delegateQueue)
    }()

    /// Recreate the session at launch so events for tasks that finished while
    /// the app was gone are delivered. Never in demo mode.
    func wake() {
        guard !Demo.active else { return }
        _ = session
        armSettle()
    }

    // ── settling ──────────────────────────────────────────────────────
    //
    // Right after a launch (or a background relaunch) the session REPLAYS
    // the outcomes of tasks that finished while the app was gone. Until that
    // replay is through, "this clip has no task" does not mean "its task was
    // lost": the finished task may simply not have reported yet. Orphan and
    // "Lost" verdicts wait for urlSessionDidFinishEvents or a short grace
    // after the session is created, whichever comes first.

    /// Main only.
    private(set) var settled = false
    private var settleArmed = false
    private var afterSettle: [() -> Void] = []
    static let settleGrace: TimeInterval = 4

    private func armSettle() {
        DispatchQueue.main.async {
            guard !self.settleArmed else { return }
            self.settleArmed = true
            DispatchQueue.main.asyncAfter(deadline: .now() + Self.settleGrace) { self.settle() }
        }
    }

    private func settle() {
        guard !settled else { return }
        settled = true
        let work = afterSettle
        afterSettle = []
        work.forEach { $0() }
    }

    /// Run `work` once the replay is through (now, if it already is). Main.
    func whenSettled(_ work: @escaping () -> Void) {
        if settled || Demo.active { return work() }
        afterSettle.append(work)
        armSettle()
    }

    // ── submitting ────────────────────────────────────────────────────

    /// Tasks this process created whose outcome has not been delivered yet,
    /// by task id. A task listing taken a moment before a submit does not
    /// contain it; this does. Main only.
    private var launched: [Int: String] = [:]

    struct Submitted {
        let id: Int
        /// Created while the app was not in the foreground. iOS treats such a
        /// background-session task as discretionary whatever the config says
        /// (it may hold it for Wi-Fi and power), so owners flag it and
        /// re-create it once the app is active again.
        let background: Bool
    }

    /// Create and resume one upload. Main only (it reads the app state).
    @discardableResult
    func upload(_ request: URLRequest, file: URL, tag: String) -> Submitted {
        let task = session.uploadTask(with: request, fromFile: file)
        task.taskDescription = tag
        task.resume()
        launched[task.taskIdentifier] = tag
        let background = UIApplication.shared.applicationState != .active
        if background { rlog("lift transfer: \(tag) created in the background (discretionary)") }
        return Submitted(id: task.taskIdentifier, background: background)
    }

    /// What the session knows right now, on main.
    struct Snapshot {
        /// Every listed task by tag, COMPLETED ones included: a finished
        /// task whose outcome is still on its way is not a lost one
        /// (counting it as gone would send the clip a second time).
        let byTag: [String: [URLSessionTask]]
        /// Tasks this process created whose outcome is not in yet, by id.
        let launched: [Int: String]
        let settled: Bool

        /// The task carrying `tag`: the one with the owner's recorded id if
        /// it is listed; nil if that id is ours and simply not listed yet;
        /// otherwise the newest listed one that is not being cancelled (a
        /// relaunch the owner did not see the id of).
        func task(_ tag: String, id: Int?) -> URLSessionTask? {
            let list = byTag[tag] ?? []
            if let id = id {
                if let t = list.first(where: { $0.taskIdentifier == id }) { return t }
                if launched[id] != nil { return nil }
            }
            return list.filter { $0.state != .canceling }.max { $0.taskIdentifier < $1.taskIdentifier }
        }

        /// A task exists for `tag`, or one of ours is about to report.
        func known(_ tag: String) -> Bool { !(byTag[tag] ?? []).isEmpty || launched.values.contains(tag) }
    }

    func tasks(_ done: @escaping (Snapshot) -> Void) {
        guard !Demo.active else { return done(Snapshot(byTag: [:], launched: [:], settled: true)) }
        session.getAllTasks { all in
            var out: [String: [URLSessionTask]] = [:]
            for t in all {
                guard let tag = t.taskDescription else { continue }
                out[tag, default: []].append(t)
            }
            DispatchQueue.main.async {
                done(Snapshot(byTag: out, launched: self.launched, settled: self.settled))
            }
        }
    }

    func cancel(tag: String) {
        guard !Demo.active else { return }
        session.getAllTasks { all in
            all.filter { $0.taskDescription == tag }.forEach { $0.cancel() }
        }
    }

    // ── delegate (delegate queue) ────────────────────────────────────

    func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64,
                    totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
        guard let tag = task.taskDescription else { return }
        let id = task.taskIdentifier
        DispatchQueue.main.async {
            Self.route(tag, probe: { LiftProbe.shared.progress($0, task: id, sent: totalBytesSent, total: totalBytesExpectedToSend) },
                       clip: { LiftStore.shared.progress($0, task: id, sent: totalBytesSent) })
        }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        bodies[dataTask.taskIdentifier, default: Data()].append(data)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let body = bodies.removeValue(forKey: task.taskIdentifier)
        let status = (task.response as? HTTPURLResponse)?.statusCode
        guard let tag = task.taskDescription else { return }
        let outcome = Outcome(status: status, body: body, error: error)
        let id = task.taskIdentifier
        DispatchQueue.main.async {
            self.launched.removeValue(forKey: id)
            Self.route(tag, probe: { LiftProbe.shared.finished($0, task: id, outcome) },
                       clip: { LiftStore.shared.finished($0, task: id, outcome) })
        }
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        DispatchQueue.main.async {
            // Every replayed outcome has been routed (they were queued on
            // main ahead of this block): verdicts may run now.
            self.settle()
            let done = self.backgroundCompletion
            self.backgroundCompletion = nil
            done?()
        }
    }

    struct Outcome {
        let status: Int?
        let body: Data?
        let error: Error?

        var json: [String: Any]? {
            body.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
        }

        /// One short line for the UI: the server's own error, the HTTP
        /// status, or the transport error.
        var cancelled: Bool { (error as NSError?)?.code == NSURLErrorCancelled }

        var errorText: String {
            if let e = error as NSError? {
                if e.code == NSURLErrorAppTransportSecurityRequiresSecureConnection {
                    return "Blocked by App Transport Security (plain http)"
                }
                return e.localizedDescription
            }
            if let msg = json?["error"] as? String { return "HTTP \(status ?? 0): \(msg)" }
            return "HTTP \(status ?? 0)"
        }
    }

    private static func route(_ tag: String, probe: (LiftTransport) -> Void, clip: (String) -> Void) {
        let parts = tag.split(separator: ":", maxSplits: 1).map(String.init)
        guard parts.count == 2 else { return }
        if parts[0] == "probe", let t = LiftTransport(rawValue: parts[1]) { probe(t) }
        if parts[0] == "clip" { clip(parts[1]) }
    }
}

/// The app delegate exists for one callback: a background relaunch for the
/// lift upload session.
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        // Before any scene: a background relaunch never shows UI, and the
        // session must exist for its finished tasks to report in.
        LiftTransfer.shared.wake()
        return true
    }

    func application(_ application: UIApplication, handleEventsForBackgroundURLSession identifier: String,
                     completionHandler: @escaping () -> Void) {
        guard identifier == LiftTransfer.identifier else { return completionHandler() }
        LiftTransfer.shared.backgroundCompletion = completionHandler
        LiftTransfer.shared.wake()
    }
}
