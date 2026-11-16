// Auto re-sign state: the facts file the runner writes and the daemon reads
// (read-only) to alert, plus the shared mkdir lock the runner and
// build-phone.sh both take. Every path is a parameter; paths() derives the
// real defaults from the home dir, so tests run entirely in temp dirs.
//
// Writes are atomic (tmp + rename in the same dir) so a reader never sees a
// torn file; reads are tolerant (missing or corrupt -> null, partial -> filled
// from defaults) so a runner bug can never crash the daemon's tick.

import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { homedir } from 'os'
import type { FailClass } from './policy.js'
import { LOCK_STALE_MS } from './policy.js'
import { PID_START_SLACK_MS, processStartMs } from './exec.js'

// ── Paths ─────────────────────────────────────────────────────────

export interface ResignPaths {
  /** ~/Library/Application Support/health-resign: unprotected by TCC. */
  base: string
  /** Installed-code snapshot the build reads (source/relayer-ios). */
  sourceDir: string
  sourceProject: string
  sourceJson: string
  sourceNext: string
  derivedData: string
  staging: string
  /** staging/current.json: the pointer to the staged run dir. */
  stagingCurrent: string
  profileBackups: string
  /** The mkdir lock shared with build-phone.sh. */
  lockDir: string
  /** ~/.claude/channels/health/resign: state and logs. */
  runtime: string
  stateFile: string
  logFile: string
  jsonlFile: string
  runsDir: string
  launchdLog: string
  /** One-shot flags written by `resign kick`, consumed by the next run. */
  flagsFile: string
  /** Xcode's profile caches (step 10). */
  profileDirs: string[]
}

export function paths(home: string = homedir()): ResignPaths {
  const base = join(home, 'Library', 'Application Support', 'health-resign')
  const runtime = join(home, '.claude', 'channels', 'health', 'resign')
  const sourceDir = join(base, 'source', 'relayer-ios')
  return {
    base,
    sourceDir,
    sourceProject: join(sourceDir, 'HealthRelay.xcodeproj'),
    sourceJson: join(base, 'source.json'),
    sourceNext: join(base, 'source.next'),
    derivedData: join(base, 'DerivedData'),
    staging: join(base, 'staging'),
    stagingCurrent: join(base, 'staging', 'current.json'),
    profileBackups: join(base, 'profile-backups'),
    lockDir: join(base, 'run.lock'),
    runtime,
    stateFile: join(runtime, 'state.json'),
    logFile: join(runtime, 'resign.log'),
    jsonlFile: join(runtime, 'resign.jsonl'),
    runsDir: join(runtime, 'runs'),
    launchdLog: join(runtime, 'launchd.log'),
    flagsFile: join(runtime, 'kick-flags.json'),
    profileDirs: [
      join(home, 'Library', 'Developer', 'Xcode', 'UserData', 'Provisioning Profiles'),
      join(home, 'Library', 'MobileDevice', 'Provisioning Profiles'),
    ],
  }
}

/** run_id: local YYYYMMDD-HHMMSS. */
export function makeRunId(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return (
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-` +
    `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  )
}

// ── The state shape ───────────────────────────────────────────────

export type RunTrigger = 'interval' | 'hello' | 'kick'

export type RunPhase = 'boot' | 'load' | 'clock' | 'recover' | 'gate' | 'build' | 'install' | 'confirm' | 'finish'

export interface StagedInfo {
  run_id: string
  /** staging/<run_id>/HealthRelay.app */
  app_path: string
  app_expiry: string
  widget_expiry: string
  version: string
  profile_uuids: string[]
  cert_sha1: string | null
  cert_changed: boolean
  staged_at: string
  /** Identity of the source snapshot it was built from (content_sha256, else
   *  captured_at): a manual install that replaced the snapshot with the SAME
   *  version string must never let this older build be installed over it. */
  source_id?: string | null
}

