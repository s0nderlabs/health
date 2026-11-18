// Lift clips, the file side: pick the ORIGINAL from Photos, read what it is,
// cut it without re-encoding.
//
// "Never a compressed copy" is the rule. Three places could break it, and
// each is closed here:
//  - the picker: PHPicker's default representation mode is .automatic, which
//    may hand over a transcoded H.264 copy of an HEVC clip. We ask for
//    .current (the asset's own bytes) and load the movie type the item itself
//    registered (com.apple.quicktime-movie for an iPhone .MOV).
//  - the trim: never UIVideoEditorController (it re-encodes). Our own
//    filmstrip picks the range, AVAssetExportSession with the PASSTHROUGH
//    preset writes it: samples are copied, never decoded, so resolution,
//    60 fps, HDR (Dolby Vision / HLG metadata) and bitrate are the camera's.
//    The keyframe question, measured (Nov 18 2026, simulator, HEVC with a
//    keyframe every 12 frames, start handle 4.3 s): the file's samples begin
//    at the keyframe before the handle (4.2 s), the frames before the handle
//    are flagged discard and an edit list starts playback at exactly 4.3 s
//    (ffprobe duration 5.7 s for a 4.3-10.0 cut, packets byte-identical to
//    the source). So playback is frame-accurate; the file just carries up to
//    one GOP of hidden lead-in. A tool that ignores edit lists would show
//    that lead-in.
//  - the full clip: uploaded as picked, byte for byte.

import AVFoundation
import Foundation
import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// What the phone knows about a picked clip before it is trimmed.
struct LiftClipInfo: Equatable {
    var duration: Double
    var fps: Double
    var width: Int
    var height: Int
    var codec: String
    var recordedAt: Date?
}

/// One clip picked from Photos, copied into the app's container (the picker's
/// own file vanishes when its callback returns).
struct PickedClip: Identifiable, Equatable {
    /// The upload's client_id from the start, so the files on disk and the
    /// daemon's idempotency key are one name.
    let id: String
    let source: URL
    let originalName: String
    let info: LiftClipInfo
}

enum LiftMedia {
    /// The daemon's rule, mirrored: a bare camera-roll name, never a path.
    static let namePattern = "^[A-Za-z0-9_-]{1,80}\\.(MOV|mov|MP4|mp4)$"

    static func validName(_ name: String) -> Bool {
        name.range(of: namePattern, options: .regularExpression) != nil
    }

