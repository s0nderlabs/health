// Lift clips, the queue: picked, trimmed (passthrough) or kept whole, then
// uploaded to the Mac through the background session (LiftTransfer) as
// POST /lift-video with the clip's facts in X-Lift-Meta.
//
// Outbox rules, same as the food log: everything is on disk before it is
// sent (clips.json + the clip files under Application Support/lift), a clip
// leaves the queue only on a 200, and its client_id is minted once and
// reused on every retry, so the daemon dedupes a retry instead of writing a
// second copy. After a 200 the exported file is deleted (the original stays
// in Photos) and the row turns into an "On the Mac" record.
//
// Foreground rule: iOS treats a background-session task created while the
// app is NOT in the foreground as discretionary (it may hold it for Wi-Fi
// and a charger), whatever the session config says. So a full clip's task
// is created synchronously inside Send, a trimmed clip's right after its cut
// while the trim sheet still holds the screen ("Cutting…"), and any task
// that did get created in the background is flagged and re-created the next
// time the app is active, if it has not started sending.
//
// Review is NOT here: the daemon raises lift.video and the main Claude
// session decides what to review. This app only delivers.

import Foundation
import SwiftUI
import UIKit

struct LiftClip: Codable, Identifiable, Equatable {
    enum State: String, Codable {
        case exporting // passthrough cut running
        case queued // handed to the session, no byte confirmed yet
        case uploading
        case failed // will retry (network, 5xx, 401, an interrupted cut)
        case refused // the daemon said no (400/413), or over the cap
        case done
    }

    let id: String // = client_id, reused on every retry
    let originalName: String
    let recordedAt: Date
    let originalDuration: Double
    let trimStart: Double
    let trimEnd: Double
    let fullClip: Bool
    let fps: Double
    let width: Int
    let height: Int
    let codec: String
    let addedAt: Date
    var file: String? // the upload, under LiftStore.dir; nil once delivered
    /// The picked copy a trimmed clip is cut from. Kept until the cut has
    /// succeeded, so a cut that failed (or was interrupted) can run again.
    var source: String?
    var poster: String?
    var bytes: Int64 = 0
    var state: State
    var sent: Int64 = 0
    var attempts = 0
    var cutAttempts = 0
    var lastError: String?
    var macPath: String?
    var dedupe: String?
    var doneAt: Date?
    /// The session task carrying it now. An outcome from any other task (a
    /// cancelled predecessor) is ignored.
    var taskId: Int?
    var submittedAt: Date?
    /// Its task was created with the app in the background, so iOS may hold
    /// it for Wi-Fi and power. Re-created on the next foreground.
    var heldInBackground = false
    /// A live task that has sent nothing for LiftStore.stallAfter: iOS has
    /// no route to the Mac on this path.
    var stalled = false

    var stem: String { (originalName as NSString).deletingPathExtension }
    var length: Double { trimEnd - trimStart }
    var fraction: Double { bytes > 0 ? min(1, Double(sent) / Double(bytes)) : 0 }
    var active: Bool { state != .done }
    /// Something is left to send (Retry has work to do).
    var retryable: Bool { file != nil || source != nil }
}