export interface PendingConfirm {
  staged_run_id: string
  /** The FIRST install of this staged build, kept across retries. */
  first_installed_at: string
  last_installed_at: string
  /** min(app expiry, widget expiry). */
  expected_until: string
  version: string
  /** What the phone reported before the install, to tell a manual install
   *  (a different newer date) from one that did not take. */
  old_signed_until: string | null
  /** Did the relaunch after the last install (or relaunch-only retry) succeed? */
  launched?: boolean
}

export interface LastSuccess {
  at: string
  expiry: string
  cert_sha1: string | null
  /** When the window this success closed had opened (counters.since), so the
   *  daemon can tell whether an alert fired inside it (the resolved line). */
  window_since?: string | null
}

export interface Episode {
  class: FailClass
  since: string
  hard: boolean
  /** Last time this episode's class recurred. */
  last_at: string
  detail: string | null
}

export interface ProfilesMoved {
  run_id: string
  backup_dir: string
  uuids: string[]
  at: string
}

export interface ResignCounters {
  /** When these counters started (the window opening). */
  since: string | null
  attempts: number
  installs: number
  locked: number
  unreachable: number
  night: number
  busy: number
  battery: number
  apple_unreachable: number
  awaiting_hello: number
  lockstate_unknown: number
  daemon_down: number
  /** Per blocker reason (live_session, recent_intent, ...). */
  blocked: Record<string, number>
  last_attempt_at: string | null
  last_skip_reason: string | null
}

/** Consecutive-failure counts for the streak-escalated classes. */
export interface ResignStreaks {
  profile_not_fresh: number
  install_failed: number
  run_timeout: number
  lockstate_unknown: number
}

export interface ResignState {
  schema: 1
  enabled: boolean
  dry_run: boolean
  /** Heartbeat: every run (even a disabled or noop one) stamps this. */
  last_run_at: string | null
  last_run_id: string | null
  trigger: RunTrigger | null
  phase: RunPhase | null
  daemon_down: boolean
  signed_until: string | null
  hours_left: number | null
  /** Quarantine in flight: set BEFORE the first move, cleared on stage or restore. */
  profiles_moved: ProfilesMoved | null
  /** The mint that passed step 11d (ties to profiles_moved.run_id). */
  mint_verified: { run_id: string; at: string } | null
  staged: StagedInfo | null
  pending_confirm: PendingConfirm | null
  last_success: LastSuccess | null
  episode: Episode | null
  /** Per-class episode start inside the current window: a class that recurs
   *  in the same window (even after another class took the episode slot)
   *  keeps its since, so its alert key is delivered once. Cleared when the
   *  window closes or a re-sign lands. */
  episode_since: Record<string, string>
  account_broken_at: string | null
  xcode_version: string | null
  counters: ResignCounters
  streaks: ResignStreaks
  last_outcome: string | null
  last_reason: string | null
  last_hard_class: FailClass | null
}

export function emptyCounters(since: string | null = null): ResignCounters {
  return {
    since,
    attempts: 0,
    installs: 0,
    locked: 0,
    unreachable: 0,
    night: 0,
    busy: 0,
    battery: 0,
    apple_unreachable: 0,
    awaiting_hello: 0,
    lockstate_unknown: 0,
    daemon_down: 0,
    blocked: {},
    last_attempt_at: null,
    last_skip_reason: null,
  }
}

export function emptyStreaks(): ResignStreaks {
  return { profile_not_fresh: 0, install_failed: 0, run_timeout: 0, lockstate_unknown: 0 }
}

