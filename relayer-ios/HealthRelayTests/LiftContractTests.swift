// Pins the phone side of the lift-video contract (Nov 18 2026) to what the
// daemon's parseLiftMeta (src/liftvideo.ts) accepts: X-Lift-Meta's exact key
// set, types and base64url form, recorded_at with the phone's offset, the
// camera-roll name rule, the codec alphabet, and a clip list that still
// decodes when fields are missing (a failed decode used to cost the queue).
// Hosted unit tests, simulator only, no network.

import XCTest
@testable import HealthRelay

final class LiftContractTests: XCTestCase {
    private func clip(full: Bool = false, codec: String = "hevc", fps: Double = 59.94006, width: Int = 1920, height: Int = 1080) -> LiftClip {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "Asia/Jakarta")!
        let rec = cal.date(from: DateComponents(year: 2026, month: 11, day: 16, hour: 15, minute: 12, second: 7))!
        return LiftClip(
            id: "6F9619FF-8B86-D011-B42D-00C04FC964FF", originalName: "IMG_0001.MOV", recordedAt: rec,
            originalDuration: 58.23, trimStart: full ? 0 : 12.3, trimEnd: full ? 58.23 : 41.0, fullClip: full,
            fps: fps, width: width, height: height, codec: codec, addedAt: rec, file: nil, poster: nil,
            state: .queued)
    }

    private func decode(_ header: String) throws -> [String: Any] {
        var b64 = header.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while b64.count % 4 != 0 { b64 += "=" }
        let data = try XCTUnwrap(Data(base64Encoded: b64), "not base64url")
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    func testMetaIsTheContract() throws {
        let header = LiftStore.meta(clip(), timeZone: TimeZone(identifier: "Asia/Jakarta")!)
        XCTAssertNil(header.rangeOfCharacter(from: CharacterSet(charactersIn: "+/=")), "base64url, no padding: \(header)")
        XCTAssertLessThan(header.count, 4096, "the daemon caps the header at 4096 chars")
        let m = try decode(header)
        XCTAssertEqual(Set(m.keys), [
            "client_id", "original_name", "recorded_at", "original_duration_s", "trim_start_s", "trim_end_s",
            "full_clip", "fps", "width", "height", "codec",
        ])
        XCTAssertEqual(m["client_id"] as? String, "6F9619FF-8B86-D011-B42D-00C04FC964FF")
        XCTAssertEqual(m["original_name"] as? String, "IMG_0001.MOV")
        XCTAssertEqual(m["recorded_at"] as? String, "2026-11-16T15:12:07+07:00", "local time with the phone's offset")
        XCTAssertEqual(m["original_duration_s"] as? Double, 58.23)
        XCTAssertEqual(m["trim_start_s"] as? Double, 12.3)
        XCTAssertEqual(m["trim_end_s"] as? Double, 41.0)
        XCTAssertEqual((m["full_clip"] as? NSNumber).map { CFGetTypeID($0) == CFBooleanGetTypeID() }, true, "a JSON bool")
        XCTAssertEqual(m["full_clip"] as? Bool, false)
        XCTAssertEqual(m["fps"] as? Double, 59.94, "two decimals")
        XCTAssertEqual(m["width"] as? Int, 1920)
        XCTAssertEqual(m["height"] as? Int, 1080)
        XCTAssertEqual(m["codec"] as? String, "hevc")
    }

    /// AVFoundation reports 0 for an unknown frame rate or size; the daemon
    /// refuses 0, so those keys are left out instead (review finding).
    func testUnknownFpsAndSizeAreOmitted() throws {
        let m = try decode(LiftStore.meta(clip(fps: 0, width: 0, height: 0)))
        XCTAssertNil(m["fps"])
        XCTAssertNil(m["width"])
        XCTAssertNil(m["height"])
        XCTAssertEqual(m["codec"] as? String, "hevc")
    }

    func testFullClipMeta() throws {
        let m = try decode(LiftStore.meta(clip(full: true)))
        XCTAssertEqual(m["full_clip"] as? Bool, true)
        XCTAssertEqual(m["trim_start_s"] as? Double, 0)
        XCTAssertEqual(m["trim_end_s"] as? Double, 58.23)
    }

    func testOriginalNameRule() {
        XCTAssertEqual(LiftMedia.originalName(suggested: "IMG_0001", ext: "MOV"), "IMG_0001.MOV")
        // The provider may suggest the full file name: no "IMG_0001_MOV.MOV".
        XCTAssertEqual(LiftMedia.originalName(suggested: "IMG_0001.MOV", ext: "MOV"), "IMG_0001.MOV")
        XCTAssertEqual(LiftMedia.originalName(suggested: "IMG_0001.mp4", ext: "mp4"), "IMG_0001.mp4")
        XCTAssertEqual(LiftMedia.originalName(suggested: "Squat day 2.mov", ext: "MOV"), "Squat_day_2.MOV")
        XCTAssertEqual(LiftMedia.originalName(suggested: "../../etc/passwd", ext: "MOV"), "______etc_passwd.MOV")
        XCTAssertEqual(LiftMedia.originalName(suggested: nil, ext: "MOV"), "clip.MOV")
        XCTAssertEqual(LiftMedia.originalName(suggested: "IMG_0001", ext: "m4v"), "IMG_0001.MOV")
        for n in ["IMG_0001.MOV", "Squat_day_2.MOV", "______etc_passwd.MOV", "clip.MOV",
                  LiftMedia.originalName(suggested: String(repeating: "a", count: 200), ext: "MOV")] {
            XCTAssertTrue(LiftMedia.validName(n), n)
        }
        XCTAssertFalse(LiftMedia.validName("a/b.MOV"))
        XCTAssertFalse(LiftMedia.validName("IMG_0001.MOV.MOV"))
    }

    func testCodecNamesStayInsideTheDaemonAlphabet() {
        func cc(_ s: String) -> FourCharCode { s.utf8.reduce(0) { $0 << 8 | FourCharCode($1) } }
        XCTAssertEqual(LiftMedia.codecName(cc("hvc1")), "hevc")
        XCTAssertEqual(LiftMedia.codecName(cc("hev1")), "hevc")
        XCTAssertEqual(LiftMedia.codecName(cc("dvh1")), "hevc", "Dolby Vision on HEVC")
        XCTAssertEqual(LiftMedia.codecName(cc("dvhe")), "hevc")
        XCTAssertEqual(LiftMedia.codecName(cc("avc1")), "h264")
        XCTAssertEqual(LiftMedia.codecName(cc("dva1")), "h264")
        XCTAssertEqual(LiftMedia.codecName(cc("apch")), "prores")
        XCTAssertEqual(LiftMedia.codecName(cc("vp09")), "vp09")
        XCTAssertEqual(LiftMedia.codecName(cc("a b ")), "unknown", "inner space")
        XCTAssertEqual(LiftMedia.codecName(0x6162_6300), "unknown", "trailing NUL")
        XCTAssertEqual(LiftMedia.codecName(cc("x-y!")), "unknown")
        for v in ["hevc", "h264", "prores", "vp09", "unknown"] {
            XCTAssertNotNil(v.range(of: LiftMedia.codecPattern, options: .regularExpression), v)
        }
    }

    func testClipListDecodesWithMissingFields() throws {
        // What a build before bytes/sent/attempts/source/taskId would write.
        let json = """
        [{"id":"a","originalName":"IMG_0001.MOV","recordedAt":800000000,"originalDuration":20,
          "trimStart":0,"trimEnd":20,"fullClip":true,"state":"queued","file":"a.MOV"}]
        """
        let clips = try JSONDecoder().decode([LiftClip].self, from: Data(json.utf8))
        XCTAssertEqual(clips.count, 1)
        XCTAssertEqual(clips[0].bytes, 0)
        XCTAssertEqual(clips[0].attempts, 0)
        XCTAssertEqual(clips[0].file, "a.MOV")
        XCTAssertNil(clips[0].source)
        XCTAssertFalse(clips[0].heldInBackground)
        // And a round trip keeps every field.
        var c = clip()
        c.source = "x-src.MOV"
        c.taskId = 7
        c.heldInBackground = true
        c.cutAttempts = 2
        let back = try JSONDecoder().decode(LiftClip.self, from: JSONEncoder().encode(c))
        XCTAssertEqual(back, c)
    }

    func testUnknownStateDoesNotLoseTheRow() throws {
        let json = """
        {"id":"a","originalName":"IMG_0001.MOV","recordedAt":800000000,"originalDuration":20,
         "trimStart":0,"trimEnd":20,"fullClip":true,"state":"someFutureState","file":"a.MOV"}
        """
        let c = try JSONDecoder().decode(LiftClip.self, from: Data(json.utf8))
        XCTAssertEqual(c.state, .failed, "an unknown state retries instead of failing the whole list")
    }
}

