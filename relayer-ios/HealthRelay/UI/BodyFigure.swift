// The Body tab's composition figure (Nov 16 2026, his ask; polished twice
// the same evening to his locked direction): the latest S400 reading as a
// 4-compartment body. An athletic front silhouette (ONE continuous Bezier
// outline: head, neck, deltoids, arms just off the body, V-taper, two legs,
// simple feet; his ask the same night: "the first one body silhouette is
// better", crafted past Xiaomi's) filled BOTTOM-UP like liquid
// levels, in bands whose AREAS are proportional to each compartment's mass:
// mineral, protein, water, fat, split by light level lines (never dark
// belts). Whatever the four do not account for stays UNFILLED at the top,
// like headroom above a liquid (never stretched to fill 100%, never a
// striped cap on the crown). A faint dashed ghost inside the body is the goal weight (the goal
// card's own number), the rim between them dimmed. The legend stands beside
// the figure; tap a band or its row for the detail: kg, % of weight, the
// 7-day trend, basis. Visceral fat is never painted here: it stays a number
// on the metrics card. Every number comes from GET /body; the phone only
// draws. Method and basis notes live behind the card's (i) sheet.

import SwiftUI

// ── type scale (the Body tab's fonts follow Dynamic Type) ───────────

/// Theme's voices at the reader's text size. A plain multiplier table (the
/// body style's own ratios, 14/17 ... 23/17), capped at xxxLarge: the
/// accessibility sizes stop growing there so the two-column rows and the
/// figure's legend keep their shape on a 375 pt screen.
enum BodyFont {
    static func scale(_ d: DynamicTypeSize) -> CGFloat {
        switch d {
        case .xSmall: return 0.82
        case .small: return 0.88
        case .medium: return 0.94
        case .large: return 1.0
        case .xLarge: return 1.12
        case .xxLarge: return 1.24
        default: return 1.35 // xxxLarge and every accessibility size
        }
    }
}

// ── palette (four distinct hues on the dark ground) ──────────────────

/// Four compartments, four hue families, so no two read as one at a glance:
/// fat wears the app's coral (on this tab coral means fat, nothing else),
/// water a cool teal, protein amber, mineral a muted bone. Lightness is held
/// close across the three saturated hues, and each band's own gradient is
/// gentle, so a boundary reads as a change of hue, not a light-dark step.
/// The unassigned rest is no hue at all: unfilled headroom.
enum BodyHue {
    /// Top and bottom of each band's soft vertical gradient.
    static func stops(_ key: String) -> (Color, Color) {
        switch key {
        case "fat": return (Color(red: 1.0, green: 0.48, blue: 0.39), Color(red: 0.93, green: 0.38, blue: 0.30))
        case "water": return (Color(red: 0.36, green: 0.73, blue: 0.79), Color(red: 0.25, green: 0.62, blue: 0.70))
        case "protein": return (Color(red: 0.96, green: 0.73, blue: 0.36), Color(red: 0.90, green: 0.63, blue: 0.26))
        case "mineral": return (Color(red: 0.86, green: 0.82, blue: 0.74), Color(red: 0.78, green: 0.74, blue: 0.66))
        default: return (Color.white.opacity(0.06), Color.white.opacity(0.06)) // unassigned: never painted
        }
    }

    static func gradient(_ key: String) -> LinearGradient {
        let (a, b) = stops(key)
        return LinearGradient(colors: [a, b], startPoint: .top, endPoint: .bottom)
    }

    /// The one flat tone a key reads as (legend tile edge, detail accent).
    static func solid(_ key: String) -> Color { stops(key).0 }
}

/// The unassigned key's mark: an EMPTY swatch, the same whisper of ground
/// the unfilled headroom of the figure shows.
struct EmptySwatch: View {
    var cornerRadius: CGFloat = 3

    var body: some View {
        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
            .fill(Color.white.opacity(0.035))
            .overlay(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous).strokeBorder(Color.white.opacity(0.4), lineWidth: 0.75))
    }
}

/// A key's swatch: the band gradient, or the empty mark for unassigned.
struct BodySwatch: View {
    let key: String
    let size: CGFloat

    var body: some View {
        Group {
            if key == "unassigned" {
                EmptySwatch()
            } else {
                RoundedRectangle(cornerRadius: 3, style: .continuous).fill(BodyHue.gradient(key))
            }
        }
        .frame(width: size, height: size)
    }
}

// ── the silhouette ─────────────────────────────────────────────────────

/// An athletic male front figure, drawn as ONE continuous outline of cubic
/// Beziers (Nov 16 2026, a third pass on his critique): an oval head (no
/// face) on a short neck about 0.83 of the head's width; trapezius rising
/// steeply off the neck, then nearly flat, so the shoulder line is square;
/// a distinct deltoid cap a little wider than the arm below it; arms free
/// of the torso from a small round armpit (a 3 pt gap at once, 8 at the
/// elbow), a biceps swell, a step in at the elbow, the forearm widest just
/// below it and tapering to the wrist, angled out a touch, a mitten hand
/// with a hint of thumb; lats bowing gently out down to the waist at 45%,
/// then near straight to hips about 6% wider (the V comes from the
/// shoulders, never a pinched waist); full thighs, a defined knee, the
/// outer calf swelling higher than the inner, a pinched ankle, the inner
/// ankle bone higher than the outer, a small foot turned out on a flat
/// sole. The right half is built here and mirrored for the left, so the
/// figure is exactly symmetric. Drawn in a 100 x 240 unit box; the body
/// spans x 14.3 to 85.7, so the view maps `viewBox`, not the whole box.
enum BodyOutline {
    static let box = CGSize(width: 100, height: 240)
    /// The part of the box the figure occupies, mapped onto the view.
    static let viewBox = CGRect(x: 13.5, y: 0, width: 73, height: 240)

    /// Which piece of the body a knot belongs to: the goal outline narrows
    /// the torso about the centre line and each leg about its own, and keeps
    /// the head, shoulders, arms and feet as they are.
    enum Part { case head, shoulder, arm, torso, leg, foot }

