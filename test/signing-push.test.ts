import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import {
  PUSH_BODY_MAX,
  RESIGN_AWAKE_MS,
  RESIGN_FIX,
  RESIGN_FIX_SHORT,
  localDate,
  loudSigningPush,
  pushClock,
  resignAlerts,
  signingNag,
  type SigningPush,
} from '../src/signing.js'
import {
  ACK_REASON_ADD_FAILED,
  MAC_MAX_ATTEMPTS,
  MAC_NOTIFY_TIMEOUT_MS,
  PUSH_ACKED_META,
  PUSH_LEDGER_TTL_MS,
  PUSH_MAC_META,
  SigningPushDelivery,
  appleScriptString,
  macNotifyArgv,
  parseLedger,
  planSigningDelivery,
  pruneLedger,
} from '../src/signing-push.js'
import type { ExecFn, ExecOptions, ExecResult } from '../src/resign/exec.js'
import { emptyState, type ResignState } from '../src/resign/state.js'

const H = 3_600_000
const now = Date.parse('2026-11-16T03:00:00Z')
const at = (hours: number) => new Date(now + hours * H).toISOString()
const awake = RESIGN_AWAKE_MS + 60_000
const day = localDate(now)

function st(over: Partial<ResignState> = {}): ResignState {
  return { ...emptyState(), enabled: true, dry_run: false, last_run_at: new Date(now - 10 * 60_000).toISOString(), ...over }
}

/** Exactly the watchdog's composition: legacy nag + resignAlerts -> pushes. */
function watchdog(signedUntil: string | null, state: ResignState | null, enabled = true): SigningPush[] {
  const nag = signingNag(signedUntil, now, { enabled, state, daemonAwakeMs: awake })
  const alerts = resignAlerts(state, signedUntil, now, awake, { enabled })
  return loudSigningPush(nag ? [nag, ...alerts] : alerts, signedUntil, now)
}

const hard = (cls: string) => st({ episode: { class: cls as never, since: at(-1), hard: true, last_at: at(-1), detail: null } })

