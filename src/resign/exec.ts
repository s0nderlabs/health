// Child processes for the auto re-sign runner: every external command
// (xcodebuild, devicectl, security, plutil, codesign) goes through exec().
//
// The rules, all from the re-sign design:
//   - children are spawned NON-detached, so they stay in the launchd job's
//     process group and launchd reaps them if bun itself dies
//   - every call has a wall timeout; xcodebuild also gets an output-idle
//     timeout (any byte on stdout or stderr resets it)
//   - on timeout the whole tree is killed BY PID: a recursive `pgrep -P` walk,
//     SIGTERM, a grace period, then SIGSTOP-freeze + SIGKILL for whatever is
//     left. Never by name: a name kill could hit his GUI Xcode.
//   - live direct-child pids are kept in a registry the runner copies into the
//     lock's owner.json, so a stale-lock takeover can reap orphans
//
// Nothing here may hang forever: the pgrep/ps helpers carry their own short
// timeouts, and the post-exit stream drain is bounded.

import { closeSync, openSync, writeSync } from 'fs'

/** PATH for every child unless the caller passes its own env. launchd hands
 *  agents a minimal PATH; this is the same one the agent plist sets. */
export const SAFE_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'

/** SIGTERM -> SIGKILL grace, per the design. */
export const KILL_GRACE_MS = 10_000

const STDOUT_CAP = 4 * 1024 * 1024
const TAIL_CAP = 16 * 1024
const DRAIN_MS = 2_000
const HELPER_TIMEOUT_MS = 2_000

export interface ExecOptions {
  /** Wall clock limit for the whole call. Required: nothing runs unbounded. */
  timeoutMs: number
  /** Kill when neither stdout nor stderr has produced a byte for this long. */
  idleTimeoutMs?: number
  cwd?: string
  /** Full child env. Default: this process's env with PATH = SAFE_PATH. */
  env?: Record<string, string | undefined>
  /** Append every output byte (stdout and stderr, interleaved) here. */
  logFile?: string
  /** Called with the direct child's pid right after spawn. */
  onSpawn?: (pid: number) => void
  /** SIGTERM -> SIGKILL grace. Default KILL_GRACE_MS; tests shorten it. */
  killGraceMs?: number
}

export interface ExecResult {
  /** Exit code, or null when killed by a signal or never spawned. */
  code: number | null
  /** stdout as text (the last 4 MB if it was larger). */
  stdout: string
  /** The last 16 KB of stderr. */
  stderrTail: string
  /** The last 16 KB of stdout and stderr interleaved, for classifiers. */
  tail: string
  timedOut: boolean
  idledOut: boolean
  /** Set when the executable could not be spawned at all. */
  spawnError?: string
}

export type ExecFn = (argv: string[], opts: ExecOptions) => Promise<ExecResult>

// ── child pid registry ───────────────────────────────────────────

const live = new Set<number>()

/** Direct children of this process still running under exec(). */
export function liveChildPids(): number[] {
  return [...live]
}

// ── process tree helpers ─────────────────────────────────────────

/** Direct children of pid (empty on any error). */
export function childPids(pid: number): number[] {
  try {
    const r = Bun.spawnSync(['/usr/bin/pgrep', '-P', String(pid)], {
      stdout: 'pipe',
      stderr: 'ignore',
      timeout: HELPER_TIMEOUT_MS,
    })
    return r.stdout
      .toString()
      .split('\n')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0)
  } catch {
    return []
  }
}

/** pid plus every descendant, parents before children. Bounded depth and
 *  size so a pathological tree cannot loop. */
export function processTree(pid: number): number[] {
  const out: number[] = []
  const seen = new Set<number>()
  const queue = [pid]
  while (queue.length && out.length < 4096) {
    const p = queue.shift()!
    if (seen.has(p)) continue
    seen.add(p)
    out.push(p)
    for (const c of childPids(p)) if (!seen.has(c)) queue.push(c)
  }
  return out
}

/** ps etime ([[dd-]hh:]mm:ss) to ms; null when unparseable. */
export function parseEtime(s: string): number | null {
  const m = s.trim().match(/^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/)
  if (!m) return null
  const [d, h, mi, se] = [m[1], m[2], m[3], m[4]].map((x) => (x ? Number(x) : 0))
  return (((d * 24 + h) * 60 + mi) * 60 + se) * 1000
}