    /// A point on the outline, its tangent (degrees: 0 = +x, 90 = down,
    /// since y runs down) and how far the curve leans on it each way.
    /// `turn` gives the outgoing tangent where the outline turns.
    struct Knot {
        let p: CGPoint, inDeg: CGFloat, outDeg: CGFloat, inLen: CGFloat, outLen: CGFloat, part: Part
        init(_ part: Part, _ x: CGFloat, _ y: CGFloat, _ deg: CGFloat, _ inLen: CGFloat, _ outLen: CGFloat, turn: CGFloat? = nil) {
            p = CGPoint(x: x, y: y); inDeg = deg; outDeg = turn ?? deg; self.inLen = inLen; self.outLen = outLen; self.part = part
        }
        static func unit(_ deg: CGFloat) -> CGPoint {
            let r = deg * .pi / 180
            return CGPoint(x: cos(r), y: sin(r))
        }
    }

    /// Right half, crown to crotch, clockwise. Both ends sit on the centre
    /// line with a level tangent, so the mirrored half joins without a seam.
    static let right: [Knot] = [
        // head: an oval, no face
        Knot(.head, 50, 3, 0, 0, 5.6),
        Knot(.head, 59.8, 14.5, 90, 5.4, 5.0),
        Knot(.head, 58.4, 25.0, 104, 3.2, 1.6),
        // a short, solid neck
        Knot(.head, 58.0, 29.0, 92, 1.4, 1.6),
        Knot(.shoulder, 58.3, 33.2, 82, 1.4, 1.2),
        // the trapezius: steep off the neck, then nearly flat (square shoulders)
        Knot(.shoulder, 62.0, 37.0, 30, 2.2, 3.0),
        Knot(.shoulder, 75.0, 40.4, 9, 4.4, 3.6),
        // the deltoid: a distinct cap, wider than the arm below it
        Knot(.shoulder, 82.8, 45.2, 40, 3.0, 3.0),
        Knot(.shoulder, 85.7, 54.5, 88, 3.0, 3.6),
        Knot(.arm, 84.3, 65.5, 96, 3.0, 3.0),
        // outer arm: upper arm, a small step in at the elbow, forearm
        Knot(.arm, 84.5, 82.0, 90, 4.8, 4.4),
        Knot(.arm, 83.7, 96.5, 90, 3.6, 3.0),
        Knot(.arm, 85.1, 107.0, 92, 3.0, 7.0),
        Knot(.arm, 84.4, 130.0, 90, 5.0, 2.6),
        // the hand: a mitten, a touch wider than the wrist
        Knot(.arm, 85.5, 139.0, 92, 2.8, 3.2),
        Knot(.arm, 81.6, 148.6, 180, 3.0, 2.6),
        Knot(.arm, 77.2, 141.0, 272, 2.6, 1.6),
        // the thumb, a hint on the inner side
        Knot(.arm, 76.6, 137.0, 270, 1.4, 2.0),
        // inner arm, back up: wrist, forearm, elbow, biceps
        Knot(.arm, 77.7, 130.5, 270, 2.0, 7.0),
        Knot(.arm, 75.3, 107.5, 270, 6.0, 3.0),
        Knot(.arm, 74.6, 97.5, 268, 2.6, 4.0),
        Knot(.arm, 73.1, 85.0, 270, 4.0, 3.4),
        Knot(.arm, 73.6, 75.5, 275, 2.6, 1.4),
        // the armpit: a small round arch, open from the start
        Knot(.arm, 72.5, 71.6, 180, 1.0, 1.0),
        // torso: lats bowing gently out down to the waist, then near straight
        Knot(.torso, 71.4, 75.0, 92, 1.6, 8.0),
        Knot(.torso, 69.4, 97.0, 99, 6.0, 5.0),
        Knot(.torso, 66.9, 111.0, 92, 4.0, 4.0),
        Knot(.torso, 67.5, 124.0, 88, 4.0, 3.0),
        // outer leg: hip, thigh, knee, calf (high), ankle
        Knot(.leg, 67.9, 132.0, 91, 3.0, 8.0),
        Knot(.leg, 64.2, 172.0, 98, 9.0, 4.0),
        Knot(.leg, 63.4, 186.0, 92, 3.6, 2.6),
        Knot(.leg, 64.4, 196.5, 90, 3.4, 6.0),
        Knot(.leg, 59.3, 224.0, 97, 7.0, 2.0),
        Knot(.foot, 59.8, 229.0, 85, 1.6, 1.6),
        // the foot: turned out, a flat sole
        Knot(.foot, 63.2, 236.4, 70, 2.6, 1.0),
        Knot(.foot, 61.6, 238.6, 180, 1.2, 4.0),
        Knot(.foot, 52.8, 238.6, 180, 3.0, 0.8),
        Knot(.foot, 52.2, 237.4, 240, 0.8, 1.0),
        // inner leg, back up: ankle bone (high), calf (low, full), knee, thigh
        Knot(.foot, 52.0, 226.5, 270, 2.6, 1.8),
        Knot(.leg, 52.7, 220.0, 272, 1.8, 6.0),
        Knot(.leg, 50.85, 203.0, 270, 6.0, 5.0),
        Knot(.leg, 51.3, 187.0, 268, 5.0, 8.0),
        Knot(.leg, 50.5, 148.0, 265, 6.0, 5.0),
        Knot(.leg, 50, 132.0, 180, 1.2, 0),
    ]

    /// The fingertip's lowest point (unit y) and the hand's span (right
    /// side), for the band cut's sliver rule.
    static let fingertipY: CGFloat = right.filter { $0.part == .arm }.map(\.p.y).max() ?? 0
    static let handX: ClosedRange<CGFloat> = {
        let hand = right.filter { $0.part == .arm && $0.p.y > fingertipY - 22 }.map(\.p.x)
        return (hand.min() ?? 0) - 1.5 ... (hand.max() ?? 0) + 1.5
    }()
    static let crownY: CGFloat = right.first?.p.y ?? 0
    /// The leg's own centre line (right side), what the goal outline
    /// narrows each leg about.
    static let legCentre: CGFloat = 57.5

    /// One cubic: from `a` to `b` through two controls.
    struct Segment { let a, c1, c2, b: CGPoint }

