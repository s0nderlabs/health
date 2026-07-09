// The End button on the session face. Demotes the card back to the pulse
// face instead of killing it: the session is over, but the band may still be
// streaming and the lock screen should keep saying so.

import ActivityKit
import AppIntents
import Foundation

struct EndSessionIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "End session"

    func perform() async throws -> some IntentResult {
        for activity in Activity<PulseAttributes>.activities {
            var state = activity.content.state
            state.sessionActive = false
            state.startedAt = nil
            state.title = "Live"
            state.planLine = nil
            state.restEndsAt = nil
            state.restLabel = nil
            await activity.update(ActivityContent(state: state, staleDate: nil))
        }
        // LiveActivityIntent runs in the app's process: tell the controller
        // so its authoritative state and the session machine follow suit.
        NotificationCenter.default.post(name: Notification.Name("hr.session.ended"), object: nil)
        return .result()
    }
}