export function emptyState(): ResignState {
  return {
    schema: 1,
    enabled: false,
    dry_run: false,
    last_run_at: null,
    last_run_id: null,
    trigger: null,
    phase: null,
    daemon_down: false,
    signed_until: null,
    hours_left: null,
    profiles_moved: null,
    mint_verified: null,
    staged: null,
    pending_confirm: null,
    last_success: null,
    episode: null,
    episode_since: {},
    account_broken_at: null,
    xcode_version: null,
    counters: emptyCounters(),
    streaks: emptyStreaks(),
    last_outcome: null,
    last_reason: null,
    last_hard_class: null,
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** Fill a parsed (possibly partial or older) object onto the defaults. Field
 *  types are trusted only when they match; anything else keeps the default. */
export function normalizeState(raw: unknown): ResignState | null {
  if (!isObj(raw)) return null
  const base = emptyState()
  const out: Record<string, unknown> = { ...base }
  for (const [k, def] of Object.entries(base)) {
    const v = raw[k]
    if (v === undefined) continue
    if (def === null) {
      out[k] = v // nullable: scalar or object, trusted as written by us
    } else if (typeof def === typeof v && Array.isArray(def) === Array.isArray(v)) {
      out[k] = v
    }
  }
  const counters = isObj(raw.counters) ? raw.counters : {}
  out.counters = { ...emptyCounters(), ...counters, blocked: isObj(counters.blocked) ? counters.blocked : {} }
  out.streaks = { ...emptyStreaks(), ...(isObj(raw.streaks) ? raw.streaks : {}) }
  out.episode_since = Object.fromEntries(
    Object.entries(isObj(raw.episode_since) ? raw.episode_since : {}).filter(([, v]) => typeof v === 'string'),
  )
  out.schema = 1
  return out as unknown as ResignState
}

/** THE tolerant JSON read for the resign modules: missing, unreadable or
 *  corrupt -> null, never a throw. */
export function readJsonFile<T = unknown>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}

/** Read state.json. Missing, unreadable, or corrupt -> null (never a throw). */
export function readState(file: string): ResignState | null {
  const raw = readJsonFile(file)
  return raw == null ? null : normalizeState(raw)
}

/** Atomic write: a uniquely-named tmp in the same dir, then rename. */
export function writeJsonAtomic(file: string, value: unknown, opts: { mkdir?: boolean } = {}): void {
  if (opts.mkdir !== false) mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n')
    renameSync(tmp, file)
  } catch (err) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* best effort */
    }
    throw err
  }
}

export function writeState(file: string, state: ResignState): void {
  writeJsonAtomic(file, state)
}

/** Read-modify-write. The updater gets the current state (or a fresh empty
 *  one) and returns the next one. Callers serialise through the run lock. */
export function updateState(file: string, fn: (s: ResignState) => ResignState): ResignState {
  const next = fn(readState(file) ?? emptyState())
  writeState(file, next)
  return next
}

/** The watchdog's merge: apply a patch but NEVER touch pending_confirm (an
 *  install that already happened must survive a watchdog firing mid-confirm). */
export function mergeStatePreservingPending(file: string, patch: Partial<ResignState>): ResignState {
  return updateState(file, (s) => {
    const { pending_confirm: _drop, ...rest } = patch
    return { ...s, ...rest, pending_confirm: s.pending_confirm }
  })
}

// ── The mkdir lock ────────────────────────────────────────────────

export interface LockChild {
  pid: number
  /** When we spawned it (real clock), so a later reaper can tell it from a
   *  process that reused its pid (owner.json survives reboots). */
  started_at: string
}

export interface LockOwner {
  pid: number
  started_at: string
  child_pids: number[]
  /** child_pids with their spawn times (absent in older owner files). */
  children?: LockChild[]
  /** Free-form holder tag: 'resign' | 'build-phone' | ... */
  holder?: string
  run_id?: string
}

export type AcquireResult =
  | {
      ok: true
      lock: ResignLock
      /** A stale lock was taken over. */
      took_over: boolean
      /** The stale owner's recorded children: the caller comm-verifies each
       *  (xcodebuild or devicectl) before killing. Never the owner pid itself. */
      reap_pids: number[]
      /** The same children with their recorded spawn times (null when the
       *  owner file predates them): a reaper kills only a pid whose current
       *  start time matches, never one that was reused. */
      reap: Array<{ pid: number; started_at: string | null }>
      previous: LockOwner | null
    }
  | { ok: false; reason: 'busy'; owner: LockOwner | null }

export interface AcquireOptions {
  pid?: number
  now?: number
  staleMs?: number
  holder?: string
  runId?: string
  isAlive?: (pid: number) => boolean
  /** When a pid started (epoch ms), null when unknown. Default: ps etime. */
  processStart?: (pid: number) => number | null
  /** A lock dir with no readable owner.json younger than this is treated as
   *  being created right now (busy), older as an abandoned half-acquire. */
  ownerlessGraceMs?: number
}

