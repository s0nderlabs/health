// Simulator-only lift-clip states for screenshots and UI tests (HR_DEMO=1):
//   HR_DEMO_LIFT=card|queue|uploaded|failed|states|empty  the card's rows
//   HR_DEMO_LIFT_PREPARING=1                      "Getting the original from Photos…"
//   HR_DEMO_LIFT_PICK=1                           Add opens a stand-in picker (UI tests)
//   HR_DEMO_LIFT_CUTTING=1                        Send stays on "Cutting…"
//   HR_DEMO_LIFT_POSTERS=<dir on the Mac>         poster-1.jpg... for the rows
//   HR_DEMO_LIFT_TRIM=<clip path on the Mac>      opens the trim sheet on it
//   HR_DEMO_LIFT_TRIM_RANGE=<start>,<end>         its initial handles
//   HR_DEMO_LIFT_TRIM_N=<n>                       "Clip 1 of n"
// All synthetic: made-up names, sizes from Apple's 1080p60 HEVC rate
// (~100 MB a minute), times on today's date.

#if DEBUG
import AVFoundation
import Foundation
import UIKit

enum DemoLift {
    static func clips(_ mode: String) -> [LiftClip] {
        func at(_ h: Int, _ m: Int) -> Date {
            Calendar.current.date(bySettingHour: h, minute: m, second: 0, of: Date()) ?? Date()
        }
        func mb(_ seconds: Double) -> Int64 { Int64(seconds * 1_670_000) }
        var n = 0
        func clip(_ name: String, _ rec: Date, _ dur: Double, _ s: Double, _ e: Double,
                  _ state: LiftClip.State, sent: Double = 0, dedupe: String? = nil, err: String? = nil,
                  stalled: Bool = false, held: Bool = false, cutFailed: Bool = false) -> LiftClip {
            n += 1
            let full = s == 0 && e == dur
            let bytes = mb(e - s)
            var c = LiftClip(id: "demo-\(n)", originalName: name, recordedAt: rec, originalDuration: dur,
                             trimStart: s, trimEnd: e, fullClip: full, fps: 60, width: 1920, height: 1080,
                             codec: "hevc", addedAt: rec, file: nil, poster: poster(n), bytes: bytes, state: state)
            c.sent = Int64(Double(bytes) * sent)
            c.dedupe = dedupe
            c.lastError = err
            if state == .done {
                c.doneAt = rec.addingTimeInterval(600)
                let day = FoodFormat.dayParser.string(from: rec)
                let file = full ? name : "\(c.stem)_trim_\(LiftFormat.s(s))-\(LiftFormat.s(e))s.MOV"
                c.macPath = "/Users/you/Pictures/lift/\(day)/Video/\(file)"
            }
            if state == .failed { c.attempts = 2 }
            c.stalled = stalled
            c.heldInBackground = held
            if state == .queued || state == .uploading || state == .failed { c.file = "demo-\(n).MOV" }
            if cutFailed {
                c.file = nil
                c.source = "demo-\(n)-src.MOV"
                c.cutAttempts = LiftStore.maxAutoCuts
            }
            return c
        }
        switch mode {
        case "queue":
            return [
                clip("IMG_8946", at(15, 12), 58.2, 12.3, 41.0, .uploading, sent: 0.62),
                clip("IMG_8949", at(15, 24), 21.4, 0, 21.4, .uploading, sent: 0.21),
                clip("IMG_8951", at(15, 37), 33.9, 3.0, 27.5, .queued),
            ]
        case "uploaded":
            return [
                clip("IMG_8940", at(14, 41), 40.3, 4.0, 31.6, .done),
                clip("IMG_8937", at(14, 26), 18.9, 0, 18.9, .done, dedupe: "syncthing"),
                clip("IMG_8933", at(14, 9), 26.0, 2.2, 24.8, .done),
            ]
        case "failed":
            return [
                clip("IMG_8946", at(15, 12), 58.2, 12.3, 41.0, .failed, err: "The network connection was lost"),
                clip("IMG_8940", at(14, 41), 40.3, 4.0, 31.6, .done),
            ]
        case "states":
            // Every row that is not plain progress, for review frames.
            return [
                clip("IMG_8946", at(15, 12), 58.2, 12.3, 41.0, .queued, stalled: true),
                clip("IMG_8949", at(15, 24), 21.4, 0, 21.4, .queued, held: true),
                clip("IMG_8951", at(15, 37), 33.9, 3.0, 27.5, .failed, err: "The network connection was lost"),
                clip("IMG_8953", at(15, 44), 40.0, 6.0, 30.0, .failed,
                     err: "Cut failed: The operation was interrupted", cutFailed: true),
            ]
        case "empty":
            return []
        default: // card: the mid-session mix
            return [
                clip("IMG_8946", at(15, 12), 58.2, 12.3, 41.0, .uploading, sent: 0.62),
                clip("IMG_8940", at(14, 41), 40.3, 4.0, 31.6, .done),
                clip("IMG_8937", at(14, 26), 18.9, 0, 18.9, .done, dedupe: "syncthing"),
            ]
        }
    }