extension LiftClip {
    /// Tolerant decode: every field with a default may be missing, so a
    /// build that adds a field can still read the list an older build wrote
    /// (a failed decode would otherwise lose the whole queue). New fields
    /// MUST be added here with decodeIfPresent.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        originalName = try c.decode(String.self, forKey: .originalName)
        recordedAt = try c.decode(Date.self, forKey: .recordedAt)
        originalDuration = try c.decode(Double.self, forKey: .originalDuration)
        trimStart = try c.decode(Double.self, forKey: .trimStart)
        trimEnd = try c.decode(Double.self, forKey: .trimEnd)
        fullClip = try c.decode(Bool.self, forKey: .fullClip)
        fps = try c.decodeIfPresent(Double.self, forKey: .fps) ?? 0
        width = try c.decodeIfPresent(Int.self, forKey: .width) ?? 0
        height = try c.decodeIfPresent(Int.self, forKey: .height) ?? 0
        codec = try c.decodeIfPresent(String.self, forKey: .codec) ?? "unknown"
        addedAt = try c.decodeIfPresent(Date.self, forKey: .addedAt) ?? recordedAt
        file = try c.decodeIfPresent(String.self, forKey: .file)
        source = try c.decodeIfPresent(String.self, forKey: .source)
        poster = try c.decodeIfPresent(String.self, forKey: .poster)
        bytes = try c.decodeIfPresent(Int64.self, forKey: .bytes) ?? 0
        state = (try? c.decodeIfPresent(State.self, forKey: .state)) ?? .failed
        sent = try c.decodeIfPresent(Int64.self, forKey: .sent) ?? 0
        attempts = try c.decodeIfPresent(Int.self, forKey: .attempts) ?? 0
        cutAttempts = try c.decodeIfPresent(Int.self, forKey: .cutAttempts) ?? 0
        lastError = try c.decodeIfPresent(String.self, forKey: .lastError)
        macPath = try c.decodeIfPresent(String.self, forKey: .macPath)
        dedupe = try c.decodeIfPresent(String.self, forKey: .dedupe)
        doneAt = try c.decodeIfPresent(Date.self, forKey: .doneAt)
        taskId = try c.decodeIfPresent(Int.self, forKey: .taskId)
        submittedAt = try c.decodeIfPresent(Date.self, forKey: .submittedAt)
        heldInBackground = try c.decodeIfPresent(Bool.self, forKey: .heldInBackground) ?? false
        stalled = try c.decodeIfPresent(Bool.self, forKey: .stalled) ?? false
    }
}

final class LiftStore: ObservableObject {
    static let shared = LiftStore()

    @Published private(set) var clips: [LiftClip] = []
    /// Clips being copied out of the picker (big originals take a moment).
    @Published var preparing = 0
    @Published var error: String?

