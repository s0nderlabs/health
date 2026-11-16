import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { BUILD_FLAGS } from '../src/resign/runner.js'

// The runner and the manual script must build the same way: every shared
// xcodebuild flag the runner passes appears in scripts/build-phone.sh.
const script = readFileSync(join(import.meta.dir, '..', 'scripts', 'build-phone.sh'), 'utf8')

describe('BUILD_FLAGS drift vs build-phone.sh', () => {
  test('every BUILD_FLAGS entry appears in the script', () => {
    for (const f of BUILD_FLAGS) expect(script).toContain(f)
  })

  test('the script keeps the re-sign invariants', () => {
    expect(script).toContain("-not -path '*Index.noindex*'")
    expect(script).toContain("grep -q 'App installed'")
    expect(script).toContain('health-resign/run.lock')
    expect(script).toContain('resign.device_udid')
    expect(script).toContain('com.s0nderlabs.HealthRelay.widgets')
    expect(script).toContain('ExpirationDate')
    expect(script).toContain('source.json')
    // Never the old blanket profile delete.
    expect(script).not.toMatch(/rm\s+(-rf?\s+)?.*Provisioning Profiles/)
  })

  test('no emdash in the script', () => {
    expect(script.includes('\u2014')).toBe(false)
  })
})

// ── Review regressions: the manual path's lock and freshness rules ──

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { readOwner } from '../src/resign/state.js'

describe('build-phone.sh freshness check', () => {
  test('checks BOTH embedded profiles, caps the floor by the cert, has an escape hatch', () => {
    expect(script).toContain('PlugIns/HealthRelayWidgets.appex/embedded.mobileprovision')
    expect(script).toContain('--extract-certificates')
    expect(script).toContain('-enddate')
    expect(script).toContain('HEALTH_ALLOW_STALE_PROFILE')
    expect(script).toMatch(/\[ "\$APP_E" -ge "\$FLOOR" \] && \[ "\$WID_E" -ge "\$FLOOR" \]/)
  })

  test('xcodebuild runs under a wall timeout with its pid recorded', () => {
    expect(script).toContain('HEALTH_BUILD_TIMEOUT_S')
    expect(script).toContain('write_owner "$XPID"')
    // Every device build goes through the timed wrapper.
    expect(script.match(/-allowProvisioningUpdates -quiet build &/g)?.length).toBe(1)
    expect(script.match(/^\s+build_device$/gm)?.length).toBe(2)
  })

  test('the script parses', () => {
    const r = Bun.spawnSync(['/bin/sh', '-n', join(import.meta.dir, '..', 'scripts', 'build-phone.sh')])
    expect(r.exitCode).toBe(0)
  })
})

describe('build-phone.sh take_lock (functions only, temp dirs)', () => {
  // Only the helper and lock function DEFINITIONS are extracted and run, with
  // the lock pointed at a temp dir: nothing touches the real system.
  const start = script.indexOf('now_iso()')
  const end = script.indexOf('# ── profile quarantine')
  const fns = script.slice(start, end)

  function takeLock(base: string): { code: number; out: string } {
    const sh = `RESIGN_BASE='${base}'\nLOCK="$RESIGN_BASE/run.lock"\nLOCK_GRACE_S=60\nBUILD_TIMEOUT_S=5\n${fns}\ntake_lock\necho TOOK\n`
    const r = Bun.spawnSync(['/bin/sh', '-e', '-c', sh], { stdout: 'pipe', stderr: 'pipe' })
    return { code: r.exitCode ?? -1, out: r.stdout.toString() + r.stderr.toString() }
  }

  test('lock rules match the runner (regression)', () => {
    const base = mkdtempSync(join(tmpdir(), 'health-build-phone-lock-'))
    try {
      const lock = join(base, 'run.lock')
      // Free: taken, owner.json written with a children array.
      expect(takeLock(base).out).toContain('TOOK')
      expect(readOwner(lock)?.holder).toBe('build-phone')
      rmSync(lock, { recursive: true, force: true })

      // A LIVE owner (this process), with a runner-style millisecond ISO: busy,
      // however old the lock looks (the old script took it over).
      mkdirSync(lock)
      writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, started_at: new Date().toISOString(), child_pids: [] }))
      const busy = takeLock(base)
      expect(busy.code).toBe(1)
      expect(busy.out).toContain('holds')
      // The same live pid recorded as taking the lock in 2000: a reused pid, stale.
      writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, started_at: '2000-01-01T00:00:00.000Z', child_pids: [] }))
      expect(takeLock(base).out).toContain('took over a stale lock')
      rmSync(lock, { recursive: true, force: true })

      // Owner-less and young: busy (a taker between mkdir and its write).
      mkdirSync(lock)
      const young = takeLock(base)
      expect(young.code).toBe(1)
      expect(young.out).toContain('being taken right now')
      // Owner-less and abandoned: taken over.
      const old = new Date(Date.now() - 5 * 60_000)
      utimesSync(lock, old, old)
      expect(takeLock(base).out).toContain('took over a stale lock')
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})