/// The probe's stored result (UserDefaults "lift_probe_v1") across the move
/// to sequential runs (Nov 18 2026): a result saved by the parallel build
/// still decodes (no order, not held), and the new fields round-trip.
final class LiftProbeStoreTests: XCTestCase {
    /// Review finding: 2 of 2 often runs with the app open after a held
    /// start; an OK proves locked-phone sending only if the app left the
    /// foreground during that upload.
    func testLockedProofNeedsABackgroundTrip() {
        var r = LiftProbe.Run(state: .ok, order: 2)
        XCTAssertFalse(r.provedLocked, "sequential OK, app never left the foreground")
        r.sawBackground = true
        XCTAssertTrue(r.provedLocked)
        r.background = true
        XCTAssertFalse(r.provedLocked, "created in the background: iOS may have deferred it")
        XCTAssertTrue(LiftProbe.Run(state: .ok).provedLocked, "parallel-era OK keeps its old meaning")
        XCTAssertFalse(LiftProbe.Run(state: .failed, order: 1, sawBackground: true).provedLocked)
    }

    func testParallelEraResultStillDecodes() throws {
        let old = #"{"host":{"state":"ok","sent":50000000,"total":50000000,"startedAt":785000000,"finishedAt":785000026.8,"serverMs":26310,"serverBytes":50000000,"taskId":7,"background":false},"tailnet":{"state":"failed","sent":0,"total":50000000,"error":"HTTP 502"}}"#
        let runs = try JSONDecoder().decode([String: LiftProbe.Run].self, from: Data(old.utf8))
        let host = try XCTUnwrap(runs["host"])
        XCTAssertEqual(host.state, .ok)
        XCTAssertNil(host.order)
        XCTAssertFalse(host.held)
        XCTAssertEqual(try XCTUnwrap(host.seconds), 26.8, accuracy: 0.001)
        XCTAssertEqual(runs["tailnet"]?.state, .failed)
        XCTAssertFalse(try XCTUnwrap(runs["tailnet"]).live)
    }

