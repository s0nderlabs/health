// Pins the Food tab's New meal sheet geometry with the keyboard up (Nov 16
// 2026 bug: a photo wider than its box made the whole sheet wider than the
// screen, so the note field's leading edge, Cancel and Send went off screen,
// the header hid under the top inset and the hint hid under the keyboard).
// Runs on the simulator in demo mode; no network, no signing.

import XCTest
import UIKit

final class ComposeSheetLayoutTests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    func testLandscapePhotoKeepsSheetOnScreen() throws { try check(photo: CGSize(width: 1600, height: 1200)) }
    func testPortraitPhotoKeepsSheetOnScreen() throws { try check(photo: CGSize(width: 1176, height: 1568)) }
    func testVeryWidePhotoKeepsSheetOnScreen() throws { try check(photo: CGSize(width: 2400, height: 800)) }

    private func check(photo size: CGSize) throws {
        let dir = try photoDir(size)
        let app = XCUIApplication()
        app.launchEnvironment = [
            "HR_DEMO": "1",
            "HR_DEMO_TAB": "food",
            "HR_DEMO_FOOD": "baseline",
            "HR_DEMO_FOOD_SHEET": "compose",
            "HR_DEMO_FOOD_NOTE": "small",
            "HR_DEMO_FOOD_PHOTOS": dir,
        ]
        app.launch()

        let note = app.descendants(matching: .any)["compose.note"].firstMatch
        let title = app.staticTexts["compose.title"].firstMatch
        let hint = app.staticTexts["compose.hint"].firstMatch
        XCTAssertTrue(note.waitForExistence(timeout: 10), "note field never appeared")
        // The keyboard is only on screen when the simulator's hardware
        // keyboard is disconnected; the horizontal and header checks do not
        // need it, the keyboard checks are skipped (loudly) without it.
        let keyboardUp = app.keyboards.firstMatch.waitForExistence(timeout: 10)
        // Let the photo-shrink animation and keyboard avoidance settle.
        Thread.sleep(forTimeInterval: 1.0)

        let screen = app.windows.firstMatch.frame

        // (1) The field sits inside the screen with a real inset on both sides.
        XCTAssertGreaterThanOrEqual(note.frame.minX, 8, "note field runs off the leading edge: \(note.frame)")
        XCTAssertLessThanOrEqual(note.frame.maxX, screen.maxX - 8, "note field runs off the trailing edge: \(note.frame)")
        XCTAssertEqual((note.value as? String) ?? "", "small")

        // (2) The header is fully visible below the status bar, buttons included.
        XCTAssertTrue(title.exists)
        XCTAssertGreaterThanOrEqual(title.frame.minY, 40, "header is under the top inset: \(title.frame)")
        for label in ["Cancel", "Send"] {
            let b = app.buttons[label].firstMatch
            XCTAssertTrue(b.exists, "\(label) missing")
            XCTAssertGreaterThanOrEqual(b.frame.minX, 0, "\(label) off screen: \(b.frame)")
            XCTAssertLessThanOrEqual(b.frame.maxX, screen.maxX, "\(label) off screen: \(b.frame)")
            XCTAssertTrue(b.isHittable, "\(label) is covered (photo overflow swallowing taps?)")
        }

        // (3) Field and hint stay above the keyboard.
        guard keyboardUp else {
            throw XCTSkip("no software keyboard (Simulator > I/O > Keyboard > Connect Hardware Keyboard is on); keyboard checks skipped")
        }
        let keyboard = app.keyboards.firstMatch.frame
        XCTAssertLessThanOrEqual(note.frame.maxY, keyboard.minY, "field under the keyboard")
        XCTAssertTrue(hint.exists)
        XCTAssertLessThanOrEqual(hint.frame.maxY, keyboard.minY, "hint under the keyboard: \(hint.frame) vs \(keyboard)")
    }

    /// A one-photo demo directory with a solid JPEG of the given pixel size.
    private func photoDir(_ size: CGSize) throws -> String {
        let dir = (NSTemporaryDirectory() as NSString).appendingPathComponent("compose-\(Int(size.width))x\(Int(size.height))")
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let img = UIGraphicsImageRenderer(size: size, format: format).image { ctx in
            UIColor.systemOrange.setFill()
            ctx.fill(CGRect(origin: .zero, size: size))
        }
        let data = try XCTUnwrap(img.jpegData(compressionQuality: 0.6))
        try data.write(to: URL(fileURLWithPath: (dir as NSString).appendingPathComponent("photo.jpg")))
        return dir
    }
}

