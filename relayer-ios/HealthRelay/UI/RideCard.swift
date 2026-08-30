// The ride half of the Plan tab. A viewer, by the user's ruling (Aug 30
// 2026): nothing to tap off, no Start, no rest timers, nothing that opens a
// session or holds a connection while riding. The head unit pairs with the
// band on the road and that BLE link is contention-sensitive: a ride begun
// while the band was still contested logged a 222 bpm peak against WHOOP's
// 154, six zero samples and a frozen stretch; the same devices later that
// day, band cleanly free, matched exactly. Do NOT add a Start button here.
//
// ONE card. The route (when a file exists) is the card's top edge, the clock
// (when the plan carries one) is a section inside it. Nothing else on the
// ride face is raised.

import MapKit
import SwiftUI

struct RideCard: View {
    let ride: Plan.Ride
    /// Whether a lift follows later today: the "back by" line says so.
    let liftsLater: Bool
    /// The parsed route, once the daemon has served it. nil = no map.
    var route: Route? = nil
    /// "route loading" / "route unavailable": the plan named a file but the
    /// map is not here yet. nil when no route was planned or it is shown.
    var routeNote: String? = nil

    /// Screenshot hook: HR_DEMO_ROUTE_SHEET=1 opens the full map.
    @State private var showFull = Demo.active
        && ProcessInfo.processInfo.environment["HR_DEMO_ROUTE_SHEET"] != nil

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let route = route {
                routeHeader(route)
            }
            VStack(alignment: .leading, spacing: 0) {
                headerRow
                if let title = ride.title, !title.isEmpty {
                    Text(title)
                        .font(Theme.rounded(18, .semibold))
                        .foregroundStyle(Theme.textPrimary)
                        .lineSpacing(1)
                        .padding(.top, 8)
                }
                if let back = backByLine {
                    Text(back)
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.textTertiary)
                        .padding(.top, 5)
                }
                if let note = routeNote {
                    HStack(spacing: 5) {
                        Image(systemName: "map")
                            .font(.system(size: 10))
                        Text(note)
                            .font(.system(size: 12))
                    }
                    .foregroundStyle(Theme.textTertiary)
                    .padding(.top, 5)
                }
                if let steps = ride.structure, !steps.isEmpty {
                    Rectangle().fill(Theme.hairline).frame(height: 1)
                        .padding(.top, 14)
                    ForEach(Array(steps.enumerated()), id: \.offset) { index, step in
                        stepRow(step, index: index)
                        if index < steps.count - 1 {
                            Rectangle().fill(Theme.hairline).frame(height: 1)
                        }
                    }
                }
                if let readout = ride.hr_readout, !readout.isEmpty {
                    Rectangle().fill(Theme.hairline).frame(height: 1)
                    HStack(alignment: .firstTextBaseline, spacing: 9) {
                        Image(systemName: "heart")
                            .font(.system(size: 11))
                            .foregroundStyle(Theme.textTertiary)
                        Text(readout)
                            .font(.system(size: 13))
                            .lineSpacing(2)
                            .foregroundStyle(Theme.textSecondary)
                    }
                    .padding(.top, 12)
                }
                if let cues = ride.cues, !cues.isEmpty {
                    label("CUES")
                        .padding(.top, 14)
                        .padding(.bottom, 7)
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(cues, id: \.self) { cue in
                            HStack(alignment: .firstTextBaseline, spacing: 9) {
                                Circle()
                                    .fill(Theme.textTertiary)
                                    .frame(width: 3, height: 3)
                                    .offset(y: -3)
                                Text(cue)
                                    .font(.system(size: 13.5))
                                    .lineSpacing(2)
                                    .foregroundStyle(Theme.textSecondary)
                            }
                        }
                    }
                }
                if let clock = ride.timeline, !clock.isEmpty {
                    Rectangle().fill(Theme.hairline).frame(height: 1)
                        .padding(.top, 14)
                    label("CLOCK")
                        .padding(.top, 14)
                        .padding(.bottom, 4)
                    clockRows(clock)
                }
                if let footer = footerLine {
                    Text(footer)
                        .font(.system(size: 11.5))
                        .lineSpacing(1.5)
                        .foregroundStyle(Theme.textTertiary)
                        .padding(.top, 12)
                }
            }
            .padding(.horizontal, 18)
            .padding(.vertical, 16)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
        .glassCard(strong: true)
        .sheet(isPresented: $showFull) {
            if let route = route { RouteSheet(route: route) }
        }
    }

    // ── Route: the card's top edge, one tap to the full map ──────────

    private func routeHeader(_ route: Route) -> some View {
        Button { showFull = true } label: {
            VStack(alignment: .leading, spacing: 0) {
                RouteMap(route: route, interactive: false)
                    .frame(height: 176)
                    .allowsHitTesting(false)
                    // Apple's attribution sits bottom-left; the caption
                    // below carries our numbers so nothing covers it.
                HStack(spacing: 6) {
                    Text(String(format: "%.1f km", route.km))
                        .font(Theme.rounded(13, .semibold))
                        .monospacedDigit()
                        .foregroundStyle(Theme.textPrimary)
                    Text("· \(route.name)")
                        .font(.system(size: 12.5))
                        .foregroundStyle(Theme.textSecondary)
                        .lineLimit(1)
                    Spacer(minLength: 6)
                    Image(systemName: "arrow.up.left.and.arrow.down.right")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(Theme.textTertiary)
                }
                .padding(.horizontal, 18)
                .padding(.top, 11)
                .padding(.bottom, 2)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    // ── Header: what kind of ride, when, how long ────────────────────

    private var headerRow: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            label("RIDE" + (ride.kind.map { " · \($0.uppercased())" } ?? ""))
            Spacer(minLength: 8)
            Text(whenText)
                .font(Theme.rounded(13, .semibold))
                .monospacedDigit()
                .foregroundStyle(kindIsHard ? Theme.accent : Theme.textSecondary)
        }
    }

    /// Quality and race days wear the accent on the time; easy and long
    /// rides stay neutral. The accent still has one job: effort.
    private var kindIsHard: Bool {
        let k = ride.kind?.lowercased() ?? ""
        return k == "quality" || k == "race" || k == "intervals"
    }

    private var whenText: String {
        var parts: [String] = []
        if let slot = ride.slot, !slot.isEmpty { parts.append(slot) }
        if let mins = ride.duration_min, mins > 0 { parts.append(Self.duration(mins)) }
        return parts.isEmpty ? "ride" : parts.joined(separator: " · ")
    }

    static func duration(_ mins: Int) -> String {
        if mins % 60 == 0 { return "\(mins / 60) h" }
        if mins > 60 { return "\(mins / 60) h \(mins % 60)" }
        return "\(mins) min"
    }

    /// slot + duration -> "back ~07:00", so the double day's shape is one
    /// glance and never mental arithmetic on the bike.
    private var backByLine: String? {
        guard let slot = ride.slot, let mins = ride.duration_min, mins > 0 else { return nil }
        let parts = slot.split(separator: ":").compactMap { Int($0) }
        guard parts.count == 2 else { return nil }
        let end = (parts[0] * 60 + parts[1] + mins) % (24 * 60)
        let text = String(format: "back ~%02d:%02d", end / 60, end % 60)
        return liftsLater ? text + " · lift later today" : text
    }

    private var footerLine: String? {
        var parts: [String] = []
        if let venue = ride.venue, !venue.isEmpty { parts.append(venue) }
        if let segments = ride.segments, !segments.isEmpty {
            parts.append("segments: " + segments.joined(separator: ", "))
        }
        if let notes = ride.notes, !notes.isEmpty { parts.append(notes) }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    // ── Steps: the session in program order, read-only ───────────────

    private func stepRow(_ step: Plan.Ride.Step, index: Int) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text("\(step.order ?? index + 1)")
                .font(Theme.rounded(11))
                .monospacedDigit()
                .foregroundStyle(Theme.textTertiary)
                .frame(width: 15, alignment: .trailing)
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(step.name ?? "Step")
                        .font(Theme.rounded(15.5, .semibold))
                        .foregroundStyle(Theme.textPrimary)
                    Spacer(minLength: 8)
                    if let rest = step.rest, !rest.isEmpty {
                        Text(rest)
                            .font(Theme.rounded(12))
                            .monospacedDigit()
                            .foregroundStyle(Theme.textTertiary)
                    }
                }
                if let detail = step.detail, !detail.isEmpty {
                    Text(detail)
                        .font(.system(size: 13))
                        .lineSpacing(2)
                        .foregroundStyle(Theme.textSecondary)
                }
                if let target = step.target, !target.isEmpty {
                    Text(target)
                        .font(.system(size: 12))
                        .lineSpacing(1.5)
                        .foregroundStyle(Theme.textTertiary)
                }
            }
        }
        .padding(.vertical, 10)
    }

    // ── The clock: gels, drinks, checkpoints in time order ───────────

    private func clockRows(_ moments: [Plan.Ride.Moment]) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(moments.enumerated()), id: \.offset) { index, moment in
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    Text(moment.at ?? "")
                        .font(Theme.rounded(13.5, .semibold))
                        .monospacedDigit()
                        .foregroundStyle(Theme.textPrimary)
                        .frame(width: 46, alignment: .leading)
                    Image(systemName: glyph(moment.kind))
                        .font(.system(size: 10.5, weight: .semibold))
                        .foregroundStyle(moment.kind?.lowercased() == "cp" ? Theme.accent : Theme.textTertiary)
                        .frame(width: 14)
                    Text(moment.what ?? "")
                        .font(.system(size: 13.5))
                        .foregroundStyle(Theme.textSecondary)
                        .lineLimit(2)
                    Spacer(minLength: 6)
                    if let km = moment.km {
                        Text(String(format: "km %.1f", km))
                            .font(Theme.rounded(11.5))
                            .monospacedDigit()
                            .foregroundStyle(Theme.textTertiary)
                    }
                }
                .padding(.vertical, 7)
            }
        }
    }

    private func glyph(_ kind: String?) -> String {
        switch kind?.lowercased() {
        case "gel": return "bolt.fill"
        case "drink", "water": return "drop.fill"
        case "cp", "checkpoint": return "flag.fill"
        case "food": return "fork.knife"
        default: return "circle.fill"
        }
    }

    private func label(_ text: String) -> some View {
        Text(text)
            .font(Theme.sectionLabel())
            .kerning(1.4)
            .foregroundStyle(Theme.textTertiary)
    }
}

