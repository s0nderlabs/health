// Pins the Body tab's composition card (Nov 16 2026, moved from the Food
// tab mock): the latest S400 weigh-in's composition, fully on a 390 pt
// screen, every value wearing its basis (quiet text, no capsules). Fat,
// water, protein and bone live on the figure's legend (one home per
// number), so with the figure on the page the card keeps the rest. A broken
// metrics object drops only the card. The demo metrics are the daemon's exact day.body contract
// (bodycomp.ts DAY_BODY_ORDER keys, labels, bare notes); the notes no longer
// print on the card, they sit in its (i) sheet, each line naming the metric
// it belongs to. Simulator demo mode only, synthetic values.

import XCTest

final class BodyCardTests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    func testFormulaCardIsFullyOnScreen() throws {
        let app = launch("formula", scroll: "metrics")
        let card = app.descendants(matching: .any)["body.card"].firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 10), "body card never appeared")
        Thread.sleep(forTimeInterval: 1.0) // let the demo scroll settle
        let screen = app.windows.firstMatch.frame
        XCTAssertTrue(screen.contains(card.frame), "body card off screen: \(card.frame) vs \(screen)")
        // Clear of the floating tab bar too, not just inside the window.
        let tabBar = app.tabBars.firstMatch
        if tabBar.exists {
            XCTAssertLessThanOrEqual(card.frame.maxY, tabBar.frame.minY, "body card under the tab bar: \(card.frame) vs \(tabBar.frame)")
        }

        // The headline pair, then every grid metric, each inside the card
        // (nothing clipped at the trailing edge) and tagged formula.
        let keys = ["visceral", "muscle_kg", "smm_kg", "lean_kg", "bmr_kcal"]
        for key in keys {
            let m = app.descendants(matching: .any)["body.metric.\(key)"].firstMatch
            XCTAssertTrue(m.exists, "\(key) missing")
            XCTAssertTrue(card.frame.contains(m.frame), "\(key) outside the card: \(m.frame) vs \(card.frame)")
            XCTAssertTrue(m.label.hasSuffix(", formula"), "\(key) label: \(m.label)")
        }
        // Nothing the daemon never sends (no body age, no BMI on the card),
        // and nothing the figure's legend already shows.
        for gone in ["metabolic_age", "bmi", "visceral_fat", "lbm_kg", "fat_pct", "water_pct", "protein_pct", "bone_kg"] {
            XCTAssertFalse(app.descendants(matching: .any)["body.metric.\(gone)"].exists, "\(gone) shown")
        }
        XCTAssertEqual(app.descendants(matching: .any)["body.metric.muscle_kg"].firstMatch.label,
                       "Muscle 52.9 kg, formula")
        XCTAssertEqual(app.descendants(matching: .any)["body.metric.visceral"].firstMatch.label,
                       "Visceral fat 12, formula")
        XCTAssertEqual(app.descendants(matching: .any)["body.figure.legend.mineral"].firstMatch.label,
                       "Mineral 2.84 kg, 4.0 percent of weight, formula")
        XCTAssertEqual(app.descendants(matching: .any)["body.metric.bmr_kcal"].firstMatch.label,
                       "BMR 1,500 kcal, formula")
        // Less text: no footnotes on the card itself.
        XCTAssertFalse(app.descendants(matching: .any)["body.card.note"].exists)
        // The (i) sheet: notes name their metrics; the same note shares one line.
        let text = openSheet(app)
        XCTAssertTrue(text.contains("Visceral fat, BMR: weight-derived, no impedance"), text)
        XCTAssertTrue(text.contains("Protein: guessed formula"), text)
        XCTAssertTrue(text.contains("Skeletal muscle: a smaller part of Muscle"), text)
        // The newest S400 reading that is his (the 06:40 repeat), as day.body
        // picks it on a live daemon: not the 06:05 one the trend counts.
        XCTAssertTrue(text.contains("S400 \u{00B7} 71.2 kg \u{00B7} 06:40"), text)
        // Formula only: nothing claims a calibration, so no explainer.
        XCTAssertFalse(text.contains("cal. to Xiaomi"), text)
    }

    func testCalibratedCardMixesBases() throws {
        let app = launch("full", scroll: "metrics")
        let card = app.descendants(matching: .any)["body.card"].firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 10))
        Thread.sleep(forTimeInterval: 1.0)
        XCTAssertTrue(app.windows.firstMatch.frame.contains(card.frame), "body card off screen: \(card.frame)")
        // "calibrated" always says what it is calibrated TO (another scale).
        XCTAssertTrue(app.descendants(matching: .any)["body.metric.muscle_kg"].firstMatch.label.hasSuffix(", calibrated to Xiaomi Home"))
        XCTAssertTrue(app.descendants(matching: .any)["body.metric.visceral"].firstMatch.label.hasSuffix(", provisional"))
        XCTAssertTrue(app.descendants(matching: .any)["body.metric.lean_kg"].firstMatch.label.hasSuffix(", calibrated to Xiaomi Home"))
        XCTAssertTrue(app.descendants(matching: .any)["body.figure.legend.water"].firstMatch.label.hasSuffix(", formula"))
        XCTAssertFalse(app.descendants(matching: .any)["body.metric.water_pct"].exists)
        // Every calibration claim carries its metric, never a bare "4 pairs".
        let text = openSheet(app)
        for line in ["Visceral fat: 1 pair, weight-derived, no impedance", "Muscle: 4 pairs, +/-0.4 kg",
                     "Body fat: 5 pairs, +/-0.3 pt", "Lean mass: from calibrated fat",
                     "Water: from formula fat 21.7%", "BMR: weight-derived, no impedance",
                     "Xiaomi Home's readings of the same weigh-ins", "not a scan",
                     "Water and Protein are built on the formula fat"] {
            XCTAssertTrue(text.contains(line), "missing \(line) in \(text)")
        }
        XCTAssertTrue(app.staticTexts["TWO FAT NUMBERS"].exists)
    }

    func testMalformedMetricsDropOnlyTheCard() throws {
        let app = launch("malformed")
        XCTAssertTrue(app.descendants(matching: .any)["body.latest"].firstMatch.waitForExistence(timeout: 10),
                      "the page (latest card) did not render")
        XCTAssertFalse(app.descendants(matching: .any)["body.card"].exists)
    }

    func testEmptyPageHasNoCard() throws {
        let app = launch("empty")
        XCTAssertTrue(app.descendants(matching: .any)["body.empty"].firstMatch.waitForExistence(timeout: 10))
        XCTAssertFalse(app.descendants(matching: .any)["body.card"].exists)
    }

    /// Opens the card's (i) sheet and returns its lines, joined.
    private func openSheet(_ app: XCUIApplication) -> String {
        app.descendants(matching: .any)["body.info.metrics"].firstMatch.tap()
        XCTAssertTrue(app.descendants(matching: .any)["body.infosheet.title"].firstMatch.waitForExistence(timeout: 5))
        Thread.sleep(forTimeInterval: 0.6)
        let lines = app.descendants(matching: .any).matching(identifier: "body.infosheet.line")
        return (0..<lines.count).map { lines.element(boundBy: $0).label }.joined(separator: " | ")
    }

    private func launch(_ mode: String, scroll: String? = nil) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment = ["HR_DEMO": "1", "HR_DEMO_TAB": "body", "HR_DEMO_BODY": mode]
        if let scroll = scroll { app.launchEnvironment["HR_DEMO_BODY_SCROLL"] = scroll }
        app.launch()
        return app
    }
}