/** kill(pid, 0): EPERM still means the process exists. */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Tolerant owner.json read (build-phone.sh writes it from bash, so numbers
 *  may arrive as strings). null when absent or unusable. */
export function readOwner(lockDir: string): LockOwner | null {
  try {
    const raw = readJsonFile<Record<string, unknown>>(join(lockDir, 'owner.json'))
    if (!isObj(raw)) return null
    const pid = Number(raw.pid)
    if (!Number.isInteger(pid) || pid <= 0) return null
    const children = Array.isArray(raw.child_pids)
      ? raw.child_pids.map(Number).filter((n: number) => Number.isInteger(n) && n > 0)
      : []
    const timed: LockChild[] = Array.isArray(raw.children)
      ? raw.children
          .filter(isObj)
          .map((c: Record<string, unknown>) => ({ pid: Number(c.pid), started_at: typeof c.started_at === 'string' ? c.started_at : '' }))
          .filter((c: LockChild) => Number.isInteger(c.pid) && c.pid > 0 && c.started_at !== '')
      : []
    return {
      pid,
      started_at: typeof raw.started_at === 'string' ? raw.started_at : '',
      child_pids: children,
      ...(timed.length ? { children: timed } : {}),
      ...(typeof raw.holder === 'string' ? { holder: raw.holder } : {}),
      ...(typeof raw.run_id === 'string' ? { run_id: raw.run_id } : {}),
    }
  } catch {
    return null
  }
}

/** Is a recorded owner stale? Its pid is dead, or the live pid is a
 *  stranger that started AFTER the owner took the lock (pid reuse: owner.json
 *  survives reboots). A live owner is NEVER displaced by age alone: a run
 *  frozen by sleep resumes and finishes, and build-phone.sh has no watchdog,
 *  so a takeover would put two minters on one profile cache (launchd never
 *  starts a second copy of the timer anyway; a wedged owner surfaces as the
 *  daemon's timer_dead alert). Only when ps cannot tell does age (staleMs)
 *  decide, so an unknowable owner can never wedge the lock forever. */
export function ownerStale(
  owner: LockOwner,
  now: number,
  staleMs: number = LOCK_STALE_MS,
  isAlive: (pid: number) => boolean = pidAlive,
  processStart: (pid: number) => number | null = processStartMs,
): boolean {
  if (!isAlive(owner.pid)) return true
  const started = Date.parse(owner.started_at)
  if (!Number.isFinite(started)) return true // unknowable age: do not wedge forever
  const procStart = processStart(owner.pid)
  if (procStart == null) return now - started > staleMs
  return procStart > started + PID_START_SLACK_MS
}

export class ResignLock {
  constructor(
    readonly dir: string,
    public owner: LockOwner,
  ) {}

  /** Write owner.json, but never over a lock that is no longer ours. */
  private persist(): void {
    if (!this.held()) return
    writeJsonAtomic(join(this.dir, 'owner.json'), this.owner, { mkdir: false })
  }

  /** Record a live child (with its spawn time) so a stale takeover can reap
   *  it, and only it. */
  addChild(pid: number, startedAt: string = new Date().toISOString()): void {
    if (!this.owner.child_pids.includes(pid)) this.owner.child_pids.push(pid)
    const kids = (this.owner.children ?? []).filter((c) => c.pid !== pid)
    this.owner.children = [...kids, { pid, started_at: startedAt }]
    this.persist()
  }

  removeChild(pid: number): void {
    this.owner.child_pids = this.owner.child_pids.filter((p) => p !== pid)
    if (this.owner.children) this.owner.children = this.owner.children.filter((c) => c.pid !== pid)
    this.persist()
  }

  /** Does the lock on disk still belong to us (not taken over)? */
  held(): boolean {
    const cur = readOwner(this.dir)
    return !!cur && cur.pid === this.owner.pid && cur.started_at === this.owner.started_at
  }