    func testSequentialFieldsRoundTrip() throws {
        let runs: [String: LiftProbe.Run] = [
            "host": LiftProbe.Run(state: .uploading, sent: 1, startedAt: Date(timeIntervalSince1970: 1), order: 1),
            "tailnet": LiftProbe.Run(state: .queued, order: 2, held: true),
        ]
        let back = try JSONDecoder().decode([String: LiftProbe.Run].self, from: JSONEncoder().encode(runs))
        XCTAssertEqual(back, runs)
        XCTAssertTrue(try XCTUnwrap(back["tailnet"]).live, "a queued second keeps the test running")
        XCTAssertFalse(try XCTUnwrap(back["tailnet"]).inFlight, "a queued second has no task to reconcile")
    }

    /// A state this build does not know (a newer build's) reads as idle
    /// rather than failing the whole stored result.
    func testUnknownStateReadsAsIdle() throws {
        let json = #"{"host":{"state":"paused-by-a-future-build","order":1}}"#
        let runs = try JSONDecoder().decode([String: LiftProbe.Run].self, from: Data(json.utf8))
        XCTAssertEqual(runs["host"]?.state, .idle)
        XCTAssertEqual(runs["host"]?.order, 1)
    }

    func testOrderIsHostThenTailnet() {
        XCTAssertEqual(LiftProbe.order, [.host, .tailnet])
        XCTAssertEqual(LiftProbe.position(.host), 1)
        XCTAssertEqual(LiftProbe.position(.tailnet), 2)
    }
}