describe('loud push policy', () => {
  test('the 48h tier stays channel-only', () => {
    expect(watchdog(at(30), st())).toEqual([])
    expect(watchdog(at(47), st())).toEqual([])
    expect(watchdog(at(24.1), st())).toEqual([])
    // The legacy nag (feature off) in its 48h band: channel only too.
    expect(watchdog(at(30), null, false)).toEqual([])
  })

  test('urgent (<=24h) is loud, keyed by the tier key', () => {
    const p = watchdog(at(20), st())
    expect(p).toHaveLength(1)
    expect(p[0].id).toBe(`phone-sign-urgent:${at(20)}`)
    expect(p[0].level).toBe('loud')
    expect(p[0].title).toBe('elpabl0s signature')
    expect(p[0].body).toContain('20h')
    expect(p[0].body).toContain(pushClock(at(20))!)
    expect(p[0].body).toContain('Unlock your phone at home on Wi-Fi')
    expect(watchdog(at(24), st())[0].id).toBe(`phone-sign-urgent:${at(24)}`)
  })

  test('critical (<=8h) and expired are level critical', () => {
    const c = watchdog(at(5), st())
    expect(c.map((x) => [x.id, x.level])).toEqual([[`phone-sign-critical:${at(5)}`, 'critical']])
    const e = watchdog(at(-3), st())
    expect(e.map((x) => [x.id, x.level])).toEqual([[`phone-sign-expired:${at(-3)}`, 'critical']])
    expect(e[0].body).toContain('expired 3h ago')
  })

  test('the legacy nag (feature off) pushes per tier too, with the reinstall action', () => {
    const u = watchdog(at(20), null, false)
    expect(u.map((x) => [x.id, x.level])).toEqual([[`phone-sign-urgent:${at(20)}`, 'loud']])
    expect(u[0].body).toContain('build-phone.sh install')
    // Its unowned key is one daily key for every tier; the push id is per
    // tier, so an urgent -> critical escalation is a new banner.
    expect(watchdog(at(5), null, false)[0].id).toBe(`phone-sign-critical:${at(5)}`)
    expect(watchdog(at(-2), null, false)[0].id).toBe(`phone-sign-expired:${at(-2)}`)
  })

  test('pending confirm: the action is to open the app', () => {
    const s = st({ pending_confirm: { first_installed_at: at(-1), version: '0.17.0 (6)' } as never })
    const p = watchdog(at(6), s)
    expect(p[0].body).toContain('Open elpabl0s once')
  })

  test('a hard episode is loud only at <=24h, level by hours left', () => {
    expect(watchdog(at(30), hard('keychain_prompt'))).toEqual([])
    const loud = watchdog(at(20), hard('keychain_prompt'))
    const fail = loud.find((x) => x.id.startsWith('resign-fail:'))!
    expect(fail.id).toBe(`resign-fail:keychain_prompt:${at(-1)}`)
    expect(fail.level).toBe('loud')
    expect(fail.title).toBe('elpabl0s: re-sign failed')
    expect(fail.body).toContain('keychain_prompt')
    expect(fail.body).toContain('20h left')
    expect(fail.body).toContain('Always Allow')
    // The clock tier rides alongside: two distinct banners.
    expect(loud.map((x) => x.id).sort()).toEqual([`phone-sign-urgent:${at(20)}`, fail.id].sort())
    expect(watchdog(at(4), hard('account_broken')).find((x) => x.id.startsWith('resign-fail:'))!.level).toBe('critical')
  })

  test('soft skips, timer-dead, unconfirmed and resolved never push', () => {
    const pushes = loudSigningPush(
      [
        { key: `resign-timer-dead:${day}`, problem: 'x' },
        { key: 'resign-unknown-expiry:never', problem: 'x' },
        { key: `resign-unconfirmed:${at(-7)}`, problem: 'x' },
        { key: `resign-resolved:${day}`, problem: 'x' },
      ],
      at(3),
      now,
    )
    expect(pushes).toEqual([])
  })

  test('unknown expiry never pushes', () => {
    expect(loudSigningPush([{ key: `resign-fail:other:${at(-1)}`, problem: 'x' }], null, now)).toEqual([])
  })

  test('every body is phone length with no emdash, for every class and tier', () => {
    expect(Object.keys(RESIGN_FIX_SHORT).sort()).toEqual(Object.keys(RESIGN_FIX).sort())
    const bodies: string[] = []
    for (const cls of Object.keys(RESIGN_FIX)) {
      for (const h of [23.9, 7.9, -150.5]) bodies.push(...watchdog(at(h), hard(cls)).map((p) => p.body))
    }
    for (const h of [23.9, 7.9, -150.5]) bodies.push(...watchdog(at(h), null, false).map((p) => p.body))
    expect(bodies.length).toBeGreaterThan(40)
    for (const b of bodies) {
      expect(b.length).toBeLessThanOrEqual(PUSH_BODY_MAX)
      expect(b).not.toContain('\u2014')
      expect(b.endsWith('...')).toBe(false) // fits without truncation
    }
    // An unknown class falls back, an emdash in a problem never leaks.
    const odd = loudSigningPush([{ key: `resign-fail:weird_new_class:${at(-1)}`, problem: 'a \u2014 b' }], at(3), now)
    expect(odd[0].body).toContain('read the re-sign run log')
  })

  test('a clock tier keeps its id across local midnight; a new signature starts fresh', () => {
    // 23:00 local, signature 20h out; three hours later it is 02:00 the next
    // local day (any timezone) but the tier and the signature have not moved.
    const d0 = new Date(now)
    d0.setHours(23, 0, 0, 0)
    const t0 = d0.getTime()
    const until = new Date(t0 + 20 * H).toISOString()
    const alerts = [{ key: `phone-sign-urgent:${localDate(t0)}`, problem: 'x' }]
    const before = loudSigningPush(alerts, until, t0)
    const later = t0 + 3 * H
    expect(localDate(later)).not.toBe(localDate(t0))
    const after = loudSigningPush([{ key: `phone-sign-urgent:${localDate(later)}`, problem: 'x' }], until, later)
    expect(after[0].id).toBe(before[0].id)
    expect(after[0].id).toBe(`phone-sign-urgent:${until}`)
    // A reinstall that still lands in the urgent tier is a new signature.
    expect(loudSigningPush(alerts, new Date(t0 + 21 * H).toISOString(), t0)[0].id).not.toBe(before[0].id)
  })

  test('nothing pushes once dead for 7 days, a hard episode included', () => {
    const ep = [{ key: `resign-fail:account_broken:${at(-200)}`, problem: 'x' }]
    expect(loudSigningPush(ep, at(-167.9), now).map((p) => p.id)).toEqual([ep[0].key])
    expect(loudSigningPush(ep, at(-168), now)).toEqual([])
    expect(loudSigningPush(ep, at(-24 * 30), now)).toEqual([])
  })

  test('pushClock labels WIB only on a WIB clock', () => {
    expect(pushClock(at(1), -420)).toMatch(/^\d\d:\d\d WIB$/)
    expect(pushClock(at(1), 0)).toMatch(/^\d\d:\d\d$/)
    expect(pushClock(null)).toBeNull()
  })
})

