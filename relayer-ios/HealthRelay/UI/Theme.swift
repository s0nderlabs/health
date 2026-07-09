// The design system, committed: a dark liquid-glass instrument for 2-second
// glances under gym fatigue. Warm dark neutrals (one temperature, never pure
// black), glass surfaces over a faint warm ambiance, one accent with a focused
// job (the live signal: BPM hero, the start capsule, the PR rung), SF Rounded
// as the display voice for numerals and titles.

import SwiftUI

enum Theme {
    static let ground = Color(red: 0.071, green: 0.067, blue: 0.063) // #121110
    static let accent = Color(red: 1.0, green: 0.42, blue: 0.34) // #FF6B57
    static let accentInk = Color(red: 0.13, green: 0.05, blue: 0.03)

    static let textPrimary = Color(red: 0.96, green: 0.95, blue: 0.93) // warm white
    static let textSecondary = Color.white.opacity(0.56)
    static let textTertiary = Color.white.opacity(0.34)
    static let hairline = Color.white.opacity(0.08)

    /// Quiet green for "link up" dots only; desaturated so it can never
    /// outshout the accent.
    static let okDim = Color(red: 0.45, green: 0.65, blue: 0.45)

    // Ladder bar tones: one scale, four meanings. Ramp is a whisper, work is
    // the brightest neutral, back-off sits between, PR wears the accent.
    static let barTrack = Color.white.opacity(0.055)
    static let barRamp = Color.white.opacity(0.16)
    static let barWork = Color.white.opacity(0.42)
    static let barBackoff = Color.white.opacity(0.30)
    static let barMaybe = Color.white.opacity(0.30) // stroke, not fill

    static func heroNumber(_ size: CGFloat) -> Font {
        .system(size: size, weight: .bold, design: .rounded)
    }

    static func weightNumber(_ size: CGFloat = 32) -> Font {
        .system(size: size, weight: .semibold, design: .rounded)
    }

    static func rounded(_ size: CGFloat, _ weight: Font.Weight = .medium) -> Font {
        .system(size: size, weight: weight, design: .rounded)
    }

    /// The label voice: expanded-width caps at small sizes. Marks section
    /// chrome (WARMUP, SESSION, NOTES) apart from content without shouting.
    static func sectionLabel(_ size: CGFloat = 10.5) -> Font {
        .system(size: size, weight: .semibold).width(.expanded)
    }
}

/// Faint warm radials behind every screen so the glass has something real to
/// refract. Alphas are whisper-level on purpose; this is ambiance, not decor.
struct AmbientBackground: View {
    var body: some View {
        ZStack {
            Theme.ground
            RadialGradient(
                colors: [Theme.accent.opacity(0.05), .clear],
                center: UnitPoint(x: 0.88, y: -0.06), startRadius: 0, endRadius: 380)
            RadialGradient(
                colors: [Color(red: 1.0, green: 0.69, blue: 0.47).opacity(0.03), .clear],
                center: UnitPoint(x: -0.14, y: 0.34), startRadius: 0, endRadius: 480)
            RadialGradient(
                colors: [Theme.accent.opacity(0.03), .clear],
                center: UnitPoint(x: 0.7, y: 1.08), startRadius: 0, endRadius: 420)
        }
        .ignoresSafeArea()
    }
}

extension View {
    /// One glass language for every surface: system material, hairline inset,
    /// a 1px top highlight to sell the lift, contact + ambient shadows.
    /// `strong` raises the hero card a step (brighter tint, deeper ambient).
    func glassCard(strong: Bool = false, cornerRadius: CGFloat = 24) -> some View {
        background(
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                .fill(.ultraThinMaterial)
                .overlay(
                    RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                        .fill(Color.white.opacity(strong ? 0.045 : 0))
                )
                .overlay(
                    RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                        .strokeBorder(Theme.hairline, lineWidth: 1)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                        .strokeBorder(Color.white.opacity(strong ? 0.09 : 0.065), lineWidth: 1)
                        .mask(
                            LinearGradient(
                                colors: [.white, .clear],
                                startPoint: .top,
                                endPoint: .center
                            )
                        )
                )
                .shadow(color: .black.opacity(0.35), radius: 1, y: 1)
                .shadow(color: .black.opacity(strong ? 0.35 : 0.28), radius: strong ? 16 : 12, y: strong ? 9 : 6)
        )
    }

    /// Glass capsule for chips and small round controls. Same material and
    /// highlight grammar as the cards, capsule geometry.
    func glassCapsule() -> some View {
        background(
            Capsule()
                .fill(.ultraThinMaterial)
                .overlay(Capsule().strokeBorder(Theme.hairline, lineWidth: 1))
                .overlay(
                    Capsule()
                        .strokeBorder(Color.white.opacity(0.08), lineWidth: 1)
                        .mask(
                            LinearGradient(
                                colors: [.white, .clear],
                                startPoint: .top,
                                endPoint: .center
                            )
                        )
                )
        )
    }
}
