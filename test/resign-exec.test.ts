import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SAFE_PATH, childPids, exec, isAlive, liveChildPids, processTree } from '../src/resign/exec.js'

// Real processes, short timeouts. Each test that spawns sleepers uses a
// unique fractional duration as a marker so the survivor check (pgrep -f)
// can only ever match processes this test started.

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'health-resign-exec-'))
})
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

function survivors(marker: string): number[] {
  const r = Bun.spawnSync(['/usr/bin/pgrep', '-f', marker], { stdout: 'pipe', stderr: 'ignore' })
  return r.stdout
    .toString()
    .split('\n')
    .map((s) => Number(s.trim()))
    .filter((n) => n > 0 && n !== process.pid)
}

describe('exec: plain runs', () => {
  test('captures stdout, exit code, and pins PATH by default', async () => {
    const r = await exec(['/bin/sh', '-c', 'echo hello; echo "$PATH"; echo oops 1>&2; exit 3'], { timeoutMs: 5000 })
    expect(r.code).toBe(3)
    expect(r.stdout).toContain('hello')
    expect(r.stdout).toContain(SAFE_PATH)
    expect(r.stderrTail).toContain('oops')
    expect(r.tail).toContain('hello')
    expect(r.tail).toContain('oops')
    expect(r.timedOut).toBe(false)
    expect(r.idledOut).toBe(false)
  })

  test('an explicit env replaces the default', async () => {
    const r = await exec(['/bin/sh', '-c', 'echo "$RESIGN_TEST_VAR:$PATH"'], {
      timeoutMs: 5000,
      env: { RESIGN_TEST_VAR: 'x', PATH: '/bin' },
    })
    expect(r.stdout.trim()).toBe('x:/bin')
  })

  test('a missing executable is a result, not a throw', async () => {
    const r = await exec(['/nonexistent/definitely-not-here'], { timeoutMs: 2000 })
    expect(r.code).toBeNull()
    expect(r.spawnError).toBeTruthy()
  })

  test('streams every byte to the log file and tracks the live pid', async () => {
    const log = join(dir, 'run.log')
    let spawned = 0
    let seenLive = false
    const r = await exec(['/bin/sh', '-c', 'echo out-line; echo err-line 1>&2; sleep 0.2'], {
      timeoutMs: 5000,
      logFile: log,
      onSpawn: (pid) => {
        spawned = pid
        seenLive = liveChildPids().includes(pid)
      },
    })
    expect(r.code).toBe(0)
    expect(spawned).toBeGreaterThan(0)
    expect(seenLive).toBe(true)
    expect(liveChildPids()).not.toContain(spawned)
    const text = readFileSync(log, 'utf8')
    expect(text).toContain('out-line')
    expect(text).toContain('err-line')
  })
})

describe('exec: timeouts kill the whole tree by pid', () => {
  test('wall timeout kills sh and both background sleeps, no survivor', async () => {
    const marker = 'sleep 30.0417'
    let root = 0
    let kids: number[] = []
    const started = Date.now()
    const p = exec(['/bin/sh', '-c', `${marker} & ${marker} & wait`], {
      timeoutMs: 600,
      killGraceMs: 3000,
      onSpawn: (pid) => {
        root = pid
      },
    })
    await Bun.sleep(300)
    kids = childPids(root)
    expect(kids.length).toBe(2)
    expect(processTree(root).length).toBe(3)
    const r = await p
    expect(r.timedOut).toBe(true)
    expect(r.code).toBeNull()
    expect(Date.now() - started).toBeLessThan(6000)
    await Bun.sleep(100)
    expect(isAlive(root)).toBe(false)
    for (const k of kids) expect(isAlive(k)).toBe(false)
    expect(survivors(marker)).toEqual([])
  })

  test('a child that ignores SIGTERM (and its children) gets SIGKILLed', async () => {
    const marker = 'sleep 0.2718'
    let root = 0
    const started = Date.now()
    const r = await exec(['/bin/sh', '-c', `trap '' TERM; while :; do ${marker}; done`], {
      timeoutMs: 300,
      killGraceMs: 500,
      onSpawn: (pid) => {
        root = pid
      },
    })
    expect(r.timedOut).toBe(true)
    // Grace is 500ms: the TERM was ignored and the SIGKILL landed after it.
    expect(Date.now() - started).toBeGreaterThanOrEqual(700)
    expect(Date.now() - started).toBeLessThan(6000)
    await Bun.sleep(100)
    expect(isAlive(root)).toBe(false)
    expect(survivors(marker)).toEqual([])
  })

  test('idle timeout fires on a silent child', async () => {
    const marker = 'sleep 30.1123'
    const started = Date.now()
    const r = await exec(['/bin/sh', '-c', `echo starting; ${marker}`], {
      timeoutMs: 20_000,
      idleTimeoutMs: 400,
      killGraceMs: 2000,
    })
    expect(r.idledOut).toBe(true)
    expect(r.timedOut).toBe(false)
    expect(r.code).toBeNull()
    expect(r.stdout).toContain('starting')
    expect(Date.now() - started).toBeLessThan(5000)
    await Bun.sleep(100)
    expect(survivors(marker)).toEqual([])
  })

  test('idle timeout does not fire on a chatty child that outlives it', async () => {
    const r = await exec(['/bin/sh', '-c', 'for i in 1 2 3 4 5 6 7 8 9 10; do echo tick $i; sleep 0.1; done'], {
      timeoutMs: 10_000,
      idleTimeoutMs: 400,
    })
    expect(r.idledOut).toBe(false)
    expect(r.timedOut).toBe(false)
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('tick 10')
  })
})

// ── Review regressions: pid reuse ──────────────────────────────────

import { killTree, parseEtime, processStartMs } from '../src/resign/exec.js'

describe('pid reuse guards', () => {
  test('parseEtime: every ps etime shape', () => {
    expect(parseEtime('00:05')).toBe(5_000)
    expect(parseEtime('  12:34 ')).toBe((12 * 60 + 34) * 1000)
    expect(parseEtime('1:02:03')).toBe((3600 + 120 + 3) * 1000)
    expect(parseEtime('2-01:02:03')).toBe(((2 * 24 + 1) * 3600 + 120 + 3) * 1000)
    expect(parseEtime('')).toBeNull()
    expect(parseEtime('garbage')).toBeNull()
  })

  test('processStartMs: our own process started in the past; a dead pid is null', async () => {
    const mine = processStartMs(process.pid)
    expect(mine).not.toBeNull()
    expect(mine!).toBeLessThanOrEqual(Date.now() + 1_000)
    const p = Bun.spawn(['true'])
    await p.exited
    expect(processStartMs(p.pid)).toBeNull()
  })

  test('killTree never SIGKILLs a survivor whose pid now belongs to a later process (regression)', async () => {
    const proc = Bun.spawn(['/bin/sh', '-c', 'trap "" TERM; sleep 30'], { stdout: 'ignore', stderr: 'ignore' })
    try {
      await Bun.sleep(100)
      // Pretend the pid was reused after the walk: the guard must leave it alone.
      await killTree(proc.pid, 200, () => Date.now() + 3_600_000)
      expect(isAlive(proc.pid)).toBe(true)
      // The real start time: it is ours, so it dies.
      await killTree(proc.pid, 200)
      await proc.exited
      expect(isAlive(proc.pid)).toBe(false)
    } finally {
      try {
        process.kill(proc.pid, 'SIGKILL')
      } catch {
        // gone
      }
    }
  }, 15_000)
})