    /// The picker's suggested name ("IMG_8946") plus the file's real
    /// extension. Anything outside the daemon's alphabet becomes "_", so an
    /// edited or AirDropped clip with spaces still uploads under a legal name.
    /// A suggested name that already carries a movie extension
    /// ("IMG_8946.MOV") loses it first: otherwise the dot would become "_"
    /// ("IMG_8946_MOV.MOV"), and both the trimmed name and the Mac's
    /// Syncthing dedupe would miss the camera's real name.
    static func originalName(suggested: String?, ext: String) -> String {
        let e = ["mov", "mp4"].contains(ext.lowercased()) ? ext : "MOV"
        var raw = (suggested ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if movieExtensions.contains((raw as NSString).pathExtension.lowercased()) {
            raw = (raw as NSString).deletingPathExtension
        }
        var stem = raw.replacingOccurrences(
            of: "[^A-Za-z0-9_-]", with: "_", options: .regularExpression)
        if stem.isEmpty { stem = "clip" }
        return String(stem.prefix(80)) + "." + e
    }

    /// Duration, frame rate, display size (rotation applied, so a portrait
    /// clip reads 1080x1920), codec, and the camera's creation date. The date
    /// comes from the file's own QuickTime metadata, so no Photos permission
    /// is needed.
    static func inspect(_ url: URL) async -> LiftClipInfo? {
        let asset = AVURLAsset(url: url)
        guard let duration = try? await asset.load(.duration),
              let track = try? await asset.loadTracks(withMediaType: .video).first
        else { return nil }
        let fps = (try? await track.load(.nominalFrameRate)) ?? 0
        let natural = (try? await track.load(.naturalSize)) ?? .zero
        let transform = (try? await track.load(.preferredTransform)) ?? .identity
        let shown = natural.applying(transform)
        let formats = (try? await track.load(.formatDescriptions)) ?? []
        let codec = formats.first.map { codecName(CMFormatDescriptionGetMediaSubType($0)) } ?? "unknown"
        var recorded: Date?
        if let item = try? await asset.load(.creationDate) {
            recorded = try? await item.load(.dateValue)
        }
        return LiftClipInfo(
            duration: duration.seconds.isFinite ? duration.seconds : 0,
            fps: Double(fps),
            width: Int(abs(shown.width).rounded()),
            height: Int(abs(shown.height).rounded()),
            codec: codec,
            recordedAt: recorded)
    }

    static let movieExtensions: Set<String> = ["mov", "mp4", "m4v", "qt"]

    /// The daemon's codec rule (parseLiftMeta), mirrored: anything else is a
    /// 400 and a clip refused for good.
    static let codecPattern = "^[A-Za-z0-9.]{2,16}$"

    static func codecName(_ fourcc: FourCharCode) -> String {
        switch fourcc {
        case kCMVideoCodecType_HEVC, kCMVideoCodecType_HEVCWithAlpha, 0x6865_7631: return "hevc" // hvc1, muxa, hev1
        // Dolby Vision profile 8.4 (iPhone HDR) rides on HEVC: dvh1, dvhe.
        case 0x6476_6831, 0x6476_6865: return "hevc"
        case kCMVideoCodecType_H264, 0x6176_6333: return "h264" // avc1, avc3
        case 0x6476_6131, 0x6476_6176: return "h264" // dva1, dvav (Dolby Vision on AVC)
        case kCMVideoCodecType_AppleProRes422, kCMVideoCodecType_AppleProRes4444,
             kCMVideoCodecType_AppleProRes422HQ, kCMVideoCodecType_AppleProRes422LT: return "prores"
        default:
            let bytes = [24, 16, 8, 0].map { UInt8((fourcc >> $0) & 0xFF) }
            let name = String(decoding: bytes, as: UTF8.self).trimmingCharacters(in: .whitespaces).lowercased()
            // A space, a NUL or anything outside the daemon's alphabet.
            return name.range(of: codecPattern, options: .regularExpression) != nil ? name : "unknown"
        }
    }

    /// The cut: samples copied, nothing decoded (see the header). `done` on
    /// main with the written file's size, or the error text.
    static func exportTrim(source: URL, to out: URL, start: Double, end: Double,
                           done: @escaping (Result<Int64, Error>) -> Void) {
        let asset = AVURLAsset(url: source)
        try? FileManager.default.removeItem(at: out)
        guard let session = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetPassthrough) else {
            return DispatchQueue.main.async { done(.failure(LiftError("passthrough export unavailable"))) }
        }
        session.outputURL = out
        session.outputFileType = out.pathExtension.lowercased() == "mp4" ? .mp4 : .mov
        session.timeRange = CMTimeRange(
            start: CMTime(seconds: start, preferredTimescale: 600),
            end: CMTime(seconds: end, preferredTimescale: 600))
        // HDR travels in the track format descriptions, which passthrough
        // copies as is. The recording time goes in X-Lift-Meta regardless.
        session.shouldOptimizeForNetworkUse = false
        session.exportAsynchronously {
            let result: Result<Int64, Error>
            if session.status == .completed {
                result = .success(fileSize(out))
            } else {
                try? FileManager.default.removeItem(at: out)
                result = .failure(session.error ?? LiftError("export \(session.status.rawValue)"))
            }
            DispatchQueue.main.async { done(result) }
        }
    }

