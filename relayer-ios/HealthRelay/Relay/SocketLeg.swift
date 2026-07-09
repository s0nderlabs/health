// WebSocket leg: phone -> daemon over the tailnet (TLS terminates in the
// tailscale serve proxy). Same dumb-pipe contract as the mac relayer, plus
// the inbound arbitration commands (standdown/pause/resume) and plan pushes
// that only exist for the phone. Buffers frames while down; flushes on
// reconnect; backoff 1 -> 30s.

import Foundation

func rlog(_ msg: String) {
    let ts = ISO8601DateFormatter().string(from: Date())
    print("health-relay: \(ts) \(msg)")
}

protocol SocketLegDelegate: AnyObject {
    func socketDidConnect()
    func socketDidDisconnect(reason: String)
    /// Any server message: ok, standdown, resume, pause, plan_updated, *_ack.
    func socketCommand(_ type: String, payload: [String: Any])
}

final class SocketLeg: NSObject, URLSessionWebSocketDelegate {
    weak var delegate: SocketLegDelegate?
    private(set) var connected = false

    private var session: URLSession?
    private var task: URLSessionWebSocketTask?
    private var backoff: TimeInterval = 1
    private var buffer: [String] = [] // frames queued while down (~10 min cap)
    private let bufferCap = 600
    private var deviceName: String?
    private var enabled = false
    // The pending reconnect, held so it can be cancelled. Without this an
    // orphaned retry from an earlier attempt fires after a restart and calls
    // connect() a second time, overwriting session/task and LEAKING the live
    // session (never invalidated) plus its zombie WebSocket.
    private var reconnectWork: DispatchWorkItem?

    /// Start (or restart after a settings change) the connect loop.
    func start() {
        enabled = true
        dropCurrent()
        connect()
    }

    func stop() {
        enabled = false
        dropCurrent()
    }

    private func dropCurrent() {
        reconnectWork?.cancel()
        reconnectWork = nil
        connected = false
        task?.cancel()
        task = nil
        session?.invalidateAndCancel()
        session = nil
    }

    private func connect() {
        guard enabled, let url = Settings.shared.streamURL else { return }
        // Never build a second session over a live one: tear the current down
        // first so a stray reconnect can't strand an un-invalidated session.
        dropCurrent()
        // One session per attempt, invalidated in dropCurrent: URLSession
        // retains its delegate, so never invalidating leaks a session (and a
        // retain on self) per reconnect.
        let s = URLSession(configuration: .default, delegate: self, delegateQueue: .main)
        session = s
        let t = s.webSocketTask(with: url)
        task = t
        t.resume()
        receiveLoop(t)
    }

    func urlSession(_ s: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didOpenWithProtocol proto: String?) {
        guard webSocketTask === task else { return } // stale attempt
        connected = true
        backoff = 1
        rlog("socket up")
        sendJSON(["type": "hello", "source": "phone", "device": deviceName ?? "iphone"])
        flush()
        schedulePing(webSocketTask)
        delegate?.socketDidConnect()
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
                    self.delegate?.socketCommand(type, payload: json)
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
        rlog("socket down: \(why), retrying in \(Int(backoff))s")
        dropCurrent() // also cancels any prior reconnectWork
        delegate?.socketDidDisconnect(reason: why)
        guard enabled else { return }
        let delay = backoff
        backoff = min(backoff * 2, 30)
        // Cancellable: start()/stop()/a fresh connect() cancel this so a stale
        // retry can never spawn a duplicate session.
        let work = DispatchWorkItem { [weak self] in self?.connect() }
        reconnectWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
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
        rlog("flushing \(buffer.count) buffered frames")
        let pending = buffer
        buffer.removeAll()
        for text in pending { send(text) }
    }
}