    static var dir: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("lift", isDirectory: true)
    }

    private static var listFile: URL { dir.appendingPathComponent("clips.json") }
    static func url(_ name: String) -> URL { dir.appendingPathComponent(name) }
    /// "On the Mac" rows kept on the card.
    static let keepDone = 6
    /// The daemon's hard cap (LIFT_VIDEO_MAX_BYTES, 4 GiB). Over it the Mac
    /// answers 413 before reading, which usually surfaces as a reset that
    /// looks transient: refused here instead of re-sent forever.
    static let maxBytes: Int64 = 4 * 1024 * 1024 * 1024
    /// A live task with no byte sent after this long is shown as stalled.
    static let stallAfter: TimeInterval = 180
    /// Automatic re-cuts of an interrupted or failed cut before it waits for
    /// a tap on Retry.
    static let maxAutoCuts = 3

    private var retry: DispatchWorkItem?
    private var flushing = false
    private var flushAgain = false

    /// The list on disk could not be read yet (the phone has not been
    /// unlocked since boot): nothing is written until it has been, or the
    /// real queue would be overwritten with an empty one.
    private var waitingForUnlock = false

    private init() {
        try? FileManager.default.createDirectory(at: Self.dir, withIntermediateDirectories: true)
        // Never back up clips: they can be gigabytes and the original is in Photos.
        var d = Self.dir
        var rv = URLResourceValues()
        rv.isExcludedFromBackup = true
        try? d.setResourceValues(rv)
        #if DEBUG
        if Demo.active {
            let env = ProcessInfo.processInfo.environment
            if let mode = env["HR_DEMO_LIFT"] { clips = DemoLift.clips(mode) }
            if env["HR_DEMO_LIFT_PREPARING"] != nil { preparing = 1 }
            return
        }
        #endif
        load()
        NotificationCenter.default.addObserver(
            forName: UIApplication.protectedDataDidBecomeAvailableNotification, object: nil, queue: .main
        ) { [weak self] _ in
            guard let self = self, self.waitingForUnlock else { return }
            self.load()
            self.flush()
        }
    }

    /// Read clips.json. The sweep (which deletes files no clip points at)
    /// runs ONLY after a complete, successful read, or when there is no list
    /// at all: a list that could not be read must never cost the clips it
    /// describes.
    private func load() {
        let fm = FileManager.default
        guard UIApplication.shared.isProtectedDataAvailable else {
            waitingForUnlock = true
            rlog("lift: clip list locked until first unlock, waiting")
            return
        }
        waitingForUnlock = false
        guard fm.fileExists(atPath: Self.listFile.path) else { return sweep() }
        struct Lossy: Decodable {
            let clip: LiftClip?
            init(from decoder: Decoder) throws { clip = try? LiftClip(from: decoder) }
        }
        guard let data = try? Data(contentsOf: Self.listFile),
              let rows = try? JSONDecoder().decode([Lossy].self, from: data) else {
            setAside("unreadable")
            return
        }
        let good = rows.compactMap(\.clip)
        clips = good.compactMap(Self.resume)
        if good.count < rows.count {
            // Some rows did not decode: keep what did, park the original.
            setAside("partial")
            persist()
            return
        }
        sweep()
    }

    /// A row as it comes back after the app was gone.
    private static func resume(_ c: LiftClip) -> LiftClip? {
        var c = c
        guard c.state == .exporting else { return c }
        // A cut the app died in the middle of: run it again from the kept
        // source, or (no source left) drop the row, the original is in Photos.
        guard let s = c.source, FileManager.default.fileExists(atPath: url(s).path) else { return nil }
        c.state = .failed
        c.lastError = "The cut was interrupted"
        return c
    }

    /// Keep an undecodable list under another name (never overwritten), and
    /// skip sweeps while one exists: its clip files stay on disk.
    private func setAside(_ why: String) {
        let stamp = Int(Date().timeIntervalSince1970)
        let to = Self.url("clips.\(why)-\(stamp).json")
        try? FileManager.default.moveItem(at: Self.listFile, to: to)
        rlog("lift: clip list \(why), kept as \(to.lastPathComponent); file cleanup paused")
    }

    /// Anything in the lift dir no clip points at: picker copies from a trim
    /// sheet the app was killed in, half-written cuts, old posters. Run at
    /// launch only, when no sheet can be holding a file.
    private func sweep() {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: Self.dir.path)) ?? []
        if names.contains(where: { $0.hasPrefix("clips.") && $0 != "clips.json" }) {
            return rlog("lift: an unreadable clip list is parked in the lift dir; not sweeping")
        }
        var keep: Set<String> = ["clips.json", LiftProbe.fileName]
        for c in clips { [c.file, c.source, c.poster].compactMap { $0 }.forEach { keep.insert($0) } }
        for n in names where !keep.contains(n) && !n.hasPrefix(".") {
            try? FileManager.default.removeItem(at: Self.url(n))
        }
    }

    var active: [LiftClip] { clips.filter(\.active) }
    var delivered: [LiftClip] { clips.filter { !$0.active }.sorted { ($0.doneAt ?? .distantPast) > ($1.doneAt ?? .distantPast) } }

    // ── adding ──────────────────────────────────────────────────────

    /// One picked clip, trimmed to [start, end] or kept whole. Full = the
    /// picked file IS the upload, and its task is created right here, inside
    /// the Send tap. Trimmed = a passthrough cut first, then the task.
    /// `submitted` runs on main once the clip's task exists (or the clip
    /// could not be queued): the trim sheet holds the screen until then.
    func add(_ picked: PickedClip, start: Double, end: Double, submitted: @escaping () -> Void = {}) {
        let duration = picked.info.duration
        let full = start <= 0.05 && end >= duration - 0.05
        let s = full ? 0 : Self.tenth(start)
        let e = full ? Self.hundredth(duration) : Self.tenth(end)
        let ext = picked.source.pathExtension.isEmpty ? "MOV" : picked.source.pathExtension
        let fileName = "\(picked.id).\(ext)"
        var clip = LiftClip(
            id: picked.id, originalName: picked.originalName,
            recordedAt: picked.info.recordedAt ?? Date(),
            originalDuration: Self.hundredth(duration), trimStart: s, trimEnd: e, fullClip: full,
            fps: picked.info.fps, width: picked.info.width, height: picked.info.height,
            codec: picked.info.codec, addedAt: Date(), file: nil, poster: "\(picked.id).jpg",
            state: full ? .queued : .exporting)
        let out = Self.url(fileName)
        do {
            if full {
                try? FileManager.default.removeItem(at: out)
                try FileManager.default.moveItem(at: picked.source, to: out)
                clip.file = fileName
                clip.bytes = LiftMedia.fileSize(out)
            } else {
                clip.source = try Self.adopt(picked.source)
            }
        } catch {
            clip.state = .refused
            clip.lastError = "Could not keep the clip: \(error.localizedDescription)"
        }
        clips.append(clip)
        let posterAt = s + min(0.5, (e - s) / 2)
        if full {
            if clip.file != nil, refuseIfOversized(clips.count - 1) == false { submit(clips.count - 1) }
            persist()
            submitted()
            // The poster is for the eyes only; the upload is already running.
            let end = Self.backgroundTime("lift poster")
            Task {
                await LiftMedia.poster(out, at: posterAt, to: Self.url(clip.poster!))
                await MainActor.run { self.objectWillChange.send(); end() }
            }
        } else {
            persist()
            guard clip.source != nil else { return submitted() }
            cut(clip.id, posterAt: posterAt, then: submitted)
        }
    }

    /// The picked copy, moved into the lift dir if it is not there already
    /// (the picker path always is); returns its name there.
    private static func adopt(_ src: URL) throws -> String {
        if src.deletingLastPathComponent().standardizedFileURL == dir.standardizedFileURL { return src.lastPathComponent }
        let name = "\(UUID().uuidString)-src.\(src.pathExtension.isEmpty ? "MOV" : src.pathExtension)"
        try FileManager.default.moveItem(at: src, to: url(name))
        return name
    }

    /// Poster (if missing), then the passthrough cut, then the task. Wrapped
    /// in background time so locking the phone mid-cut does not kill it; if
    /// the cut still fails, the source stays and the cut can run again.
    private func cut(_ id: String, posterAt: Double? = nil, then submitted: @escaping () -> Void = {}) {
        guard let i = clips.firstIndex(where: { $0.id == id }), let src = clips[i].source else { return submitted() }
        let c = clips[i]
        let fileName = "\(c.id).\((src as NSString).pathExtension.isEmpty ? "MOV" : (src as NSString).pathExtension)"
        clips[i].state = .exporting
        clips[i].lastError = nil
        persist()
        let end = Self.backgroundTime("lift cut")
        Task {
            if let at = posterAt, let p = c.poster, !FileManager.default.fileExists(atPath: Self.url(p).path) {
                await LiftMedia.poster(Self.url(src), at: at, to: Self.url(p))
                await MainActor.run { self.objectWillChange.send() }
            }
            LiftMedia.exportTrim(source: Self.url(src), to: Self.url(fileName), start: c.trimStart, end: c.trimEnd) { result in
                defer { end(); submitted() }
                guard let i = self.clips.firstIndex(where: { $0.id == id }) else {
                    try? FileManager.default.removeItem(at: Self.url(fileName)) // removed while cutting
                    return
                }
                switch result {
                case .success(let bytes):
                    try? FileManager.default.removeItem(at: Self.url(src))
                    self.clips[i].source = nil
                    self.clips[i].file = fileName
                    self.clips[i].bytes = bytes
                    if !self.refuseIfOversized(i) { self.submit(i) }
                case .failure(let err):
                    self.clips[i].cutAttempts += 1
                    self.clips[i].state = .failed
                    self.clips[i].lastError = "Cut failed: \(err.localizedDescription)"
                    rlog("lift cut \(self.clips[i].originalName) failed (\(self.clips[i].cutAttempts)): \(err.localizedDescription)")
                }
                self.persist()
            }
        }
    }

    /// Over the Mac's cap: refused for good (the file goes, nothing to send).
    private func refuseIfOversized(_ i: Int) -> Bool {
        guard clips[i].bytes > Self.maxBytes else { return false }
        if let f = clips[i].file { try? FileManager.default.removeItem(at: Self.url(f)) }
        clips[i].file = nil
        clips[i].state = .refused
        clips[i].lastError = "\(LiftFormat.size(clips[i].bytes)) is over the Mac's 4 GiB limit. Trim it shorter."
        return true
    }

    /// A picked clip he skipped in the trim sheet: its copy goes.
    func discard(_ picked: PickedClip) {
        guard !Demo.active else { return } // the demo clip is a file on the Mac
        try? FileManager.default.removeItem(at: picked.source)
    }

    // ── sending ─────────────────────────────────────────────────────

    /// Create the clip's task NOW (synchronously, on main). Callers on the
    /// Send path run inside the tap, so the task is born in the foreground.
    private func submit(_ i: Int) {
        let c = clips[i]
        guard let file = c.file else { return }
        switch request(c) {
        case .failure(let why):
            clips[i].state = .failed
            clips[i].lastError = why.text
            clips[i].taskId = nil
        case .success(let req):
            let sub = LiftTransfer.shared.upload(req, file: Self.url(file), tag: "clip:\(c.id)")
            clips[i].state = .queued
            clips[i].sent = 0
            clips[i].taskId = sub.id
            clips[i].submittedAt = Date()
            clips[i].heldInBackground = sub.background
            clips[i].stalled = false
        }
    }

    /// Hand every clip that needs a task to the background session, and
    /// refresh the rest from their live tasks. Safe from any trigger
    /// (foreground, socket reconnect, retry tap, timer). Verdicts wait until
    /// the session has replayed the outcomes of tasks that finished while
    /// the app was gone (LiftTransfer.whenSettled), so a clip whose finished
    /// task has not reported yet is never sent a second time.
    func flush() {
        guard !Demo.active, !waitingForUnlock else { return }
        // One pass at a time: two overlapping task listings would both see
        // "no task yet" and submit a clip twice.
        if flushing { flushAgain = true; return }
        flushing = true
        LiftTransfer.shared.whenSettled {
            LiftTransfer.shared.tasks { snap in
                defer {
                    self.flushing = false
                    if self.flushAgain { self.flushAgain = false; self.flush() }
                }
                let front = UIApplication.shared.applicationState == .active
                var changed = false
                for i in self.clips.indices {
                    let c = self.clips[i]
                    let tag = "clip:\(c.id)"
                    // A cut that failed or was interrupted: again, in front
                    // only (an export in the background is what failed).
                    if c.state == .failed, c.file == nil, c.source != nil {
                        if front, c.cutAttempts < Self.maxAutoCuts { self.cut(c.id) }
                        continue
                    }
                    guard c.file != nil, c.state != .done, c.state != .refused, c.state != .exporting else { continue }
                    if let t = snap.task(tag, id: c.taskId) {
                        changed = self.refresh(i, from: t) || changed
                        // Born in the background and not started: re-create
                        // it now, in front, so iOS does not hold it.
                        if front, c.heldInBackground, t.state != .completed, t.countOfBytesSent == 0 {
                            rlog("lift: re-creating \(c.originalName) in the foreground")
                            t.cancel()
                            self.submit(i)
                            changed = true
                        }
                        continue
                    }
                    // Created by this process a moment ago, or finished and
                    // still reporting: not lost.
                    if snap.known(tag) { continue }
                    // No task: an "uploading"/"queued" row lost it (force
                    // quit, reboot), a failed row is due. Same client_id.
                    self.submit(i)
                    changed = true
                }
                if changed { self.persist() }
            }
        }
    }

    /// Bytes sent and the stall flag, read from the live tasks (a suspended
    /// app gets no progress callbacks). The card calls it while on screen.
    func refreshLive() {
        guard !Demo.active, !waitingForUnlock, active.contains(where: { $0.state == .queued || $0.state == .uploading }) else { return }
        LiftTransfer.shared.tasks { snap in
            var changed = false
            for i in self.clips.indices where self.clips[i].state == .queued || self.clips[i].state == .uploading {
                if let t = snap.task("clip:\(self.clips[i].id)", id: self.clips[i].taskId) {
                    changed = self.refresh(i, from: t) || changed
                }
            }
            if changed { self.persist() }
        }
    }

    /// One clip from the task carrying it (its id is adopted: after a
    /// relaunch that is how the outcome is matched). Returns whether
    /// anything changed.
    private func refresh(_ i: Int, from t: URLSessionTask) -> Bool {
        let before = clips[i]
        clips[i].taskId = t.taskIdentifier
        guard t.state != .completed else { return clips[i] != before }
        let sent = t.countOfBytesSent
        if sent > 0 {
            clips[i].state = .uploading
            clips[i].sent = max(clips[i].sent, sent)
            clips[i].stalled = false
        } else if let at = clips[i].submittedAt {
            clips[i].stalled = Date().timeIntervalSince(at) >= Self.stallAfter
        }
        return clips[i] != before
    }

    func retryNow(_ id: String) {
        guard let i = clips.firstIndex(where: { $0.id == id }) else { return }
        if clips[i].file == nil, clips[i].source != nil {
            clips[i].cutAttempts = 0 // a tap always gets a fresh cut
            return cut(id)
        }
        guard clips[i].file != nil else { return }
        if clips[i].state == .refused { clips[i].state = .failed }
        flush()
    }

    /// Remove a row: cancels its upload and deletes its files. A delivered
    /// row only leaves the card (the clip stays on the Mac).
    func remove(_ id: String) {
        guard let c = clips.first(where: { $0.id == id }) else { return }
        LiftTransfer.shared.cancel(tag: "clip:\(id)")
        for f in [c.file, c.source, c.poster].compactMap({ $0 }) { try? FileManager.default.removeItem(at: Self.url(f)) }
        clips.removeAll { $0.id == id }
        persist()
    }

    struct Unsendable: Error { let text: String }

    private func request(_ c: LiftClip) -> Result<URLRequest, Unsendable> {
        let s = Settings.shared
        guard let url = s.liftURL("/lift-video", via: s.liftTransport) else {
            return .failure(Unsendable(text: s.liftUnreachableReason(s.liftTransport)))
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue(c.originalName.lowercased().hasSuffix(".mp4") ? "video/mp4" : "video/quicktime",
                     forHTTPHeaderField: "content-type")
        req.setValue(Self.meta(c), forHTTPHeaderField: "X-Lift-Meta")
        return .success(req)
    }

    /// X-Lift-Meta: base64url (no padding) of the clip's facts, the daemon
    /// contract. recorded_at carries the phone's offset, so the Mac files it
    /// under the right local day. Pinned by HealthRelayTests.
    static func meta(_ c: LiftClip, timeZone: TimeZone = .current) -> String {
        let iso = ISO8601DateFormatter()
        iso.timeZone = timeZone
        iso.formatOptions = [.withInternetDateTime]
        var obj: [String: Any] = [
            "client_id": c.id,
            "original_name": c.originalName,
            "recorded_at": iso.string(from: c.recordedAt),
            "original_duration_s": c.originalDuration,
            "trim_start_s": c.trimStart,
            "trim_end_s": c.trimEnd,
            "full_clip": c.fullClip,
            "codec": c.codec,
        ]
        // AVFoundation reports 0 for an unknown frame rate or size (edited or
        // variable-rate clips): those keys are left out, never sent as 0,
        // which the daemon refuses.
        let fps = (c.fps * 100).rounded() / 100
        if fps > 0 { obj["fps"] = fps }
        if c.width > 0 && c.height > 0 {
            obj["width"] = c.width
            obj["height"] = c.height
        }
        let data = (try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys])) ?? Data()
        return data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    // ── from LiftTransfer (main) ─────────────────────────────────────

    private var lastPersist = Date.distantPast

    /// Is this outcome/progress from the clip's CURRENT task?
    private func current(_ i: Int, _ task: Int) -> Bool { clips[i].taskId == nil || clips[i].taskId == task }

    func progress(_ id: String, task: Int, sent: Int64) {
        guard let i = clips.firstIndex(where: { $0.id == id }), clips[i].active,
              clips[i].state != .refused, current(i, task) else { return }
        clips[i].state = .uploading
        clips[i].sent = sent
        clips[i].stalled = false
        if Date().timeIntervalSince(lastPersist) > 3 { persist() }
    }

    func finished(_ id: String, task: Int, _ o: LiftTransfer.Outcome) {
        guard let i = clips.firstIndex(where: { $0.id == id }) else { return }
        rlog("lift clip \(clips[i].originalName) task \(task): status=\(o.status ?? 0) error=\(o.error?.localizedDescription ?? "none")")
        // A cancelled predecessor, or a second task for a clip already on the
        // Mac: its outcome must not touch the row.
        guard current(i, task), clips[i].state != .done else { return }
        clips[i].taskId = nil
        clips[i].stalled = false
        switch (o.error, o.status) {
        case (nil, 200?):
            if let f = clips[i].file { try? FileManager.default.removeItem(at: Self.url(f)) }
            clips[i].file = nil
            clips[i].state = .done
            clips[i].sent = clips[i].bytes
            clips[i].doneAt = Date()
            clips[i].macPath = o.json?["path"] as? String
            clips[i].dedupe = o.json?["dedupe"] as? String
            clips[i].lastError = nil
            clips[i].heldInBackground = false
            prune()
        case (nil, 400?), (nil, 413?):
            clips[i].state = .refused
            clips[i].lastError = o.errorText
        default:
            clips[i].state = .failed
            clips[i].attempts += 1
            clips[i].lastError = o.errorText
            scheduleRetry(after: min(300, 20 * Double(1 << min(clips[i].attempts, 4))))
        }
        persist()
    }

    private func scheduleRetry(after seconds: Double) {
        retry?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.flush() }
        retry = work
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: work)
    }

    /// Keep the newest delivered rows; older records leave the card.
    private func prune() {
        let old = delivered.dropFirst(Self.keepDone)
        for c in old {
            if let p = c.poster { try? FileManager.default.removeItem(at: Self.url(p)) }
            clips.removeAll { $0.id == c.id }
        }
    }

    private func persist() {
        lastPersist = Date()
        guard !Demo.active, !waitingForUnlock else { return }
        if let data = try? JSONEncoder().encode(clips) { try? data.write(to: Self.listFile, options: .atomic) }
    }

    /// A short background-execution window (a cut or a poster finishing
    /// after he locks the phone). Returns the call that ends it; main.
    static func backgroundTime(_ name: String) -> () -> Void {
        var id = UIBackgroundTaskIdentifier.invalid
        let end = {
            guard id != .invalid else { return }
            UIApplication.shared.endBackgroundTask(id)
            id = .invalid
        }
        id = UIApplication.shared.beginBackgroundTask(withName: name) { end() }
        return end
    }

    static func tenth(_ v: Double) -> Double { (v * 10).rounded() / 10 }
    static func hundredth(_ v: Double) -> Double { (v * 100).rounded() / 100 }
}