// ── Delivery ──────────────────────────────────────────────────────

const P = (id: string): SigningPush => ({ id, title: 'elpabl0s signature', body: `body ${id}`, level: 'loud' })

function harness(opts: { phones?: number; exec?: ExecFn; meta?: Map<string, string>; clock?: { t: number } } = {}) {
  const meta = opts.meta ?? new Map<string, string>()
  const sent: Record<string, unknown>[] = []
  const calls: Array<{ argv: string[]; opts: ExecOptions }> = []
  const logs: string[] = []
  const ok: ExecResult = { code: 0, stdout: '', stderrTail: '', tail: '', timedOut: false, idledOut: false }
  const exec: ExecFn =
    opts.exec ??
    (async (argv, o) => {
      calls.push({ argv, opts: o })
      return ok
    })
  const clock = opts.clock ?? { t: now }
  const d = new SigningPushDelivery({
    getMeta: (k) => meta.get(k) ?? null,
    setMeta: (k, v) => void meta.set(k, v),
    pushPhone: (obj) => {
      const n = opts.phones ?? 1
      if (n > 0) sent.push(obj)
      return n
    },
    exec,
    log: (m) => logs.push(m),
    now: () => clock.t,
  })
  return { d, meta, sent, calls, logs, clock }
}

describe('signing push delivery', () => {
  test('planSigningDelivery: phone = not acked, mac = never posted', () => {
    const plan = planSigningDelivery([P('a'), P('b'), P('c')], { a: at(0) }, { b: at(0) })
    expect(plan.phone.map((p) => p.id)).toEqual(['b', 'c'])
    expect(plan.mac.map((p) => p.id)).toEqual(['a', 'c'])
  })

  test('phone resends every tick until acked; the Mac posts once per id', async () => {
    const h = harness()
    await h.d.tick([P('x')])
    await h.d.tick([P('x')])
    expect(h.sent).toHaveLength(2)
    expect(h.sent[0]).toEqual({ type: 'notify', id: 'x', title: 'elpabl0s signature', body: 'body x', level: 'loud' })
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0].opts.timeoutMs).toBe(MAC_NOTIFY_TIMEOUT_MS)
    expect(h.calls[0].argv[0]).toBe('/usr/bin/osascript')
    h.d.onAck('x', true)
    await h.d.tick([P('x')])
    expect(h.sent).toHaveLength(2) // done
    // A new id starts its own cycle.
    await h.d.tick([P('x'), P('y')])
    expect(h.sent.map((m) => m.id)).toEqual(['x', 'x', 'y'])
    expect(h.calls).toHaveLength(2)
  })

  test('an ack with shown=false still ends the resends (permission off), and is logged', async () => {
    const h = harness()
    await h.d.tick([P('x')])
    h.d.onAck('x', false)
    await h.d.tick([P('x')])
    expect(h.sent).toHaveLength(1)
    expect(h.logs.some((l) => l.includes('NOT shown'))).toBe(true)
  })

  test('no phone connected: nothing sent, still unacked, the Mac still posts', async () => {
    const h = harness({ phones: 0 })
    const r = await h.d.tick([P('x')])
    expect(r.phoneSent).toBe(0)
    expect(r.macPosted).toEqual(['x'])
    expect(parseLedger(h.meta.get(PUSH_ACKED_META))).toEqual({})
  })

  test('the ledgers survive a restart: no second Mac banner, acks remembered', async () => {
    const meta = new Map<string, string>()
    const a = harness({ meta })
    await a.d.tick([P('x')])
    a.d.onAck('x', true)
    const b = harness({ meta })
    await b.d.tick([P('x')])
    expect(b.sent).toHaveLength(0)
    expect(b.calls).toHaveLength(0)
  })

  test('a definite Mac failure or throw is retried, bounded; never thrown', async () => {
    let n = 0
    const failing: ExecFn = async () => {
      n++
      return { code: 1, stdout: '', stderrTail: 'boom', tail: 'boom', timedOut: false, idledOut: false }
    }
    const h = harness({ exec: failing })
    for (let i = 0; i < MAC_MAX_ATTEMPTS + 3; i++) await h.d.tick([P('x')])
    expect(n).toBe(MAC_MAX_ATTEMPTS)
    expect(h.logs.some((l) => l.includes('failed (exit 1: boom)') && l.includes('retried next tick'))).toBe(true)
    expect(h.logs.some((l) => l.includes('giving up'))).toBe(true)
    // After giving up the id stays marked: no further attempts.
    expect('x' in parseLedger(h.meta.get(PUSH_MAC_META))).toBe(true)

    let m = 0
    const spawnFail: ExecFn = async () => {
      m++
      return { code: null, stdout: '', stderrTail: '', tail: '', timedOut: false, idledOut: false, spawnError: 'ENOENT' }
    }
    const s = harness({ exec: spawnFail })
    await s.d.tick([P('x')])
    await s.d.tick([P('x')])
    expect(m).toBe(2)

    // A failure then a success: posted once, never again.
    let k = 0
    const flaky: ExecFn = async () => {
      k++
      return k === 1
        ? { code: 1, stdout: '', stderrTail: 'busy', tail: 'busy', timedOut: false, idledOut: false }
        : { code: 0, stdout: '', stderrTail: '', tail: '', timedOut: false, idledOut: false }
    }
    const f = harness({ exec: flaky })
    expect((await f.d.tick([P('x')])).macPosted).toEqual([])
    expect((await f.d.tick([P('x')])).macPosted).toEqual(['x'])
    await f.d.tick([P('x')])
    expect(k).toBe(2)

    const throwing: ExecFn = async () => {
      throw new Error('spawn exploded')
    }
    const t = harness({ exec: throwing })
    await expect(t.d.tick([P('y')])).resolves.toEqual({ phoneSent: 1, macPosted: [] })
    expect(t.logs.some((l) => l.includes('spawn exploded'))).toBe(true)
  })

  test('a Mac timeout may have posted: never retried', async () => {
    let n = 0
    const slow: ExecFn = async () => {
      n++
      return { code: null, stdout: '', stderrTail: '', tail: '', timedOut: true, idledOut: false }
    }
    const h = harness({ exec: slow })
    await h.d.tick([P('x')])
    await h.d.tick([P('x')])
    expect(n).toBe(1)
    expect(h.logs.some((l) => l.includes('timed out, not retried'))).toBe(true)
  })

  test('phoneOnly (the hello resend): unacked phone pushes only, the Mac untouched', async () => {
    const h = harness()
    const r = await h.d.tick([P('x'), P('y')], { phoneOnly: true })
    expect(r).toEqual({ phoneSent: 2, macPosted: [] })
    expect(h.calls).toHaveLength(0)
    expect(h.meta.get(PUSH_MAC_META)).toBeUndefined()
    h.d.onAck('x', true)
    await h.d.tick([P('x'), P('y')], { phoneOnly: true })
    expect(h.sent.map((m) => m.id)).toEqual(['x', 'y', 'y'])
    // The next real tick still posts the Mac once per id.
    await h.d.tick([P('x'), P('y')])
    expect(h.calls).toHaveLength(2)
  })

  test('a live id is never pruned from the ledgers (no re-post after 10 days)', async () => {
    const old = new Date(now - PUSH_LEDGER_TTL_MS - H).toISOString()
    const meta = new Map<string, string>([
      [PUSH_ACKED_META, JSON.stringify({ live: old, gone: old })],
      [PUSH_MAC_META, JSON.stringify({ live: old, gone: old })],
    ])
    const h = harness({ meta })
    await h.d.tick([P('live')])
    expect(h.sent).toHaveLength(0)
    expect(h.calls).toHaveLength(0)
    expect(Object.keys(parseLedger(meta.get(PUSH_MAC_META)))).toEqual(['live'])
    expect(Object.keys(parseLedger(meta.get(PUSH_ACKED_META)))).toEqual(['live'])
  })

  test('ack reasons: add_failed is resent, permission off is recorded and surfaced', async () => {
    const notShown: Array<[string, string | null]> = []
    const meta = new Map<string, string>()
    const sent: Record<string, unknown>[] = []
    const d = new SigningPushDelivery({
      getMeta: (k) => meta.get(k) ?? null,
      setMeta: (k, v) => void meta.set(k, v),
      pushPhone: (obj) => (sent.push(obj), 1),
      exec: async () => ({ code: 0, stdout: '', stderrTail: '', tail: '', timedOut: false, idledOut: false }),
      log: () => {},
      onPhoneNotShown: (id, reason) => void notShown.push([id, reason]),
      now: () => now,
    })
    await d.tick([P('x')])
    d.onAck('x', false, ACK_REASON_ADD_FAILED)
    expect(parseLedger(meta.get(PUSH_ACKED_META))).toEqual({})
    expect(notShown).toEqual([])
    await d.tick([P('x')])
    expect(sent.map((m) => m.id)).toEqual(['x', 'x'])
    d.onAck('x', false, 'no_permission')
    expect('x' in parseLedger(meta.get(PUSH_ACKED_META))).toBe(true)
    expect(notShown).toEqual([['x', 'no_permission']])
    // A duplicate ack surfaces nothing twice; an old build (no reason) counts.
    d.onAck('x', false, 'no_permission')
    d.onAck('y', false)
    expect(notShown).toEqual([['x', 'no_permission'], ['y', null]])
    d.onAck('z', true)
    expect(notShown).toHaveLength(2)
  })

  test('ledgers prune entries older than 10 days and tolerate garbage', async () => {
    const meta = new Map<string, string>([
      [PUSH_ACKED_META, JSON.stringify({ old: new Date(now - PUSH_LEDGER_TTL_MS - 1).toISOString(), fresh: at(-1) })],
      [PUSH_MAC_META, 'not json'],
    ])
    const h = harness({ meta })
    await h.d.tick([P('other')])
    expect(Object.keys(parseLedger(meta.get(PUSH_ACKED_META)))).toEqual(['fresh'])
    expect(h.sent.map((m) => m.id)).toEqual(['other'])
    expect(parseLedger('[1,2]')).toEqual({})
    expect(parseLedger(JSON.stringify({ a: 'nope', b: at(0) }))).toEqual({ b: at(0) })
    expect(pruneLedger({ a: at(-1) }, now)).toEqual({ a: at(-1) })
  })

  test('a malformed ack id is ignored', () => {
    const h = harness()
    h.d.onAck('', true)
    h.d.onAck('z'.repeat(201), true)
    expect(h.meta.get(PUSH_ACKED_META)).toBeUndefined()
  })
})