    /// The right half's segments, each knot moved by `map` (x' = s * x + t,
    /// its handles scaled by s), so a moved knot keeps its tangent's sense.
    private static func half(_ map: (Knot) -> (CGFloat, CGFloat)) -> [Segment] {
        var out: [Segment] = []
        for (k0, k1) in zip(right, right.dropFirst()) {
            let (s0, t0) = map(k0), (s1, t1) = map(k1)
            let d0 = Knot.unit(k0.outDeg), d1 = Knot.unit(k1.inDeg)
            let a = CGPoint(x: k0.p.x * s0 + t0, y: k0.p.y)
            let b = CGPoint(x: k1.p.x * s1 + t1, y: k1.p.y)
            out.append(Segment(a: a,
                               c1: CGPoint(x: a.x + d0.x * k0.outLen * s0, y: a.y + d0.y * k0.outLen),
                               c2: CGPoint(x: b.x - d1.x * k1.inLen * s1, y: b.y - d1.y * k1.inLen),
                               b: b))
        }
        return out
    }

    /// The whole loop: the right half, then the left half mirrored and run
    /// backwards (crotch to crown).
    private static func loop(_ half: [Segment]) -> [Segment] {
        let m = { (q: CGPoint) in CGPoint(x: box.width - q.x, y: q.y) }
        return half + half.reversed().map { Segment(a: m($0.b), c1: m($0.c2), c2: m($0.c1), b: m($0.a)) }
    }

    private static func path(_ segs: [Segment]) -> Path {
        var p = Path()
        p.move(to: segs[0].a)
        for g in segs { p.addCurve(to: g.b, control1: g.c1, control2: g.c2) }
        p.closeSubpath()
        return p
    }

    private static let body: [Segment] = loop(half { _ in (1, 0) })

    /// The figure in unit space.
    static func path() -> Path { path(body) }

    // ── the goal outline ──────────────────────────────────────────────

    /// How the goal outline moves a knot at narrowing `a`: the torso about
    /// the centre line, each leg about its own (blending in from the hip,
    /// so the outline stays one smooth curve), head, shoulders, arms
    /// and feet kept. A lighter body is the same frame, less around the middle.
    private static func ghostMap(_ k: Knot, _ a: CGFloat) -> (CGFloat, CGFloat) {
        switch k.part {
        case .head, .shoulder, .arm, .foot:
            return (1, 0)
        case .torso:
            return (a, 50 * (1 - a))
        case .leg:
            if k.p.x <= 50.001 { return (a, 50 * (1 - a)) }
            let w = min(max((k.p.y - 124) / 26, 0), 1)
            let c = 50 + (legCentre - 50) * w
            return (a, c * (1 - a))
        }
    }

    private static func ghostLoop(_ a: CGFloat) -> [Segment] { loop(half { ghostMap($0, a) }) }

    /// Polygon area of a closed run of cubics (each flattened to 12 steps).
    private static func area(_ segs: [Segment]) -> CGFloat {
        var pts: [CGPoint] = []
        for g in segs {
            for i in 0..<12 {
                let t = CGFloat(i) / 12, u = 1 - t
                let x = u * u * u * g.a.x + 3 * u * u * t * g.c1.x + 3 * u * t * t * g.c2.x + t * t * t * g.b.x
                let y = u * u * u * g.a.y + 3 * u * u * t * g.c1.y + 3 * u * t * t * g.c2.y + t * t * t * g.b.y
                pts.append(CGPoint(x: x, y: y))
            }
        }
        var s: CGFloat = 0
        for (p, q) in zip(pts, pts.dropFirst() + [pts[0]]) { s += p.x * q.y - q.x * p.y }
        return abs(s) / 2
    }

    private static let bodyArea: CGFloat = area(body)

    /// The narrowing that makes the goal outline's AREA `ratio` of the
    /// figure's (the area-for-mass rule the bands are cut by). Only the
    /// torso and legs give, so they give more than `ratio` itself.
    static func ghostNarrowing(areaRatio ratio: CGFloat) -> CGFloat {
        let goal = bodyArea * min(max(ratio, 0), 1)
        var lo: CGFloat = 0.3, hi: CGFloat = 1
        if area(ghostLoop(lo)) >= goal { return lo }
        for _ in 0..<24 {
            let mid = (lo + hi) / 2
            if area(ghostLoop(mid)) > goal { hi = mid } else { lo = mid }
        }
        return (lo + hi) / 2
    }

    /// The goal outline, closed (for the dimmed rim).
    static func ghost(narrowing a: CGFloat) -> Path { path(ghostLoop(a)) }

    /// The goal outline's dashed line: only where it leaves the figure's
    /// own edge (torso and legs). Where it would sit on the edge (head,
    /// shoulders, arms, feet) it is not drawn, so no dash doubles the outline.
    static func ghostLine(narrowing a: CGFloat) -> Path {
        let segs = ghostLoop(a)
        let n = right.count - 1
        var p = Path()
        var open = false
        for (i, g) in segs.enumerated() {
            // The knots this segment joins, on the right half's numbering.
            let j = i < n ? i : 2 * n - 1 - i
            let kept = { (k: Knot) in k.part == .head || k.part == .shoulder || k.part == .arm || k.part == .foot }
            if kept(right[j]) && kept(right[j + 1]) {
                open = false
                continue
            }
            if !open { p.move(to: g.a); open = true }
            p.addCurve(to: g.b, control1: g.c1, control2: g.c2)
        }
        return p
    }

    /// The fingertip sliver rule's reach (unit y, about 6 pt at the hero
    /// size): a band cut this close above the fingertips gives the tips to
    /// the band above, so no band leaves painted nails. The crown's reach
    /// (about 2 pt): unfilled headroom thinner than this goes to the band
    /// below, so it never reads as a cap.
    static let tipSliver: CGFloat = 3.9
    static let crownSliver: CGFloat = 1.3

    /// Area below each height, sampled once: rows[i] = the silhouette's
    /// area from unit y = i * step down to the feet, as a fraction of the
    /// whole. The bands are cut by AREA, so a band's painted size is its
    /// share of the mass (cutting by height would let the narrow legs shrink
    /// the bottom band and the wide shoulders inflate the top one).
    /// `noTips` leaves out the hands' tips (the reach of the sliver rule):
    /// a cut that gives them away is placed on the rest, so every band
    /// still paints its own share.
    private static let step: CGFloat = 0.5
    private static func table(noTips: Bool) -> [CGFloat] {
        let shape = path().cgPath
        let rows = Int(box.height / step)
        let cols = 240
        let tipRows = fingertipY - tipSliver - 2
        let mirrored = (box.width - handX.upperBound)...(box.width - handX.lowerBound)
        var widths = [CGFloat](repeating: 0, count: rows)
        var whole: CGFloat = 0
        for r in 0..<rows {
            let y = (CGFloat(r) + 0.5) * step
            var inside = 0, all = 0
            for c in 0..<cols {
                let x = viewBox.minX + (CGFloat(c) + 0.5) * viewBox.width / CGFloat(cols)
                guard shape.contains(CGPoint(x: x, y: y), using: .evenOdd) else { continue }
                all += 1
                if noTips && y >= tipRows && (handX.contains(x) || mirrored.contains(x)) { continue }
                inside += 1
            }
            widths[r] = CGFloat(inside)
            whole += CGFloat(all)
        }
        let total = max(whole, 1)
        var out = [CGFloat](repeating: 0, count: rows + 1)
        var acc: CGFloat = 0
        for r in stride(from: rows - 1, through: 0, by: -1) {
            acc += widths[r]
            out[r] = acc / total
        }
        out[rows] = 0
        return out
    }
    private static let areaBelow = table(noTips: false)
    private static let areaBelowNoTips = table(noTips: true)

