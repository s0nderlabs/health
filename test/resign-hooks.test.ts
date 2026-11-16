import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  HELLO_KICK_DELAY_MS,
  HELLO_KICK_MIN_GAP_MS,
  HelloKicker,
  blockerInputFrom,
  buildPreflight,
  helloKickDecision,
  lastIntentTs,
  resignStatus,
  type LiveStatusLike,
} from '../src/resign/hooks.js'
import { DEFAULT_RESIGN, installBlocker, resolveResignConfig } from '../src/resign/policy.js'
import { emptyState, type ResignState } from '../src/resign/state.js'
import { oneShotRpc, readDbClock } from '../src/resign/rpc.js'
import { IpcServer } from '../src/ipc.js'
import { resignPlist, versionFromProjectYml, parseArgs } from '../scripts/resign.js'
import { DEFAULT_CONFIG } from '../src/types.js'

const H = 3_600_000
const now = Date.parse('2026-11-20T10:00:00Z')
const iso = (ms: number) => new Date(ms).toISOString()
const cfg = { ...DEFAULT_RESIGN, enabled: true, device_udid: '00000000-000A000000000001' }

const live = (o: Partial<LiveStatusLike> = {}): LiveStatusLike => ({
  active_source: 'mac',
  relayers: [
    { source: 'mac', band_seen_ago_s: 1 },
    { source: 'iphone', band_seen_ago_s: 2 },
  ],
  yield: { active: false },
  ...o,
})

const input = (o: Partial<Parameters<typeof blockerInputFrom>[0]> = {}) =>
  blockerInputFrom({
    now,
    hoursLeft: 40,
    liveSessionOpen: false,
    intentLogRaw: null,
    lastScoredWorkoutAt: null,
    lastRestAt: null,
    live: live(),
    ...o,
  })

describe('daemon preflight wiring (pure)', () => {
  test('lastIntentTs takes the newest entry; junk is null', () => {
    expect(lastIntentTs(JSON.stringify([{ ts: iso(now - 2 * H) }, { ts: iso(now - H) }, { ts: 'x' }]))).toBe(iso(now - H))
    expect(lastIntentTs('not json')).toBeNull()
    expect(lastIntentTs(null)).toBeNull()
  })

  test('a dual hold with the Mac writing does NOT block; the phone writing does', () => {
    expect(installBlocker(input())).toBeNull()
    expect(installBlocker(input({ live: live({ active_source: 'iphone' }) }))?.reason).toBe('phone_writer')
    // ...unless critical.
    expect(installBlocker(input({ hoursLeft: 6, live: live({ active_source: 'iphone' }) }))).toBeNull()
  })

  test('open session, fresh intent, recent rest, yield', () => {
    expect(installBlocker(input({ liveSessionOpen: true }))?.reason).toBe('live_session')
    const log = JSON.stringify([{ ts: iso(now - H), activity: 'lift' }])
    expect(installBlocker(input({ intentLogRaw: log }))?.reason).toBe('recent_intent')
    expect(installBlocker(input({ intentLogRaw: log, lastScoredWorkoutAt: iso(now - 10 * 60_000) }))).toBeNull()
    expect(installBlocker(input({ lastRestAt: iso(now - 30 * 60_000) }))?.reason).toBe('recent_rest')
    expect(installBlocker(input({ live: live({ yield: { active: true } }) }))?.reason).toBe('yield')
  })

  test('buildPreflight carries the clock, the blocker and the switches', () => {
    const pf = buildPreflight({
      signedUntil: iso(now + 40 * H),
      hoursLeft: 40,
      phoneVersion: '0.17.4 (7)',
      phoneLastSeen: iso(now),
      phoneHelloAt: iso(now - H),
      blockerInput: input({ liveSessionOpen: true }),
      cfg,
      systemHealthEnabled: true,
    })
    expect(pf).toEqual({
      signed_until: iso(now + 40 * H),
      hours_left: 40,
      phone_app_version: '0.17.4 (7)',
      phone_last_seen: iso(now),
      phone_hello_at: iso(now - H),
      blocker: { reason: 'live_session', overridable: false },
      system_health_enabled: true,
      resign_enabled: true,
    })
  })
})