// ── formatting ────────────────────────────────────────────────────

enum LiftFormat {
    /// "12.3" (one decimal, the daemon's file-name precision).
    static func s(_ v: Double) -> String { String(format: "%.1f", v) }

    /// Decimal units ("54 MB", "1.2 GB"; the daemon's event text uses its own
    /// precision), always with a dot: a device-locale "47,9 MB" reads as forty-seven
    /// thousand (the same rule as FoodFormat).
    static func size(_ bytes: Int64) -> String {
        let mb = Double(bytes) / 1_000_000
        if mb >= 1000 { return String(format: "%.1f GB", mb / 1000) }
        return "\(Int(mb.rounded())) MB"
    }

    /// "30 of 48 MB": progress, one unit.
    static func progress(_ sent: Int64, of total: Int64) -> String {
        let t = size(total)
        let unit = t.hasSuffix("GB") ? 1_000_000_000.0 : 1_000_000.0
        let s = Double(sent) / unit
        let n = unit > 1_000_000 ? String(format: "%.1f", s) : "\(Int(s.rounded(.down)))"
        return "\(n) of \(t)"
    }

    /// "Trimmed 12.3–41.0 s of 58.2 s" / "Full clip · 58.2 s".
    static func range(_ c: LiftClip) -> String {
        c.fullClip ? "Full clip · \(s(c.originalDuration)) s"
            : "\(s(c.trimStart))–\(s(c.trimEnd)) s of \(s(c.originalDuration)) s"
    }

    /// Built once: formatters are expensive and this runs per row on every
    /// progress render (the same rule as FoodFormat).
    private static let clockToday: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm"
        return f
    }()
    private static let clockDay: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "EEE HH:mm"
        return f
    }()

    static func recorded(_ d: Date) -> String {
        (Calendar.current.isDateInToday(d) ? clockToday : clockDay).string(from: d)
    }
}
