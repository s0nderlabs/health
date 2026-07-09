// Local parse of the SIG Heart Rate Measurement (0x2A37) for the UI ONLY.
// The daemon's parser (src/hrparse.ts) is the single source of truth for the
// pipeline; this mirrors just enough of it to show a live number on screen.

import Foundation

struct HrLocal {
    let bpm: Int
    let contact: Bool?

    static func parse(_ data: Data) -> HrLocal? {
        guard data.count >= 2 else { return nil }
        let flags = data[0]
        let sixteenBit = flags & 0x01 != 0
        var bpm: Int
        if sixteenBit {
            guard data.count >= 3 else { return nil }
            bpm = Int(data[1]) | (Int(data[2]) << 8)
        } else {
            bpm = Int(data[1])
        }
        var contact: Bool? = nil
        if flags & 0x04 != 0 { contact = flags & 0x02 != 0 }
        guard bpm > 0, bpm <= 250 else { return nil }
        return HrLocal(bpm: bpm, contact: contact)
    }
}