// Pins the multi-photo meal (Nov 18 2026): the gallery is one tap beside the
// camera; a meal carries up to six photos, the first its cover; the compose
// strip shows every photo with a remove and an add tile until the cap, all on
// screen at once; Cancel asks before throwing away two or more; the list
// badges a multi-photo meal; the detail pages through every photo.
// Synthetic plates only (drawn in the app), never the photo library.
final class FoodMultiPhotoTests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    private func launch(_ extra: [String: String] = [:]) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment = ["HR_DEMO": "1", "HR_DEMO_TAB": "food", "HR_DEMO_FOOD": "baseline"].merging(extra) { $1 }
        app.launch()
        return app
    }

    private func el(_ app: XCUIApplication, _ id: String) -> XCUIElement { app.descendants(matching: .any)[id].firstMatch }

    func testCaptureRowHasCameraAndLibrary() throws {
        let app = launch()
        let camera = el(app, "food.capture.camera"), library = el(app, "food.capture.library")
        XCTAssertTrue(camera.waitForExistence(timeout: 10))
        XCTAssertTrue(library.exists, "no one-tap library button")
        XCTAssertTrue(camera.isHittable && library.isHittable)
        XCTAssertEqual(library.label, "Choose from library")
        // Side by side, then the quick-text field still has room to type.
        XCTAssertGreaterThan(library.frame.minX, camera.frame.maxX)
        let field = app.textFields.firstMatch
        XCTAssertGreaterThanOrEqual(field.frame.minX, library.frame.maxX)
        XCTAssertGreaterThanOrEqual(field.frame.width, 130, "quick field squeezed: \(field.frame)")
        XCTAssertLessThanOrEqual(field.frame.maxX, app.windows.firstMatch.frame.maxX - 8)
    }

    func testComposeThreeThenRemove() throws {
        let app = launch(["HR_DEMO_FOOD_SHEET": "compose", "HR_DEMO_FOOD_COMPOSE_N": "3"])
        let count = el(app, "compose.count")
        XCTAssertTrue(count.waitForExistence(timeout: 10))
        XCTAssertEqual(count.label, "3 of 6")
        for i in 0..<3 { XCTAssertTrue(el(app, "compose.thumb.\(i)").exists, "thumb \(i)") }
        XCTAssertEqual(el(app, "compose.thumb.0").label, "Photo 1, cover")
        XCTAssertTrue(el(app, "compose.add").exists, "no add tile under the cap")
        // A tap on a thumb shows THAT photo big; removing it shows its neighbour.
        XCTAssertEqual(el(app, "compose.photo").value as? String, "1 of 3")
        el(app, "compose.thumb.1").tap()
        XCTAssertEqual(el(app, "compose.photo").value as? String, "2 of 3")
        el(app, "compose.remove.1").tap()
        XCTAssertTrue(NSPredicate(format: "label == '2 of 6'").evaluate(with: count) || {
            Thread.sleep(forTimeInterval: 0.6); return count.label == "2 of 6"
        }(), "count after remove: \(count.label)")
        XCTAssertFalse(el(app, "compose.thumb.2").exists)
        XCTAssertEqual(el(app, "compose.photo").value as? String, "2 of 2")
        // Two left: Cancel asks first, and Keep editing keeps them.
        app.buttons["Cancel"].tap()
        let discard = app.buttons["Discard 2 photos"]
        XCTAssertTrue(discard.waitForExistence(timeout: 3), "Cancel did not ask before discarding 2 photos")
        // The cancel action shows as a button on some iOS versions; on others
        // a tap outside the dialog is the way back.
        if app.buttons["Keep editing"].exists { app.buttons["Keep editing"].tap() } else {
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.12)).tap()
        }
        XCTAssertFalse(discard.waitForExistence(timeout: 1.5) && discard.isHittable, "dialog did not close")
        XCTAssertTrue(el(app, "compose.title").waitForExistence(timeout: 2))
        XCTAssertEqual(count.label, "2 of 6")
    }

    func testComposeAtCapHidesAddAndFits() throws {
        let app = launch(["HR_DEMO_FOOD_SHEET": "compose", "HR_DEMO_FOOD_COMPOSE_N": "6"])
        let count = el(app, "compose.count")
        XCTAssertTrue(count.waitForExistence(timeout: 10))
        XCTAssertEqual(count.label, "6 of 6")
        XCTAssertFalse(el(app, "compose.add").exists, "add tile shown at the cap")
        let screen = app.windows.firstMatch.frame
        for i in 0..<6 {
            let t = el(app, "compose.thumb.\(i)")
            XCTAssertTrue(t.exists, "thumb \(i)")
            XCTAssertLessThanOrEqual(t.frame.maxX, screen.maxX - 8, "thumb \(i) off screen: \(t.frame)")
            XCTAssertTrue(el(app, "compose.remove.\(i)").isHittable, "remove \(i) not tappable")
        }
        // One out, and the add tile comes back.
        el(app, "compose.remove.5").tap()
        XCTAssertTrue(el(app, "compose.add").waitForExistence(timeout: 2))
        XCTAssertEqual(count.label, "5 of 6")
        XCTAssertTrue(app.buttons["Send"].isEnabled)
    }

    func testListBadgesMultiPhotoMeal() throws {
        let app = launch()
        let badge = el(app, "meal.photocount")
        XCTAssertTrue(badge.waitForExistence(timeout: 10), "no photo-count badge on the 3-photo meal")
        // VoiceOver reads the count first, as part of the meal's row.
        XCTAssertTrue(badge.label.hasPrefix("3 photos, Nasi + ayam goreng"), badge.label)
        // Only multi-photo meals carry it, each with its own count (the row
        // and the badge may both answer to the id); never the one-photo soto.
        for b in app.descendants(matching: .any).matching(identifier: "meal.photocount").allElementsBoundByIndex {
            let ok = b.label.hasPrefix("3 photos, Nasi") || b.label.hasPrefix("2 photos, Dirty latte") || b.label == "3 photos" || b.label == "2 photos"
            XCTAssertTrue(ok, "unexpected badge: \(b.label)")
            XCTAssertFalse(b.label.contains("soto"), "badge on a single-photo meal: \(b.label)")
        }
    }

    func testDetailPagesThroughPhotos() throws {
        let app = launch(["HR_DEMO_FOOD_SHEET": "detail", "HR_DEMO_FOOD_MEAL": "2", "HR_DEMO_FOOD_PAGE": "1"])
        let page = el(app, "detail.page")
        XCTAssertTrue(page.waitForExistence(timeout: 10))
        XCTAssertEqual(page.label, "2 / 3")
        el(app, "detail.photo.1").swipeLeft()
        XCTAssertTrue(NSPredicate(format: "label == '3 / 3'").evaluate(with: page) || {
            Thread.sleep(forTimeInterval: 0.8); return page.label == "3 / 3"
        }(), "swipe did not page: \(page.label)")
        // A tap opens the photo full screen; Done closes it.
        el(app, "detail.photo.2").tap()
        let done = app.buttons["Done"]
        XCTAssertTrue(done.waitForExistence(timeout: 3), "tap did not open the full photo")
        done.tap()
        XCTAssertTrue(page.waitForExistence(timeout: 3))
    }

    // ── add photos to a logged meal ────────────────────────────────

    func testDetailAddPhotoShowsRoomAndSending() throws {
        let app = launch(["HR_DEMO_FOOD_SHEET": "detail", "HR_DEMO_FOOD_MEAL": "1"])
        let add = el(app, "detail.addphoto")
        XCTAssertTrue(add.waitForExistence(timeout: 10), "no Add photo on a logged meal")
        XCTAssertTrue(add.isHittable)
        XCTAssertEqual(el(app, "detail.photocount").label, "2 of 6")
        XCTAssertFalse(el(app, "detail.sending").exists)
        app.terminate()
        // Two photos queued for the same meal: said in the detail and counted
        // against the six, and on the meal's row in the list.
        let queued = launch(["HR_DEMO_FOOD_SHEET": "detail", "HR_DEMO_FOOD_MEAL": "1", "HR_DEMO_FOOD_QUEUED": "add"])
        let sending = el(queued, "detail.sending")
        XCTAssertTrue(sending.waitForExistence(timeout: 10), "no sending state in the detail")
        XCTAssertEqual(sending.label, "2 photos sending")
        XCTAssertEqual(el(queued, "detail.photocount").label, "4 of 6")
    }

    // ── history ───────────────────────────────────────────────────

    func testHistoryFromHeaderAndDayIsReadOnly() throws {
        let app = launch()
        let button = el(app, "food.history")
        XCTAssertTrue(button.waitForExistence(timeout: 10), "no history button in the Food header")
        XCTAssertEqual(button.label, "Meal history")
        button.tap()
        XCTAssertTrue(app.navigationBars["History"].waitForExistence(timeout: 5))
        let rows = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'history.day.'"))
        XCTAssertTrue(rows.firstMatch.waitForExistence(timeout: 5))
        XCTAssertTrue(rows.firstMatch.label.hasPrefix("Yesterday"), rows.firstMatch.label)
        // Past days only: today lives on the Food tab, never read-only here.
        XCTAssertFalse(el(app, "history.day.\(foodToday())").exists, "history lists today")
        XCTAssertFalse(el(app, "history.stale").exists, "stale line on a fresh list")
        // The second row's kcal is exactly what its day adds up to.
        let row = rows.element(boundBy: 1)
        let kcal = try XCTUnwrap(firstKcal(row.label), row.label)
        row.tap()
        let summary = el(app, "history.summary")
        XCTAssertTrue(summary.waitForExistence(timeout: 5), "day did not open")
        XCTAssertEqual(firstKcal(summary.label), kcal, "row \(row.label) vs day \(summary.label)")
        // A past meal opens read-only: the photo pager, no fix, no adding.
        let meal = app.buttons.matching(NSPredicate(format: "label CONTAINS 'Kopi susu'")).firstMatch
        XCTAssertTrue(meal.waitForExistence(timeout: 3))
        meal.tap()
        XCTAssertTrue(el(app, "detail.photo.0").waitForExistence(timeout: 5), "past meal detail has no photo")
        XCTAssertFalse(el(app, "detail.addphoto").exists, "past meal offers Add photo")
        XCTAssertFalse(app.staticTexts["FIX"].exists, "past meal offers a fix")
    }

    /// A daemon from before the past-days-only change also sent today: the
    /// phone drops it, so the list still starts at Yesterday.
    func testHistoryNeverListsToday() throws {
        let app = launch(["HR_DEMO_FOOD_SHEET": "history", "HR_DEMO_FOOD_HISTORY_TODAY": "1"])
        XCTAssertTrue(app.navigationBars["History"].waitForExistence(timeout: 10))
        let rows = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'history.day.'"))
        XCTAssertTrue(rows.firstMatch.waitForExistence(timeout: 5))
        XCTAssertTrue(rows.firstMatch.label.hasPrefix("Yesterday"), rows.firstMatch.label)
        XCTAssertFalse(el(app, "history.day.\(foodToday())").exists, "today listed (and openable read-only)")
    }

    /// The app's food day: the date 4 hours ago (04:00 rollover), local zone.
    private func foodToday() -> String {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.locale = Locale(identifier: "en_US_POSIX")
        return f.string(from: Date().addingTimeInterval(-4 * 3600))
    }

    private func firstKcal(_ label: String) -> String? {
        guard let r = label.range(of: "\\d,\\d{3}", options: .regularExpression) else { return nil }
        return String(label[r])
    }
}
