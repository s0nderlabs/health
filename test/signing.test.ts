import { describe, expect, test } from 'bun:test'
import { SIGNING_EXPIRED_NAG_DAYS, SIGNING_NAG_HOURS, localDate, signedHoursLeft, signingNag } from '../src/signing.js'

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

  test('expiry nag inside the window, keyed to the LOCAL day', () => {
    const nag = signingNag(at(30), now)
    expect(nag?.key).toBe(`phone-sign-expiry:${localDate(now)}`)
    expect(nag?.problem).toContain('expires in 30h')
    expect(nag?.problem).toContain('build-phone.sh install')
    // Same local day, a later tick: same key, so the engine dedupes to one per day.
    const sameDay = now + 60_000
    expect(signingNag(at(30), sameDay)?.key).toBe(`phone-sign-expiry:${localDate(sameDay)}`)
    // The next local day: a fresh key, a fresh nag.
    expect(signingNag(at(30), now + 24 * H)?.key).toBe(`phone-sign-expiry:${localDate(now + 24 * H)}`)
    expect(localDate(now + 24 * H)).not.toBe(localDate(now))
  })

  test('expired nag uses its own key and stops after the bounded window', () => {
    const dead = signingNag(at(-3), now)
    expect(dead?.key).toBe(`phone-sign-expired:${localDate(now)}`)
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

// ── Auto re-sign: the backstop and resignAlerts ────────────────────

import {
  RESIGN_AWAKE_MS,
  RESIGN_FIX,
  RESIGN_HEARTBEAT_MS,
  resignAlerts,
  resignHealthy,
  type ResignAlert,
} from '../src/signing.js'
import { emptyState, type ResignState } from '../src/resign/state.js'
import { STOP_HOURS } from '../src/resign/policy.js'

const awake = RESIGN_AWAKE_MS + 60_000

function st(over: Partial<ResignState> = {}): ResignState {
  return { ...emptyState(), enabled: true, dry_run: false, last_run_at: new Date(now - 10 * 60_000).toISOString(), ...over }
}

function keys(a: ResignAlert[]): string[] {
  return a.map((x) => x.key)
}

describe('legacy nag backstop', () => {
  const healthy = { enabled: true, state: st(), daemonAwakeMs: awake }

  test('the new REINSTALL text: wireless, no manual profile delete, auto re-sign pointer', () => {
    const p = signingNag(at(30), now)!.problem
    expect(p).toContain('scripts/build-phone.sh install')
    expect(p).toContain('bun run resign install-agent')
    expect(p).toContain('Cable only if Wi-Fi pairing fails')
    expect(p).not.toContain('cable in')
    expect(p).not.toContain('delete the cached profiles')
  })

  test('defers ONLY while the automation is healthy', () => {
    expect(resignHealthy(healthy, now)).toBe(true)
    expect(signingNag(at(30), now, healthy)).toBeNull()
  })

  test('fires exactly as today when disabled, dry run, stale heartbeat, sleepy daemon or no state', () => {
    const legacy = signingNag(at(30), now)
    const cases = [
      { ...healthy, enabled: false },
      { ...healthy, state: st({ dry_run: true }) },
      { ...healthy, state: st({ last_run_at: new Date(now - RESIGN_HEARTBEAT_MS).toISOString() }) },
      { ...healthy, state: st({ last_run_at: null }) },
      { ...healthy, state: null },
    ]
    for (const c of cases) {
      expect(resignHealthy(c, now)).toBe(false)
      expect(signingNag(at(30), now, c)).toEqual(legacy)
    }
  })

  test('wake grace: a fresh heartbeat defers at any awake time; a stale one only inside the grace', () => {
    // Regression: the legacy nag used to take over for 45 min after EVERY
    // wake or daemon restart, giving two alerts a day and the reinstall text
    // while an install was pending.
    const pendingState = st({
      pending_confirm: { staged_run_id: 'r1', first_installed_at: at(-1), last_installed_at: at(-1), expected_until: at(160), version: 'v', old_signed_until: at(20) },
    })
    for (const awakeMs of [0, 10 * 60_000, awake]) {
      const ctx = { enabled: true, state: pendingState, daemonAwakeMs: awakeMs }
      expect(signingNag(at(20), now, ctx)).toBeNull()
      const c = resignAlerts(pendingState, at(20), now, awakeMs).filter((a) => a.key.startsWith('phone-sign'))
      expect(keys(c)).toEqual([`phone-sign-urgent:${localDate(now)}`])
      expect(c[0].problem).toContain('installed, unconfirmed: open the app once')
    }
    // A stale heartbeat right after a wake: still the automation's voice (the
    // timer has not had its chance), never silence.
    const stale = st({ last_run_at: new Date(now - 8 * H).toISOString() })
    expect(signingNag(at(20), now, { enabled: true, state: stale, daemonAwakeMs: 10 * 60_000 })).toBeNull()
    expect(keys(resignAlerts(stale, at(20), now, 10 * 60_000)).filter((k) => k.startsWith('phone-sign'))).toEqual([`phone-sign-urgent:${localDate(now)}`])
    // Past the grace the legacy nag takes over, on the SAME tier key.
    const legacy = signingNag(at(20), now, { enabled: true, state: stale, daemonAwakeMs: awake })
    expect(legacy?.key).toBe(`phone-sign-urgent:${localDate(now)}`)
    expect(resignAlerts(stale, at(20), now, awake).filter((a) => a.key.startsWith('phone-sign'))).toEqual([])
  })

  test('legacy nag with the feature on: tier keys, critical priority, pending-aware text', () => {
    const stale = st({ last_run_at: new Date(now - 3 * H).toISOString() })
    const ctx = { enabled: true, state: stale, daemonAwakeMs: awake }
    expect(signingNag(at(40), now, ctx)?.key).toBe(`phone-sign-expiry:${localDate(now)}`)
    expect(signingNag(at(20), now, ctx)?.key).toBe(`phone-sign-urgent:${localDate(now)}`)
    const crit = signingNag(at(5), now, ctx)!
    expect(crit.key).toBe(`phone-sign-critical:${localDate(now)}`)
    expect(crit.priority).toBe('alert')
    expect(signingNag(at(-2), now, ctx)?.key).toBe(`phone-sign-expired:${localDate(now)}`)
    const pend = st({
      last_run_at: new Date(now - 3 * H).toISOString(),
      pending_confirm: { staged_run_id: 'r1', first_installed_at: at(-1), last_installed_at: at(-1), expected_until: at(160), version: 'v', old_signed_until: at(20) },
    })
    for (const h of [40, 20, 5, -2]) {
      const p = signingNag(at(h), now, { enabled: true, state: pend, daemonAwakeMs: awake })!.problem
      expect(p).toContain('installed, unconfirmed: open the app once')
      expect(p.toLowerCase()).not.toContain('reinstall')
    }
    // Feature off: exactly today's keys, no priority.
    const off = signingNag(at(5), now, { ...ctx, enabled: false })!
    expect(off.key).toBe(`phone-sign-expiry:${localDate(now)}`)
    expect(off.priority).toBeUndefined()
  })

  test('STOP_HOURS in policy mirrors the expired-nag window', () => {
    expect(STOP_HOURS).toBe(-SIGNING_EXPIRED_NAG_DAYS * 24)
  })
})

describe('resignAlerts', () => {
  test('nothing while disabled (by config) or a dry run', () => {
    const s = st({ episode: { class: 'account_broken', since: at(-1), hard: true, last_at: at(-1), detail: null } })
    expect(resignAlerts(s, at(30), now, awake, { enabled: false })).toEqual([])
    expect(resignAlerts({ ...s, dry_run: true }, at(30), now, awake)).toEqual([])
    expect(resignAlerts(null, at(30), now, awake, { enabled: false })).toEqual([])
  })

  test('enabled with no state.json: timer_dead and unknown_expiry still fire (regression)', () => {
    // The agent was never installed, or its state was removed: the legacy nag
    // covers the clock, and the timer alert names the dead agent.
    expect(keys(resignAlerts(null, at(30), now, awake, { enabled: true }))).toEqual([`resign-timer-dead:${localDate(now)}`])
    expect(resignAlerts(null, at(30), now, awake, { enabled: true })[0].problem).toContain('has not run in ever')
    expect(keys(resignAlerts(null, at(100), now, awake, { enabled: true }))).toEqual([])
    expect(keys(resignAlerts(null, null, now, awake, { enabled: true }))).toEqual(['resign-unknown-expiry:never'])
    // The legacy nag fires alongside (no state = not healthy).
    expect(signingNag(at(30), now, { enabled: true, state: null, daemonAwakeMs: awake })).not.toBeNull()
  })

  test('a hard episode alerts with ONE stable key across many ticks', () => {
    const since = at(-2)
    const s = st({ episode: { class: 'account_broken', since, hard: true, last_at: since, detail: 'no Apple account in Xcode settings' } })
    const seen = new Set<string>()
    for (let i = 0; i < 12; i++) {
      for (const a of resignAlerts(s, at(60), now + i * 5 * 60_000, awake)) if (a.key.startsWith('resign-fail')) seen.add(a.key)
    }
    expect([...seen]).toEqual([`resign-fail:account_broken:${since}`])
    const a = resignAlerts(s, at(60), now, awake).find((x) => x.key.startsWith('resign-fail'))!
    expect(a.priority).toBe('notable')
    expect(a.problem).toContain(RESIGN_FIX.account_broken)
    expect(a.problem).toContain('Xcode > Settings > Accounts, sign in + 2FA, then bun run resign kick --force')
    expect(a.problem).toContain('resign.log')
    expect(a.problem).toContain('expires in 60h')
    // A new episode of the same class (new since) is a new key.
    const s2 = st({ episode: { ...s.episode!, since: at(-1) } })
    expect(keys(resignAlerts(s2, at(60), now, awake))).toContain(`resign-fail:account_broken:${at(-1)}`)
  })

  test('a hard episode under 8h left is a priority alert; soft episodes never alert', () => {
    const ep = { class: 'new_certificate' as const, since: at(-1), hard: true, last_at: at(-1), detail: null }
    expect(resignAlerts(st({ episode: ep }), at(7), now, awake).find((a) => a.key.startsWith('resign-fail'))?.priority).toBe('alert')
    const soft = { ...ep, class: 'locked' as const, hard: false }
    expect(keys(resignAlerts(st({ episode: soft }), at(60), now, awake)).some((k) => k.startsWith('resign-fail'))).toBe(false)
  })

  test('clock tiers: one key per local day, highest tier only', () => {
    const s = st()
    const tier = (h: number) => resignAlerts(s, at(h), now, awake).filter((a) => a.key.startsWith('phone-sign'))
    expect(tier(49)).toEqual([])
    expect(keys(tier(47))).toEqual([`phone-sign-expiry:${localDate(now)}`])
    expect(keys(tier(23))).toEqual([`phone-sign-urgent:${localDate(now)}`])
    expect(keys(tier(7))).toEqual([`phone-sign-critical:${localDate(now)}`])
    expect(tier(7)[0].priority).toBe('alert')
    expect(tier(23)[0].priority).toBe('notable')
    expect(keys(tier(-2))).toEqual([`phone-sign-expired:${localDate(now)}`])
    expect(tier(-SIGNING_EXPIRED_NAG_DAYS * 24)).toEqual([])
  })

  test('the 48h tier reports the attempts and the exact advice', () => {
    const s = st({
      counters: {
        ...emptyState().counters,
        since: at(-20),
        attempts: 9,
        locked: 4,
        unreachable: 3,
        blocked: { live_session: 2 },
        last_attempt_at: at(-0.2),
        last_skip_reason: 'locked',
      },
    })
    const a = resignAlerts(s, at(40), now, awake).find((x) => x.key.startsWith('phone-sign-expiry'))!
    expect(a.problem).toContain('Auto re-sign has not landed: 9 attempts since the window opened (locked 4, away 3, blocked 2: live_session)')
    expect(a.problem).toContain('Unlock the phone at home on Wi-Fi and it installs within 15 min')
    expect(a.problem).toContain('bun run resign kick --force')
    expect(a.problem).toContain('Cable fallback: scripts/build-phone.sh install.')
    const u = resignAlerts({ ...s, last_hard_class: 'keychain_prompt' }, at(20), now, awake).find((x) => x.key.startsWith('phone-sign-urgent'))!
    expect(u.problem).toContain('Last hard failure: keychain_prompt')
  })

  test('the clock tiers are the legacy nag\'s job while unhealthy (no double alert)', () => {
    const stale = st({ last_run_at: new Date(now - 3 * H).toISOString() })
    expect(keys(resignAlerts(stale, at(30), now, awake)).some((k) => k.startsWith('phone-sign'))).toBe(false)
    expect(signingNag(at(30), now, { enabled: true, state: stale, daemonAwakeMs: awake })).not.toBeNull()
  })

  test('while pending_confirm is set, every tier says open the app, never reinstall', () => {
    const s = st({
      pending_confirm: {
        staged_run_id: 'r1',
        first_installed_at: at(-1),
        last_installed_at: at(-1),
        expected_until: at(160),
        version: '0.17.4 (7)',
        old_signed_until: at(30),
      },
    })
    for (const h of [40, 20, 6, -1]) {
      const a = resignAlerts(s, at(h), now, awake).filter((x) => x.key.startsWith('phone-sign'))
      expect(a).toHaveLength(1)
      expect(a[0].problem).toContain('installed, unconfirmed: open the app once')
      expect(a[0].problem.toLowerCase()).not.toContain('reinstall')
    }
  })

  test('unconfirmed 6h after the FIRST install, keyed on it', () => {
    const first = at(-7)
    const s = st({
      pending_confirm: { staged_run_id: 'r1', first_installed_at: first, last_installed_at: at(-1), expected_until: at(160), version: 'v', old_signed_until: null },
    })
    expect(keys(resignAlerts(s, at(60), now, awake))).toContain(`resign-unconfirmed:${first}`)
    const young = st({ pending_confirm: { ...s.pending_confirm!, first_installed_at: at(-5) } })
    expect(keys(resignAlerts(young, at(60), now, awake)).some((k) => k.startsWith('resign-unconfirmed'))).toBe(false)
  })

  test('timer_dead: window open, heartbeat over 2h old, daemon awake 45+ min', () => {
    const dead = st({ last_run_at: new Date(now - 3 * H).toISOString() })
    const a = resignAlerts(dead, at(60), now, awake).find((x) => x.key.startsWith('resign-timer-dead'))!
    expect(a.key).toBe(`resign-timer-dead:${localDate(now)}`)
    expect(a.problem).toContain('launchctl print gui/$UID/com.s0nderlabs.health.resign')
    expect(a.problem).toContain('resign.log')
    expect(keys(resignAlerts(dead, at(100), now, awake)).some((k) => k.startsWith('resign-timer-dead'))).toBe(false)
    expect(keys(resignAlerts(dead, at(60), now, RESIGN_AWAKE_MS - 1)).some((k) => k.startsWith('resign-timer-dead'))).toBe(false)
  })

  test('unknown expiry while enabled: one key per stretch, not one per day (regression)', () => {
    expect(keys(resignAlerts(st(), null, now, awake))).toEqual(['resign-unknown-expiry:never'])
    expect(keys(resignAlerts(st(), null, now + 3 * 24 * H, awake))).toEqual(['resign-unknown-expiry:never'])
    const succ = { at: at(-200), expiry: at(-32), cert_sha1: null }
    expect(keys(resignAlerts(st({ last_success: succ }), null, now, awake))).toEqual([`resign-unknown-expiry:${succ.at}`])
  })

  test('a success from the PREVIOUS window never silences the clock tiers (regression)', () => {
    // last_success.expiry IS the current signed_until once the next cycle
    // starts; the tiers must still escalate all the way to expired.
    const signed = at(30)
    const s = st({ last_success: { at: at(-138), expiry: signed, cert_sha1: 'C', window_since: at(-180) } })
    for (const [h, tier] of [[30, 'expiry'], [20, 'urgent'], [5, 'critical'], [-1, 'expired']] as const) {
      const signedUntil = at(h)
      const ss = { ...s, last_success: { ...s.last_success!, expiry: signedUntil } }
      expect(keys(resignAlerts(ss, signedUntil, now, awake).filter((a) => a.key.startsWith('phone-sign')))).toEqual([
        `phone-sign-${tier}:${localDate(now)}`,
      ])
      // ...and the legacy nag still defers (no double alert, no silence).
      expect(signingNag(signedUntil, now, { enabled: true, state: ss, daemonAwakeMs: awake })).toBeNull()
    }
  })

  test('resolved: one line only when something alerted this window', () => {
    const success = { at: new Date(now - H).toISOString(), expiry: at(167), cert_sha1: null, window_since: at(-60) }
    const s = st({ last_success: success })
    expect(keys(resignAlerts(s, at(167), now, awake)).some((k) => k.startsWith('resign-resolved'))).toBe(false)
    let asked: [string, string] | null = null
    const yes = resignAlerts(s, at(167), now, awake, {
      alertedBetween: (f, t) => {
        asked = [f, t]
        return true
      },
    })
    expect(keys(yes)).toEqual([`resign-resolved:${localDate(now - H)}`])
    expect(asked!).toEqual([at(-60), success.at])
    expect(keys(resignAlerts(s, at(167), now, awake, { alertedBetween: () => false }))).toEqual([])
    // A success that already covers the clock silences the tiers.
    expect(keys(resignAlerts(st({ last_success: success }), at(167), now, awake)).some((k) => k.startsWith('phone-sign'))).toBe(false)
  })

  test('no alert string ever contains an emdash (even from tool output)', () => {
    const all: ResignAlert[] = []
    for (const cls of Object.keys(RESIGN_FIX)) {
      const s = st({
        episode: { class: cls as never, since: at(-1), hard: true, last_at: at(-1), detail: 'tool said \u2014 something' },
        last_hard_class: cls as never,
        last_success: { at: new Date(now - H).toISOString(), expiry: at(160), cert_sha1: null },
        pending_confirm: { staged_run_id: 'r', first_installed_at: at(-8), last_installed_at: at(-8), expected_until: at(160), version: 'v', old_signed_until: null },
        last_run_at: new Date(now - 3 * H).toISOString(),
      })
      for (const h of [60, 40, 20, 6, -1]) all.push(...resignAlerts(s, at(h), now, awake, { alertedBetween: () => true }))
      all.push(...resignAlerts({ ...s, pending_confirm: null, last_run_at: new Date(now).toISOString() }, at(20), now, awake))
    }
    all.push(...resignAlerts(st(), null, now, awake))
    expect(all.length).toBeGreaterThan(50)
    for (const a of all) expect(a.problem.includes('\u2014')).toBe(false)
    for (const h of [30, -3]) expect(signingNag(at(h), now)!.problem.includes('\u2014')).toBe(false)
  })
})

describe('review regressions (v0.18.0)', () => {
  test('at exactly 8.0h the hard-episode alert and the critical tier agree: both priority alert', () => {
    const since = at(-2)
    const s = st({ episode: { class: 'account_broken', since, hard: true, last_at: since, detail: null } })
    const out = resignAlerts(s, at(8), now, awake)
    const fail = out.find((x) => x.key.startsWith('resign-fail'))!
    const clock = out.find((x) => x.key.startsWith('phone-sign'))!
    expect(clock.key).toBe(`phone-sign-critical:${localDate(now)}`)
    expect(clock.priority).toBe('alert')
    expect(fail.priority).toBe('alert')
  })
})
