// Pins the Food tab's protein-left line (Nov 16 2026): always on under the
// protein total, worked on the same rounded numbers the card shows, quiet
// when met or over, gone when there is no target. And it is protein only:
// during the baseline the card never grows a kcal-left / kcal target.
// Simulator demo mode only.

import XCTest

final class ProteinLeftTests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    func testMidDayShowsGramsLeft() throws {
        let app = launch("baseline") // 50 of 140 logged
        let line = app.staticTexts["food.protein.left"].firstMatch
        XCTAssertTrue(line.waitForExistence(timeout: 10), "protein-left line never appeared")
        // On screen: "90 g protein left" (the label is its spoken form).
        XCTAssertEqual(line.label, "90 grams of protein left")
        let screen = app.windows.firstMatch.frame
        XCTAssertTrue(screen.contains(line.frame), "protein-left off screen: \(line.frame) vs \(screen)")
        assertNoKcalTarget(app)
    }

    func testTargetMet() throws {
        let app = launch("protein-met") // 140 of 140
        let line = app.staticTexts["food.protein.left"].firstMatch
        XCTAssertTrue(line.waitForExistence(timeout: 10))
        XCTAssertEqual(line.label, "Protein target met") // on screen: "target met"
        assertNoKcalTarget(app)
    }

    func testOverIsQuiet() throws {
        let app = launch("protein-over") // 152 of 140
        let line = app.staticTexts["food.protein.left"].firstMatch
        XCTAssertTrue(line.waitForExistence(timeout: 10))
        XCTAssertEqual(line.label, "Protein target met, 12 grams over") // on screen: "+12 g over"
        assertNoKcalTarget(app)
    }

    func testNoTargetNoLine() throws {
        let app = launch("protein-notarget")
        XCTAssertTrue(app.staticTexts["PROTEIN"].waitForExistence(timeout: 10), "the day did not render")
        XCTAssertFalse(app.staticTexts["food.protein.left"].exists)
    }

    /// The baseline phase has no kcal target: RANGE stays, LEFT/OVER never show.
    private func assertNoKcalTarget(_ app: XCUIApplication) {
        XCTAssertTrue(app.staticTexts["RANGE"].exists, "kcal RANGE stat missing")
        XCTAssertFalse(app.staticTexts["LEFT"].exists)
        XCTAssertFalse(app.staticTexts["OVER"].exists)
    }

    private func launch(_ mode: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment = ["HR_DEMO": "1", "HR_DEMO_TAB": "food", "HR_DEMO_FOOD": mode]
        app.launch()
        return app
    }
}
