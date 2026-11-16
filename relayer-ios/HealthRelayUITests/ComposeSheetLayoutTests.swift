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