    /// A 10 s, 320x180, 30 fps H.264 clip written once with AVAssetWriter:
    /// a slow colour sweep with a moving bar, so the filmstrip and preview
    /// visibly change along the timeline. For UI tests (HR_DEMO_LIFT_TRIM=synthetic).
    static func syntheticClip() async -> URL? {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("IMG_0001.MOV")
        if FileManager.default.fileExists(atPath: url.path) { return url }
        let tmp = url.deletingLastPathComponent().appendingPathComponent("IMG_0001-writing.MOV")
        try? FileManager.default.removeItem(at: tmp)
        let w = 320, h = 180, fps: Int32 = 30, frames = 300
        guard let writer = try? AVAssetWriter(outputURL: tmp, fileType: .mov) else { return nil }
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: w, AVVideoHeightKey: h,
        ])
        input.expectsMediaDataInRealTime = false
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: w, kCVPixelBufferHeightKey as String: h,
        ])
        writer.add(input)
        guard writer.startWriting() else { return nil }
        writer.startSession(atSourceTime: .zero)
        for i in 0..<frames {
            while !input.isReadyForMoreMediaData { try? await Task.sleep(nanoseconds: 2_000_000) }
            guard let pool = adaptor.pixelBufferPool else { return nil }
            var buf: CVPixelBuffer?
            CVPixelBufferPoolCreatePixelBuffer(nil, pool, &buf)
            guard let pb = buf else { return nil }
            CVPixelBufferLockBaseAddress(pb, [])
            if let base = CVPixelBufferGetBaseAddress(pb) {
                let row = CVPixelBufferGetBytesPerRow(pb)
                let p = base.assumingMemoryBound(to: UInt8.self)
                let f = Double(i) / Double(frames)
                let bar = Int(f * Double(w))
                for y in 0..<h {
                    for x in 0..<w {
                        let o = y * row + x * 4
                        let onBar = abs(x - bar) < 5
                        p[o] = onBar ? 240 : UInt8(60 + 120 * f) // B
                        p[o + 1] = onBar ? 240 : UInt8(50 + 60 * Double(y) / Double(h)) // G
                        p[o + 2] = onBar ? 240 : UInt8(170 - 110 * f) // R
                        p[o + 3] = 255
                    }
                }
            }
            CVPixelBufferUnlockBaseAddress(pb, [])
            adaptor.append(pb, withPresentationTime: CMTime(value: CMTimeValue(i), timescale: fps))
        }
        input.markAsFinished()
        await writer.finishWriting()
        guard writer.status == .completed else { return nil }
        try? FileManager.default.moveItem(at: tmp, to: url)
        return url
    }

    /// Copies poster-<n>.jpg from HR_DEMO_LIFT_POSTERS into the container
    /// (or draws a plain stand-in) and returns its name.
    private static func poster(_ n: Int) -> String {
        let name = "demo-poster-\(n).jpg"
        let out = LiftStore.url(name)
        try? FileManager.default.createDirectory(at: LiftStore.dir, withIntermediateDirectories: true)
        if let dir = ProcessInfo.processInfo.environment["HR_DEMO_LIFT_POSTERS"],
           let data = try? Data(contentsOf: URL(fileURLWithPath: dir).appendingPathComponent("poster-\(n).jpg")) {
            try? data.write(to: out, options: .atomic)
        } else {
            let img = UIGraphicsImageRenderer(size: CGSize(width: 144, height: 144)).image { ctx in
                UIColor(white: 0.16 + CGFloat(n % 3) * 0.04, alpha: 1).setFill()
                ctx.fill(CGRect(x: 0, y: 0, width: 144, height: 144))
            }
            try? img.jpegData(compressionQuality: 0.8)?.write(to: out, options: .atomic)
        }
        return name
    }
}
#endif
