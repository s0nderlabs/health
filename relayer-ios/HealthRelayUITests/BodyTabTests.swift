// Pins the Body tab (Nov 16 2026, polished the same evening): the fourth tab
// exists and opens; the order is latest, figure, metrics, goal, confounders,
// history; every section renders and sits fully on screen (inside the
// window, clear of the floating tab bar, nothing past either edge); the
// composition figure (hero) carries its legend, ghost and tap-to-detail
// (fat is the outer shell since Nov 18: a tap on it opens fat);
// every card's (i) opens a sheet holding the notes the card no longer prints;
// the legend stands BESIDE the figure; the ghost names the goal card's main
// number (the target fat % at today's S400 lean mass), the scan's weight
// sits under it as a labelled reference; the (i) targets are 44 pt; the S400 and Xiaomi copies of one
// weigh-in render as one grouped pair;
// excluded rows carry their reason; a possible-other-person row shows no
// numbers; an open confounder is said under the trend; a stale 7-day average
// says how old it is; the empty and unreachable states say different
// things; the page holds at xxxLarge text. Simulator demo mode only,
// synthetic values.

import XCTest

final class BodyTabTests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    func testBodyTabExistsAndOpens() throws {
        let app = XCUIApplication()
        app.launchEnvironment = ["HR_DEMO": "1", "HR_DEMO_BODY": "full"]
        app.launch()
        let tab = app.tabBars.buttons["Body"]
        XCTAssertTrue(tab.waitForExistence(timeout: 10), "no Body tab")
        // The other three stay where they were.
        for name in ["Live", "Plan", "Food"] {
            XCTAssertTrue(app.tabBars.buttons[name].exists, "\(name) tab missing")
        }
        tab.tap()
        XCTAssertTrue(app.descendants(matching: .any)["body.figure"].firstMatch.waitForExistence(timeout: 5))
    }

    func testFigureIsTheHero() throws {
        let app = launch("full", scroll: "figure")
        let fig = element(app, "body.figure")
        XCTAssertTrue(fig.waitForExistence(timeout: 10))
        Thread.sleep(forTimeInterval: 1.0) // the fill animation
        // The figure and its legend sit fully on screen.
        let body = element(app, "body.figure.body")
        assertOnScreen(app, body, "figure")
        XCTAssertGreaterThanOrEqual(body.frame.height, 360, "the hero shrank: \(body.frame)")
        // The figure owns the left of the card, the legend stands beside it.
        XCTAssertLessThan(body.frame.midX, fig.frame.midX, "figure not on the left: \(body.frame) in \(fig.frame)")
        XCTAssertTrue(body.label.hasPrefix("Body composition, 71.2 kg: Fat 15.2 kg, Water 38.2 kg, Protein 14.7 kg, Mineral 2.84 kg"), body.label)
        // The ghost is the goal card's main number: 15% at today's lean mass.
        XCTAssertTrue(body.label.contains("goal outline 65.9 kg"), body.label)
        for key in ["fat", "water", "protein", "mineral", "unassigned"] {
            let row = element(app, "body.figure.legend.\(key)")
            XCTAssertTrue(row.exists, "legend \(key) missing")
            assertOnScreen(app, row, "legend \(key)")
            XCTAssertTrue(fig.frame.contains(row.frame), "legend \(key) outside the card")
            // The legend stands BESIDE the figure, within its height.
            XCTAssertGreaterThanOrEqual(row.frame.minX, body.frame.maxX, "legend \(key) not beside the figure")
            XCTAssertLessThanOrEqual(row.frame.maxY, body.frame.maxY + 1, "legend \(key) below the figure")
        }
        // Top of the body first: fat over water over protein over mineral.
        let ys = ["fat", "water", "protein", "mineral"].map { element(app, "body.figure.legend.\($0)").frame.minY }
        XCTAssertEqual(ys, ys.sorted(), "legend order: \(ys)")
        // The reading's OWN fat (06:40), never the 06:05 weigh-in's.
        XCTAssertEqual(element(app, "body.figure.legend.fat").label, "Fat 15.2 kg, 21.3 percent of weight, calibrated to Xiaomi Home")
        XCTAssertEqual(element(app, "body.figure.legend.unassigned").label, "Unassigned 0.3 kg, 0.4 percent of weight")
        // Which reading, never a second weight (the latest card owns it).
        XCTAssertEqual(element(app, "body.figure.time").label, "S400 \u{00B7} 06:40")
        // One short key for the ghost; the method sits behind (i).
        let ghost = element(app, "body.figure.ghost.note").label
        XCTAssertEqual(ghost, "Goal outline ~65.9 kg")
        // Less text: no reading note or method paragraph on the card.
        XCTAssertFalse(element(app, "body.figure.reading").exists)
        XCTAssertFalse(element(app, "body.figure.note").exists)
        XCTAssertFalse(element(app, "body.figure.detail").exists)
        // Visceral is never painted on the figure.
        XCTAssertFalse(body.label.lowercased().contains("visceral"))
    }

    /// Latest first, then the figure, metrics, goal, confounders, history.
    func testSectionOrder() throws {
        let app = launch("full")
        XCTAssertTrue(element(app, "body.latest").waitForExistence(timeout: 10))
        let ids = ["body.latest", "body.figure", "body.card", "body.goal", "body.confounders", "body.history"]
        let ys = ids.map { element(app, $0).frame.minY }
        for i in 1..<ys.count {
            XCTAssertLessThan(ys[i - 1], ys[i], "\(ids[i - 1]) should sit above \(ids[i]): \(ys)")
        }
        // The top of the page: the latest card fully on screen, the figure
        // starting under it.
        assertOnScreen(app, element(app, "body.latest"), "latest card")
    }

    /// Every card's (i) opens a sheet with the words the card no longer
    /// prints, and Done closes it.
    func testInfoSheets() throws {
        let cases: [(key: String, scroll: String, title: String, says: [String])] = [
            ("latest", "latest", "Latest weigh-in", ["trend only", "3 or more counted readings"]),
            ("figure", "figure", "Composition", [
                "15% fat at today's 56.0 kg lean mass (S400, calibrated) = ~65.9 kg, the goal card's main number",
                "its area is 65.9 / 71.2 of today's", "the thin hatched band at the top",
                "Fat is the outer layer", "shrunk toward its own centre line by ONE factor", "No rim is drawn thinner than 1.25 pt",
                "The coral outside it is the fat between today and the goal",
                "(06:40, 71.2 kg). The trend counts the 06:05 weigh-in", "Fat: cal. to Xiaomi, 5 pairs, +/-0.3 pt",
                "Protein is the formulas' remainder",
            ]),
            ("metrics", "metrics", "Body metrics", ["Visceral fat: 1 pair, weight-derived, no impedance", "not a scan"]),
            ("goal", "goal", "Goal", ["checked against a scan, not the scale", "trend only",
                                      "today's 56.0 kg lean mass (S400, calibrated): about 65.9 kg",
                                      "a formula estimate, not a measurement", "moves as you gain muscle",
                                      "58.0 kg lean mass (InBody scan 2026-10-05): about 68.2 kg",
                                      "the reference until a new scan", "~69.2 kg while on creatine", "the bright dot, \"now\""]),
            ("confounders", "confounders", "Confounders", ["scale trend reads high", "Provisional"]),
            ("history", "history", "Weigh-ins", ["possible other person", "values are hidden", "same weigh-in, other source",
                                                  "not his (weight outlier)", "if it was you, say so", "(by hand)",
                                                  "same weigh-in, re-measured"]),
        ]
        for c in cases {
            let app = launch("full", scroll: c.scroll)
            let button = element(app, "body.info.\(c.key)")
            XCTAssertTrue(button.waitForExistence(timeout: 10), "no (i) on \(c.key)")
            Thread.sleep(forTimeInterval: 0.8)
            // The only way into the notes: a full 44 pt target.
            XCTAssertGreaterThanOrEqual(button.frame.width, 44, "\(c.key) (i) target: \(button.frame)")
            XCTAssertGreaterThanOrEqual(button.frame.height, 44, "\(c.key) (i) target: \(button.frame)")
            button.tap()
            let title = element(app, "body.infosheet.title")
            XCTAssertTrue(title.waitForExistence(timeout: 5), "\(c.key): no sheet")
            XCTAssertEqual(title.label, c.title)
            Thread.sleep(forTimeInterval: 0.6)
            assertOnScreen(app, title, "\(c.key) sheet title")
            let text = sheetText(app)
            for line in c.says {
                XCTAssertTrue(text.contains(line), "\(c.key) sheet misses \(line): \(text)")
            }
            element(app, "body.infosheet.done").tap()
            XCTAssertFalse(title.waitForExistence(timeout: 1.5) && title.isHittable, "\(c.key): sheet did not close")
            app.terminate()
        }
    }

    func testTapBandOpensDetail() throws {
        let app = launch("full", scroll: "figure")
        let fat = element(app, "body.figure.legend.fat")
        XCTAssertTrue(fat.waitForExistence(timeout: 10))
        fat.tap()
        let detail = element(app, "body.figure.detail")
        XCTAssertTrue(detail.waitForExistence(timeout: 3))
        XCTAssertTrue(element(app, "body.figure.detail.trend").exists, "no 7-day trend in the detail")
        XCTAssertTrue(detail.staticTexts["15.2"].exists)
        XCTAssertTrue(detail.staticTexts["cal. to Xiaomi"].exists)
        // The detail takes the legend's place beside the figure (the card
        // does not grow), fully on screen and inside the card.
        XCTAssertFalse(element(app, "body.figure.legend.fat").exists, "legend still showing under the detail")
        Thread.sleep(forTimeInterval: 0.6)
        let card = element(app, "body.figure")
        let figure = element(app, "body.figure.body")
        XCTAssertGreaterThanOrEqual(detail.frame.minX, figure.frame.maxX, "detail not beside the figure: \(detail.frame) vs \(figure.frame)")
        XCTAssertTrue(card.frame.contains(detail.frame), "detail outside the card: \(detail.frame)")
        assertOnScreen(app, detail, "detail")
        assertOnScreen(app, figure, "figure with a band open")
        // A tap on the figure picks the band under the finger (the torso is
        // water in this split); the same band again closes it.
        figure.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.45)).tap()
        XCTAssertTrue(detail.staticTexts["38.2"].waitForExistence(timeout: 3))
        figure.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.45)).tap()
        XCTAssertFalse(element(app, "body.figure.detail").waitForExistence(timeout: 1.5))
        XCTAssertTrue(element(app, "body.figure.legend.fat").waitForExistence(timeout: 2), "legend did not come back")
        // The legs are protein; the detail's close button brings the legend back.
        figure.coordinate(withNormalizedOffset: CGVector(dx: 0.38, dy: 0.72)).tap()
        XCTAssertTrue(detail.staticTexts["14.7"].waitForExistence(timeout: 3))
        detail.buttons["Close detail"].tap()
        XCTAssertTrue(element(app, "body.figure.legend.protein").waitForExistence(timeout: 2))
        XCTAssertFalse(element(app, "body.figure.detail").exists)
        // Fat is the outer layer: a tap on the shell (the torso's flank, or
        // just off the edge) opens fat, never the band at that height.
        figure.coordinate(withNormalizedOffset: CGVector(dx: 0.725, dy: 0.46)).tap()
        XCTAssertTrue(detail.staticTexts["15.2"].waitForExistence(timeout: 3), "shell tap did not open fat")
        figure.coordinate(withNormalizedOffset: CGVector(dx: 0.725, dy: 0.46)).tap()
        XCTAssertFalse(element(app, "body.figure.detail").waitForExistence(timeout: 1.5))
        figure.coordinate(withNormalizedOffset: CGVector(dx: 0.765, dy: 0.46)).tap()
        XCTAssertTrue(detail.staticTexts["15.2"].waitForExistence(timeout: 3), "a tap just off the edge did not open fat")
    }

    /// The same lean body at the goal's 15%: fat's own share, no goal
    /// outline (the body IS the goal).
    func testShellGoalDemo() throws {
        let app = launch("shell-goal", scroll: "figure")
        XCTAssertTrue(element(app, "body.figure").waitForExistence(timeout: 10))
        XCTAssertEqual(element(app, "body.figure.legend.fat").label, "Fat 9.9 kg, 15.0 percent of weight, calibrated to Xiaomi Home")
        XCTAssertEqual(element(app, "body.figure.legend.water").label.hasPrefix("Water 38.2 kg, 58.0 percent of weight"), true)
        XCTAssertFalse(element(app, "body.figure.ghost.note").exists)
        XCTAssertTrue(element(app, "body.figure.body").label.hasPrefix("Body composition, 65.9 kg: Fat 9.9 kg"))
    }

    func testFormulaFigureHasNoGap() throws {
        let app = launch("formula")
        XCTAssertTrue(element(app, "body.figure").waitForExistence(timeout: 10))
        // Formula values alone close on the weight: protein is their remainder.
        XCTAssertEqual(element(app, "body.figure.legend.unassigned").label, "Unassigned 0.0 kg, 0.0 percent of weight")
        XCTAssertEqual(element(app, "body.figure.legend.fat").label, "Fat 15.5 kg, 21.7 percent of weight, formula")
        // The outline follows the reading's own lean mass, whatever its basis.
        XCTAssertEqual(element(app, "body.figure.ghost.note").label, "Goal outline ~65.6 kg")
        element(app, "body.info.figure").tap()
        XCTAssertTrue(element(app, "body.infosheet.title").waitForExistence(timeout: 5))
        let text = sheetText(app)
        XCTAssertTrue(text.contains("today's 55.8 kg lean mass (S400, formula) = ~65.6 kg"), text)
    }

    func testTopSectionsOnScreen() throws {
        let app = launch("full", scroll: "latest")
        let latest = element(app, "body.latest")
        XCTAssertTrue(latest.waitForExistence(timeout: 10))
        Thread.sleep(forTimeInterval: 1.0)
        assertOnScreen(app, latest, "latest card")
        XCTAssertEqual(element(app, "body.latest.value").label, "Latest 71.3 kg, 21.4% fat (cal.), trend only")
        XCTAssertEqual(element(app, "body.avg7").label, "7-day average 71.6 kg over 7 readings")
        XCTAssertTrue(element(app, "body.trend").label.contains("\u{2212}0.7 kg vs the week before (72.3)"),
                      element(app, "body.trend").label)
        let spark = element(app, "body.sparkline")
        XCTAssertTrue(spark.exists)
        XCTAssertTrue(spark.label.contains("from 72.4 to 71.3 kg, change \u{2212}1.1 kg"), spark.label)
        // The open creatine window is flagged right by the trend (a chip;
        // VoiceOver reads the daemon's own words) and takes him to the windows.
        let hint = element(app, "body.trend.confounder")
        XCTAssertTrue(hint.exists)
        XCTAssertTrue(hint.label.contains("weight trend inflated"), hint.label)
        XCTAssertTrue(latest.frame.contains(hint.frame), "confounder hint outside the latest card")
        XCTAssertEqual(element(app, "body.latest.time").label, "S400 \u{00B7} 06:05")
        for id in ["body.latest.value", "body.avg7", "body.trend", "body.sparkline"] {
            XCTAssertTrue(latest.frame.contains(element(app, id).frame), "\(id) outside the latest card")
        }
    }

    func testGoalSectionOnScreen() throws {
        let app = launch("full", scroll: "goal")
        let goal = element(app, "body.goal")
        XCTAssertTrue(goal.waitForExistence(timeout: 10))
        Thread.sleep(forTimeInterval: 1.0)
        assertOnScreen(app, goal, "goal card")
        // The main number (today's lean mass, the same as the figure's
        // outline) and the scan's, each named by its lean mass, one line each.
        let primary = element(app, "body.goal.primary")
        let reference = element(app, "body.goal.reference")
        XCTAssertEqual(primary.label, "15% at today's lean mass (scale): ~65.9 kg")
        XCTAssertEqual(reference.label, "InBody Oct lean: 58.0 kg, ~68.2 kg at 15%")
        for (e, what) in [(primary, "primary"), (reference, "reference")] {
            XCTAssertTrue(goal.frame.contains(e.frame), "\(what) outside the goal card")
            XCTAssertLessThan(e.frame.height, 30, "\(what) wraps: \(e.frame)")
        }
        XCTAssertLessThan(primary.frame.minY, reference.frame.minY, "reference above the main number")
        let ms = element(app, "body.goal.milestone").label
        for v in ["70.0", "1.3"] {
            XCTAssertTrue(ms.contains(v), "\(v) missing in \(ms)")
        }
        XCTAssertFalse(ms.contains("68.2") || ms.contains("65.9"), ms)
        // The latest weight lives on the latest card only (one home per
        // number), the target is said once (the main line, no header repeat),
        // and the creatine variant and scan note sit in the (i) sheet.
        XCTAssertFalse(ms.contains("71.3"), ms)
        XCTAssertFalse(ms.contains("creatine"), ms)
        XCTAssertFalse(element(app, "body.goal.target").exists)
        XCTAssertFalse(element(app, "body.goal.note").exists)
        XCTAssertTrue(goal.frame.contains(element(app, "body.goal.milestone").frame), "stats outside the goal card")
    }

    func testConfoundersOnScreen() throws {
        let app = launch("full", scroll: "confounders")
        let section = element(app, "body.confounders")
        XCTAssertTrue(section.waitForExistence(timeout: 10))
        Thread.sleep(forTimeInterval: 1.0)
        assertOnScreen(app, section, "confounders")
        XCTAssertEqual(element(app, "body.baseline").label, "Baseline provisional")
        // Title and (i) inside the card, like every card.
        XCTAssertTrue(section.frame.contains(element(app, "body.info.confounders").frame))
        XCTAssertTrue(section.frame.contains(element(app, "body.baseline").frame))
        let creatine = element(app, "body.confounder.creatine_start")
        XCTAssertTrue(creatine.exists)
        // A human title, not the raw kind ("Creatine start").
        XCTAssertTrue(creatine.label.hasPrefix("Creatine"), creatine.label)
        XCTAssertFalse(creatine.label.contains("Creatine start"), creatine.label)
        XCTAssertTrue(creatine.label.contains("through ~"), creatine.label)
        XCTAssertTrue(creatine.label.contains("scale trend reads high"), creatine.label)
        let travel = element(app, "body.confounder.travel")
        XCTAssertTrue(travel.exists)
        XCTAssertTrue(travel.label.contains("closed"), travel.label)
    }

    func testHistoryPairsAndExclusions() throws {
        let app = launch("full", scroll: "history")
        let history = element(app, "body.history")
        XCTAssertTrue(history.waitForExistence(timeout: 10))
        Thread.sleep(forTimeInterval: 1.0)
        // ONE pair group, holding the S400 copy (counts) and the Xiaomi copy.
        let pairs = app.descendants(matching: .any).matching(identifier: "body.history.pair")
        XCTAssertEqual(pairs.count, 1)
        let pair = pairs.firstMatch
        assertOnScreen(app, pair, "pair group")
        let inPair = pair.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'body.history.row'"))
        XCTAssertEqual(inPair.count, 2)
        let labels = (0..<inPair.count).map { inPair.element(boundBy: $0).label }
        XCTAssertTrue(labels.contains { $0.contains("S400, counts") }, "\(labels)")
        XCTAssertTrue(labels.contains { $0.contains("Xiaomi, excluded: same weigh-in, other source") }, "\(labels)")
        for row in (0..<inPair.count).map({ inPair.element(boundBy: $0) }) {
            XCTAssertTrue(pair.frame.contains(row.frame), "pair row outside its group: \(row.frame)")
        }
        // Every exclusion reason the daemon sends, short and readable.
        let excluded = app.descendants(matching: .any).matching(identifier: "body.history.row.excluded")
        let reasons = (0..<excluded.count).map { excluded.element(boundBy: $0).label }
        for reason in ["test", "not a morning reading", "repeat", "after a meal", "possible other person",
                       "possible replay", "same weigh-in, other source"] {
            XCTAssertTrue(reasons.contains { $0.hasSuffix("excluded: \(reason)") }, "missing \(reason) in \(reasons)")
        }
        XCTAssertEqual(app.descendants(matching: .any).matching(identifier: "body.history.row").count, 12)
        // Someone else's weigh-in: date, source and reason, never numbers.
        let guest = reasons.first { $0.hasSuffix("excluded: possible other person") } ?? ""
        XCTAssertTrue(guest.contains("values hidden"), guest)
        XCTAssertFalse(guest.contains(" kg"), guest)
    }

    func testStaleAverageSaysHowOld() throws {
        let app = launch("stale")
        let avg = element(app, "body.avg7")
        XCTAssertTrue(avg.waitForExistence(timeout: 10))
        XCTAssertTrue(avg.label.contains(", up to "), avg.label)
        XCTAssertTrue(avg.label.contains("none since"), avg.label)
        XCTAssertFalse(element(app, "body.figure").exists) // day.body looks back 7 days only
    }

    func testUnreachableIsNotEmpty() throws {
        let app = launch("error")
        let card = element(app, "body.unavailable")
        XCTAssertTrue(card.waitForExistence(timeout: 10))
        assertOnScreen(app, card, "unavailable card")
        XCTAssertTrue(card.label.contains("Can't read body data"), card.label)
        XCTAssertTrue(card.label.contains("update the health plugin"), card.label)
        XCTAssertFalse(element(app, "body.empty").exists, "an unreachable daemon must not read as no weigh-ins")
    }

    /// xxxLarge text: the figure, its legend and the history rows still sit
    /// inside the screen's width (the type scale caps there).
    func testLargeTextHolds() throws {
        let app = XCUIApplication()
        app.launchEnvironment = ["HR_DEMO": "1", "HR_DEMO_TAB": "body", "HR_DEMO_BODY": "full"]
        app.launchArguments = ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryXXXL"]
        app.launch()
        let fig = element(app, "body.figure")
        XCTAssertTrue(fig.waitForExistence(timeout: 10))
        let screen = app.windows.firstMatch.frame
        for key in ["fat", "water", "protein", "mineral", "unassigned"] {
            let row = element(app, "body.figure.legend.\(key)")
            XCTAssertTrue(row.exists)
            XCTAssertTrue(fig.frame.contains(row.frame), "legend \(key) outside the card at xxxLarge: \(row.frame) vs \(fig.frame)")
            XCTAssertLessThanOrEqual(row.frame.maxX, screen.maxX)
        }
        XCTAssertGreaterThanOrEqual(fig.frame.minX, screen.minX)
        XCTAssertLessThanOrEqual(fig.frame.maxX, screen.maxX)
    }

    func testHistoryBottomClearOfTabBar() throws {
        let app = launch("full", scroll: "bottom")
        let history = element(app, "body.history")
        XCTAssertTrue(history.waitForExistence(timeout: 10))
        Thread.sleep(forTimeInterval: 1.0)
        let screen = app.windows.firstMatch.frame
        // Every row, wherever it sits, stays inside the screen's width (no
        // trailing kg column pushed off the edge).
        let rows = history.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'body.history.row'"))
        XCTAssertEqual(rows.count, 19)
        for i in 0..<rows.count {
            let f = rows.element(boundBy: i).frame
            XCTAssertGreaterThanOrEqual(f.minX, screen.minX, "row \(i) past the leading edge: \(f)")
            XCTAssertLessThanOrEqual(f.maxX, screen.maxX, "row \(i) past the trailing edge: \(f)")
        }
        // The last row ends above the floating tab bar at the bottom scroll.
        let last = rows.element(boundBy: rows.count - 1)
        let tabBar = app.tabBars.firstMatch
        if tabBar.exists {
            XCTAssertLessThanOrEqual(last.frame.maxY, tabBar.frame.minY, "last row under the tab bar: \(last.frame)")
        }
    }

    func testEmptyState() throws {
        let app = launch("empty")
        let empty = element(app, "body.empty")
        XCTAssertTrue(empty.waitForExistence(timeout: 10))
        assertOnScreen(app, empty, "empty card")
        XCTAssertFalse(element(app, "body.latest").exists)
        XCTAssertFalse(element(app, "body.goal").exists)
        XCTAssertFalse(element(app, "body.history").exists)
        XCTAssertEqual(element(app, "body.baseline").label, "Baseline collecting")
    }

    // ── helpers ──────────────────────────────────────────────────────

    private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
        app.descendants(matching: .any)[id].firstMatch
    }

    /// Every body line of the open (i) sheet, joined.
    private func sheetText(_ app: XCUIApplication) -> String {
        let lines = app.descendants(matching: .any).matching(identifier: "body.infosheet.line")
        return (0..<lines.count).map { lines.element(boundBy: $0).label }.joined(separator: " | ")
    }

    private func assertOnScreen(_ app: XCUIApplication, _ e: XCUIElement, _ what: String,
                                file: StaticString = #filePath, line: UInt = #line) {
        let screen = app.windows.firstMatch.frame
        XCTAssertTrue(screen.contains(e.frame), "\(what) off screen: \(e.frame) vs \(screen)", file: file, line: line)
        let tabBar = app.tabBars.firstMatch
        if tabBar.exists {
            XCTAssertLessThanOrEqual(e.frame.maxY, tabBar.frame.minY, "\(what) under the tab bar: \(e.frame) vs \(tabBar.frame)",
                                     file: file, line: line)
        }
    }

    private func launch(_ mode: String, scroll: String? = nil) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment = ["HR_DEMO": "1", "HR_DEMO_TAB": "body", "HR_DEMO_BODY": mode]
        if let scroll = scroll { app.launchEnvironment["HR_DEMO_BODY_SCROLL"] = scroll }
        app.launch()
        return app
    }
}