    /// The unit y at which the area BELOW it is `fraction` of the whole
    /// (`noTips`: of the figure without the hands' tips below it).
    static func y(forAreaBelow fraction: CGFloat, noTips: Bool = false) -> CGFloat {
        let f = min(max(fraction, 0), 1)
        let table = noTips ? areaBelowNoTips : areaBelow
        let rows = table.count - 1
        // The table falls from 1 (top) to 0 (bottom): find the crossing.
        for r in stride(from: rows, through: 1, by: -1) where table[r - 1] >= f {
            let hi = table[r - 1], lo = table[r]
            let t = hi > lo ? (f - lo) / (hi - lo) : 0
            return (CGFloat(r) - t) * step
        }
        return 0
    }

    /// Unit space to a view rect (the viewBox fills it).
    static func transform(into rect: CGRect) -> CGAffineTransform {
        CGAffineTransform(translationX: rect.minX, y: rect.minY)
            .scaledBy(x: rect.width / viewBox.width, y: rect.height / viewBox.height)
            .translatedBy(x: -viewBox.minX, y: -viewBox.minY)
    }
}

struct BodySilhouette: Shape {
    func path(in rect: CGRect) -> Path {
        BodyOutline.path().applying(BodyOutline.transform(into: rect))
    }
}

/// The goal outline, closed (see BodyOutline.ghost).
private struct GhostOutline: Shape {
    let narrowing: CGFloat

    func path(in rect: CGRect) -> Path {
        BodyOutline.ghost(narrowing: narrowing).applying(BodyOutline.transform(into: rect))
    }
}

/// The goal outline's dashed line, only where it leaves the figure's edge.
private struct GhostLine: Shape {
    let narrowing: CGFloat

    func path(in rect: CGRect) -> Path {
        BodyOutline.ghostLine(narrowing: narrowing).applying(BodyOutline.transform(into: rect))
    }
}

/// Everything OUTSIDE the ghost (even-odd against the whole rect): clipped
/// to the body, it is the rim between today's outline and the goal's.
private struct GhostRim: Shape {
    let narrowing: CGFloat

    func path(in rect: CGRect) -> Path {
        var p = Path(rect.insetBy(dx: -2, dy: -2))
        p.addPath(GhostOutline(narrowing: narrowing).path(in: rect))
        return p
    }
}

// ── the bands ────────────────────────────────────────────────────────

/// One painted band: unit-space top and bottom, its key.
struct BodyBand: Equatable {
    let key: String
    let top: CGFloat
    let bottom: CGFloat
}

/// A piece of a band outside its rows (unit space): the fingertips below a
/// cut that would leave them a sliver of the band under it, or the crown
/// over headroom too thin to read. `low` paints the band's lower tone.
struct BodyPatch: Equatable {
    let key: String
    let rect: CGRect
    let low: Bool
}

enum BodyBands {
    /// Bottom-up bands by area share of the whole. The denominator is the
    /// weight, or the four's sum when they come to MORE than the weight (the
    /// over is then said in words, never hidden by clipping a band).
    /// The sliver rule: a cut just above the fingertips gives the tips to
    /// the band above, and the cut is placed so every band still paints its
    /// own share of the area; headroom thinner than the crown's reach goes
    /// to the band below (at most about 0.1 kg).
    static func of(_ parts: [BodyCompartment], unassignedKg: Double, total: Double) -> (bands: [BodyBand], patches: [BodyPatch]) {
        guard total > 0 else { return ([], []) }
        let items = parts.map { ($0.key, $0.kg) } + (unassignedKg > 0 ? [("unassigned", unassignedKg)] : [])
        // cuts[i] is band i's bottom, cuts[i + 1] its top; tip marks a cut
        // placed by the sliver rule.
        var cuts: [(y: CGFloat, tip: Bool)] = [(BodyOutline.y(forAreaBelow: 0), false)]
        var below: Double = 0
        for (i, item) in items.enumerated() {
            below += item.1
            let f = CGFloat(min(below / total, 1))
            let y = BodyOutline.y(forAreaBelow: f)
            let gap = BodyOutline.fingertipY - y
            if i < items.count - 1, gap > 0, gap < BodyOutline.tipSliver {
                cuts.append((BodyOutline.y(forAreaBelow: f, noTips: true), true))
            } else {
                cuts.append((y, false))
            }
        }
        let bands = items.enumerated().map { i, item in BodyBand(key: item.0, top: cuts[i + 1].y, bottom: cuts[i].y) }
        var patches: [BodyPatch] = []
        for i in 0..<(items.count - 1) where cuts[i + 1].tip {
            let y = cuts[i + 1].y
            let hand = BodyOutline.handX
            let h = BodyOutline.box.height - y
            patches.append(BodyPatch(key: items[i + 1].0, rect: CGRect(x: hand.lowerBound, y: y, width: hand.upperBound - hand.lowerBound, height: h), low: true))
            patches.append(BodyPatch(key: items[i + 1].0, rect: CGRect(x: BodyOutline.box.width - hand.upperBound, y: y, width: hand.upperBound - hand.lowerBound, height: h), low: true))
        }
        if let last = bands.last, last.key == "unassigned", bands.count >= 2, last.bottom - BodyOutline.crownY < BodyOutline.crownSliver {
            patches.append(BodyPatch(key: bands[bands.count - 2].key, rect: CGRect(x: 0, y: 0, width: BodyOutline.box.width, height: last.bottom), low: false))
        }
        return (bands, patches)
    }
}