/** When pid started (epoch ms, 1 s resolution), or null when it is gone or
 *  ps cannot say. Used to tell a process we recorded from a later process
 *  that reused its pid. */
export function processStartMs(pid: number): number | null {
  if (!Number.isInteger(pid) || pid <= 0) return null
  try {
    const r = Bun.spawnSync(['/bin/ps', '-o', 'etime=', '-p', String(pid)], {
      stdout: 'pipe',
      stderr: 'ignore',
      timeout: HELPER_TIMEOUT_MS,
    })
    const e = parseEtime(r.stdout.toString())
    return e == null ? null : Date.now() - e
  } catch {
    return null
  }
}

/** etime has 1 s resolution: a start computed from it can read up to ~1 s
 *  late. A process that "started" later than this past a reference instant
 *  is a different process that reused the pid. */
export const PID_START_SLACK_MS = 2_000

/** True when pid exists and is not a zombie. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch (e) {
    // EPERM means it exists but is not ours; still alive.
    return (e as NodeJS.ErrnoException)?.code === 'EPERM'
  }
  try {
    const r = Bun.spawnSync(['/bin/ps', '-o', 'stat=', '-p', String(pid)], {
      stdout: 'pipe',
      stderr: 'ignore',
      timeout: HELPER_TIMEOUT_MS,
    })
    const stat = r.stdout.toString().trim()
    if (!stat) return false
    return !stat.startsWith('Z')
  } catch {
    return true
  }
}

function signal(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig)
  } catch {
    // already gone
  }
}

/** Kill pid and all its descendants: SIGTERM the tree, wait up to graceMs
 *  for it to go, then freeze what is left with SIGSTOP (so nothing can fork
 *  between the walk and the kill), re-walk until stable, and SIGKILL. The
 *  tree is walked BEFORE any signal, because a dead parent's children are
 *  reparented to launchd and the walk can no longer find them. A survivor of
 *  the grace is frozen and killed only if it is still the process we walked:
 *  one that started after the walk is a stranger that reused an exited
 *  member's pid (xcodebuild churns through compiler pids). */
export async function killTree(
  pid: number,
  graceMs = KILL_GRACE_MS,
  startOf: (pid: number) => number | null = processStartMs,
): Promise<number[]> {
  if (pid <= 1 || pid === process.pid) return []
  const walkedAt = Date.now()
  const tree = processTree(pid)
  for (const p of tree) signal(p, 'SIGTERM')
  const deadline = Date.now() + graceMs
  while (Date.now() < deadline) {
    if (!tree.some(isAlive)) return tree
    await Bun.sleep(Math.min(100, Math.max(1, deadline - Date.now())))
  }
  const ours = (p: number): boolean => {
    const started = startOf(p)
    return started == null || started <= walkedAt + PID_START_SLACK_MS
  }
  // Freeze, re-walk from every survivor until no new pid appears (a new pid
  // found under a frozen survivor is its child, so ours by construction).
  const all = new Set<number>(tree.filter((p) => isAlive(p) && ours(p)))
  for (let round = 0; round < 5; round++) {
    for (const p of all) signal(p, 'SIGSTOP')
    let grew = false
    for (const p of [...all]) {
      for (const c of processTree(p)) {
        if (!all.has(c)) {
          all.add(c)
          grew = true
        }
      }
    }
    if (!grew) break
  }
  for (const p of all) signal(p, 'SIGKILL')
  // A stopped process still takes SIGKILL; CONT is harmless and covers any
  // kernel that defers delivery to stopped tasks.
  for (const p of all) signal(p, 'SIGCONT')
  return [...new Set([...tree, ...all])]
}

// ── exec ─────────────────────────────────────────────────────────

class Tail {
  private buf = ''
  constructor(private cap: number) {}
  push(s: string): void {
    this.buf += s
    if (this.buf.length > this.cap * 2) this.buf = this.buf.slice(-this.cap)
  }
  get value(): string {
    return this.buf.length > this.cap ? this.buf.slice(-this.cap) : this.buf
  }
}

/** The default child env: everything we have, PATH pinned. */
export function defaultEnv(): Record<string, string | undefined> {
  return { ...process.env, PATH: SAFE_PATH }
}

