import { describe, expect, test } from 'bun:test'
import { SIGNING_EXPIRED_NAG_DAYS, SIGNING_NAG_HOURS, signedHoursLeft, signingNag } from '../src/signing.js'

const H = 3_600_000
const now = Date.parse('2026-08-30T12:00:00Z')
const at = (hours: number) => new Date(now + hours * H).toISOString()

describe('sideload clock (daemon side)', () => {
  test('signedHoursLeft: one decimal, negative once dead, null when unknown', () => {
    expect(signedHoursLeft(at(74.04), now)).toBe(74)
    expect(signedHoursLeft(at(-3), now)).toBe(-3)
    expect(signedHoursLeft(null, now)).toBeNull()
    expect(signedHoursLeft('', now)).toBeNull()
    expect(signedHoursLeft('not a date', now)).toBeNull()
  })

  test('no nag while healthy or unknown', () => {
    expect(signingNag(at(SIGNING_NAG_HOURS + 0.1), now)).toBeNull()
    expect(signingNag(at(7 * 24), now)).toBeNull()
    expect(signingNag(null, now)).toBeNull()
  })

  test('expiry nag inside the window, keyed to the UTC day', () => {
    const nag = signingNag(at(30), now)
    expect(nag?.key).toBe('phone-sign-expiry:2026-08-30')
    expect(nag?.problem).toContain('expires in 30h')
    expect(nag?.problem).toContain('build-phone.sh install')
    // Same day, later tick: same key, so the engine dedupes to one per day.
    expect(signingNag(at(30), now + 4 * H)?.key).toBe('phone-sign-expiry:2026-08-30')
    // Next UTC day: a fresh key, a fresh nag.
    expect(signingNag(at(30), now + 13 * H)?.key).toBe('phone-sign-expiry:2026-08-31')
  })

  test('expired nag uses its own key and stops after the bounded window', () => {
    const dead = signingNag(at(-3), now)
    expect(dead?.key).toBe('phone-sign-expired:2026-08-30')
    expect(dead?.problem).toContain('EXPIRED')
    expect(dead?.problem).toContain('3h ago')
    // Still nagging inside the window.
    expect(signingNag(at(-(SIGNING_EXPIRED_NAG_DAYS * 24 - 1)), now)?.key).toContain('phone-sign-expired')
    // Silent once the phone has been dead longer than the window.
    expect(signingNag(at(-SIGNING_EXPIRED_NAG_DAYS * 24), now)).toBeNull()
    expect(signingNag(at(-30 * 24), now)).toBeNull()
  })

  test('the boundary hour is an expiry nag, not an expired one', () => {
    expect(signingNag(at(0.1), now)?.key).toContain('phone-sign-expiry')
    expect(signingNag(at(0), now)?.key).toContain('phone-sign-expired')
  })
})