// ── the card ─────────────────────────────────────────────────────────

struct BodyFigureCard: View {
    let page: BodyPage
    let composition: FoodBody
    @Binding var info: BodyInfo?

    @Environment(\.dynamicTypeSize) private var dts
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var fill: CGFloat = 0
    @State private var selected: String? = {
        #if DEBUG
        // Screenshot / UI-test hook: HR_DEMO_BODY_SELECT=fat opens that band.
        if Demo.active { return ProcessInfo.processInfo.environment["HR_DEMO_BODY_SELECT"] }
        #endif
        return nil
    }()

    /// The hero: fixed in points (it is a picture, not text: Dynamic Type
    /// grows the words around it), the viewBox's own aspect, tall enough to
    /// own the card with the legend standing beside it.
    static let figureSize = CGSize(width: 114, height: 374)

    private var k: CGFloat { BodyFont.scale(dts) }
    private var parts: [BodyCompartment] { page.compartments }
    private var unassignedKg: Double { page.unassigned?.kg ?? 0 }
    private var overKg: Double { page.unassigned?.over_kg ?? 0 }
    private var total: Double { max(composition.kg, parts.reduce(0) { $0 + $1.kg } + unassignedKg) }
    private var split: (bands: [BodyBand], patches: [BodyPatch]) { BodyBands.of(parts, unassignedKg: unassignedKg, total: total) }
    private var bands: [BodyBand] { split.bands }
    /// The legend reads top to bottom, like the figure: fat, water, protein,
    /// mineral (whichever the reading has).
    private var tileKeys: [String] { parts.map(\.key).reversed() }

