// The audible rest-over cue, two delivery paths. In the foreground the
// bundled sample plays through a playback session, because the mute switch
// (on, in every gym) silences notification sounds but not playback audio;
// music ducks for the chime instead of stopping. Locked or backgrounded,
// the same sample rides the rest-over notification at ringer volume.

import AVFoundation
import UIKit
import UserNotifications

enum RestChime {
    private static let resource = "rest-over"
    private static var player: AVAudioPlayer?

    private static var url: URL? {
        Bundle.main.url(forResource: resource, withExtension: "wav")
    }

    /// The notification's sound: the bundled sample, or the system default
    /// if the resource ever goes missing rather than a silent notification.
    static var notificationSound: UNNotificationSound {
        url == nil
            ? .default
            : UNNotificationSound(named: UNNotificationSoundName("\(resource).wav"))
    }

    /// Foreground chime + haptic.
    static func play() {
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        guard let url = url else { return }
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, options: [.duckOthers])
        try? session.setActive(true)
        guard let chime = try? AVAudioPlayer(contentsOf: url) else {
            try? session.setActive(false, options: [.notifyOthersOnDeactivation])
            return
        }
        player = chime
        chime.play()
        // Hand the audio session back once the tail rings out, so ducked
        // music returns to full volume instead of staying quiet.
        DispatchQueue.main.asyncAfter(deadline: .now() + chime.duration + 0.2) {
            player = nil
            try? session.setActive(false, options: [.notifyOthersOnDeactivation])
        }
    }
}