  /** Remove the lock only if it is still ours. Returns whether it removed it. */
  release(): boolean {
    if (!this.held()) return false
    try {
      rmSync(this.dir, { recursive: true, force: true })
      return true
    } catch {
      return false
    }
  }
}

function sameOwner(a: LockOwner | null, b: LockOwner | null): boolean {
  if (!a || !b) return a === b
  return a.pid === b.pid && a.started_at === b.started_at
}

function tryMkdir(dir: string): boolean {
  try {
    mkdirSync(dir) // not recursive: EEXIST is the mutual exclusion
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw err
  }
}

/** Take the run lock. Held by a live owner: busy (see ownerStale). Stale
 *  (owner dead or its pid reused, or an abandoned owner-less dir): take it over in
 *  place under a nested mkdir gate (one taker wins) and hand back the stale
 *  owner's recorded children for the caller to reap. */
export function acquireLock(lockDir: string, opts: AcquireOptions = {}): AcquireResult {
  const pid = opts.pid ?? process.pid
  const now = opts.now ?? Date.now()
  const staleMs = opts.staleMs ?? LOCK_STALE_MS
  const isAlive = opts.isAlive ?? pidAlive
  const grace = opts.ownerlessGraceMs ?? 60_000
  mkdirSync(dirname(lockDir), { recursive: true })

  const owner: LockOwner = {
    pid,
    started_at: new Date(now).toISOString(),
    child_pids: [],
    ...(opts.holder ? { holder: opts.holder } : {}),
    ...(opts.runId ? { run_id: opts.runId } : {}),
  }
  const claim = (tookOver: boolean, previous: LockOwner | null): AcquireResult => {
    const lock = new ResignLock(lockDir, owner)
    writeJsonAtomic(join(lockDir, 'owner.json'), owner, { mkdir: false })
    const pids = previous?.child_pids ?? []
    const reap = pids.map((p) => ({ pid: p, started_at: previous?.children?.find((c) => c.pid === p)?.started_at ?? null }))
    return { ok: true, lock, took_over: tookOver, reap_pids: pids, reap, previous }
  }

  if (tryMkdir(lockDir)) return claim(false, null)

  const current = readOwner(lockDir)
  if (current) {
    if (!ownerStale(current, now, staleMs, isAlive, opts.processStart)) return { ok: false, reason: 'busy', owner: current }
  } else {
    // No owner.json yet: either a taker between mkdir and its write (busy), or
    // a crash in that gap long ago (stale).
    let age: number
    try {
      age = now - statSync(lockDir).mtimeMs
    } catch {
      // Released between our mkdir and now: one more plain attempt.
      if (tryMkdir(lockDir)) return claim(false, null)
      return { ok: false, reason: 'busy', owner: readOwner(lockDir) }
    }
    if (age < grace) return { ok: false, reason: 'busy', owner: null }
  }

  // Take over IN PLACE: the lock dir never disappears (so no fresh mkdir can
  // slip in and swallow the stale owner's children), and a nested mkdir
  // serialises the takers. Inside it, re-read the owner: if it is no longer
  // the one we judged stale, another taker already won.
  const gate = join(lockDir, 'takeover')
  if (!tryMkdirGate(gate, now, grace)) return { ok: false, reason: 'busy', owner: readOwner(lockDir) }
  try {
    if (!sameOwner(readOwner(lockDir), current)) return { ok: false, reason: 'busy', owner: readOwner(lockDir) }
    return claim(true, current)
  } finally {
    try {
      rmSync(gate, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
}

/** mkdir the takeover gate; a gate abandoned by a crash mid-takeover (older
 *  than grace) is cleared once and retried. */
function tryMkdirGate(gate: string, now: number, grace: number): boolean {
  try {
    if (tryMkdir(gate)) return true
  } catch {
    return false // lock dir vanished (released): let the caller report busy
  }
  try {
    if (now - statSync(gate).mtimeMs < grace) return false
    rmSync(gate, { recursive: true, force: true })
    return tryMkdir(gate)
  } catch {
    return false
  }
}
