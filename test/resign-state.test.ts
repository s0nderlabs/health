import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  acquireLock,
  emptyState,
  makeRunId,
  mergeStatePreservingPending,
  normalizeState,
  ownerStale,
  paths,
  pidAlive,
  readOwner,
  readState,
  updateState,
  writeState,
  type PendingConfirm,
} from '../src/resign/state.js'
import { LOCK_STALE_MS } from '../src/resign/policy.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'health-resign-'))
const STATE_TS = join(import.meta.dir, '..', 'src', 'resign', 'state.ts')

describe('paths', () => {
  test('derived from the given home, never hard-coded', () => {
    const p = paths('/home/placeholder')
    expect(p.base).toBe('/home/placeholder/Library/Application Support/health-resign')
    expect(p.lockDir).toBe('/home/placeholder/Library/Application Support/health-resign/run.lock')
    expect(p.sourceDir).toBe('/home/placeholder/Library/Application Support/health-resign/source/relayer-ios')
    expect(p.stagingCurrent).toBe('/home/placeholder/Library/Application Support/health-resign/staging/current.json')
    expect(p.stateFile).toBe('/home/placeholder/.claude/channels/health/resign/state.json')
    expect(p.jsonlFile).toBe('/home/placeholder/.claude/channels/health/resign/resign.jsonl')
    expect(p.profileDirs[0]).toBe('/home/placeholder/Library/Developer/Xcode/UserData/Provisioning Profiles')
    // Nothing the build touches lives under a TCC-protected folder.
    for (const v of [p.base, p.sourceDir, p.derivedData, p.staging, p.profileBackups, p.runtime]) {
      expect(v).not.toMatch(/\/(Documents|Desktop|Downloads)\//)
    }
  })

  test('makeRunId is local YYYYMMDD-HHMMSS', () => {
    expect(makeRunId(new Date(2026, 10, 6, 3, 4, 5))).toBe('20261106-030405')
  })
})

describe('state file', () => {
  test('missing and corrupt read as null, never a throw', () => {
    const dir = tmp()
    expect(readState(join(dir, 'nope.json'))).toBeNull()
    writeFileSync(join(dir, 'bad.json'), '{"enabled": tru')
    expect(readState(join(dir, 'bad.json'))).toBeNull()
    writeFileSync(join(dir, 'arr.json'), '[1,2]')
    expect(readState(join(dir, 'arr.json'))).toBeNull()
  })

  test('round trip, atomic (no tmp left behind), parent dir created', () => {
    const dir = tmp()
    const file = join(dir, 'deep', 'state.json')
    const s = { ...emptyState(), enabled: true, last_run_at: '2026-11-16T03:00:00.000Z', hours_left: 61.5 }
    s.counters.blocked.live_session = 2
    writeState(file, s)
    expect(readState(file)).toEqual(s)
    expect(readdirSync(join(dir, 'deep'))).toEqual(['state.json'])
  })

  test('partial or older files are filled from defaults; wrong types are dropped', () => {
    const n = normalizeState({ enabled: true, dry_run: 'yes', counters: { locked: 3 }, streaks: { install_failed: 2 } })!
    expect(n.enabled).toBe(true)
    expect(n.dry_run).toBe(false)
    expect(n.counters.locked).toBe(3)
    expect(n.counters.unreachable).toBe(0)
    expect(n.counters.blocked).toEqual({})
    expect(n.streaks).toEqual({ profile_not_fresh: 0, install_failed: 2, run_timeout: 0, lockstate_unknown: 0 })
    expect(n.pending_confirm).toBeNull()
    expect(n.schema).toBe(1)
  })

  test('updateState starts from empty when the file is absent', () => {
    const file = join(tmp(), 'state.json')
    const s = updateState(file, (x) => ({ ...x, last_outcome: 'noop' }))
    expect(s.last_outcome).toBe('noop')
    expect(readState(file)?.last_outcome).toBe('noop')
  })

  test('the watchdog merge never overwrites pending_confirm', () => {
    const file = join(tmp(), 'state.json')
    const pending: PendingConfirm = {
      staged_run_id: '20261116-030000',
      first_installed_at: '2026-11-16T09:00:00.000Z',
      last_installed_at: '2026-11-16T09:00:00.000Z',
      expected_until: '2026-11-23T03:00:00.000Z',
      version: '0.17.4 (7)',
      old_signed_until: '2026-11-18T10:00:00.000Z',
    }
    writeState(file, { ...emptyState(), pending_confirm: pending })
    const after = mergeStatePreservingPending(file, { last_outcome: 'run_timeout', pending_confirm: null })
    expect(after.last_outcome).toBe('run_timeout')
    expect(after.pending_confirm).toEqual(pending)
    expect(readState(file)?.pending_confirm).toEqual(pending)
  })
})

describe('mkdir lock', () => {
  const now = Date.parse('2026-11-16T10:00:00Z')

  test('first taker wins, second is busy while the owner is alive and young', () => {
    const lockDir = join(tmp(), 'run.lock')
    const a = acquireLock(lockDir, { pid: 1001, now, isAlive: () => true, holder: 'resign', runId: 'R1' })
    expect(a.ok).toBe(true)
    if (!a.ok) return
    expect(a.took_over).toBe(false)
    expect(readOwner(lockDir)).toEqual({ pid: 1001, started_at: new Date(now).toISOString(), child_pids: [], holder: 'resign', run_id: 'R1' })
    const b = acquireLock(lockDir, { pid: 1002, now: now + 49 * 60_000, isAlive: () => true })
    expect(b).toMatchObject({ ok: false, reason: 'busy', owner: { pid: 1001 } })
  })

  test('child pids are recorded in owner.json and handed to a stale taker', () => {
    const lockDir = join(tmp(), 'run.lock')
    const a = acquireLock(lockDir, { pid: 2001, now, isAlive: () => true })
    if (!a.ok) throw new Error('expected lock')
    a.lock.addChild(31337)
    a.lock.addChild(31338)
    a.lock.addChild(31337)
    a.lock.removeChild(31338)
    a.lock.addChild(31339)
    expect(readOwner(lockDir)?.child_pids).toEqual([31337, 31339])

    // Owner dies: the next run takes over and gets the children to reap.
    const b = acquireLock(lockDir, { pid: 2002, now: now + 60_000, isAlive: (p) => p !== 2001 })
    expect(b).toMatchObject({ ok: true, took_over: true, reap_pids: [31337, 31339], previous: { pid: 2001 } })
    if (!b.ok) return
    expect(readOwner(lockDir)?.pid).toBe(2002)
    expect(readOwner(lockDir)?.child_pids).toEqual([])
    // The dead owner can no longer release the taker's lock.
    expect(a.lock.held()).toBe(false)
    expect(a.lock.release()).toBe(false)
    expect(existsSync(lockDir)).toBe(true)
    expect(b.lock.release()).toBe(true)
    expect(existsSync(lockDir)).toBe(false)
  })

  test('a live owner is NEVER stale by age; only a reused pid is (regression)', () => {
    const lockDir = join(tmp(), 'run.lock')
    acquireLock(lockDir, { pid: 3001, now, isAlive: () => true })
    // The owner's own process (started just before it took the lock), hours later.
    const own = () => now - 1_000
    expect(acquireLock(lockDir, { pid: 3002, now: now + 5 * LOCK_STALE_MS, isAlive: () => true, processStart: own }).ok).toBe(false)
    // The pid now belongs to a process that started after the lock: reused.
    const reused = () => now + 10 * 60_000
    const b = acquireLock(lockDir, { pid: 3002, now: now + 20 * 60_000, isAlive: () => true, processStart: reused })
    expect(b).toMatchObject({ ok: true, took_over: true, previous: { pid: 3001 } })
  })

  test('ps cannot tell: age decides, so an unknowable owner never wedges the lock', () => {
    const o = { pid: 1, started_at: new Date(now).toISOString(), child_pids: [] }
    expect(ownerStale(o, now + LOCK_STALE_MS, LOCK_STALE_MS, () => true, () => null)).toBe(false)
    expect(ownerStale(o, now + LOCK_STALE_MS + 1, LOCK_STALE_MS, () => true, () => null)).toBe(true)
  })

  test('children carry spawn times; a displaced holder can no longer write owner.json', () => {
    const lockDir = join(tmp(), 'run.lock')
    const a = acquireLock(lockDir, { pid: 7001, now, isAlive: () => true })
    if (!a.ok) throw new Error('expected lock')
    a.lock.addChild(41, '2026-11-16T10:00:01.000Z')
    a.lock.addChild(42, '2026-11-16T10:00:02.000Z')
    a.lock.removeChild(41)
    expect(readOwner(lockDir)?.children).toEqual([{ pid: 42, started_at: '2026-11-16T10:00:02.000Z' }])
    const b = acquireLock(lockDir, { pid: 7002, now: now + 60_000, isAlive: (p) => p !== 7001 })
    expect(b).toMatchObject({ ok: true, reap: [{ pid: 42, started_at: '2026-11-16T10:00:02.000Z' }] })
    // The old holder (frozen, then resumed) records a child: it must not
    // overwrite the new owner.
    a.lock.addChild(43)
    expect(readOwner(lockDir)?.pid).toBe(7002)
    expect(readOwner(lockDir)?.child_pids).toEqual([])
  })

  test('a really dead pid (real kill(0) probe) is stale', async () => {
    const proc = Bun.spawn(['true'])
    await proc.exited
    const dead = proc.pid
    expect(pidAlive(dead)).toBe(false)
    expect(pidAlive(process.pid)).toBe(true)
    expect(pidAlive(0)).toBe(false)
    const lockDir = join(tmp(), 'run.lock')
    mkdirSync(lockDir)
    writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ pid: dead, started_at: new Date().toISOString(), child_pids: [] }))
    expect(acquireLock(lockDir)).toMatchObject({ ok: true, took_over: true })
  })

  test('bash-written owner.json with string numbers is read tolerantly', () => {
    const lockDir = join(tmp(), 'run.lock')
    mkdirSync(lockDir)
    writeFileSync(join(lockDir, 'owner.json'), '{"pid":"4001","started_at":"2026-11-16T10:00:00Z","child_pids":["77","x",88],"holder":"build-phone"}')
    expect(readOwner(lockDir)).toEqual({ pid: 4001, started_at: '2026-11-16T10:00:00Z', child_pids: [77, 88], holder: 'build-phone' })
    expect(acquireLock(lockDir, { pid: 4002, now, isAlive: () => true, processStart: () => null }).ok).toBe(false)
  })

  test('owner-less lock dir: busy while young, stale once abandoned', () => {
    const lockDir = join(tmp(), 'run.lock')
    mkdirSync(lockDir)
    expect(acquireLock(lockDir, { pid: 5001, isAlive: () => true })).toMatchObject({ ok: false, owner: null })
    const old = new Date(Date.now() - 5 * 60_000)
    utimesSync(lockDir, old, old)
    expect(acquireLock(lockDir, { pid: 5001, isAlive: () => true })).toMatchObject({ ok: true, took_over: true, reap_pids: [] })
  })

  test('a takeover gate abandoned mid-takeover is cleared after the grace', () => {
    const lockDir = join(tmp(), 'run.lock')
    mkdirSync(lockDir)
    writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ pid: 6001, started_at: new Date(now).toISOString(), child_pids: [9] }))
    mkdirSync(join(lockDir, 'takeover'))
    // Fresh gate: someone is taking over right now.
    expect(acquireLock(lockDir, { pid: 6002, now: Date.now(), isAlive: () => false }).ok).toBe(false)
    const old = new Date(Date.now() - 5 * 60_000)
    utimesSync(join(lockDir, 'takeover'), old, old)
    expect(acquireLock(lockDir, { pid: 6002, now: Date.now(), isAlive: () => false })).toMatchObject({ ok: true, took_over: true, reap_pids: [9] })
    expect(existsSync(join(lockDir, 'takeover'))).toBe(false)
  })

  test('ownerStale: unparseable started_at never wedges', () => {
    expect(ownerStale({ pid: 1, started_at: 'garbage', child_pids: [] }, now, LOCK_STALE_MS, () => true, () => null)).toBe(true)
    expect(ownerStale({ pid: 1, started_at: new Date(now).toISOString(), child_pids: [] }, now, LOCK_STALE_MS, () => true, () => null)).toBe(false)
  })

  test('concurrent takers across real processes: exactly one wins', async () => {
    const lockDir = join(tmp(), 'run.lock')
    const code = `
      import { acquireLock } from ${JSON.stringify(STATE_TS)}
      const r = acquireLock(${JSON.stringify(lockDir)})
      console.log(r.ok ? 'WON' : 'BUSY')
      if (r.ok) await Bun.sleep(400)
    `
    const procs = Array.from({ length: 8 }, () => Bun.spawn(['bun', '-e', code], { stdout: 'pipe', stderr: 'pipe' }))
    const outs = await Promise.all(procs.map(async (p) => (await new Response(p.stdout).text()).trim()))
    await Promise.all(procs.map((p) => p.exited))
    expect(outs.filter((o) => o === 'WON')).toHaveLength(1)
    expect(outs.filter((o) => o === 'BUSY')).toHaveLength(7)
  }, 30_000)

  test('concurrent stale takeover across real processes: exactly one wins', async () => {
    const lockDir = join(tmp(), 'run.lock')
    mkdirSync(lockDir)
    // A stale owner: our own (live) pid, but recorded as taking the lock in
    // 2000, long before this process started: the pid was reused.
    writeFileSync(
      join(lockDir, 'owner.json'),
      JSON.stringify({ pid: process.pid, started_at: '2000-01-01T00:00:00Z', child_pids: [424242] }),
    )
    const code = `
      import { acquireLock } from ${JSON.stringify(STATE_TS)}
      const r = acquireLock(${JSON.stringify(lockDir)})
      console.log(r.ok ? 'WON ' + JSON.stringify(r.reap_pids) : 'BUSY')
      if (r.ok) await Bun.sleep(400)
    `
    const procs = Array.from({ length: 6 }, () => Bun.spawn(['bun', '-e', code], { stdout: 'pipe', stderr: 'pipe' }))
    const outs = await Promise.all(procs.map(async (p) => (await new Response(p.stdout).text()).trim()))
    await Promise.all(procs.map((p) => p.exited))
    const won = outs.filter((o) => o.startsWith('WON'))
    expect(won).toHaveLength(1)
    expect(won[0]).toBe('WON [424242]')
    // The takeover gate is gone once the winner is in.
    expect(existsSync(join(lockDir, 'takeover'))).toBe(false)
    expect(JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf8')).child_pids).toEqual([])
  }, 30_000)
})