describe('AppleScript escaping', () => {
  test('quotes, backslashes and newlines', () => {
    expect(appleScriptString('plain')).toBe('"plain"')
    expect(appleScriptString('say "hi"')).toBe('"say \\"hi\\""')
    expect(appleScriptString('a\\b')).toBe('"a\\\\b"')
    expect(appleScriptString('a\\"b')).toBe('"a\\\\\\"b"')
    expect(appleScriptString('one\ntwo\r\nthree')).toBe('"one two three"')
  })

  test('the notification argv', () => {
    const argv = macNotifyArgv({ title: 'T "q"', body: 'B \\ x' })
    expect(argv).toEqual([
      '/usr/bin/osascript',
      '-e',
      'display notification "B \\\\ x" with title "T \\"q\\"" sound name "Glass"',
    ])
  })

  // Round-trips through the real AppleScript parser with `return`, which
  // only evaluates the literal: no notification is ever posted.
  test.skipIf(!existsSync('/usr/bin/osascript'))('the escaped literal round-trips through osascript', () => {
    const nasty = 'He said "unlock" \\ at C:\\path\\ "end"\\'
    const r = Bun.spawnSync(['/usr/bin/osascript', '-e', `return ${appleScriptString(nasty)}`], { stdout: 'pipe' })
    expect(r.exitCode).toBe(0)
    expect(new TextDecoder().decode(r.stdout).replace(/\n$/, '')).toBe(nasty)
  })
})