describe('hello kick', () => {
  const staged = (o: Partial<ResignState> = {}): ResignState => ({
    ...emptyState(),
    enabled: true,
    staged: {
      run_id: 'r1',
      app_path: '/x',
      app_expiry: iso(now + 160 * H),
      widget_expiry: iso(now + 160 * H),
      version: 'v',
      profile_uuids: [],
      cert_sha1: null,
      cert_changed: false,
      staged_at: iso(now),
    },
    ...o,
  })
  const base = { cfg, state: staged(), hoursLeft: 40, blocker: null, lastKickAt: null, now }

  test('decision table', () => {
    expect(helloKickDecision(base)).toEqual({ kick: true })
    expect(helloKickDecision({ ...base, cfg: { ...cfg, enabled: false } })).toEqual({ kick: false, reason: 'disabled' })
    expect(helloKickDecision({ ...base, cfg: { ...cfg, install_on_hello: false } }).kick).toBe(false)
    expect(helloKickDecision({ ...base, state: staged({ staged: null }) })).toEqual({ kick: false, reason: 'nothing_staged' })
    expect(helloKickDecision({ ...base, hoursLeft: 73 })).toEqual({ kick: false, reason: 'window_closed' })
    expect(helloKickDecision({ ...base, hoursLeft: null }).kick).toBe(false)
    expect(helloKickDecision({ ...base, blocker: { reason: 'yield', overridable: true } })).toEqual({ kick: false, reason: 'blocked:yield' })
    expect(helloKickDecision({ ...base, lastKickAt: now - HELLO_KICK_MIN_GAP_MS + 1 })).toEqual({ kick: false, reason: 'recent_kick' })
    expect(helloKickDecision({ ...base, lastKickAt: now - HELLO_KICK_MIN_GAP_MS - 1 })).toEqual({ kick: true })
    const pending = staged({
      pending_confirm: { staged_run_id: 'r1', first_installed_at: iso(now), last_installed_at: iso(now), expected_until: iso(now), version: 'v', old_signed_until: null },
    })
    expect(helloKickDecision({ ...base, state: pending })).toEqual({ kick: false, reason: 'pending_confirm' })
  })

  test('HelloKicker: delayed, debounced, evaluated at fire time, gap enforced via lastKickAt', () => {
    const timers: Array<{ fn: () => void; ms: number }> = []
    let kicks = 0
    let t = now
    let decision: ReturnType<typeof helloKickDecision> = { kick: true }
    const k: HelloKicker = new HelloKicker({
      evaluate: () => decision,
      kick: () => kicks++,
      now: () => t,
      setTimer: (fn, ms) => timers.push({ fn, ms }),
    })
    k.onHello()
    k.onHello() // absorbed while pending
    expect(timers).toHaveLength(1)
    expect(timers[0].ms).toBe(HELLO_KICK_DELAY_MS)
    t += HELLO_KICK_DELAY_MS
    timers.shift()!.fn()
    expect(kicks).toBe(1)
    expect(k.lastKickAt).toBe(t)
    decision = { kick: false, reason: 'recent_kick' }
    k.onHello()
    timers.shift()!.fn()
    expect(kicks).toBe(1)
  })
})

describe('status block and config', () => {
  test('resignStatus is compact and never carries the udid', () => {
    const s = resignStatus({ ...emptyState(), enabled: true, last_run_at: iso(now - 30 * 60_000), last_outcome: 'noop' }, cfg, now)
    expect(s.enabled).toBe(true)
    expect(s.last_run_ago_min).toBe(30)
    expect(s.device_udid_set).toBe(true)
    expect(JSON.stringify(s)).not.toContain(cfg.device_udid)
    expect(resignStatus(null, DEFAULT_RESIGN, now).state).toBe('none')
  })

  test('a partial resign patch merges field by field over the current block', () => {
    const cur = { ...cfg, window_hours: 60 }
    const merged = resolveResignConfig({ enabled: false }, cur)
    expect(merged).toEqual({ ...cur, enabled: false })
  })

  test('the default config carries a disabled resign block with no udid', () => {
    expect(DEFAULT_CONFIG.resign).toEqual({ ...DEFAULT_RESIGN, enabled: false, device_udid: null })
  })
})

