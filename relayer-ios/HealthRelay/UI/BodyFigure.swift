// The Body tab's composition figure (Nov 16 2026, his ask; polished twice
// the same evening; FAT AS THE OUTER LAYER on Nov 18, his decision): the
// latest S400 reading as a 4-compartment body. An athletic front silhouette
// (ONE continuous Bezier outline: head, neck, deltoids, arms just off the
// body, V-taper, two legs, simple feet; crafted past Xiaomi's). Fat is a
// SHELL around the whole figure, its area fat's share of the weight: the
// inner edge is the same figure shrunk per part toward each part's own
// medial line by ONE factor solved on area, so every limb keeps a
// proportionate rim and the shell thins as the fat % drops (a 1.25 pt floor
// keeps it visible, solved inside the area). Inside the shell, mineral,
// protein and water fill the lean body BOTTOM-UP like liquid levels, in
// bands whose AREAS are proportional to their mass, split by light level
// lines (never dark belts); whatever the four do not account for is a thin
// hatched band at the top. A dashed line inside the shell is the goal
// weight (the goal card's own number): the same lean body with the goal's
// thinner shell. The legend stands beside the figure; tap the shell, a band
// or its row for the detail: kg, % of weight, the 7-day trend, basis.
// Visceral fat is never painted here: it stays a number on the metrics
// card. Every number comes from GET /body; the phone only draws. Method and
// basis notes live behind the card's (i) sheet.

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
/// The unassigned rest is no hue at all: a thin hatched band.
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
/// the hatched band of the figure sits on.
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

    /// Which piece of the body a knot belongs to: the shell's inner edge
    /// shrinks each piece toward its own medial line.
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

    /// One cubic: from `a` to `b` through two controls.
    struct Segment { let a, c1, c2, b: CGPoint }

    /// How a knot moves for a derived outline: toward `m` by `fx` across and
    /// `fy` down (1 = kept), its handles scaled the same way, so a moved knot
    /// keeps its tangent's sense.
    struct Move {
        let m: CGPoint, fx: CGFloat, fy: CGFloat
        static let kept = Move(m: .zero, fx: 1, fy: 1)
        func apply(_ p: CGPoint) -> CGPoint { CGPoint(x: m.x + (p.x - m.x) * fx, y: m.y + (p.y - m.y) * fy) }
    }

    /// The right half's segments, each knot moved by `map`.
    private static func half(_ map: (Int, Knot) -> Move) -> [Segment] {
        let moves = right.indices.map { map($0, right[$0]) }
        var out: [Segment] = []
        for i in 0..<(right.count - 1) {
            let k0 = right[i], k1 = right[i + 1], v0 = moves[i], v1 = moves[i + 1]
            let d0 = Knot.unit(k0.outDeg), d1 = Knot.unit(k1.inDeg)
            let a = v0.apply(k0.p), b = v1.apply(k1.p)
            out.append(Segment(a: a,
                               c1: CGPoint(x: a.x + d0.x * k0.outLen * v0.fx, y: a.y + d0.y * k0.outLen * v0.fy),
                               c2: CGPoint(x: b.x - d1.x * k1.inLen * v1.fx, y: b.y - d1.y * k1.inLen * v1.fy),
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

    private static let body: [Segment] = loop(half { _, _ in .kept })

    /// The figure in unit space.
    static func path() -> Path { path(body) }

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

    // ── the fat shell ─────────────────────────────────────────────────
    //
    // Fat is the OUTER LAYER (Nov 18 2026, his decision): a shell around the
    // whole body. Its inner edge is the same figure shrunk PER PART toward
    // that part's own medial line, by ONE factor `s` solved so the inner
    // AREA is the lean share of the weight. A uniform-width inset would eat
    // a thin forearm whole at 15% while barely touching the torso; a per-part
    // shrink takes the same fraction of every part's half-width, so each
    // limb keeps a proportionate rim and the shell thins as the fat % drops.

    /// The medial lines (right side, unit space): each arm's axis from the
    /// shoulder joint to the mitten's centre, each leg's from the hip to the
    /// foot, and the shoulder girdle (centre line to the shoulder joint),
    /// so the trapezius gets a rim on TOP rather than a narrower shoulder.
    private static let armAxis: [CGPoint] = [CGPoint(x: 77.6, y: 52), CGPoint(x: 79.0, y: 66), CGPoint(x: 78.8, y: 83),
                                             CGPoint(x: 79.2, y: 97), CGPoint(x: 80.2, y: 107), CGPoint(x: 81.0, y: 130),
                                             CGPoint(x: 81.2, y: 142.5)]
    private static let legAxis: [CGPoint] = [CGPoint(x: 59.0, y: 128), CGPoint(x: 58.5, y: 148), CGPoint(x: 57.4, y: 172),
                                             CGPoint(x: 57.4, y: 187), CGPoint(x: 57.6, y: 200), CGPoint(x: 56.0, y: 222),
                                             CGPoint(x: 55.9, y: 229), CGPoint(x: 57.2, y: 233.8)]
    private static let girdle: [CGPoint] = [CGPoint(x: 50, y: 49), CGPoint(x: 77.6, y: 52)]

    private static func nearest(_ p: CGPoint, on line: [CGPoint]) -> CGPoint {
        var best = line[0], bd = CGFloat.infinity
        for (a, b) in zip(line, line.dropFirst()) {
            let dx = b.x - a.x, dy = b.y - a.y
            let t = max(0, min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)))
            let q = CGPoint(x: a.x + t * dx, y: a.y + t * dy)
            let d = hypot(p.x - q.x, p.y - q.y)
            if d < bd { bd = d; best = q }
        }
        return best
    }

    /// The armpit's arch: the last knot of the arm, where it meets the torso.
    private static let armpit: Int = right.lastIndex { $0.part == .arm } ?? 0

    /// Each right-half knot's medial point: the head about its centre (the
    /// crown shrinks down onto it), the neck and torso about the centre
    /// line, the trapezius down onto the girdle, the deltoid and each arm
    /// about the arm's axis (the armpit's arch up into the shoulder), each
    /// leg about its own axis (blending in from the hip, as the goal outline
    /// does), the crotch up toward the pelvis on the centre line (so the
    /// mirrored halves still meet), the feet onto the foot's end of the axis.
    static let medial: [CGPoint] = right.indices.map { i in
        let p = right[i].p
        switch right[i].part {
        case .head:
            return CGPoint(x: 50, y: min(max(p.y, 15), 33))
        case .shoulder:
            if p.x < 60 { return CGPoint(x: 50, y: p.y) }
            let g = nearest(p, on: girdle), a = nearest(p, on: armAxis)
            return hypot(p.x - g.x, p.y - g.y) <= hypot(p.x - a.x, p.y - a.y) ? g : a
        case .arm:
            return i == armpit ? CGPoint(x: 72.8, y: 61) : nearest(p, on: armAxis)
        case .torso:
            return CGPoint(x: 50, y: p.y)
        case .leg, .foot:
            if p.x <= 50.001 { return CGPoint(x: 50, y: 121) }
            let q = nearest(p, on: legAxis)
            let w = min(max((p.y - 124) / 26, 0), 1)
            return CGPoint(x: 50 + (q.x - 50) * w, y: p.y + (q.y - p.y) * w)
        }
    }

    /// The legibility floor: no rim thinner than 1.25 pt at the hero size
    /// (114 pt across 73 units), so a lean forearm still shows its layer.
    /// The factor is solved WITH the floor in place, so the coral's total
    /// area stays exactly the fat share; the floor only moves a little of it
    /// from the torso to the limbs. Below `floorShare` (about 9% fat) the
    /// floor alone is more than the share, and the shell is drawn at the
    /// floor (said in the (i) sheet; the factor reports it as 1).
    static let rimFloorPt: CGFloat = 1.25
    static let rimFloor: CGFloat = rimFloorPt * viewBox.width / 114

    /// The deepest a part's rim is measured from: a wide part (the torso,
    /// the head) shrinks toward a medial line this far in from its edge, not
    /// toward its exact centre, so the shell is one even layer around the
    /// trunk instead of bulging at the flanks while the shoulders stay bare.
    /// Limbs are thinner than this and shrink about their own axis.
    static let depthCap: CGFloat = 12

    /// A knot's depth: its distance to its medial point, capped.
    private static let depth: [CGFloat] = right.indices.map { i in
        let p = right[i].p, m = medial[i]
        return min(hypot(p.x - m.x, p.y - m.y), depthCap)
    }

    /// The rim at depth `d` and shrink `s`: (1 - s) of the depth, never
    /// under the floor, never over 70% of the part. The one formula the
    /// shell's inner edge and the goal outline share.
    private static func rim(depth d: CGFloat, _ s: CGFloat, floor: CGFloat) -> CGFloat {
        min(max((1 - s) * d, floor), 0.7 * d)
    }

    /// A knot's move at shrink `s`: toward its (capped) medial point by its rim.
    private static func shellMove(_ i: Int, _ s: CGFloat, floor: CGFloat) -> Move {
        let p = right[i].p, m0 = medial[i]
        let d0 = hypot(p.x - m0.x, p.y - m0.y)
        guard d0 > 0.001 else { return .kept }
        let d = depth[i]
        let m = CGPoint(x: p.x + (m0.x - p.x) * d / d0, y: p.y + (m0.y - p.y) * d / d0)
        let f = 1 - rim(depth: d, s, floor: floor) / d
        return Move(m: m, fx: f, fy: f)
    }

    private static func shellLoop(_ s: CGFloat, floor: CGFloat) -> [Segment] { loop(half { i, _ in shellMove(i, s, floor: floor) }) }

    /// The shrink whose inner outline has `ratio` of the figure's AREA
    /// (ratio = 1 - fat's share of the weight). Bisection on the sampled
    /// area, the floor in place throughout; 1 when the floor alone already
    /// covers more than the share. Memoized per (ratio to 1e-6, floor): the
    /// card and its sheet ask for the same reading's factor on every render.
    static func shellFactor(areaRatio ratio: CGFloat, floor: CGFloat = rimFloor) -> CGFloat {
        let key = FactorKey(ratio: Int((min(max(ratio, 0), 1) * 1_000_000).rounded()), floor: floor)
        if let s = factors[key] { return s }
        let s = solve(areaRatio: CGFloat(key.ratio) / 1_000_000, floor: floor)
        if factors.count > 32 { factors.removeAll() }
        factors[key] = s
        return s
    }

    private struct FactorKey: Hashable { let ratio: Int; let floor: CGFloat }
    private static var factors: [FactorKey: CGFloat] = [:]

    private static func solve(areaRatio ratio: CGFloat, floor: CGFloat) -> CGFloat {
        let goal = bodyArea * ratio
        var lo: CGFloat = 0.3, hi: CGFloat = 1
        if area(shellLoop(hi, floor: floor)) <= goal { return hi }
        if area(shellLoop(lo, floor: floor)) >= goal { return lo }
        for _ in 0..<26 {
            let mid = (lo + hi) / 2
            if area(shellLoop(mid, floor: floor)) > goal { hi = mid } else { lo = mid }
        }
        return (lo + hi) / 2
    }

    /// The fat share the floor alone already covers (about 9%): below it the
    /// shell is drawn at the floor, a little more than the share.
    static let floorShare: CGFloat = 1 - area(shellLoop(1, floor: rimFloor)) / bodyArea

    /// The shell's inner edge (the lean body), closed, in unit space.
    static func inner(_ s: CGFloat) -> Path { path(shellLoop(s, floor: rimFloor)) }

    // ── the goal outline ──────────────────────────────────────────────

    /// The goal outline: the SAME lean body with the goal's thinner shell,
    /// i.e. the figure shrunk by the same per-part machinery (no floor: it
    /// is a line, not a layer) until its area is the goal weight over
    /// today's. It runs inside today's shell: the coral outside it is the
    /// fat between today and the goal, the coral inside it the goal's shell.
    static func ghostFactor(areaRatio ratio: CGFloat) -> CGFloat { shellFactor(areaRatio: ratio, floor: 0) }

    /// The goal outline's dashed line: only where it stands at least
    /// `minGap` units in from the figure's edge (the torso, the shoulders,
    /// the hips), so on a thin limb no dash doubles the outline.
    static func ghostLine(_ s: CGFloat, minGap: CGFloat) -> Path {
        let segs = shellLoop(s, floor: 0)
        let n = right.count - 1
        let gap = depth.map { rim(depth: $0, s, floor: 0) }
        var p = Path()
        var open = false
        for (i, g) in segs.enumerated() {
            // The knots this segment joins, on the right half's numbering.
            let j = i < n ? i : 2 * n - 1 - i
            if gap[j] < minGap || gap[j + 1] < minGap {
                open = false
                continue
            }
            if !open { p.move(to: g.a); open = true }
            p.addCurve(to: g.b, control1: g.c1, control2: g.c2)
        }
        return p
    }

    // ── area tables (the bands are cut by area) ───────────────────────

    /// The hand rule's reach (unit y, the mitten from fingertip to wrist,
    /// about 31 pt at the hero size): a band cut inside the hands gives the
    /// whole hand to the band above, so no band leaves painted gloves or
    /// nails, and the cut is placed on the rest. The crown's reach
    /// (about 2 pt): an unassigned band thinner than this goes to the band
    /// below, so it never reads as a cap.
    static let tipSliver: CGFloat = 20
    static let crownSliver: CGFloat = 1.3

    /// A fillable outline (the whole figure, or the lean body inside the
    /// shell) with what the band cut needs: its fingertip (lowest arm point),
    /// the hand's span (right side), its crown, and the area below each
    /// height, sampled once: below[i] = the outline's area from unit y =
    /// i * step down to the feet, as a fraction of the whole. The bands are
    /// cut by AREA, so a band's painted size is its share of the mass
    /// (cutting by height would let the narrow legs shrink the bottom band
    /// and the wide shoulders inflate the top one). `belowNoTips` leaves out
    /// the hands' tips (the reach of the sliver rule): a cut that gives them
    /// away is placed on the rest, so every band still paints its own share.
    struct Profile {
        let shape: CGPath
        let fingertipY: CGFloat
        let handX: ClosedRange<CGFloat>
        let crownY: CGFloat
        let below: [CGFloat]
        let belowNoTips: [CGFloat]

        static let step: CGFloat = 0.5

        init(_ map: (Int, Knot) -> Move) {
            shape = BodyOutline.path(loop(half(map))).cgPath
            let pts = right.indices.map { map($0, right[$0]).apply(right[$0].p) }
            let arm = right.indices.filter { right[$0].part == .arm }.map { pts[$0] }
            let tip = arm.map(\.y).max() ?? 0
            fingertipY = tip
            let hand = arm.filter { $0.y > tip - 22 }.map(\.x)
            handX = (hand.min() ?? 0) - 1.5 ... (hand.max() ?? 0) + 1.5
            crownY = pts.first?.y ?? 0
            let rows = Int(box.height / Self.step)
            let cols = 240
            let tipRows = tip - tipSliver - 2
            let mirrored = (box.width - handX.upperBound)...(box.width - handX.lowerBound)
            var all = [CGFloat](repeating: 0, count: rows), noTips = all
            var whole: CGFloat = 0
            for r in 0..<rows {
                let y = (CGFloat(r) + 0.5) * Self.step
                var inside = 0, kept = 0
                for c in 0..<cols {
                    let x = viewBox.minX + (CGFloat(c) + 0.5) * viewBox.width / CGFloat(cols)
                    guard shape.contains(CGPoint(x: x, y: y), using: .evenOdd) else { continue }
                    inside += 1
                    if y >= tipRows && (handX.contains(x) || mirrored.contains(x)) { continue }
                    kept += 1
                }
                all[r] = CGFloat(inside)
                noTips[r] = CGFloat(kept)
                whole += CGFloat(inside)
            }
            let total = max(whole, 1)
            func cumulative(_ w: [CGFloat]) -> [CGFloat] {
                var out = [CGFloat](repeating: 0, count: rows + 1)
                var acc: CGFloat = 0
                for r in stride(from: rows - 1, through: 0, by: -1) {
                    acc += w[r]
                    out[r] = acc / total
                }
                return out
            }
            below = cumulative(all)
            belowNoTips = cumulative(noTips)
        }

        /// The unit y at which the area BELOW it is `fraction` of the whole
        /// (`noTips`: of the outline without the hands' tips below it).
        func y(forAreaBelow fraction: CGFloat, noTips: Bool = false) -> CGFloat {
            let f = min(max(fraction, 0), 1)
            let table = noTips ? belowNoTips : below
            let rows = table.count - 1
            // The table falls from 1 (top) to 0 (bottom): find the crossing.
            for r in stride(from: rows, through: 1, by: -1) where table[r - 1] >= f {
                let hi = table[r - 1], lo = table[r]
                let t = hi > lo ? (f - lo) / (hi - lo) : 0
                return (CGFloat(r) - t) * Self.step
            }
            return 0
        }
    }

    /// The whole figure's profile.
    static let whole = Profile { _, _ in .kept }

    /// The lean body's profile at shrink `s`, built once per reading (the
    /// shrink is rounded to 1e-4, far under a pixel).
    private static var innerProfiles: [Int: Profile] = [:]
    static func innerProfile(_ s: CGFloat) -> Profile {
        let key = Int((s * 10000).rounded())
        if let p = innerProfiles[key] { return p }
        let q = CGFloat(key) / 10000
        let p = Profile { i, _ in shellMove(i, q, floor: rimFloor) }
        if innerProfiles.count > 8 { innerProfiles.removeAll() }
        innerProfiles[key] = p
        return p
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

/// The lean body inside the fat shell at shrink `s` (see BodyOutline.inner).
struct BodyInner: Shape {
    let s: CGFloat

    func path(in rect: CGRect) -> Path {
        BodyOutline.inner(s).applying(BodyOutline.transform(into: rect))
    }
}

/// The fat shell: the figure with the lean body cut out (fill even-odd).
private struct BodyShell: Shape {
    let s: CGFloat

    func path(in rect: CGRect) -> Path {
        var p = BodySilhouette().path(in: rect)
        p.addPath(BodyInner(s: s).path(in: rect))
        return p
    }
}

/// The fat shell for one reading, the ONE derivation the card and its (i)
/// sheet share: fat (when the reading has it), the mass the figure stands
/// for (the weight, or the four's sum when they come to more), and the
/// shrink whose inner area is the lean share (nil with no fat value).
struct BodyShellFit {
    let fat: BodyCompartment?
    let total: Double
    let s: CGFloat?

    init(_ page: BodyPage, _ reading: FoodBody) {
        fat = page.compartments.first { $0.key == "fat" && $0.kg > 0 }
        total = max(reading.kg, page.compartments.reduce(0) { $0 + $1.kg } + (page.unassigned?.kg ?? 0))
        if let f = fat, total > 0 {
            s = BodyOutline.shellFactor(areaRatio: CGFloat(1 - f.kg / total))
        } else {
            s = nil
        }
    }

    /// The floor alone covers more than the share: drawn a little thicker.
    var atFloor: Bool { s == 1 }
}

/// The goal outline's dashed line, only where it leaves the figure's edge.
private struct GhostLine: Shape {
    let s: CGFloat

    func path(in rect: CGRect) -> Path {
        // Drawn where it stands at least 1.2 pt in from the edge.
        BodyOutline.ghostLine(s, minGap: 1.2 * BodyOutline.viewBox.width / rect.width).applying(BodyOutline.transform(into: rect))
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
    /// Bottom-up bands by area share of the outline they fill (`profile`:
    /// the lean body inside the fat shell). The denominator is the mass that
    /// outline stands for: the weight less fat, or the four's sum less fat
    /// when they come to MORE than the weight (the over is then said in
    /// words, never hidden by clipping a band).
    /// The sliver rule: a cut just above the fingertips gives the tips to
    /// the band above, and the cut is placed so every band still paints its
    /// own share of the area; an unassigned band thinner than the crown's reach goes
    /// to the band below (at most about 0.1 kg).
    static func of(_ parts: [BodyCompartment], unassignedKg: Double, total: Double,
                   profile o: BodyOutline.Profile = BodyOutline.whole) -> (bands: [BodyBand], patches: [BodyPatch]) {
        guard total > 0 else { return ([], []) }
        let items = parts.map { ($0.key, $0.kg) } + (unassignedKg > 0 ? [("unassigned", unassignedKg)] : [])
        // cuts[i] is band i's bottom, cuts[i + 1] its top; tip marks a cut
        // placed by the sliver rule.
        var cuts: [(y: CGFloat, tip: Bool)] = [(o.y(forAreaBelow: 0), false)]
        var below: Double = 0
        for (i, item) in items.enumerated() {
            below += item.1
            let f = CGFloat(min(below / total, 1))
            let y = o.y(forAreaBelow: f)
            let gap = o.fingertipY - y
            if i < items.count - 1, gap > 0, gap < BodyOutline.tipSliver {
                cuts.append((o.y(forAreaBelow: f, noTips: true), true))
            } else {
                cuts.append((y, false))
            }
        }
        let bands = items.enumerated().map { i, item in BodyBand(key: item.0, top: cuts[i + 1].y, bottom: cuts[i].y) }
        var patches: [BodyPatch] = []
        for i in 0..<(items.count - 1) where cuts[i + 1].tip {
            let y = cuts[i + 1].y
            let hand = o.handX
            let h = BodyOutline.box.height - y
            patches.append(BodyPatch(key: items[i + 1].0, rect: CGRect(x: hand.lowerBound, y: y, width: hand.upperBound - hand.lowerBound, height: h), low: true))
            patches.append(BodyPatch(key: items[i + 1].0, rect: CGRect(x: BodyOutline.box.width - hand.upperBound, y: y, width: hand.upperBound - hand.lowerBound, height: h), low: true))
        }
        if let last = bands.last, last.key == "unassigned", bands.count >= 2, last.bottom - o.crownY < BodyOutline.crownSliver {
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
    /// The shell's arrival: it fades in once the lean body has risen.
    @State private var shellIn: Double = 0
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
    /// Fat is the outer layer (his Nov 18 decision): a shell whose area is
    /// fat's share of the weight. Everything else fills the lean body inside.
    private var fit: BodyShellFit { BodyShellFit(page, composition) }
    private var total: Double { fit.total }
    private var fatPart: BodyCompartment? { fit.fat }
    private var shellS: CGFloat? { fit.s }
    private var profile: BodyOutline.Profile { shellS.map(BodyOutline.innerProfile) ?? BodyOutline.whole }
    private var split: (bands: [BodyBand], patches: [BodyPatch]) {
        BodyBands.of(parts.filter { $0.key != fatPart?.key }, unassignedKg: unassignedKg,
                     total: total - (fatPart?.kg ?? 0), profile: profile)
    }
    private var bands: [BodyBand] { split.bands }
    /// The legend reads top to bottom, like the figure: fat, water, protein,
    /// mineral (whichever the reading has).
    private var tileKeys: [String] { parts.map(\.key).reversed() }

    /// The goal outline's shrink: the same lean body with the goal's
    /// thinner shell, its AREA the goal mass over today's (the rule the
    /// shell and the bands are cut by); see BodyOutline.ghostFactor.
    private var ghostS: CGFloat? {
        guard let g = page.goal_ghost, composition.kg > 0, g.kg > 0, g.kg < composition.kg else { return nil }
        return BodyOutline.ghostFactor(areaRatio: CGFloat(g.kg / composition.kg))
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
                shellIn = 1
            } else if fill < 1 {
                // Short and settling: the lean body fills from the feet up
                // once, then the shell (fat) settles over it.
                withAnimation(.timingCurve(0.23, 1, 0.32, 1, duration: 0.7)) { fill = 1 }
                withAnimation(.timingCurve(0.23, 1, 0.32, 1, duration: 0.4).delay(0.45)) { shellIn = 1 }
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

    /// The goal line recedes with the shell when another band is open.
    private var dimmedGhost: Bool { selected != nil && selected != fatPart?.key }

    private var figure: some View {
        GeometryReader { geo in
            let sx = geo.size.width / BodyOutline.viewBox.width
            let sy = geo.size.height / BodyOutline.box.height
            let sp = split
            let all = sp.bands, patches = sp.patches
            let painted = all.filter(paints)
            let shell = shellS
            // Where the paint starts: the top band's top, or the crown when
            // thin headroom went to the band below.
            let paintTop = patches.contains { $0.rect.minY <= 0 } ? 0 : (painted.map(\.top).min() ?? 0)
            let rest = all.first { $0.key == "unassigned" }
            ZStack(alignment: .topLeading) {
                // The body before the fill arrives: a whisper of ground.
                BodySilhouette().fill(Color.white.opacity(0.035), style: FillStyle(eoFill: true))
                ZStack(alignment: .topLeading) {
                    // The lean body: each band with the patches it carries;
                    // a band never paints under another band's patch (a
                    // dimmed patch would let it show through).
                    ZStack(alignment: .topLeading) {
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
                        // The unassigned rest: a thin hatched band at the
                        // top of the fill, never a hue.
                        if let r = rest, r.bottom - r.top > 0.05, !patches.contains(where: { $0.rect.minY <= 0 }) {
                            hatch(r, width: geo.size.width, sy: sy)
                                .opacity(dimmed("unassigned") ? 0.4 : 1)
                        }
                        // Level lines between bands: a light hairline, like
                        // the surface of a liquid, never a dark belt (and
                        // never across fingertips the band above has taken).
                        levelLines(painted, patches: patches, sx: sx, sy: sy)
                            .fill(Color.white.opacity(0.22))
                        // The paint's own surface under the unassigned rest.
                        if paintTop > 0, rest != nil {
                            Rectangle()
                                .fill(Color.white.opacity(0.3))
                                .frame(width: geo.size.width, height: 0.5)
                                .offset(y: paintTop * sy - 0.25)
                        }
                    }
                    .frame(width: geo.size.width, height: geo.size.height, alignment: .topLeading)
                    .clipShape(fillShape(shell), style: FillStyle(eoFill: true))
                    if let s = shell {
                        // The shell: fat, the outer layer, over the whole body.
                        BodyShell(s: s)
                            .fill(BodyHue.gradient("fat"), style: FillStyle(eoFill: true))
                            .grayscale(dimmed("fat") ? 1 : 0)
                            .opacity(dimmed("fat") ? 0.36 : 1)
                            .opacity(shellIn)
                    }
                    // Depth over the shell and the lean body together, so
                    // the figure reads as one rounded form under one light.
                    volume(shell)
                        .opacity(shell == nil ? 1 : shellIn)
                }
                .compositingGroup()
                .frame(width: geo.size.width, height: geo.size.height, alignment: .topLeading)
                .mask(alignment: .bottom) {
                    Rectangle().frame(height: geo.size.height * fill)
                }
                .clipShape(BodySilhouette(), style: FillStyle(eoFill: true))
                if let s = shell {
                    // The shell's inner edge: a crisp light hairline, kept
                    // INSIDE the lean body so it never eats a thin rim.
                    BodyInner(s: s)
                        .stroke(Color.white.opacity(0.42), lineWidth: 1.2)
                        .clipShape(BodyInner(s: s), style: FillStyle(eoFill: true))
                        .opacity(shellIn)
                }
                if let a = ghostS {
                    // Quiet at rest (a faint guide in the coral), crisp when
                    // the shell is open: then it is the point.
                    let open = selected == fatPart?.key
                    GhostLine(s: a)
                        .stroke(Color.white.opacity(open ? 0.8 : 0.3),
                                style: StrokeStyle(lineWidth: open ? 0.9 : 0.6, lineCap: .round, dash: open ? [2.5, 2.2] : [3.5, 3.5]))
                        // Never a dash on the card: only inside the body.
                        .clipShape(BodySilhouette(), style: FillStyle(eoFill: true))
                        .opacity(Double(fill) * (dimmedGhost ? 0.5 : 1))
                        .accessibilityIdentifier("body.figure.ghost")
                }
                if shell == nil {
                    BodySilhouette()
                        .stroke(Color.white.opacity(0.16), lineWidth: 0.75)
                }
            }
            .contentShape(Rectangle())
            .onTapGesture { loc in
                let u = CGPoint(x: BodyOutline.viewBox.minX + loc.x / sx, y: loc.y / sy)
                if let key = hitKey(u, bands: all, patches: patches, shell: shell) { toggle(key) }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(figureAccessibility)
        .accessibilityIdentifier("body.figure.body")
    }

    /// The outline the bands fill: the lean body inside the shell, or the
    /// whole figure when the reading has no fat value.
    private func fillShape(_ s: CGFloat?) -> AnyShape {
        if let s { return AnyShape(BodyInner(s: s)) }
        return AnyShape(BodySilhouette())
    }

    /// What a tap at unit point `u` opens: a band inside the lean body (a
    /// patch first), the shell anywhere else on the body or within about
    /// 6 pt of its edge (a 2 pt rim is too thin to aim at); with no shell,
    /// the band at that height.
    private func hitKey(_ u: CGPoint, bands: [BodyBand], patches: [BodyPatch], shell: CGFloat?) -> String? {
        let byBand = { () -> String? in
            if let p = patches.first(where: { $0.rect.contains(u) }) { return p.key }
            return bands.first(where: { u.y >= $0.top && u.y <= $0.bottom })?.key
        }
        guard let s = shell else { return byBand() }
        if BodyOutline.inner(s).contains(u, eoFill: true) { return byBand() ?? fatPart?.key }
        let reach = BodyOutline.path().cgPath.copy(strokingWithWidth: 8, lineCap: .round, lineJoin: .round, miterLimit: 1)
        if BodyOutline.path().contains(u, eoFill: true) || reach.contains(u) { return fatPart?.key }
        return nil
    }

    /// The unassigned band's hatch: fine diagonal lines on a whisper of
    /// ground, so the rest reads as "not one of the four", never as a hue.
    private func hatch(_ b: BodyBand, width: CGFloat, sy: CGFloat) -> some View {
        let top = b.top * sy, bottom = b.bottom * sy, h = max(bottom - top, 0.5)
        return ZStack(alignment: .topLeading) {
            Rectangle().fill(Color.white.opacity(0.03))
                .frame(width: width, height: h)
                .offset(y: top)
            Path { p in
                var x = -h
                while x < width + h {
                    p.move(to: CGPoint(x: x, y: top + h))
                    p.addLine(to: CGPoint(x: x + h, y: top))
                    x += 2.6
                }
            }
            .stroke(Color.white.opacity(0.22), lineWidth: 0.5)
            .clipShape(Rectangle().offset(y: top).size(width: width, height: h))
        }
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
    private func volume(_ shell: CGFloat?) -> some View {
        ZStack {
            // Edge shade: a narrow blurred stroke of the outline, multiplied
            // in (a lightness step at the band's own hue).
            BodySilhouette()
                .stroke(Color(white: shell == nil ? 0.8 : 0.9), lineWidth: shell == nil ? 5 : 3)
                .blur(radius: shell == nil ? 2.2 : 1.2)
                .blendMode(.multiply)
            // Under the shell, the lean body sinks a step: a soft shade
            // along the shell's inner edge, inside it, so the layer reads as
            // ON TOP of what it covers.
            if let s = shell {
                BodyInner(s: s)
                    .stroke(Color(white: 0.84), lineWidth: 3)
                    .blur(radius: 1.2)
                    .blendMode(.multiply)
                    .clipShape(BodyInner(s: s), style: FillStyle(eoFill: true))
            }
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
        let ghost = ghostS == nil ? "" : page.goal_ghost.map { ", goal outline \(FoodFormat.kg($0.kg)) kg" } ?? ""
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
        if let g = page.goal_ghost, ghostS != nil {
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
