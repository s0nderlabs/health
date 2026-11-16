// Pins the Food tab's energy row (Nov 16 2026): calibrated days show the
// balance with its band on screen; before calibration the row shows WHOOP's
// raw burn and never a balance value. The demo payloads carry the daemon's
// exact note strings, so these run against what the phone really renders.
// Simulator demo mode only.

import XCTest

final class EnergyRowTests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    func testCalibratedDeficitIsOnScreen() throws {
        let app = launch("energy-deficit")
        let value = app.descendants(matching: .any)["food.energy.value"].firstMatch
        XCTAssertTrue(value.waitForExistence(timeout: 10), "energy value never appeared")
        XCTAssertTrue(value.label.contains("deficit"), "label: \(value.label)")
        XCTAssertTrue(value.label.contains("\u{00B1}180"), "band missing: \(value.label)")
        let screen = app.windows.firstMatch.frame
        XCTAssertTrue(screen.contains(value.frame), "energy value off screen: \(value.frame) vs \(screen)")
        // Full coverage, nothing to add: the daemon sends no note.
        XCTAssertFalse(app.descendants(matching: .any)["food.energy.note"].exists)
    }

    func testTodayReadsSoFar() throws {
        let app = launch("energy-sofar")
        let value = app.descendants(matching: .any)["food.energy.value"].firstMatch
        XCTAssertTrue(value.waitForExistence(timeout: 10))
        XCTAssertTrue(value.label.contains("so far"), "label: \(value.label)")
    }

    func testUncalibratedShowsNoBalanceValue() throws {
        let app = launch("energy-uncal")
        let value = app.descendants(matching: .any)["food.energy.value"].firstMatch
        XCTAssertTrue(value.waitForExistence(timeout: 10))
        // The value is the raw burn, never a signed balance.
        XCTAssertTrue(value.label.hasPrefix("Burned "), "label: \(value.label)")
        XCTAssertTrue(value.label.contains("uncalibrated"), "label: \(value.label)")
        let balance = NSPredicate(format: "label MATCHES %@", ".*[+\u{2212}][0-9,]+ kcal (deficit|surplus).*")
        XCTAssertEqual(app.descendants(matching: .any).matching(balance).count, 0, "uncalibrated day shows a balance value")
        let note = app.descendants(matching: .any)["food.energy.note"].firstMatch
        XCTAssertTrue(note.exists)
        XCTAssertEqual(note.label, "No balance until the baseline calibrates WHOOP.")
    }

    func testPendingMealShowsNoBalance() throws {
        let app = launch("energy-pending")
        let value = app.descendants(matching: .any)["food.energy.value"].firstMatch
        XCTAssertTrue(value.waitForExistence(timeout: 10))
        XCTAssertTrue(value.label.hasPrefix("Burned "), "label: \(value.label)")
        XCTAssertEqual(app.descendants(matching: .any)["food.energy.note"].firstMatch.label,
                       "1 meal not estimated yet, so no balance yet.")
    }

    func testProvisionalFactorIsHedged() throws {
        let app = launch("energy-provisional")
        let value = app.descendants(matching: .any)["food.energy.value"].firstMatch
        XCTAssertTrue(value.waitForExistence(timeout: 10))
        XCTAssertTrue(value.label.contains("provisional"), "label: \(value.label)")
        let tag = app.descendants(matching: .any)["food.energy.tag"].firstMatch
        XCTAssertTrue(tag.label.contains("provisional"), "tag: \(tag.label)")
        let footer = NSPredicate(format: "label BEGINSWITH 'Baseline provisional'")
        XCTAssertGreaterThan(app.staticTexts.matching(footer).count, 0, "footer does not say provisional")
        XCTAssertFalse(app.staticTexts["Baseline ready. Ask Claude for your budget."].exists)
    }

    func testMalformedEnergyDropsOnlyTheRow() throws {
        let app = launch("energy-malformed")
        XCTAssertTrue(app.staticTexts["PROTEIN"].waitForExistence(timeout: 10), "the day did not render")
        XCTAssertFalse(app.descendants(matching: .any)["food.energy"].exists)
    }

    func testOlderDaemonShowsNoEnergyRow() throws {
        let app = launch("baseline")
        XCTAssertTrue(app.staticTexts["PROTEIN"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.descendants(matching: .any)["food.energy"].exists)
    }

    private func launch(_ mode: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment = ["HR_DEMO": "1", "HR_DEMO_TAB": "food", "HR_DEMO_FOOD": mode]
        app.launch()
        return app
    }
}