describe('one-shot RPC and the db fallback', () => {
  let dir: string
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'health-resign-rpc-'))
  })
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('connects, calls once, returns the data; errors and timeouts are values', async () => {
    const sock = join(dir, 'd.sock')
    const server = new IpcServer(sock, {
      onRpc: async (m) => {
        if (m === 'resign_preflight') return { hours_left: 40 }
        if (m === 'slow') return new Promise(() => {})
        throw new Error('nope')
      },
      onAck: () => {},
      onSubscriberConnected: () => {},
    })
    server.start()
    try {
      expect(await oneShotRpc(sock, 'resign_preflight')).toEqual({ ok: true, data: { hours_left: 40 } })
      expect(await oneShotRpc(sock, 'other')).toEqual({ ok: false, error: 'nope' })
      const slow = await oneShotRpc(sock, 'slow', {}, 200)
      expect(slow.ok).toBe(false)
      expect(server.subscriberCount()).toBe(0) // events:false, never a subscriber
    } finally {
      server.stop()
    }
    const down = await oneShotRpc(join(dir, 'missing.sock'), 'resign_preflight', {}, 1000)
    expect(down.ok).toBe(false)
  })

  test('readDbClock reads meta read-only; a missing db is null', () => {
    const path = join(dir, 'h.db')
    const db = new Database(path)
    db.run('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)')
    db.run("INSERT INTO meta VALUES ('phone_app_signed_until', '2026-11-22T00:00:00Z'), ('phone_app_version', '0.17.4 (7)')")
    db.close()
    expect(readDbClock(path)).toEqual({ signed_until: '2026-11-22T00:00:00Z', phone_app_version: '0.17.4 (7)', phone_hello_at: null })
    expect(readDbClock(join(dir, 'nope.db'))).toBeNull()
  })
})

describe('resign CLI pure pieces', () => {
  test('the agent plist', () => {
    const p = resignPlist({ bunPath: '/opt/homebrew/bin/bun', repo: '/repo', logPath: '/logs/launchd.log' })
    expect(p).toContain('<string>com.s0nderlabs.health.resign</string>')
    expect(p).toContain('<string>/repo/scripts/resign.ts</string>')
    expect(p).toMatch(/<key>StartInterval<\/key>\s*<integer>900<\/integer>/)
    expect(p).toMatch(/<key>RunAtLoad<\/key>\s*<false\/>/)
    expect(p).toMatch(/<key>ProcessType<\/key>\s*<string>Standard<\/string>/)
    expect(p).toMatch(/<key>Nice<\/key>\s*<integer>5<\/integer>/)
    expect(p).toContain('/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin')
    expect(p).toMatch(/<key>StandardOutPath<\/key>\s*<string>\/logs\/launchd.log<\/string>/)
    expect(p).not.toContain('AbandonProcessGroup')
    expect(p).not.toContain('KeepAlive')
  })

  test('version from project.yml (the app target, first)', () => {
    expect(versionFromProjectYml('a:\n        MARKETING_VERSION: "0.17.4"\n        CURRENT_PROJECT_VERSION: "7"\n        MARKETING_VERSION: "9.9.9"\n')).toBe('0.17.4 (7)')
    expect(versionFromProjectYml('nothing')).toBeNull()
  })

  test('args', () => {
    expect(parseArgs(['seed', '--ref', 'abc'])).toEqual({ cmd: 'seed', flags: new Set(), ref: 'abc' })
    const k = parseArgs(['kick', '--force', '--build-only'])
    expect([...k.flags]).toEqual(['--force', '--build-only'])
  })
})
