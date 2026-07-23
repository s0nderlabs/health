// The one Live Activity, two faces. Compiled into BOTH the app and the
// widget extension: the app starts/updates it, the extension renders it.
//
// PULSE face (sessionActive == false): quiet BPM row, any time this phone is
// the band's receiver. SESSION face (sessionActive == true): plan title, a
// timer iOS ticks natively, BPM + zone, the plan line, an End button.

import ActivityKit
import Foundation

struct PulseAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        var bpm: Int?
        var zone: Int?
        var sessionActive: Bool
        var startedAt: Date?
        var title: String
        var planLine: String?
        var stateLine: String
        /// Rest countdown between sets: iOS renders the ticking text natively,
        /// so a locked phone counts your rest with zero updates from us.
        var restEndsAt: Date?
        var restLabel: String?
    }
}

enum HrZones {
    /// Mirrors the daemon's canonical numbers (WHOOP profile max HR raised by
    /// any higher observed workout max; rolling 7-day median resting HR) for
    /// zone math. The daemon owns the real values; these are display-only and
    /// synced by hand until the socket carries them.
    static let maxHr = 187.0
    static let restHr = 59.0

    /// Karvonen zone: % of heart-rate reserve above resting, edges
    /// 40/60/70/80/90, matching the daemon and WHOOP's own bands. Plain
    /// %-of-max read up to two zones hot at the low end.
    static func zone(for bpm: Int) -> Int {
        let pct = (Double(bpm) - restHr) / max(1, maxHr - restHr)
        switch pct {
        case ..<0.4: return 0
        case ..<0.6: return 1
        case ..<0.7: return 2
        case ..<0.8: return 3
        case ..<0.9: return 4
        default: return 5
        }
    }
}