    /// The goal outline's narrowing: torso and legs narrowed side to side
    /// (head, shoulders, arms and feet kept) until its AREA is the goal mass over
    /// today's, the rule the bands are cut by; height is kept. A shape cue
    /// for the gap, said so in the (i) sheet.
    private var ghostNarrowing: CGFloat? {
        guard let g = page.goal_ghost, composition.kg > 0, g.kg > 0, g.kg < composition.kg else { return nil }
        return BodyOutline.ghostNarrowing(areaRatio: CGFloat(g.kg / composition.kg))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .center, spacing: 8) {
                Text("COMPOSITION")
                    .font(Theme.sectionLabel(10 * k))
                    .kerning(1.3)
                    .foregroundStyle(Theme.textTertiary)
                    .lineLimit(1)
                    .layoutPriority(1)
                Spacer(minLength: 4)
                // Which reading: the source and time, never a second weight
                // (the latest card owns the weigh-in's kg).
                ViewThatFits(in: .horizontal) {
                    stamp("S400 \u{00B7} \(FoodFormat.weighIn(composition.measured_at))")
                    stamp(FoodFormat.weighIn(composition.measured_at))
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("S400 \u{00B7} \(FoodFormat.weighIn(composition.measured_at))")
                .accessibilityIdentifier("body.figure.time")
                InfoButton(key: "figure", what: "composition") { info = BodyInfo.figure(page, composition) }
            }
            // The figure on the left owns the card; the legend stands beside
            // it, top of the body first. A selected band swaps the legend for
            // its detail, level with the band, so the card never grows.
            HStack(alignment: .top, spacing: 16) {
                figure
                    .frame(width: Self.figureSize.width, height: Self.figureSize.height)
                ZStack(alignment: .topLeading) {
                    if let key = selected {
                        VStack(spacing: 0) {
                            Color.clear.frame(height: panelTop(key))
                            detail(key)
                            Spacer(minLength: 0)
                        }
                        .transition(.opacity)
                    } else {
                        legend
                            .transition(.opacity)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
            .fixedSize(horizontal: false, vertical: true)
            .padding(.top, 2)
            .id("body.anchor.legend")
        }
        .padding(18)
        .glassCard(strong: true)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("body.figure")
        .onAppear {
            if reduceMotion {
                fill = 1
            } else if fill < 1 {
                // Short and settling: the body fills from the feet up once.
                withAnimation(.timingCurve(0.23, 1, 0.32, 1, duration: 0.7)) { fill = 1 }
            }
        }
    }

    // ── figure ─────────────────────────────────────────────────────────

    /// Whether a band is painted: every compartment. The unassigned rest
    /// is left unfilled at the top (still tappable: it has a band).
    private func paints(_ b: BodyBand) -> Bool { b.key != "unassigned" }

    /// A band recedes while another one is open: its own tone without the
    /// hue, lighter where the hue was lighter, so the open band carries the
    /// only colour and the rest stays clean (never composited toward mud).
    private func dimmed(_ key: String) -> Bool { selected != nil && selected != key }

    private var figure: some View {
        GeometryReader { geo in
            let sx = geo.size.width / BodyOutline.viewBox.width
            let sy = geo.size.height / BodyOutline.box.height
            let sp = split
            let all = sp.bands, patches = sp.patches
            let painted = all.filter(paints)
            // Where the paint starts: the top band's top, or the crown when
            // thin headroom went to the band below.
            let paintTop = patches.contains { $0.rect.minY <= 0 } ? 0 : (painted.map(\.top).min() ?? 0)
            ZStack(alignment: .topLeading) {
                // The body before the fill arrives: a whisper of ground.
                BodySilhouette().fill(Color.white.opacity(0.035), style: FillStyle(eoFill: true))
                ZStack(alignment: .topLeading) {
                    // Each band with the patches it carries; a band never
                    // paints under another band's patch (a dimmed patch
                    // would let it show through).
                    ForEach(painted, id: \.key) { b in
                        ZStack(alignment: .topLeading) {
                            band(b, width: geo.size.width, sy: sy)
                            ForEach(Array(patches.enumerated()).filter { $0.element.key == b.key }, id: \.offset) { _, p in
                                Rectangle()
                                    .fill(p.low ? BodyHue.stops(p.key).1 : BodyHue.stops(p.key).0)
                                    .frame(width: p.rect.width * sx, height: p.rect.height * sy)
                                    .offset(x: (p.rect.minX - BodyOutline.viewBox.minX) * sx, y: p.rect.minY * sy)
                            }
                        }
                        .frame(width: geo.size.width, height: geo.size.height, alignment: .topLeading)
                        .mask(alignment: .topLeading) {
                            holes(patches.filter { $0.key != b.key }, size: geo.size, sx: sx, sy: sy)
                                .fill(style: FillStyle(eoFill: true))
                        }
                        .grayscale(dimmed(b.key) ? 1 : 0)
                        .opacity(dimmed(b.key) ? 0.36 : 1)
                    }
                    // Depth only where there is paint: the unfilled
                    // headroom stays a clean, empty top, never a dark cap.
                    volume
                        .mask(alignment: .top) {
                            VStack(spacing: 0) {
                                Color.clear.frame(height: paintTop * sy)
                                Rectangle()
                            }
                        }
                    // Level lines between bands: a light hairline, like the
                    // surface of a liquid, never a dark belt (and never
                    // across fingertips the band above has taken).
                    levelLines(painted, patches: patches, sx: sx, sy: sy)
                        .fill(Color.white.opacity(0.22))
                    // The paint's own surface under unfilled headroom: the
                    // same hairline, so the empty crown reads as a level,
                    // not as hair.
                    if paintTop > 0, all.contains(where: { $0.key == "unassigned" }) {
                        Rectangle()
                            .fill(Color.white.opacity(0.3))
                            .frame(width: geo.size.width, height: 0.5)
                            .offset(y: paintTop * sy - 0.25)
                    }
                }
                .compositingGroup()
                .frame(width: geo.size.width, height: geo.size.height, alignment: .topLeading)
                .mask(alignment: .bottom) {
                    Rectangle().frame(height: geo.size.height * fill)
                }
                .clipShape(BodySilhouette(), style: FillStyle(eoFill: true))
                if let a = ghostNarrowing {
                    ZStack {
                        GhostRim(narrowing: a)
                            .fill(Theme.ground.opacity(0.38), style: FillStyle(eoFill: true))
                        GhostLine(narrowing: a)
                            .stroke(Color.white.opacity(0.55), style: StrokeStyle(lineWidth: 0.8, lineCap: .round, dash: [2.5, 2.2]))
                    }
                    // Never a dash on the card: only inside the body.
                    .clipShape(BodySilhouette(), style: FillStyle(eoFill: true))
                    .opacity(Double(fill))
                    .accessibilityIdentifier("body.figure.ghost")
                }
                BodySilhouette()
                    .stroke(Color.white.opacity(0.16), lineWidth: 0.75)
            }
            .contentShape(Rectangle())
            .onTapGesture { loc in
                let x = BodyOutline.viewBox.minX + loc.x / sx
                let y = loc.y / sy
                if let p = patches.first(where: { $0.rect.contains(CGPoint(x: x, y: y)) }) {
                    toggle(p.key)
                } else if let hit = all.first(where: { y >= $0.top && y <= $0.bottom }) {
                    toggle(hit.key)
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(figureAccessibility)
        .accessibilityIdentifier("body.figure.body")
    }

    /// The whole figure rect with `patches` cut out (fill even-odd).
    private func holes(_ patches: [BodyPatch], size: CGSize, sx: CGFloat, sy: CGFloat) -> Path {
        var p = Path(CGRect(origin: .zero, size: size))
        for r in patches.map(\.rect) {
            p.addRect(CGRect(x: (r.minX - BodyOutline.viewBox.minX) * sx, y: r.minY * sy, width: r.width * sx, height: r.height * sy))
        }
        return p
    }

    /// The hairlines between painted bands, in view space: full width,
    /// broken where a patch carries the band above across the cut.
    private func levelLines(_ painted: [BodyBand], patches: [BodyPatch], sx: CGFloat, sy: CGFloat) -> Path {
        var p = Path()
        for b in painted.dropLast() {
            let y = b.top * sy - 0.25
            var from = BodyOutline.viewBox.minX
            let breaks = patches.filter { abs($0.rect.minY - b.top) < 0.01 }.map(\.rect).sorted { $0.minX < $1.minX }
            for r in breaks {
                if r.minX > from { p.addRect(CGRect(x: (from - BodyOutline.viewBox.minX) * sx, y: y, width: (r.minX - from) * sx, height: 0.5)) }
                from = max(from, r.maxX)
            }
            if BodyOutline.viewBox.maxX > from {
                p.addRect(CGRect(x: (from - BodyOutline.viewBox.minX) * sx, y: y, width: (BodyOutline.viewBox.maxX - from) * sx, height: 0.5))
            }
        }
        return p
    }

    /// Depth over the flat bands, so they read as one rounded form: every
    /// edge sinks into a soft inner shade, a sheen runs down the centre
    /// line, and a faint rim of light sits on the outline itself. Drawn
    /// over all the bands at once, so a band boundary never changes the
    /// light. The shade is narrow and light (its darkest is about 12%, the
    /// band's own hue a step lower, never a black wash): on a limb about
    /// 15 pt wide the two edges never meet, so an arm keeps the colour of
    /// the torso it belongs to.
    private var volume: some View {
        ZStack {
            // Edge shade: a narrow blurred stroke of the outline, multiplied
            // in (a lightness step at the band's own hue).
            BodySilhouette()
                .stroke(Color(white: 0.8), lineWidth: 5)
                .blur(radius: 2.2)
                .blendMode(.multiply)
            // The sheen: a soft highlight down the middle of each part
            // (the sternum, each arm, then each leg below the hips), so
            // the limbs carry the same light as the torso and every part
            // reads round. The two sets cross-fade over the hips.
            ZStack {
                Self.sheen([(0.10, 0.05, 0.2), (0.5, 0.25, 0.3), (0.90, 0.05, 0.2)])
                    .mask(LinearGradient(stops: [.init(color: .black, location: 0.5), .init(color: .clear, location: 0.6)],
                                         startPoint: .top, endPoint: .bottom))
                Self.sheen([(0.10, 0.05, 0.2), (0.395, 0.085, 0.24), (0.605, 0.085, 0.24), (0.90, 0.05, 0.2)])
                    .mask(LinearGradient(stops: [.init(color: .clear, location: 0.5), .init(color: .black, location: 0.6)],
                                         startPoint: .top, endPoint: .bottom))
            }
            .blendMode(.softLight)
            // Rim light: a faint hairline of light just inside the edge.
            BodySilhouette()
                .stroke(Color.white.opacity(0.12), lineWidth: 1)
                .blur(radius: 0.5)
                .blendMode(.plusLighter)
        }
        .allowsHitTesting(false)
    }

    /// A horizontal run of soft highlights: (centre, half width, opacity)
    /// as fractions of the figure's width, left to right, never touching.
    private static func sheen(_ peaks: [(CGFloat, CGFloat, Double)]) -> LinearGradient {
        var stops: [Gradient.Stop] = []
        for (c, w, o) in peaks {
            stops += [.init(color: .clear, location: c - w), .init(color: .white.opacity(o), location: c), .init(color: .clear, location: c + w)]
        }
        return LinearGradient(stops: stops, startPoint: .leading, endPoint: .trailing)
    }

    @ViewBuilder
    private func band(_ b: BodyBand, width: CGFloat, sy: CGFloat) -> some View {
        let h = max(0, (b.bottom - b.top) * sy)
        BodyHue.gradient(b.key)
        .frame(width: width, height: h)
        .clipped()
        .offset(y: b.top * sy)
    }

    private var figureAccessibility: String {
        let parts = self.parts.reversed().map { "\($0.label) \(BodyText.kg($0)) kg" }.joined(separator: ", ")
        let ghost = ghostNarrowing == nil ? "" : page.goal_ghost.map { ", goal outline \(FoodFormat.kg($0.kg)) kg" } ?? ""
        return "Body composition, \(FoodFormat.kg(composition.kg)) kg: \(parts)\(ghost)"
    }

    private func toggle(_ key: String) {
        withAnimation(reduceMotion ? nil : .timingCurve(0.23, 1, 0.32, 1, duration: 0.25)) {
            selected = selected == key ? nil : key
        }
    }

    private func stamp(_ t: String) -> some View {
        Text(t)
            .font(Theme.rounded(11.5 * k))
            .monospacedDigit()
            .foregroundStyle(Theme.textTertiary)
            .lineLimit(1)
            .fixedSize()
    }

    /// The detail's top edge: centred on its band where it can be, kept
    /// inside the figure's height (the panel is about 200 pt tall at the
    /// default text size).
    private func panelTop(_ key: String) -> CGFloat {
        guard let b = bands.first(where: { $0.key == key }) else { return 0 }
        let sy = Self.figureSize.height / BodyOutline.box.height
        let mid = (b.top + b.bottom) / 2 * sy
        let panel = 200 * k
        return max(0, min(mid - panel / 2, Self.figureSize.height - panel))
    }

    // ── legend ─────────────────────────────────────────────────────────

    /// One row per compartment, top of the body first, then (pushed to the
    /// feet) the two quiet keys: the unassigned rest and the goal outline.
    private var legend: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(tileKeys, id: \.self) { key in tile(key) }
            Spacer(minLength: 12)
            VStack(alignment: .leading, spacing: 2) {
                unassignedRow
                ghostKey
            }
            if overKg > 0 {
                Text("The four add up to \(FoodFormat.kg(overKg)) kg more than the weight.")
                    .font(.system(size: 11.5 * k))
                    .foregroundStyle(Theme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 4)
                    .accessibilityIdentifier("body.figure.over")
            }
        }
    }

    private func tile(_ key: String) -> some View {
        let part = parts.first { $0.key == key }
        let label = part?.label ?? key
        let kg = part.map { BodyText.kg($0) } ?? "0.0"
        let pct = part.map { String(format: "%.1f", $0.pct) } ?? "0.0"
        return Button { toggle(key) } label: {
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 7) {
                    BodySwatch(key: key, size: 9 * k)
                        .alignmentGuide(.firstTextBaseline) { d in d[.bottom] - 0.5 }
                    Text(label)
                        .font(.system(size: 12.5 * k, weight: .medium))
                        .foregroundStyle(Theme.textSecondary)
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    Text("\(pct)%")
                        .font(Theme.rounded(11.5 * k))
                        .monospacedDigit()
                        .foregroundStyle(Theme.textTertiary)
                        .lineLimit(1)
                        .fixedSize()
                }
                HStack(alignment: .firstTextBaseline, spacing: 3) {
                    Text(kg)
                        .font(Theme.rounded(20 * k, .semibold))
                        .monospacedDigit()
                        .foregroundStyle(Theme.textPrimary)
                    Text("kg")
                        .font(Theme.rounded(11.5 * k))
                        .foregroundStyle(Theme.textSecondary)
                }
                .lineLimit(1)
                .fixedSize()
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(Color.white.opacity(0.03))
            )
            .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .buttonStyle(PressScale())
        .accessibilityLabel("\(label) \(kg) kg, \(pct) percent of weight\(part.map { ", \(FoodFormat.basisSpoken($0.basis))" } ?? "")")
        .accessibilityAddTraits(selected == key ? .isSelected : [])
        .accessibilityIdentifier("body.figure.legend.\(key)")
    }

    /// A quiet key line: a mark, a name and a value, on one line while it
    /// fits and the value under the name at the largest text sizes.
    private func keyLine<Mark: View>(_ name: String, _ value: String, @ViewBuilder mark: () -> Mark) -> some View {
        let m = mark()
        return ViewThatFits(in: .horizontal) {
            HStack(alignment: .firstTextBaseline, spacing: 7) {
                m
                keyName(name)
                keyValue(value)
            }
            HStack(alignment: .firstTextBaseline, spacing: 7) {
                m
                VStack(alignment: .leading, spacing: 1) {
                    keyName(name)
                    keyValue(value)
                }
            }
        }
    }

    private func keyName(_ s: String) -> some View {
        Text(s)
            .font(.system(size: 12 * k))
            .foregroundStyle(Theme.textSecondary)
            .lineLimit(1)
            .fixedSize()
    }

    private func keyValue(_ s: String) -> some View {
        Text(s)
            .font(Theme.rounded(12 * k, .semibold))
            .monospacedDigit()
            .foregroundStyle(Theme.textPrimary.opacity(0.85))
            .lineLimit(1)
            .fixedSize()
    }

    private var unassignedRow: some View {
        let kg = FoodFormat.kg(unassignedKg)
        let pct = String(format: "%.1f", page.unassigned?.pct ?? 0)
        return Button { toggle("unassigned") } label: {
            keyLine("Unassigned", "\(kg) kg") {
                BodySwatch(key: "unassigned", size: 9 * k)
                    .alignmentGuide(.firstTextBaseline) { d in d[.bottom] - 1 }
            }
            .padding(.vertical, 5)
            .padding(.horizontal, 4)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressScale())
        .accessibilityLabel("Unassigned \(kg) kg, \(pct) percent of weight")
        .accessibilityAddTraits(selected == "unassigned" ? .isSelected : [])
        .accessibilityIdentifier("body.figure.legend.unassigned")
    }

    @ViewBuilder
    private var ghostKey: some View {
        if let g = page.goal_ghost, ghostNarrowing != nil {
            keyLine("Goal outline", "~\(FoodFormat.kg(g.kg)) kg") {
                RoundedRectangle(cornerRadius: 2.5, style: .continuous)
                    .stroke(Color.white.opacity(0.6), style: StrokeStyle(lineWidth: 1, dash: [2.5, 2]))
                    .frame(width: 9 * k, height: 9 * k)
                    .alignmentGuide(.firstTextBaseline) { d in d[.bottom] - 1 }
            }
            .padding(.vertical, 5)
            .padding(.horizontal, 4)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Goal outline ~\(FoodFormat.kg(g.kg)) kg")
            .accessibilityIdentifier("body.figure.ghost.note")
        }
    }

    // ── detail ─────────────────────────────────────────────────────────

    @ViewBuilder
    private func detail(_ key: String) -> some View {
        let part = parts.first { $0.key == key }
        let kg = part.map { BodyText.kg($0) } ?? FoodFormat.kg(unassignedKg)
        let pct = part?.pct ?? page.unassigned?.pct ?? 0
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .center, spacing: 7) {
                BodySwatch(key: key, size: 9 * k)
                Text(part?.label ?? "Unassigned")
                    .font(.system(size: 13 * k, weight: .semibold))
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                Spacer(minLength: 2)
                Button { toggle(key) } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 10 * k, weight: .semibold))
                        .foregroundStyle(Theme.textSecondary)
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .padding(.trailing, -15)
                .padding(.vertical, -15)
                .accessibilityLabel("Close detail")
            }
            VStack(alignment: .leading, spacing: 1) {
                HStack(alignment: .firstTextBaseline, spacing: 3) {
                    Text(kg)
                        .font(Theme.rounded(28 * k, .semibold))
                        .monospacedDigit()
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(1)
                    Text("kg")
                        .font(Theme.rounded(12.5 * k))
                        .foregroundStyle(Theme.textSecondary)
                }
                Text("\(String(format: "%.1f", pct))% of weight")
                    .font(Theme.rounded(12 * k))
                    .monospacedDigit()
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                if let p = part { BasisTag(basis: p.basis).padding(.top, 2) }
            }
            if let p = part {
                if p.series.count >= 2 {
                    Sparkline(values: p.series.map(\.kg), decimals: p.key == "mineral" ? 2 : 1,
                              floor: p.key == "mineral" ? 0.1 : 0.5, unit: "kg", dot: BodyHue.solid(p.key))
                        .frame(height: 38)
                        .padding(.top, 4)
                        .accessibilityIdentifier("body.figure.detail.trend")
                    Text("Last 7 days")
                        .font(.system(size: 11 * k))
                        .foregroundStyle(Theme.textTertiary)
                } else {
                    Text("A trend needs two S400 readings.")
                        .font(.system(size: 11.5 * k))
                        .foregroundStyle(Theme.textTertiary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            } else {
                Text(overKg > 0 ? "The four add up to more than the weight." : "Mass the four do not account for.")
                    .font(.system(size: 12 * k))
                    .foregroundStyle(Theme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(Color.white.opacity(0.045))
                .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Theme.hairline, lineWidth: 1))
        )
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("body.figure.detail")
    }
}