    static func fileSize(_ url: URL) -> Int64 {
        ((try? FileManager.default.attributesOfItem(atPath: url.path))?[.size] as? NSNumber)?.int64Value ?? 0
    }

    /// A small poster JPEG for a queue row (the frame at `at`).
    static func poster(_ url: URL, at: Double, to out: URL) async {
        let gen = AVAssetImageGenerator(asset: AVURLAsset(url: url))
        gen.appliesPreferredTrackTransform = true
        gen.maximumSize = CGSize(width: 240, height: 240)
        guard let image = try? await gen.image(at: CMTime(seconds: at, preferredTimescale: 600)).image,
              let jpeg = UIImage(cgImage: image).jpegData(compressionQuality: 0.7)
        else { return }
        try? jpeg.write(to: out, options: .atomic)
    }
}

struct LiftError: LocalizedError {
    let text: String
    init(_ text: String) { self.text = text }
    var errorDescription: String? { text }
}

/// PHPicker for videos, multi-select, in pick order, asking for the CURRENT
/// representation (see the header). Runs out of process: no Photos
/// permission prompt, no usage string.
struct LiftVideoPicker: UIViewControllerRepresentable {
    var done: ([PHPickerResult]) -> Void

    func makeUIViewController(context: Context) -> PHPickerViewController {
        var config = PHPickerConfiguration()
        config.filter = .videos
        config.selectionLimit = 0
        config.selection = .ordered
        config.preferredAssetRepresentationMode = .current
        let picker = PHPickerViewController(configuration: config)
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ vc: PHPickerViewController, context: Context) {}
    func makeCoordinator() -> Coordinator { Coordinator(done: done) }

    final class Coordinator: NSObject, PHPickerViewControllerDelegate {
        let done: ([PHPickerResult]) -> Void
        init(done: @escaping ([PHPickerResult]) -> Void) { self.done = done }
        func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
            done(results)
        }
    }
}

extension LiftMedia {
    /// Every picked result copied into the container and inspected, IN PICK
    /// ORDER. A result that fails (iCloud original not downloadable, not a
    /// movie) is skipped and counted.
    static func load(_ results: [PHPickerResult], into dir: URL) async -> (clips: [PickedClip], failed: Int) {
        var clips: [PickedClip] = []
        var failed = 0
        for r in results {
            if let clip = await load(r, into: dir) { clips.append(clip) } else { failed += 1 }
        }
        return (clips, failed)
    }

    private static func load(_ result: PHPickerResult, into dir: URL) async -> PickedClip? {
        let provider = result.itemProvider
        // The item's OWN movie type first (the original container), never a
        // generic type the system would have to convert to.
        let type = provider.registeredTypeIdentifiers.first {
            UTType($0)?.conforms(to: .movie) == true
        } ?? UTType.movie.identifier
        let suggested = provider.suggestedName
        let id = UUID().uuidString
        let copied: URL? = await withCheckedContinuation { cont in
            provider.loadFileRepresentation(forTypeIdentifier: type) { url, _ in
                guard let url = url else { return cont.resume(returning: nil) }
                let ext = url.pathExtension.isEmpty ? "MOV" : url.pathExtension
                let dest = dir.appendingPathComponent("\(id)-src.\(ext)")
                do {
                    try? FileManager.default.removeItem(at: dest)
                    // Same volume as the picker's temp file: usually a clone,
                    // so a 1 GB clip costs no time and no extra space.
                    try FileManager.default.copyItem(at: url, to: dest)
                    cont.resume(returning: dest)
                } catch {
                    rlog("lift: copy of picked clip failed: \(error.localizedDescription)")
                    cont.resume(returning: nil)
                }
            }
        }
        guard let src = copied else { return nil }
        guard let info = await inspect(src) else {
            try? FileManager.default.removeItem(at: src)
            return nil
        }
        return PickedClip(id: id, source: src,
                          originalName: originalName(suggested: suggested, ext: src.pathExtension),
                          info: info)
    }
}