/** Run argv to completion or until a timeout kills its whole tree. Never
 *  throws: a spawn failure comes back as code null plus spawnError. */
export const exec: ExecFn = async (argv, opts) => {
  const timeoutMs = Math.max(1, opts.timeoutMs)
  const grace = opts.killGraceMs ?? KILL_GRACE_MS
  let logFd: number | null = null
  if (opts.logFile) {
    try {
      logFd = openSync(opts.logFile, 'a')
    } catch {
      logFd = null
    }
  }
  const closeLog = () => {
    if (logFd != null) {
      try {
        closeSync(logFd)
      } catch {
        // ignore
      }
      logFd = null
    }
  }

  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn(argv, {
      cwd: opts.cwd,
      env: opts.env ?? defaultEnv(),
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
  } catch (e) {
    closeLog()
    const msg = e instanceof Error ? e.message : String(e)
    return { code: null, stdout: '', stderrTail: msg, tail: msg, timedOut: false, idledOut: false, spawnError: msg }
  }

  const pid = proc.pid
  live.add(pid)
  try {
    opts.onSpawn?.(pid)
  } catch {
    // a bad callback must not leak the child
  }

  let stdout = ''
  const stderrTail = new Tail(TAIL_CAP)
  const tail = new Tail(TAIL_CAP)
  let lastOutput = Date.now()
  let timedOut = false
  let idledOut = false
  let killing: Promise<unknown> | null = null

  const kill = () => {
    if (!killing) killing = killTree(pid, grace)
  }

  const pump = async (stream: ReadableStream<Uint8Array>, isErr: boolean) => {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) {
          const rest = decoder.decode()
          if (rest) {
            tail.push(rest)
            if (isErr) stderrTail.push(rest)
            else stdout += rest
          }
          break
        }
        if (!value || value.length === 0) continue
        lastOutput = Date.now()
        if (logFd != null) {
          try {
            writeSync(logFd, value)
          } catch {
            // a full disk must not kill the build
          }
        }
        const s = decoder.decode(value, { stream: true })
        tail.push(s)
        if (isErr) stderrTail.push(s)
        else {
          stdout += s
          if (stdout.length > STDOUT_CAP * 1.5) stdout = stdout.slice(-STDOUT_CAP)
        }
      }
    } catch {
      // stream cancelled or errored
    }
    return reader
  }

  const outP = pump(proc.stdout as ReadableStream<Uint8Array>, false)
  const errP = pump(proc.stderr as ReadableStream<Uint8Array>, true)

  const wall = setTimeout(() => {
    timedOut = true
    kill()
  }, timeoutMs)
  let idleTimer: ReturnType<typeof setInterval> | null = null
  if (opts.idleTimeoutMs && opts.idleTimeoutMs > 0) {
    const idle = opts.idleTimeoutMs
    idleTimer = setInterval(
      () => {
        if (!killing && Date.now() - lastOutput >= idle) {
          idledOut = true
          kill()
        }
      },
      Math.max(20, Math.min(1000, Math.floor(idle / 4))),
    )
  }

  let code: number | null
  try {
    code = await proc.exited
  } finally {
    clearTimeout(wall)
    if (idleTimer) clearInterval(idleTimer)
    live.delete(pid)
  }
  if (proc.signalCode) code = null
  if (killing) await killing

  // Bounded drain: a grandchild that outlived its parent can hold the pipes
  // open; never wait on it past DRAIN_MS.
  const drained = await Promise.race([
    Promise.all([outP, errP]).then(() => true),
    Bun.sleep(DRAIN_MS).then(() => false),
  ])
  if (!drained) {
    try {
      ;(proc.stdout as ReadableStream).cancel().catch(() => {})
    } catch {
      // locked stream; the pump owns it
    }
    try {
      ;(proc.stderr as ReadableStream).cancel().catch(() => {})
    } catch {
      // ignore
    }
  }
  closeLog()

  return {
    code: timedOut || idledOut ? null : code,
    stdout: stdout.length > STDOUT_CAP ? stdout.slice(-STDOUT_CAP) : stdout,
    stderrTail: stderrTail.value,
    tail: tail.value,
    timedOut,
    idledOut,
  }
}
