// Pins the lift-clip fast path's phone side (Nov 18 2026): the trim sheet's
// handles move and the selected duration follows them, "Use full clip" puts
// both handles back on the ends, Send holds the sheet until the upload task
// exists, a pick that loads instantly still opens the trim sheet (the
// picker's dismissal used to swallow it), the Plan card renders the queue,
// the not-yet-sending states and the delivered rows from demo state, the
// locked-phone claim waits for a passed probe, and Diagnostics stays hidden
// until five taps on Version, then shows both transport rows. Simulator demo
// mode only: the clip is written in-app (HR_DEMO_LIFT_TRIM=synthetic), no
// network.

import XCTest

final class LiftClipsTests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    // ── trim ─────────────────────────────────────────────────────────

    func testHandlesMoveAndDurationFollows() throws {
        let app = launchTrim(range: nil) // the whole 10.0 s clip
        let duration = element(app, "trim.duration")
        XCTAssertTrue(duration.waitForExistence(timeout: 20), "trim sheet never opened")
        XCTAssertTrue(waitFor(duration, value: "10.0 s"), "starts on the full clip, got \(duration.value ?? "nil")")
        XCTAssertEqual(element(app, "trim.range").label, "Full clip")

        // Start handle in by ~a quarter of the strip.
        let start = element(app, "trim.start")
        let from = start.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.5))
        from.press(forDuration: 0.1, thenDragTo: from.withOffset(CGVector(dx: 80, dy: 0)))
        let afterStart = seconds(duration)
        XCTAssertLessThan(afterStart, 9.0, "start handle did not move the duration (\(afterStart))")
        XCTAssertGreaterThan(afterStart, 5.0, "start handle jumped too far (\(afterStart))")
        XCTAssertNotEqual(element(app, "trim.range").label, "Full clip")

        // End handle in too: the duration shrinks again.
        let end = element(app, "trim.end")
        let endFrom = end.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.5))
        endFrom.press(forDuration: 0.1, thenDragTo: endFrom.withOffset(CGVector(dx: -60, dy: 0)))
        let afterEnd = seconds(duration)
        XCTAssertLessThan(afterEnd, afterStart - 0.5, "end handle did not shrink the selection (\(afterEnd))")
        XCTAssertGreaterThanOrEqual(afterEnd, 1.0, "the 1 s minimum was broken (\(afterEnd))")

        // Both handles stay on screen and inside the strip.
        let screen = app.windows.firstMatch.frame
        XCTAssertTrue(screen.contains(element(app, "trim.start").frame))
        XCTAssertTrue(screen.contains(element(app, "trim.end").frame))
    }

    func testUseFullClipResets() throws {
        let app = launchTrim(range: "2.0,6.0")
        let duration = element(app, "trim.duration")
        XCTAssertTrue(duration.waitForExistence(timeout: 20), "trim sheet never opened")
        XCTAssertTrue(waitFor(duration, value: "4.0 s"), "demo range not applied, got \(duration.value ?? "nil")")
        XCTAssertEqual(element(app, "trim.range").label, "2.0 – 6.0 s")

        let full = app.buttons["trim.full"]
        XCTAssertTrue(full.isEnabled)
        full.tap()
        XCTAssertTrue(waitFor(duration, value: "10.0 s"), "Use full clip did not reset, got \(duration.value ?? "nil")")
        XCTAssertEqual(element(app, "trim.range").label, "Full clip")
        XCTAssertFalse(full.isEnabled, "already full: the button should rest")
    }

    // ── the Plan card ────────────────────────────────────────────────

    func testQueueRowsRender() throws {
        let app = launchPlan("queue")
        let header = app.staticTexts["lift.header"]
        XCTAssertTrue(header.waitForExistence(timeout: 10), "lift clips card missing")
        XCTAssertEqual(header.label, "LIFT CLIPS · 2 SENDING")
        let uploading = app.descendants(matching: .any).matching(identifier: "lift.row.uploading")
        let queued = app.descendants(matching: .any).matching(identifier: "lift.row.queued")
        XCTAssertEqual(uploading.count, 2)
        XCTAssertEqual(queued.count, 1)
        XCTAssertTrue(uploading.element(boundBy: 0).label.contains("62%"), uploading.element(boundBy: 0).label)
        XCTAssertTrue(uploading.element(boundBy: 0).label.contains("12.3–41.0 s of 58.2 s"))
        XCTAssertTrue(queued.element(boundBy: 0).label.contains("Queued"))
        // No probe has passed: the card does not claim locked-phone delivery.
        XCTAssertEqual(app.staticTexts["lift.locked"].label, "Locked-phone sending not yet tested.")
    }

    func testLockedClaimAfterAPassedProbe() throws {
        let app = launchPlan("queue", extra: ["HR_DEMO_PROBE": "ok"])
        let line = app.staticTexts["lift.locked"]
        XCTAssertTrue(line.waitForExistence(timeout: 10))
        XCTAssertEqual(line.label, "Keeps sending with the phone locked.")
    }

    func testStateRowsSayWhy() throws {
        let app = launchPlan("states")
        XCTAssertTrue(app.staticTexts["lift.header"].waitForExistence(timeout: 10), "lift clips card missing")
        let queued = app.descendants(matching: .any).matching(identifier: "lift.row.queued")
        XCTAssertEqual(queued.count, 2)
        XCTAssertTrue(queued.element(boundBy: 0).label.contains("No route to the Mac yet"), queued.element(boundBy: 0).label)
        XCTAssertTrue(queued.element(boundBy: 1).label.contains("Opening the app restarts it"), queued.element(boundBy: 1).label)
        let failed = app.descendants(matching: .any).matching(identifier: "lift.row.failed")
        XCTAssertEqual(failed.count, 2)
        XCTAssertTrue(failed.element(boundBy: 1).label.contains("Tap Retry to cut it again"), failed.element(boundBy: 1).label)
        // A cut that failed keeps its source, so it can be retried.
        XCTAssertEqual(app.buttons.matching(identifier: "lift.retry").count, 2)
    }

    func testPickThatLoadsAtOnceStillOpensTrim() throws {
        let app = XCUIApplication()
        app.launchEnvironment = ["HR_DEMO": "1", "HR_DEMO_TAB": "plan", "HR_DEMO_FACE": "lift",
                                 "HR_DEMO_LIFT": "empty", "HR_DEMO_LIFT_PICK": "1", "HR_DEMO_SCROLL": "clips:center"]
        app.launch()
        let add = app.buttons["lift.add"]
        XCTAssertTrue(add.waitForExistence(timeout: 10))
        sleep(2) // the synthetic clip is written ahead, so the pick returns at once
        add.tap()
        let pick = app.buttons["lift.fakepick"]
        XCTAssertTrue(pick.waitForExistence(timeout: 5), "picker stand-in did not open")
        pick.tap()
        XCTAssertTrue(element(app, "trim.duration").waitForExistence(timeout: 10),
                      "the trim sheet never opened after the picker closed")
    }

    func testSendHoldsTheSheetUntilQueued() throws {
        let app = launchTrim(range: "2.0,6.0")
        let send = app.buttons["trim.send"]
        XCTAssertTrue(send.waitForExistence(timeout: 20), "trim sheet never opened")
        send.tap()
        XCTAssertTrue(element(app, "trim.cutting").waitForExistence(timeout: 2), "no Cutting state after Send")
        let gone = NSPredicate(format: "exists == false")
        XCTAssertEqual(XCTWaiter().wait(for: [expectation(for: gone, evaluatedWith: element(app, "trim.sheet"))], timeout: 8),
                       .completed, "the sheet did not close once the clip was queued")
    }

    func testDeliveredRowsRender() throws {
        let app = launchPlan("uploaded")
        let header = app.staticTexts["lift.header"]
        XCTAssertTrue(header.waitForExistence(timeout: 10), "lift clips card missing")
        XCTAssertEqual(header.label, "LIFT CLIPS")
        let done = app.descendants(matching: .any).matching(identifier: "lift.row.done")
        XCTAssertEqual(done.count, 3)
        XCTAssertTrue(done.element(boundBy: 1).label.contains("Syncthing had it already"), done.element(boundBy: 1).label)
        XCTAssertTrue(done.element(boundBy: 0).label.contains("On the Mac"))
        // Alone, the delivered rows need no second "ON THE MAC" label.
        XCTAssertFalse(app.staticTexts["ON THE MAC"].exists)
    }

    // ── the card on a ride day ───────────────────────────────────────

    /// A double day's ride face carries the card too (he looked for it on a
    /// ride morning and it was not there), and switching faces never shows
    /// two: one card, outside the face-keyed group.
    func testCardOnTheRideFaceOfADoubleDay() throws {
        let app = XCUIApplication()
        app.launchEnvironment = ["HR_DEMO": "1", "HR_DEMO_TAB": "plan", "HR_DEMO_RIDE": "easy", "HR_DEMO_FACE": "ride",
                                 "HR_DEMO_LIFT": "card", "HR_DEMO_SCROLL": "clips:center"]
        app.launch()
        let ride = app.staticTexts["Easy 2 h, the first of the new weekday length"]
        XCTAssertTrue(ride.waitForExistence(timeout: 10), "not on the ride face")
        let headers = app.staticTexts.matching(identifier: "lift.header")
        XCTAssertTrue(headers.firstMatch.waitForExistence(timeout: 5), "no lift clips card on the ride face")
        XCTAssertEqual(headers.count, 1)
        XCTAssertTrue(app.windows.firstMatch.frame.contains(headers.firstMatch.frame), "the card is not scrolled into view")
        // The card sits below the ride card.
        XCTAssertGreaterThan(headers.firstMatch.frame.minY, ride.frame.maxY)

        let toLift = app.buttons["plan.face.lift"]
        app.swipeDown() // back to the top, where the toggle is
        XCTAssertTrue(toLift.waitForExistence(timeout: 5))
        toLift.tap()
        XCTAssertTrue(waitGone(ride), "still on the ride face after tapping Lift")
        XCTAssertEqual(headers.count, 1, "lift face: exactly one card")
        app.buttons["plan.face.ride"].tap()
        XCTAssertTrue(ride.waitForExistence(timeout: 5), "back on the ride face")
        XCTAssertEqual(headers.count, 1, "ride face again: exactly one card")
    }

    func testCardOnARideOnlyDay() throws {
        let app = XCUIApplication()
        app.launchEnvironment = ["HR_DEMO": "1", "HR_DEMO_TAB": "plan", "HR_DEMO_RIDE": "long",
                                 "HR_DEMO_LIFT": "uploaded", "HR_DEMO_SCROLL": "clips:center"]
        app.launch()
        XCTAssertTrue(app.staticTexts["Long ride, build Saturday 1 of 3"].waitForExistence(timeout: 10), "not the ride-only demo day")
        XCTAssertFalse(app.buttons["plan.face.lift"].exists, "a ride-only day has no toggle")
        let headers = app.staticTexts.matching(identifier: "lift.header")
        XCTAssertTrue(headers.firstMatch.waitForExistence(timeout: 5), "no lift clips card on a ride-only day")
        XCTAssertEqual(headers.count, 1)
        XCTAssertEqual(app.descendants(matching: .any).matching(identifier: "lift.row.done").count, 3)
    }

    // ── Diagnostics ──────────────────────────────────────────────────

    func testProbeRevealAndBothTransports() throws {
        let app = XCUIApplication()
        app.launchEnvironment = ["HR_DEMO": "1", "HR_DEMO_SETTINGS": "1", "HR_DEMO_PROBE": "mixed"]
        app.launch()
        let version = app.staticTexts["Version"]
        XCTAssertTrue(version.waitForExistence(timeout: 10), "settings did not open")
        XCTAssertFalse(app.staticTexts["Background upload test"].exists, "Diagnostics must start hidden")

        for _ in 0..<5 { version.tap() }

        let host = element(app, "diag.probe.host")
        for _ in 0..<6 where !host.exists || !app.windows.firstMatch.frame.contains(host.frame) {
            app.swipeUp()
        }
        XCTAssertTrue(host.waitForExistence(timeout: 5), "Diagnostics did not appear after 5 taps")
        let tailnet = element(app, "diag.probe.tailnet")
        XCTAssertTrue(tailnet.exists)
        XCTAssertTrue(host.label.contains("Failed"), host.label)
        XCTAssertTrue(host.label.contains("1 of 2"), host.label)
        XCTAssertTrue(tailnet.label.contains("OK"), tailnet.label)
        XCTAssertTrue(tailnet.label.contains("2 of 2"), tailnet.label)
        XCTAssertTrue(tailnet.label.contains("50 MB in 6.2 s"), tailnet.label)
        XCTAssertTrue(app.buttons["diag.probe.start"].exists, "Run again missing")
        XCTAssertTrue(app.staticTexts["Background upload test"].exists)
        // Clips already use the path that passed; the failed one offers nothing.
        XCTAssertTrue(app.staticTexts["Lift clips go this way"].exists)
        XCTAssertFalse(app.buttons["diag.probe.use.host"].exists)
        XCTAssertFalse(app.buttons["diag.probe.use.tailnet"].exists)
    }

    // The paths go one after the other (Nov 18 2026): the rows say the order
    // and what the second is waiting for.

    func testProbeFirstSendingSecondNext() throws {
        let app = launchProbe("running")
        let host = element(app, "diag.probe.host"), tailnet = element(app, "diag.probe.tailnet")
        XCTAssertTrue(host.waitForExistence(timeout: 10), "Diagnostics not shown")
        XCTAssertTrue(host.label.contains("1 of 2"), host.label)
        XCTAssertTrue(host.label.contains("62%"), host.label)
        XCTAssertTrue(tailnet.label.contains("2 of 2"), tailnet.label)
        XCTAssertTrue(tailnet.label.contains("Next"), tailnet.label)
        XCTAssertTrue(tailnet.label.contains("starts when 1 of 2 finishes"), tailnet.label)
        XCTAssertTrue(hint(app, "Sending 1 of 2. Lock the phone now").exists, "hint does not name 1 of 2")
        XCTAssertTrue(app.buttons["diag.probe.stop"].exists, "a queued second still counts as running")
        XCTAssertFalse(app.buttons["diag.probe.start"].exists)
    }

    func testProbeFirstDoneSecondSending() throws {
        let app = launchProbe("sequential")
        let host = element(app, "diag.probe.host"), tailnet = element(app, "diag.probe.tailnet")
        XCTAssertTrue(host.waitForExistence(timeout: 10), "Diagnostics not shown")
        XCTAssertTrue(host.label.contains("OK"), host.label)
        XCTAssertTrue(host.label.contains("1 of 2"), host.label)
        XCTAssertTrue(host.label.contains("50 MB in 11.4 s"), host.label)
        XCTAssertTrue(tailnet.label.contains("2 of 2"), tailnet.label)
        XCTAssertTrue(tailnet.label.contains("37%"), tailnet.label)
        XCTAssertTrue(hint(app, "Sending 2 of 2. Lock the phone now").exists, "hint does not name 2 of 2")
    }

    func testProbeHeldSecondSaysOpenTheApp() throws {
        let app = launchProbe("held")
        let tailnet = element(app, "diag.probe.tailnet")
        XCTAssertTrue(tailnet.waitForExistence(timeout: 10), "Diagnostics not shown")
        XCTAssertTrue(tailnet.label.contains("2 of 2"), tailnet.label)
        XCTAssertTrue(tailnet.label.contains("Waiting"), tailnet.label)
        XCTAssertTrue(tailnet.label.contains("waiting to start, open the app"), tailnet.label)
    }

    /// A result stored before the probe went sequential still reads, with
    /// no made-up order (both of those ran at once).
    func testProbeLegacyResultHasNoOrder() throws {
        let app = launchProbe("legacy")
        let host = element(app, "diag.probe.host"), tailnet = element(app, "diag.probe.tailnet")
        XCTAssertTrue(host.waitForExistence(timeout: 10), "Diagnostics not shown")
        XCTAssertTrue(host.label.contains("50 MB in 26.8 s"), host.label)
        XCTAssertTrue(tailnet.label.contains("50 MB in 56.5 s"), tailnet.label)
        XCTAssertFalse(host.label.contains("of 2"), host.label)
        XCTAssertFalse(tailnet.label.contains("of 2"), tailnet.label)
        XCTAssertTrue(app.buttons["diag.probe.start"].exists, "Run again missing")
    }

    // ── helpers ──────────────────────────────────────────────────────

    private func launchProbe(_ mode: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment = ["HR_DEMO": "1", "HR_DEMO_SETTINGS": "1", "HR_DEMO_DIAG": "scroll", "HR_DEMO_PROBE": mode]
        app.launch()
        return app
    }

    private func hint(_ app: XCUIApplication, _ prefix: String) -> XCUIElement {
        let e = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", prefix)).firstMatch
        _ = e.waitForExistence(timeout: 5)
        return e
    }

    private func waitGone(_ e: XCUIElement, timeout: TimeInterval = 5) -> Bool {
        let p = NSPredicate(format: "exists == false")
        return XCTWaiter().wait(for: [expectation(for: p, evaluatedWith: e)], timeout: timeout) == .completed
    }

    private func launchTrim(range: String?) -> XCUIApplication {
        let app = XCUIApplication()
        var env = ["HR_DEMO": "1", "HR_DEMO_TAB": "plan", "HR_DEMO_LIFT": "empty", "HR_DEMO_LIFT_TRIM": "synthetic"]
        if let r = range { env["HR_DEMO_LIFT_TRIM_RANGE"] = r }
        app.launchEnvironment = env
        app.launch()
        return app
    }

    private func launchPlan(_ mode: String, extra: [String: String] = [:]) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment = ["HR_DEMO": "1", "HR_DEMO_TAB": "plan", "HR_DEMO_FACE": "lift",
                                 "HR_DEMO_LIFT": mode, "HR_DEMO_SCROLL": "clips:center"].merging(extra) { $1 }
        app.launch()
        return app
    }

    private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: id).firstMatch
    }

    /// "11.4 s" -> 11.4
    private func seconds(_ e: XCUIElement) -> Double {
        Double((e.value as? String ?? "").replacingOccurrences(of: " s", with: "")) ?? -1
    }

    private func waitFor(_ e: XCUIElement, value: String, timeout: TimeInterval = 8) -> Bool {
        let p = NSPredicate(format: "value == %@", value)
        return XCTWaiter().wait(for: [expectation(for: p, evaluatedWith: e)], timeout: timeout) == .completed
    }
}