/// Press feedback for the tappable tiles: a small settle, never a bounce;
/// with Reduce Motion a gentle dim instead of any movement.
struct PressScale: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        Pressed(label: configuration.label, pressed: configuration.isPressed)
    }

    private struct Pressed<Label: View>: View {
        let label: Label
        let pressed: Bool
        @Environment(\.accessibilityReduceMotion) private var reduceMotion

        var body: some View {
            label
                .scaleEffect(pressed && !reduceMotion ? 0.97 : 1)
                .opacity(pressed && reduceMotion ? 0.7 : 1)
                .animation(reduceMotion ? nil : .timingCurve(0.23, 1, 0.32, 1, duration: 0.14), value: pressed)
        }
    }
}

// ── shared words ───────────────────────────────────────────────────────

enum BodyText {
    /// A compartment's kg: one decimal, mineral two (bone, like the card).
    static func kg(_ c: BodyCompartment) -> String {
        c.key == "mineral" ? String(format: "%.2f", c.kg) : FoodFormat.kg(c.kg)
    }

    static func percent(_ v: Double) -> String {
        String(format: v == v.rounded() ? "%.0f" : "%.1f", v)
    }

    /// day.body is the NEWEST S400 reading that is his: a repeat after the
    /// counted weigh-in still is, so the composition can describe a later
    /// weigh-in than the latest card. Said (in the sheet) when it does.
    static func readingNote(_ m: FoodBody, _ latest: BodyLatest?) -> String? {
        guard let l = latest, l.measured_at != m.measured_at,
              let a = FoodFormat.bodyDate(m.measured_at), let b = FoodFormat.bodyDate(l.measured_at) else { return nil }
        if a > b {
            return "From the newest S400 reading (\(FoodFormat.weighIn(m.measured_at)), \(FoodFormat.kg(m.kg)) kg). The trend counts the \(FoodFormat.weighIn(l.measured_at)) weigh-in."
        }
        return "From the newest S400 reading (\(FoodFormat.weighIn(m.measured_at)), \(FoodFormat.kg(m.kg)) kg), older than the latest weigh-in."
    }

    /// What the unassigned band is, in his terms.
    static func unassignedExplainer(_ p: BodyPage, overKg: Double) -> String {
        let all: [(String, String)] = [("water", "water"), ("fat", "fat"), ("protein", "protein"), ("mineral", "mineral")]
        let missing = all.filter { k in !p.compartments.contains { $0.key == k.0 } }.map(\.1)
        var s = overKg > 0
            ? "The four add up to \(FoodFormat.kg(overKg)) kg MORE than the weight, so nothing is unassigned. They are independent estimates; the figure shows them as they are, not stretched or trimmed."
            : "\(FoodFormat.kg(p.unassigned?.kg ?? 0)) kg the four compartments do not account for. Protein is the formulas' remainder, so on formula values alone this is near zero; it opens up where a calibrated value meets formula ones."
        if !missing.isEmpty {
            s += " No \(missing.joined(separator: " or ")) value from this reading: that mass sits here."
        }
        return s
    }
}