/// Full-screen, pannable version of the same line. Still no turns, no
/// elevation, no numbers beyond the length: the head unit navigates.
struct RouteSheet: View {
    let route: Route
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ZStack(alignment: .top) {
            RouteMap(route: route, interactive: true)
                .ignoresSafeArea()
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(route.name)
                        .font(Theme.rounded(15, .semibold))
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(1)
                    Text(String(format: "%.1f km", route.km))
                        .font(Theme.rounded(12.5))
                        .monospacedDigit()
                        .foregroundStyle(Theme.textSecondary)
                }
                .padding(.leading, 16)
                .padding(.trailing, 14)
                .frame(height: 44)
                .glassCapsule()
                Spacer()
                Button { dismiss() } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Theme.textSecondary)
                        .frame(width: 44, height: 44)
                        .glassCapsule()
                        .contentShape(Circle())
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 14)
        }
        .preferredColorScheme(.dark)
    }
}

struct RouteMap: View {
    let route: Route
    let interactive: Bool

    var body: some View {
        Map(initialPosition: .region(region),
            interactionModes: interactive ? .all : []) {
            MapPolyline(coordinates: route.coordinates)
                .stroke(Theme.accent, style: StrokeStyle(lineWidth: 3.5, lineCap: .round, lineJoin: .round))
            if let start = route.start {
                Annotation("", coordinate: start) { dot(filled: true) }
            }
            if let finish = route.finish {
                Annotation("", coordinate: finish) { dot(filled: false) }
            }
        }
        .mapStyle(.standard(elevation: .flat, emphasis: .muted, pointsOfInterest: .excludingAll, showsTraffic: false))
        .mapControlVisibility(.hidden)
    }

    private func dot(filled: Bool) -> some View {
        Circle()
            .fill(filled ? Theme.accent : Theme.ground)
            .frame(width: 10, height: 10)
            .overlay(Circle().strokeBorder(filled ? Theme.ground : Theme.accent, lineWidth: 2))
    }

    private var region: MKCoordinateRegion {
        let lats = route.coordinates.map(\.latitude)
        let lons = route.coordinates.map(\.longitude)
        guard let minLat = lats.min(), let maxLat = lats.max(),
              let minLon = lons.min(), let maxLon = lons.max() else {
            return MKCoordinateRegion(center: CLLocationCoordinate2D(latitude: 0, longitude: 0),
                                      span: MKCoordinateSpan(latitudeDelta: 1, longitudeDelta: 1))
        }
        let pad = 1.35
        return MKCoordinateRegion(
            center: CLLocationCoordinate2D(latitude: (minLat + maxLat) / 2, longitude: (minLon + maxLon) / 2),
            span: MKCoordinateSpan(latitudeDelta: max(0.01, (maxLat - minLat) * pad),
                                   longitudeDelta: max(0.01, (maxLon - minLon) * pad)))
    }
}
