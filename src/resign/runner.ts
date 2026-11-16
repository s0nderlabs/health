// Auto re-sign, the ORCHESTRATOR: steps 0-17 of the design, in two phases.
//   BUILD (Mac only): gates, preflight, quarantine our cached profiles, mint
//     with xcodebuild, verify both embedded profiles, stage the bundle.
//   INSTALL (needs the phone and the daemon): gates, blockers, device probes,
//     install, relaunch, confirm through the daemon's clock.
//
// Every external effect is injected (exec, daemon preflight, clock, sleep,
// tree kill), so the whole run is testable against a fake exec. The runner
// NEVER alerts: it writes facts (state.json, resign.log, resign.jsonl, the
// run dir) and the daemon decides what to say.
//
// Control flow: each step either returns or throws a Stop carrying the
// outcome; finish() (step 17) always runs. A 40-min watchdog races the whole
// run and, when it wins, kills the children, puts quarantined profiles back
// (unless a mint was verified), and merges its outcome WITHOUT touching
// pending_confirm (an install that already happened must survive it).

import { intentsGap } from './bundle.js'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, appendFileSync, writeFileSync } from 'fs'
import { createHash } from 'crypto'
import { dirname, join } from 'path'
import { exec as realExec, killTree as realKillTree, liveChildPids, processStartMs, type ExecFn, type ExecOptions } from './exec.js'
import { decodeProfile, findOurProfiles, quarantine, readManifest, restore, type ProfileInfo } from './profile.js'
import { listDevices, lockState, install as deviceInstall, appInfo, launch as deviceLaunch } from './device.js'
import {
  APP_BUNDLE_ID,
  WIDGET_BUNDLE_ID,
  RUN_WATCHDOG_MS,
  TIMEOUTS,
  CONFIRM_SLACK_MS,
  BATTERY_MIN_PCT,
  HARD_AFTER,
  buildAllowed,
  checkFreshPair,
  classifyBuild,
  classifyInstall,
  classifyLaunch,
  clockGate,
  escalatedClass,
  installAllowed,
  parseDevices,
  parseLockState,
  parseTeamId,
  reconcilePending,
  sameVersion,
  snapshotGuard,
  stagedValid,
  toMs,
  type Classified,
  type DecodedProfile,
  type FailClass,
  type ResignConfig,
} from './policy.js'
import {
  acquireLock,
  emptyCounters,
  emptyState,
  emptyStreaks,
  makeRunId,
  mergeStatePreservingPending,
  readState,
  writeJsonAtomic,
  writeState,
  type ResignLock,
  type ResignPaths,
  type ResignState,
  type RunPhase,
  type RunTrigger,
  type StagedInfo,
} from './state.js'
import type { ResignPreflight } from './hooks.js'
import type { DbClock } from './rpc.js'

// ── Constants ─────────────────────────────────────────────────────

/** The xcodebuild flags the runner shares with scripts/build-phone.sh (a
 *  drift test pins every entry into the script). The runner adds -project,
 *  -derivedDataPath and the build action around them. */
export const BUILD_FLAGS = ['-scheme', 'HealthRelay', '-destination', 'generic/platform=iOS', '-allowProvisioningUpdates'] as const

const LOG_ROTATE_BYTES = 5 * 1024 * 1024
const PRUNE_MS = 14 * 24 * 3_600_000
/** Kick flags older than this are stale (the kickstart they belonged to
 *  never ran us) and are dropped instead of honoured. */
const FLAGS_STALE_MS = 15 * 60_000
/** Children a stale-lock takeover may reap, by executable name. */
const REAPABLE = new Set(['xcodebuild', 'devicectl'])
/** A recorded child is reaped only if its current start time is within this
 *  of the recorded spawn time (ps etime has 1 s resolution). */
const REAP_START_SLACK_MS = 3_000
/** Classes an install must NOT clear: they describe the install itself (or
 *  what happens right after it), so clearing them on every reinstall would
 *  give each recurrence a fresh episode, a fresh key, and a fresh alert. */
const POST_INSTALL_CLASSES = new Set<string>(['untrusted_developer', 'install_did_not_take', 'new_certificate'])

// ── Types ─────────────────────────────────────────────────────────

export interface SourceInfo {
  /** 'X.Y.Z (N)' from the BUILT Info.plist. */
  version: string
  git_commit: string | null
  dirty: boolean | null
  content_sha256: string | null
  captured_at: string
}

export interface RunOptions {
  trigger?: RunTrigger
  forced?: boolean
  buildOnly?: boolean
  /** Every read probe, no mutation (lock + heartbeat only). */
  dryRun?: boolean
  /** Read-only report: no lock, no state, no log lines. */
  plan?: boolean
  /** plan: also probe the phone's lockState. */
  probeLock?: boolean
  /** Do not consume the kick flags file (plan, tests). */
  ignoreFlags?: boolean
}

export interface RunnerDeps {
  paths: ResignPaths
  /** null = the daemon is unreachable. */
  preflight: () => Promise<ResignPreflight | null>
  loadConfig: () => ResignConfig
  /** Daemon-down fallback: health.db meta, read-only. */
  readDbClock?: () => DbClock | null
  exec?: ExecFn
  now?: () => number
  localHour?: (ms: number) => number
  sleep?: (ms: number) => Promise<void>
  pid?: number
  isAlive?: (pid: number) => boolean
  /** Executable name (and full command) of a pid, for comm-verified reaping. */
  commOf?: (pid: number) => Promise<{ comm: string; command: string } | null>
  /** When a pid started (epoch ms, real clock), for start-time-verified
   *  reaping and the lock's pid-reuse check. Default: ps etime. */
  processStart?: (pid: number) => number | null
  killTree?: (pid: number) => Promise<unknown>
  liveChildren?: () => number[]
  /** Hold off idle sleep during the build (caffeinate -i -w <pid>); returns
   *  the release. */
  keepAwake?: () => () => void
  watchdogMs?: number
  confirmTotalMs?: number
  confirmPollMs?: number
  /** Parent for profile decode temp dirs. */
  tmpDir?: string
  /** Echo of the finish line (launchd.log via stderr). */
  log?: (msg: string) => void
}

export type RunOutcome =
  | 'busy'
  | 'disabled'
  | 'unknown_expiry'
  | 'noop'
  | 'stopped'
  | 'skipped'
  | 'failed'
  | 'staged'
  | 'installed_unconfirmed'
  | 'confirmed'
  | 'run_timeout'
  | 'dry_run'
  | 'plan'

export interface RunReport {
  run_id: string
  trigger: RunTrigger
  mode: 'run' | 'dry' | 'plan'
  forced: boolean
  build_only: boolean
  phase: RunPhase
  outcome: RunOutcome
  reason: string | null
  class: FailClass | null
  hard: boolean
  hours_left: number | null
  signed_until: string | null
  started_at: string
  duration_ms: number
  durations: Record<string, number>
  run_dir: string
  /** Facts and would-do lines (dry run and plan carry the full picture). */
  notes: string[]
}

class Stop {
  constructor(
    readonly outcome: RunOutcome,
    readonly reason: string | null,
    readonly cls: FailClass | null = null,
    readonly hard = false,
  ) {}
}

// ── Small pure helpers (exported for the CLI and tests) ───────────

export { readJsonFile } from './state.js'
import { readJsonFile } from './state.js'

/** A source snapshot's identity: its content hash, else its capture time. */
export function sourceId(s: Pick<SourceInfo, 'content_sha256' | 'captured_at'>): string {
  return s.content_sha256 ?? `captured:${s.captured_at}`
}

export function readSource(p: ResignPaths): SourceInfo | null {
  const s = readJsonFile<Partial<SourceInfo>>(p.sourceJson)
  if (!s || typeof s.version !== 'string' || typeof s.captured_at !== 'string') return null
  return {
    version: s.version,
    git_commit: typeof s.git_commit === 'string' ? s.git_commit : null,
    dirty: typeof s.dirty === 'boolean' ? s.dirty : null,
    content_sha256: typeof s.content_sha256 === 'string' ? s.content_sha256 : null,
    captured_at: s.captured_at,
  }
}

export function toDecoded(p: ProfileInfo): DecodedProfile {
  return {
    uuid: p.uuid,
    creation_date: p.creationDate,
    expiration_date: p.expirationDate,
    team_ids: p.teamId ? [p.teamId] : [],
    application_identifier: p.appId,
    provisioned_devices: p.devices,
  }
}

/** SHA-1s of valid codesigning identities, plus how many are Apple Development. */
export function parseIdentities(text: string): { sha1s: string[]; appleDevelopment: number } {
  const sha1s: string[] = []
  let appleDevelopment = 0
  for (const m of text.matchAll(/^\s*\d+\)\s+([0-9A-F]{40})\s+"([^"]*)"/gim)) {
    sha1s.push(m[1].toUpperCase())
    if (/^Apple Development:/.test(m[2])) appleDevelopment++
  }
  return { sha1s, appleDevelopment }
}

/** `defaults read com.apple.dt.Xcode DVTDeveloperAccountManagerAppleIDLists`
 *  lists signed-in accounts as `identifier = ...;` entries. The values are
 *  never logged (they are Apple IDs). */
export function hasXcodeAccount(code: number | null, text: string): boolean {
  return code === 0 && /\bidentifier\s*=\s*\S/.test(text)
}

export function parseBattery(text: string): { onBattery: boolean; pct: number | null } {
  const onBattery = /drawing from 'Battery Power'/i.test(text)
  const m = text.match(/(\d{1,3})%/)
  return { onBattery, pct: m ? Number(m[1]) : null }
}

/** The built app under a pinned DerivedData, never the Index.noindex copy. */
export function findProduct(derivedData: string): string | null {
  const products = join(derivedData, 'Build', 'Products')
  try {
    for (const d of readdirSync(products).sort()) {
      if (!d.endsWith('-iphoneos')) continue
      const app = join(products, d, 'HealthRelay.app')
      if (existsSync(app)) return app
    }
  } catch {
    // no products dir
  }
  return null
}

export function widgetPath(appPath: string): string {
  return join(appPath, 'PlugIns', 'HealthRelayWidgets.appex')
}

function minIso(a: string, b: string): string {
  return (toMs(a) ?? 0) <= (toMs(b) ?? 0) ? a : b
}

/** 'Nov 16 03:29:47 2027 GMT' (openssl -enddate) to ISO; null when odd. */
export function parseOpensslDate(s: string): string | null {
  const m = s.match(/([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})\s+GMT/)
  if (!m) return null
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].indexOf(m[1])
  if (mon < 0) return null
  return new Date(Date.UTC(Number(m[6]), mon, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]))).toISOString()
}

const BUILD_PHASE_CLASSES = new Set<string>([
  'account_broken',
  'profile_not_fresh',
  'keychain_prompt',
  'prompt_hang',
  'xcode_setup',
  'free_tier_limit',
  'snapshot_mismatch',
  'other',
  'run_timeout',
  'device_not_in_profile',
])

// ── The run ───────────────────────────────────────────────────────

export async function runResign(opts: RunOptions, deps: RunnerDeps): Promise<RunReport> {
  return new Run(opts, deps).go()
}

class Run {
  private readonly p: ResignPaths
  private readonly baseExec: ExecFn
  private readonly now: () => number
  private readonly t0: number
  private readonly runId: string
  private mode: 'run' | 'dry' | 'plan'
  private o: RunOptions
  private st: ResignState = emptyState()
  private lock: ResignLock | null = null
  private aborted = false
  private runDir: string
  private cfg: ResignConfig | null = null
  private pf: ResignPreflight | null = null
  private daemonDown = false
  private signedUntil: string | null = null
  private hoursLeft: number | null = null
  private phoneVersion: string | null = null
  private helloAt: string | null = null
  private phaseNow: RunPhase = 'boot'
  private notes: string[] = []
  private durations: Record<string, number> = {}
  private movedUuids: string[] = []

  constructor(
    opts: RunOptions,
    private readonly d: RunnerDeps,
  ) {
    this.o = { ...opts }
    this.p = d.paths
    this.baseExec = d.exec ?? realExec
    this.now = d.now ?? Date.now
    this.t0 = this.now()
    this.runId = makeRunId(new Date(this.t0))
    this.mode = opts.plan ? 'plan' : opts.dryRun ? 'dry' : 'run'
    this.runDir = join(this.p.runsDir, this.mode === 'plan' ? `${this.runId}-plan` : this.runId)
  }

  private iso(ms = this.now()): string {
    return new Date(ms).toISOString()
  }

  private note(s: string): void {
    this.notes.push(s)
  }

  private phase(ph: RunPhase): void {
    this.phaseNow = ph
    this.st.phase = ph
  }

  private localHour(): number {
    const ms = this.now()
    return this.d.localHour ? this.d.localHour(ms) : new Date(ms).getHours()
  }

  /** exec that records every child pid in the lock's owner.json, and that
   *  refuses to spawn anything once the watchdog has won (the main flow is
   *  not cancelled by the race, so it must not start new children the kill
   *  loop already took its snapshot without). */
  private exec: ExecFn = async (argv, opts) => {
    if (this.aborted) throw new Stop('run_timeout', 'aborted')
    let child: number | null = null
    const wrapped: ExecOptions = {
      ...opts,
      onSpawn: (pid) => {
        child = pid
        try {
          this.lock?.addChild(pid, new Date().toISOString())
        } catch {
          // a lost owner.json write must never break the call
        }
        opts.onSpawn?.(pid)
      },
    }
    try {
      return await this.baseExec(argv, wrapped)
    } finally {
      if (child != null) {
        try {
          this.lock?.removeChild(child)
        } catch {
          // ignore
        }
      }
    }
  }

  private async timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const t = this.now()
    try {
      return await fn()
    } finally {
      this.durations[label] = (this.durations[label] ?? 0) + (this.now() - t)
    }
  }

  // ── state ──

  /** Persist. A dry run only stamps the heartbeat facts; an aborted run
   *  (watchdog won) never writes again. */
  private save(): void {
    if (this.aborted || this.mode === 'plan') return
    if (this.mode === 'dry') {
      const cur = readState(this.p.stateFile) ?? emptyState()
      writeState(this.p.stateFile, {
        ...cur,
        enabled: this.st.enabled,
        dry_run: true,
        last_run_at: this.st.last_run_at,
        last_run_id: this.st.last_run_id,
        trigger: this.st.trigger,
        phase: this.st.phase,
        daemon_down: this.st.daemon_down,
        signed_until: this.st.signed_until,
        hours_left: this.st.hours_left,
        last_outcome: this.st.last_outcome,
        last_reason: this.st.last_reason,
      })
      return
    }
    writeState(this.p.stateFile, this.st)
  }

  private bump(key: string): void {
    const c = this.st.counters as unknown as Record<string, unknown>
    if (typeof c[key] === 'number') c[key] = (c[key] as number) + 1
  }

  private soft(cls: string, detail: string | null = null): never {
    this.bump(cls)
    this.st.counters.last_skip_reason = detail ? `${cls}: ${detail}` : cls
    throw new Stop('skipped', detail ? `${cls}: ${detail}` : cls, cls as FailClass, false)
  }

  /** Record a hard episode without throwing. Identity (since, which keys the
   *  daemon's one alert) is per class per WINDOW: a recurrence in the same
   *  window keeps its since even if another class held the slot in between,
   *  so alternating classes never re-mint keys; a class whose episode began
   *  before this window (counters.since) starts a new one, so a cycle-N
   *  episode can never silence the same failure in cycle N+1. */
  private markHard(cls: FailClass, detail: string | null): void {
    const at = this.iso()
    const win = toMs(this.st.counters.since)
    const inWindow = (s: string | null | undefined): boolean => {
      const t = toMs(s ?? null)
      return win != null && t != null && t >= win
    }
    const mem = this.st.episode_since ?? {}
    const ep = this.st.episode
    let since = at
    if (ep && ep.class === cls && inWindow(ep.since)) since = ep.since
    else if (inWindow(mem[cls])) since = mem[cls]
    this.st.episode = { class: cls, since, hard: true, last_at: at, detail }
    const kept = Object.fromEntries(Object.entries(mem).filter(([, v]) => inWindow(v)))
    this.st.episode_since = { ...kept, [cls]: since }
    this.st.last_hard_class = cls
  }

  private hard(cls: FailClass, detail: string | null = null): never {
    this.markHard(cls, detail)
    throw new Stop('failed', detail ? `${cls}: ${detail}` : cls, cls, true)
  }

  /** The watchdog won: nothing new may start or move. */
  private checkAborted(step: string): void {
    if (this.aborted) throw new Stop('run_timeout', `aborted before ${step}`)
  }

  /** A mutating step only runs while the lock on disk is still ours. */
  private checkLock(step: string): void {
    if (this.mode === 'run' && this.lock && !this.lock.held()) throw new Stop('busy', `lock_lost before ${step}`)
  }

  /** A streak class: count it, escalate on the Nth in a row. */
  private streakFail(cls: keyof typeof HARD_AFTER, detail: string | null): never {
    const n = (this.st.streaks[cls] ?? 0) + 1
    this.st.streaks[cls] = n
    const esc = escalatedClass(cls, n)
    if (esc.hard) this.hard(esc.class, `${detail ?? cls} (${n} in a row)`)
    this.soft(esc.class, detail)
  }

  /** Route a classified failure: streak classes, then intrinsic severity. */
  private fail(c: Classified, detail: string): never {
    if (c.class in HARD_AFTER) this.streakFail(c.class as keyof typeof HARD_AFTER, `${detail}: ${c.why}`)
    if (c.hard) this.hard(c.class, `${detail}: ${c.why}`)
    this.soft(c.class, `${detail}: ${c.why}`)
  }

  private clearEpisodeIf(pred: (cls: string) => boolean): void {
    if (this.st.episode && pred(this.st.episode.class)) this.st.episode = null
  }

  /** Put quarantined profiles back, unless this run's mint was verified
   *  (then the originals stay in the backup dir: never old next to new). */
  private restoreProfiles(why: string): void {
    const pm = this.st.profiles_moved
    if (!pm) return
    if (this.mode === 'run' && this.lock && !this.lock.held()) {
      // Someone else holds the cache now: putting old profiles next to their
      // mint is worse than waiting. profiles_moved stays, recover() finishes.
      this.note(`profiles NOT restored (${why}): the lock is no longer ours; a later run recovers them`)
      return
    }
    if (this.st.mint_verified?.run_id === pm.run_id) {
      this.note(`profiles: mint verified, originals stay in ${pm.backup_dir}`)
      this.st.profiles_moved = null
      return
    }
    const r = restore(join(pm.backup_dir, 'manifest.json'))
    this.note(
      `profiles restored (${why}): ${r.restored.length} back, ${r.keptExisting.length} kept existing, ${r.missingBackup.length} missing, ${r.errors.length} errors`,
    )
    this.st.profiles_moved = null
  }

  // ── entry ──

  async go(): Promise<RunReport> {
    let stop: Stop
    try {
      mkdirSync(this.runDir, { recursive: true })
    } catch {
      // logs land elsewhere; the run can still decide
    }
    if (this.mode !== 'plan') this.rotateLog()

    // Step 0: lock (plan reads only and never locks).
    if (this.mode !== 'plan') {
      const acq = acquireLock(this.p.lockDir, {
        pid: this.d.pid,
        now: this.now(),
        holder: 'resign',
        runId: this.runId,
        isAlive: this.d.isAlive,
        processStart: this.d.processStart,
      })
      if (!acq.ok) {
        this.note(`lock busy: held by pid ${acq.owner?.pid ?? '?'} since ${acq.owner?.started_at ?? '?'}`)
        return this.finishLine(new Stop('busy', 'lock_held'), false)
      }
      this.lock = acq.lock
      if (acq.took_over) await this.reap(acq.reap, acq.previous?.pid ?? null)
      if (!this.o.ignoreFlags) this.consumeFlags()
    }
    this.st = readState(this.p.stateFile) ?? emptyState()
    this.st.last_run_id = this.runId
    this.st.trigger = this.o.trigger ?? 'interval'

    const watchdogMs = this.d.watchdogMs ?? RUN_WATCHDOG_MS
    let timer: ReturnType<typeof setTimeout> | null = null
    const watchdog = new Promise<'watchdog'>((resolve) => {
      timer = setTimeout(() => resolve('watchdog'), watchdogMs)
    })
    const main = (async (): Promise<Stop> => {
      try {
        if (this.mode === 'run') await this.main()
        else await this.inspect()
        return new Stop(this.mode === 'run' ? 'confirmed' : this.mode === 'dry' ? 'dry_run' : 'plan', null)
      } catch (e) {
        if (e instanceof Stop) return e
        const msg = e instanceof Error ? e.message : String(e)
        this.note(`unexpected error: ${msg}`)
        // An unexpected throw is a runner bug: restore anything quarantined
        // and record it as a hard 'other' (the daemon alerts once).
        if (this.mode === 'run') {
          try {
            this.restoreProfiles('unexpected error')
          } catch {
            // best effort
          }
          try {
            this.hard('other', `runner error: ${msg.slice(0, 200)}`)
          } catch (s) {
            if (s instanceof Stop) return s
          }
        }
        return new Stop('failed', `runner error: ${msg.slice(0, 200)}`, 'other', true)
      }
    })()
    const winner = await Promise.race([main, watchdog])
    if (timer) clearTimeout(timer)
    if (winner === 'watchdog') {
      stop = await this.onWatchdog()
      return this.finishLine(stop, true)
    }
    stop = winner
    return this.finish(stop)
  }

  private rotateLog(): void {
    try {
      if (statSync(this.p.logFile).size > LOG_ROTATE_BYTES) renameSync(this.p.logFile, this.p.logFile + '.1')
    } catch {
      // no log yet
    }
  }

  private consumeFlags(): void {
    const f = readJsonFile<{ force?: boolean; build_only?: boolean; dry_run?: boolean; trigger?: string; at?: string }>(
      this.p.flagsFile,
    )
    if (!existsSync(this.p.flagsFile)) return
    try {
      rmSync(this.p.flagsFile, { force: true })
    } catch {
      // a flags file we cannot delete would replay; note it
      this.note('flags file could not be deleted')
    }
    if (!f) return
    const at = toMs(f.at ?? null)
    if (at == null || this.now() - at > FLAGS_STALE_MS) {
      this.note('stale kick flags dropped')
      return
    }
    this.o = {
      ...this.o,
      trigger: f.trigger === 'hello' ? 'hello' : 'kick',
      forced: this.o.forced || f.force === true,
      buildOnly: this.o.buildOnly || f.build_only === true,
      dryRun: this.o.dryRun || f.dry_run === true,
    }
    if (this.o.dryRun && this.mode === 'run') this.mode = 'dry'
    this.note(`kick flags: ${JSON.stringify({ force: f.force === true, build_only: f.build_only === true, dry_run: f.dry_run === true, trigger: this.o.trigger })}`)
  }

  /** Stale takeover: kill the previous owner's recorded children, but only
   *  the very processes it recorded: the current start time must match the
   *  recorded spawn time (owner.json survives reboots, pids get reused), and
   *  the executable must be xcodebuild or devicectl. A child without a
   *  recorded start time is left alone. */
  private async reap(children: Array<{ pid: number; started_at: string | null }>, ownerPid: number | null): Promise<void> {
    const commOf = this.d.commOf ?? defaultCommOf
    const kill = this.d.killTree ?? ((pid: number) => realKillTree(pid))
    const startOf = this.d.processStart ?? processStartMs
    for (const { pid, started_at } of children) {
      if (pid === ownerPid) continue
      const recorded = toMs(started_at)
      if (recorded == null) {
        this.note(`reap: pid ${pid} has no recorded start time, left alone`)
        continue
      }
      const current = startOf(pid)
      if (current == null) continue // gone
      if (Math.abs(current - recorded) > REAP_START_SLACK_MS) {
        this.note(`reap: pid ${pid} was reused by another process, left alone`)
        continue
      }
      const c = await commOf(pid)
      if (!c) continue
      const base = c.comm.split('/').pop() ?? ''
      const viaXcrun = base === 'xcrun' && /\bdevicectl\b/.test(c.command)
      if (!REAPABLE.has(base) && !viaXcrun) {
        this.note(`reap: pid ${pid} is ${base}, left alone`)
        continue
      }
      await kill(pid)
      this.note(`reap: killed orphan ${base} pid ${pid}`)
    }
  }

  private async onWatchdog(): Promise<Stop> {
    this.aborted = true
    const kill = this.d.killTree ?? ((pid: number) => realKillTree(pid))
    for (const pid of (this.d.liveChildren ?? liveChildPids)()) {
      try {
        await kill(pid)
      } catch {
        // keep going
      }
    }
    if (this.mode !== 'run') return new Stop('run_timeout', 'watchdog')
    try {
      this.restoreProfiles('watchdog')
    } catch {
      // best effort
    }
    const n = (this.st.streaks.run_timeout ?? 0) + 1
    const esc = escalatedClass('run_timeout', n)
    if (esc.hard) this.markHard('run_timeout', `watchdog fired in ${this.phaseNow} (${n} in a row)`)
    const { pending_confirm: _keep, ...rest } = this.st
    try {
      mergeStatePreservingPending(this.p.stateFile, {
        ...rest,
        phase: this.phaseNow,
        streaks: { ...this.st.streaks, run_timeout: n },
        last_outcome: 'run_timeout',
        last_reason: `watchdog in ${this.phaseNow}`,
      })
    } catch (e) {
      this.note(`watchdog state write failed: ${e}`)
    }
    return new Stop('run_timeout', `watchdog in ${this.phaseNow}`, 'run_timeout', esc.hard)
  }

  // ── step 17 ──

  private finish(stop: Stop): RunReport {
    if (this.mode !== 'plan') {
      this.st.last_outcome = stop.outcome
      this.st.last_reason = stop.reason
      if (stop.outcome !== 'run_timeout' && this.mode === 'run') this.st.streaks.run_timeout = 0
      try {
        this.save()
      } catch (e) {
        this.note(`state write failed: ${e}`)
      }
    }
    return this.finishLine(stop, true)
  }

  private finishLine(stop: Stop, release: boolean): RunReport {
    const report: RunReport = {
      run_id: this.runId,
      trigger: this.o.trigger ?? 'interval',
      mode: this.mode,
      forced: !!this.o.forced,
      build_only: !!this.o.buildOnly,
      phase: this.phaseNow,
      outcome: stop.outcome,
      reason: stop.reason,
      class: stop.cls,
      hard: stop.hard,
      hours_left: this.hoursLeft,
      signed_until: this.signedUntil,
      started_at: this.iso(this.t0),
      duration_ms: this.now() - this.t0,
      durations: this.durations,
      run_dir: this.runDir,
      notes: this.notes,
    }
    if (this.mode !== 'plan') {
      const durs = Object.entries(this.durations)
        .map(([k, v]) => `${k}=${Math.round(v / 1000)}s`)
        .join(',')
      const line =
        `${this.iso()} run=${this.runId} trigger=${report.trigger} mode=${this.mode}${report.forced ? ' forced' : ''}` +
        `${report.build_only ? ' build-only' : ''} phase=${report.phase} outcome=${report.outcome}` +
        ` reason=${report.reason ?? '-'} hours_left=${report.hours_left ?? '-'}` +
        ` dur=${Math.round(report.duration_ms / 1000)}s${durs ? ` (${durs})` : ''} log=${this.runDir}`
      try {
        mkdirSync(this.p.runtime, { recursive: true })
        appendFileSync(this.p.logFile, line + '\n')
        appendFileSync(this.p.jsonlFile, JSON.stringify(report) + '\n')
      } catch {
        // logs are best effort; state.json is the contract
      }
      this.d.log?.(line)
    }
    if (release && this.lock) {
      try {
        this.lock.release()
      } catch {
        // ignore
      }
    }
    if (this.mode !== 'plan' && release) this.prune()
    return report
  }

  /** runs/ and profile-backups/ older than 14 days. A backup still named by
   *  profiles_moved is never pruned. */
  private prune(): void {
    const cutoff = this.now() - PRUNE_MS
    const keep = this.st.profiles_moved?.backup_dir
    for (const dir of [this.p.runsDir, this.p.profileBackups]) {
      let entries: string[] = []
      try {
        entries = readdirSync(dir)
      } catch {
        continue
      }
      for (const e of entries) {
        const full = join(dir, e)
        if (full === keep) continue
        try {
          if (statSync(full).mtimeMs < cutoff) rmSync(full, { recursive: true, force: true })
        } catch {
          // ignore
        }
      }
    }
  }

  // ── the real run ──

  private async main(): Promise<void> {
    // 1 LOAD
    this.phase('load')
    const cfg = (this.cfg = this.d.loadConfig())
    this.st.last_run_at = this.iso(this.t0)
    this.st.dry_run = false
    this.st.enabled = cfg.enabled

    // 3 RECOVER, before the disabled exit: it is local-only and idempotent,
    // and a forced run (allowed while disabled) that crashed after its
    // quarantine must not strand the profiles until the next forced run.
    this.phase('recover')
    this.recover()

    if (!cfg.enabled && !this.o.forced) throw new Stop('disabled', 'resign.enabled is false')
    this.save() // heartbeat immediately

    // 2 CLOCK
    this.phase('clock')
    await this.timed('clock', () => this.clock())

    // 4 RECONCILE
    this.reconcile()

    // 5 GATE
    this.phase('gate')
    this.gate()

    // 6 SNAPSHOT
    const source = this.snapshot()

    // 7 STAGED
    let staged = await this.timed('staged_check', () => this.stagedCheck(source))
    if (!staged) {
      this.phase('build')
      const teamId = await this.buildGate()
      const xcodebuild = await this.timed('preflight', () => this.buildPreflight())
      await this.timed('quarantine', () => this.quarantine(teamId))
      staged = await this.timed('build', () => this.build(xcodebuild, source, teamId))
      if (this.o.buildOnly) throw new Stop('staged', null)
    } else if (this.o.buildOnly) {
      throw new Stop('staged', 'already_staged')
    }

    // 12 INSTALL GATE
    this.phase('install')
    const action = this.installGate(staged)

    // 13 BLOCKERS
    this.blockers(this.pf)

    // 14 PROBES
    const udid = await this.timed('probes', () => this.probes())

    // 15 INSTALL (+ launch)
    if (action === 'install') await this.timed('install', () => this.install(udid, staged!))
    else await this.toctou()
    await this.timed('launch', () => this.launch(udid))

    // 16 CONFIRM
    this.phase('confirm')
    await this.timed('confirm', () => this.confirm())
  }

  // 2
  private async clock(): Promise<void> {
    this.pf = await this.d.preflight()
    if (this.pf) {
      this.daemonDown = false
      this.signedUntil = this.pf.signed_until
      this.hoursLeft = this.pf.hours_left
      this.phoneVersion = this.pf.phone_app_version
      this.helloAt = this.pf.phone_hello_at
    } else {
      this.daemonDown = true
      const db = this.d.readDbClock?.() ?? null
      this.signedUntil = db?.signed_until ?? null
      const t = toMs(this.signedUntil)
      this.hoursLeft = t == null ? null : Math.round(((t - this.now()) / 3_600_000) * 10) / 10
      this.phoneVersion = db?.phone_app_version ?? null
      this.helloAt = db?.phone_hello_at ?? null
      this.bump('daemon_down')
      this.note(`daemon unreachable: clock from health.db (${this.signedUntil ?? 'unknown'}); build phase only`)
    }
    this.st.daemon_down = this.daemonDown
    this.st.signed_until = this.signedUntil
    this.st.hours_left = this.hoursLeft
  }

  // 3
  private recover(): void {
    this.checkAborted('recover')
    this.recoverBuildPhone()
    const pm = this.st.profiles_moved
    if (!pm) return
    if (this.st.mint_verified?.run_id === pm.run_id) {
      this.note(`recover: run ${pm.run_id} had a verified mint; originals stay in ${pm.backup_dir}`)
    } else {
      const r = restore(join(pm.backup_dir, 'manifest.json'))
      this.note(
        `recover: run ${pm.run_id} crashed mid-quarantine; restored ${r.restored.length}, kept ${r.keptExisting.length}, missing ${r.missingBackup.length}, errors ${r.errors.length}`,
      )
    }
    this.st.profiles_moved = null
    this.save()
  }

  /** build-phone.sh keeps its quarantine record in <backup>/moves.tsv and
   *  marks the dir 'active' until it either verified a fresh mint or put the
   *  originals back. An 'active' dir we can see while WE hold the lock means
   *  that script died mid-build (kill -9, a closed terminal): put its
   *  originals back the way it would have (never over an existing file). */
  private recoverBuildPhone(): void {
    let entries: string[] = []
    try {
      entries = readdirSync(this.p.profileBackups)
    } catch {
      return
    }
    for (const e of entries) {
      if (!e.endsWith('-build-phone')) continue
      const dir = join(this.p.profileBackups, e)
      const marker = join(dir, 'active')
      if (!existsSync(marker)) continue
      let restored = 0
      let kept = 0
      let tsv = ''
      try {
        tsv = readFileSync(join(dir, 'moves.tsv'), 'utf8')
      } catch {
        // no moves recorded: nothing moved
      }
      for (const line of tsv.split('\n')) {
        const [from, to] = line.split('\t')
        if (!from || !to) continue
        if (existsSync(from) || !existsSync(to)) {
          kept++
          continue
        }
        try {
          mkdirSync(dirname(from), { recursive: true })
          renameSync(to, from)
          restored++
        } catch (err) {
          this.note(`recover build-phone ${e}: ${from}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      try {
        rmSync(marker, { force: true })
      } catch {
        // retried next run
      }
      this.note(`recover: build-phone.sh run ${e} died mid-quarantine; restored ${restored}, left ${kept}`)
    }
  }

  // 4
  private reconcile(): void {
    const pending = this.st.pending_confirm
    const v = reconcilePending({
      pending,
      signedUntil: this.signedUntil,
      oldSignedUntil: pending?.old_signed_until ?? null,
      lastHelloAt: this.helloAt,
    })
    if (v.verdict === 'confirmed') {
      this.note('reconcile: the phone reports the new signature: confirmed')
      this.success()
      this.save()
    } else if (v.verdict === 'superseded') {
      // A manual install fixed whatever the episode was about: a later
      // recurrence must be a NEW episode (a new alert), not the old key.
      this.note('reconcile: the phone reports another newer signature (a manual install): pending and episode cleared')
      this.st.pending_confirm = null
      this.st.episode = null
      this.st.episode_since = {}
      this.st.last_hard_class = null
      // The phone now runs a build signed outside the runner, by a cert we
      // cannot see: forget the baseline, so a cert he already trusted by hand
      // never reads as "changed" (certChanged is false without a baseline).
      if (this.st.last_success) this.st.last_success = { ...this.st.last_success, cert_sha1: null }
      this.save()
    } else if (v.verdict === 'did_not_take') {
      // Recorded, not thrown: the run continues (the pending rule keeps a
      // reinstall from looping, a later run may relaunch). The episode
      // alerts once per window, even when another class takes the slot later.
      this.markHard('install_did_not_take', 'a hello after the install still reports the old signature')
      this.note('reconcile: install did not take')
      this.save()
    }
  }

  private success(): void {
    const expiry = this.signedUntil ?? this.st.pending_confirm?.expected_until ?? this.iso()
    this.st.last_success = {
      at: this.iso(),
      expiry,
      cert_sha1: this.st.staged?.cert_sha1 ?? this.st.last_success?.cert_sha1 ?? null,
      window_since: this.st.counters.since,
    }
    this.st.pending_confirm = null
    this.st.staged = null
    try {
      rmSync(this.p.stagingCurrent, { force: true })
    } catch {
      // the bundle check would reject it anyway
    }
    this.st.episode = null
    this.st.episode_since = {}
    this.st.last_hard_class = null
    this.st.counters = emptyCounters(null)
    this.st.streaks = emptyStreaks()
  }

  // 5
  private gate(): void {
    const g = clockGate(this.hoursLeft, this.cfg!, !!this.o.forced)
    if (!g.proceed) {
      if (g.outcome === 'noop' && this.st.counters.since && !this.st.pending_confirm) {
        this.st.counters = emptyCounters(null) // the window closed (a manual install)
        this.st.episode_since = {}
      }
      throw new Stop(g.outcome, g.outcome === 'noop' ? `hours_left ${this.hoursLeft} > ${this.cfg!.window_hours}` : g.outcome)
    }
    if (!this.st.counters.since) this.st.counters.since = this.iso()
    this.st.counters.attempts++
    this.st.counters.last_attempt_at = this.iso()
  }

  // 6
  private snapshot(): SourceInfo {
    const source = readSource(this.p)
    const g = snapshotGuard({ source, phoneVersion: this.phoneVersion, now: this.now() })
    if (!g.ok) {
      if (g.class === 'awaiting_hello') this.soft('awaiting_hello', `snapshot ${source?.version} vs phone ${this.phoneVersion}`)
      this.hard(
        'snapshot_mismatch',
        g.why === 'missing'
          ? 'no source snapshot (run: bun run resign seed --ref <commit of the installed build>)'
          : `snapshot ${source?.version} vs phone ${this.phoneVersion} (run: bun run resign seed --ref <commit of the installed build>)`,
      )
    }
    this.clearEpisodeIf((c) => c === 'snapshot_mismatch')
    return source!
  }

  // 7
  private async decodeBundle(appPath: string): Promise<{
    app: ProfileInfo | null
    widget: ProfileInfo | null
    version: string | null
    errors: string[]
  }> {
    const deps = { exec: this.exec, tmpDir: this.d.tmpDir }
    const [a, w, version] = await Promise.all([
      decodeProfile(join(appPath, 'embedded.mobileprovision'), deps),
      decodeProfile(join(widgetPath(appPath), 'embedded.mobileprovision'), deps),
      this.bundleVersion(appPath),
    ])
    const errors: string[] = []
    if (!a.ok) errors.push(`app: ${a.error}`)
    if (!w.ok) errors.push(`widget: ${w.error}`)
    return { app: a.ok ? a.profile : null, widget: w.ok ? w.profile : null, version, errors }
  }

  private async bundleVersion(appPath: string): Promise<string | null> {
    const plist = join(appPath, 'Info.plist')
    const get = async (key: string) => {
      const r = await this.exec(['/usr/bin/plutil', '-extract', key, 'raw', '-o', '-', plist], { timeoutMs: TIMEOUTS.plutil })
      return r.code === 0 ? r.stdout.trim() || null : null
    }
    const [short, build] = await Promise.all([get('CFBundleShortVersionString'), get('CFBundleVersion')])
    if (!short) return null
    return build ? `${short} (${build})` : short
  }

  private async stagedCheck(source: SourceInfo): Promise<StagedInfo | null> {
    const cur = readJsonFile<{ run_id?: string }>(this.p.stagingCurrent)
    if (!cur?.run_id) {
      this.note('staged: none')
      return null
    }
    const appPath = join(this.p.staging, cur.run_id, 'HealthRelay.app')
    if (!existsSync(appPath)) {
      this.note(`staged: ${cur.run_id} pointer without a bundle`)
      return null
    }
    const b = await this.decodeBundle(appPath)
    const v = stagedValid({
      appExpiry: b.app?.expirationDate ?? null,
      widgetExpiry: b.widget?.expirationDate ?? null,
      stagedVersion: b.version,
      sourceVersion: source.version,
      signedUntil: this.signedUntil,
      now: this.now(),
    })
    if (!v.valid) {
      this.note(`staged: ${cur.run_id} not usable (${v.reason}${b.errors.length ? `; ${b.errors.join('; ')}` : ''})`)
      return null
    }
    const gap = intentsGap(join(this.p.sourceDir, 'HealthRelay'), appPath)
    if (gap) {
      this.note(`staged: ${cur.run_id} not usable (${gap})`)
      return null
    }
    // Built from THIS snapshot? A manual install swaps the snapshot (maybe
    // keeping the version string); an older staged build must then never be
    // installed over his newer code.
    const meta = readJsonFile<{ source_id?: string | null }>(join(this.p.staging, cur.run_id, 'staged.json'))
    if (!meta?.source_id || meta.source_id !== sourceId(source)) {
      this.note(`staged: ${cur.run_id} not usable (built from another source snapshot)`)
      return null
    }
    const known = this.st.staged?.run_id === cur.run_id ? this.st.staged : null
    let certSha1 = known?.cert_sha1 ?? null
    if (!certSha1) certSha1 = (await this.extractCert(appPath))?.sha1 ?? null
    const staged: StagedInfo = {
      run_id: cur.run_id,
      app_path: appPath,
      app_expiry: b.app!.expirationDate!,
      widget_expiry: b.widget!.expirationDate!,
      version: b.version!,
      profile_uuids: [b.app!.uuid, b.widget!.uuid],
      cert_sha1: certSha1,
      cert_changed: this.certChanged(certSha1),
      staged_at: known?.staged_at ?? this.iso(),
    }
    this.st.staged = staged
    this.note(`staged: ${cur.run_id} valid (app until ${staged.app_expiry}, ${staged.version})`)
    return staged
  }

  /** Did the signing certificate change since the last success? An
   *  unreadable certificate (null) counts as changed: failing open here
   *  would auto-install a possibly new cert that strands a working app until
   *  Trust is tapped. No previous success to compare with: unchanged. */
  private certChanged(sha1: string | null): boolean {
    const prev = this.st.last_success?.cert_sha1
    if (!prev) return false
    return sha1 !== prev
  }

  // 8
  private async pgrep(name: string): Promise<boolean> {
    const r = await this.exec(['/usr/bin/pgrep', '-x', name], { timeoutMs: TIMEOUTS.pgrep })
    return r.code === 0
  }

  private async buildGate(): Promise<string> {
    const cfg = this.cfg!
    const xcodeRunning = (await this.pgrep('xcodebuild')) || (await this.pgrep('Xcode'))
    const b = buildAllowed({
      hoursLeft: this.hoursLeft,
      localHour: this.localHour(),
      forced: !!this.o.forced,
      cfg,
      accountBrokenAt: this.st.account_broken_at,
      now: this.now(),
      xcodeRunning,
    })
    // A forced run always clears the breaker, even one that then ends busy.
    if (b.clear_account_broken) {
      this.st.account_broken_at = null
      this.note('forced run: account_broken cleared')
    }
    if (!b.allowed) {
      if (b.reason === 'account_broken_cooloff') throw new Stop('skipped', 'account_broken_cooloff', 'account_broken', false)
      this.soft(b.reason)
    }
    if (!cfg.device_udid) this.hard('device_setup', 'resign.device_udid is not set (config_set {resign:{device_udid}})')
    let yml = ''
    try {
      yml = readFileSync(join(this.p.sourceDir, 'project.yml'), 'utf8')
    } catch {
      // handled below
    }
    const team = parseTeamId(yml)
    if (!team) this.hard('snapshot_mismatch', 'no single DEVELOPMENT_TEAM in the snapshot project.yml (re-seed)')
    return team
  }

  // 9
  private async buildPreflight(): Promise<string> {
    const find = await this.exec(['/usr/bin/xcrun', '--find', 'xcodebuild'], { timeoutMs: TIMEOUTS.find_xcodebuild })
    if (find.timedOut) this.hard('prompt_hang', 'xcrun --find xcodebuild timed out')
    const xcodebuild = find.stdout.trim().split('\n').pop()?.trim() ?? ''
    if (find.code !== 0 || !xcodebuild) this.hard('xcode_setup', `xcrun --find xcodebuild: ${find.tail.trim().slice(-200)}`)

    const ver = await this.exec([xcodebuild, '-version'], { timeoutMs: TIMEOUTS.xcodebuild_version })
    if (ver.timedOut) this.hard('prompt_hang', 'xcodebuild -version timed out')
    if (ver.code !== 0) {
      const c = classifyBuild(ver.tail)
      this.hard(c.class === 'other' ? 'xcode_setup' : (c.class as FailClass), `xcodebuild -version: ${c.why}`)
    }
    const version = ver.stdout.trim().split('\n').map((s) => s.trim()).join(' ')
    if (this.st.xcode_version && this.st.xcode_version !== version) {
      this.note(`xcode changed (${this.st.xcode_version} -> ${version}): breakers re-opened`)
      this.st.account_broken_at = null
      this.st.streaks = emptyStreaks()
    }
    this.st.xcode_version = version

    const ids = await this.exec(['/usr/bin/security', 'find-identity', '-v', '-p', 'codesigning'], { timeoutMs: TIMEOUTS.find_identity })
    if (ids.timedOut) this.hard('keychain_prompt', 'security find-identity timed out')
    const parsed = parseIdentities(ids.stdout)
    this.note(`identities: ${parsed.sha1s.length} valid, ${parsed.appleDevelopment} Apple Development (${parsed.sha1s.map((s) => s.slice(0, 8)).join(',') || 'none'})`)
    if (parsed.appleDevelopment === 0) this.note('warning: no Apple Development identity yet (Xcode mints one when the account is healthy)')

    const acct = await this.exec(['/usr/bin/defaults', 'read', 'com.apple.dt.Xcode', 'DVTDeveloperAccountManagerAppleIDLists'], {
      timeoutMs: TIMEOUTS.defaults_read,
    })
    if (acct.timedOut) this.hard('prompt_hang', 'defaults read com.apple.dt.Xcode timed out')
    if (!hasXcodeAccount(acct.code, acct.stdout)) {
      this.st.account_broken_at = this.iso()
      this.hard('account_broken', 'no Apple account in Xcode settings')
    }

    const batt = await this.exec(['/usr/bin/pmset', '-g', 'batt'], { timeoutMs: TIMEOUTS.pmset })
    const b = parseBattery(batt.stdout)
    if (b.onBattery && b.pct != null && b.pct < BATTERY_MIN_PCT) this.soft('battery', `${b.pct}% on battery`)
    return xcodebuild
  }

  // 10
  private async quarantine(teamId: string): Promise<void> {
    this.checkAborted('quarantine')
    this.checkLock('quarantine')
    const backupDir = join(this.p.profileBackups, this.runId)
    this.st.profiles_moved = { run_id: this.runId, backup_dir: backupDir, uuids: [], at: this.iso() }
    this.st.mint_verified = null
    this.save() // recorded BEFORE the first move
    try {
      const m = await quarantine(this.p.profileDirs, [APP_BUNDLE_ID, WIDGET_BUNDLE_ID], this.p.profileBackups, this.runId, {
        exec: this.exec,
        teamId,
        tmpDir: this.d.tmpDir,
      })
      this.movedUuids = m.moves.filter((x) => x.moved).map((x) => x.uuid)
      this.st.profiles_moved.uuids = this.movedUuids
      this.note(`quarantine: moved ${this.movedUuids.length} (${m.undecodable.length} undecodable left in place)`)
      this.save()
    } catch (e) {
      const m = readManifest(join(backupDir, 'manifest.json'))
      if (m) restore(m)
      this.st.profiles_moved = null
      if (e instanceof Stop) throw e
      this.hard('other', `quarantine failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // 11
  private async extractCert(appPath: string): Promise<{ sha1: string; notAfter: string | null } | null> {
    const prefix = join(this.runDir, `cert-${Math.random().toString(36).slice(2, 8)}-`)
    const r = await this.exec(['/usr/bin/codesign', '-d', `--extract-certificates=${prefix}`, appPath], {
      timeoutMs: TIMEOUTS.codesign_extract,
    })
    const leaf = `${prefix}0`
    if (r.code !== 0 || !existsSync(leaf)) {
      this.note(`cert: extract failed (${r.tail.trim().slice(-120)})`)
      return null
    }
    const sha1 = createHash('sha1').update(readFileSync(leaf)).digest('hex').toUpperCase()
    const end = await this.exec(['/usr/bin/openssl', 'x509', '-inform', 'DER', '-in', leaf, '-noout', '-enddate'], {
      timeoutMs: TIMEOUTS.codesign_extract,
    })
    const notAfter = end.code === 0 ? parseOpensslDate(end.stdout) : null
    return { sha1, notAfter }
  }

  private async build(xcodebuild: string, source: SourceInfo, teamId: string): Promise<StagedInfo> {
    this.checkAborted('build')
    const dd = this.p.derivedData
    // 11a: our whole DerivedData, so every build is a CLEAN build. Never wipe
    // only Build/Products: the incremental build that follows relinks just
    // the Debug stub executable, the App Intents extractor then sees no
    // AppIntents dependency and silently drops Metadata.appintents (Nov 16
    // 2026: the Money shortcut vanished from the phone). A full build is
    // ~40 s; it is our own dir and nothing else anchors it.
    try {
      rmSync(dd, { recursive: true, force: true })
    } catch {
      // nothing there
    }
    // 11b
    const release = (this.d.keepAwake ?? defaultKeepAwake)()
    let r
    try {
      r = await this.exec([xcodebuild, '-project', this.p.sourceProject, ...BUILD_FLAGS, '-derivedDataPath', dd, 'build'], {
        timeoutMs: TIMEOUTS.xcodebuild_wall,
        idleTimeoutMs: TIMEOUTS.xcodebuild_idle,
        cwd: this.p.sourceDir,
        logFile: join(this.runDir, 'xcodebuild.log'),
      })
    } finally {
      try {
        release()
      } catch {
        // ignore
      }
    }
    const product = findProduct(dd)
    // 11c
    if (r.code !== 0 || r.timedOut || r.idledOut || !product) {
      const c = classifyBuild(r.tail, { timedOut: r.timedOut, idledOut: r.idledOut, productMissing: r.code === 0 && !product })
      this.restoreProfiles('build failed')
      if (r.timedOut || r.idledOut) {
        try {
          rmSync(dd, { recursive: true, force: true })
        } catch {
          // next build retries
        }
      }
      if (c.class === 'account_broken') this.st.account_broken_at = this.iso()
      this.fail(c, 'xcodebuild')
    }

    // 11d VERIFY (the cert first: its notAfter caps the expiry floor)
    const cert = await this.extractCert(product!)
    const b = await this.decodeBundle(product!)
    if (!b.app || !b.widget) {
      this.restoreProfiles('embedded profile unreadable')
      this.streakFail('profile_not_fresh', `embedded profile unreadable: ${b.errors.join('; ')}`)
    }
    const pair = checkFreshPair(
      { app: toDecoded(b.app!), widget: toDecoded(b.widget!) },
      {
        runStart: this.t0,
        now: this.now(),
        movedUuids: this.movedUuids,
        certNotAfter: cert?.notAfter ?? null,
        teamId,
        deviceUdid: this.cfg!.device_udid!,
      },
    )
    if (!pair.fresh) {
      this.restoreProfiles('profile not fresh')
      const why = pair.failures.map((f) => `${f.bundle}: ${f.reasons.join('+')}`).join('; ')
      if (pair.class === 'device_not_in_profile') this.hard('device_not_in_profile', why)
      this.streakFail('profile_not_fresh', why)
    }
    const v = await this.exec(['/usr/bin/codesign', '--verify', '--deep', '--strict', product!], { timeoutMs: TIMEOUTS.codesign_verify })
    if (v.code !== 0) {
      this.restoreProfiles('codesign verify failed')
      this.hard('other', `codesign --verify: ${v.tail.trim().slice(-200)}`)
    }
    const gap = intentsGap(join(this.p.sourceDir, 'HealthRelay'), product!)
    if (gap) {
      this.restoreProfiles('bundle incomplete')
      this.hard('build_incomplete', gap)
    }
    if (!sameVersion(b.version, source.version)) {
      this.restoreProfiles('version mismatch')
      this.hard('snapshot_mismatch', `built ${b.version} but the snapshot says ${source.version}`)
    }
    this.st.streaks.profile_not_fresh = 0
    this.st.mint_verified = { run_id: this.runId, at: this.iso() }
    this.save()

    // 11e CERT
    const certChanged = this.certChanged(cert?.sha1 ?? null)
    if (certChanged) {
      this.note(
        cert ? 'cert: the signing certificate changed since the last success' : 'cert: unreadable, treated as changed (the install waits for Trust)',
      )
    }

    // 11f STAGE
    const dir = join(this.p.staging, this.runId)
    const dest = join(dir, 'HealthRelay.app')
    mkdirSync(dir, { recursive: true })
    const dit = await this.exec(['/usr/bin/ditto', product!, dest], { timeoutMs: TIMEOUTS.ditto })
    if (dit.code !== 0) {
      this.st.profiles_moved = null // mint verified: originals stay in the backup
      this.hard('other', `ditto into staging failed: ${dit.tail.trim().slice(-200)}`)
    }
    const prev = readJsonFile<{ run_id?: string }>(this.p.stagingCurrent)?.run_id ?? null
    const staged: StagedInfo = {
      run_id: this.runId,
      app_path: dest,
      app_expiry: b.app!.expirationDate!,
      widget_expiry: b.widget!.expirationDate!,
      version: b.version!,
      profile_uuids: [b.app!.uuid, b.widget!.uuid],
      cert_sha1: cert?.sha1 ?? null,
      cert_changed: certChanged,
      staged_at: this.iso(),
      source_id: sourceId(source),
    }
    writeJsonAtomic(join(dir, 'staged.json'), staged)
    writeJsonAtomic(this.p.stagingCurrent, { run_id: this.runId, at: this.iso() })
    this.pruneStaging([this.runId, prev])
    this.st.staged = staged
    this.st.profiles_moved = null
    this.clearEpisodeIf((c) => BUILD_PHASE_CLASSES.has(c))
    this.save()
    this.note(`staged ${this.runId}: app until ${staged.app_expiry}, widget until ${staged.widget_expiry}`)
    return staged
  }

  private pruneStaging(keep: Array<string | null>): void {
    let entries: string[] = []
    try {
      entries = readdirSync(this.p.staging)
    } catch {
      return
    }
    for (const e of entries) {
      if (e === 'current.json' || keep.includes(e)) continue
      try {
        rmSync(join(this.p.staging, e), { recursive: true, force: true })
      } catch {
        // ignore
      }
    }
  }

  // 12
  private installGate(staged: StagedInfo): 'install' | 'relaunch_only' {
    const pending = this.st.pending_confirm
    // The no-reinstall rule keys on the LAST install of this staged build:
    // at most one reinstall per 24h, or per 2h when critical, and none after
    // expiry once it was launched (never a 15-min loop).
    const d = installAllowed({
      hoursLeft: this.hoursLeft,
      localHour: this.localHour(),
      forced: !!this.o.forced,
      cfg: this.cfg!,
      daemonReachable: !this.daemonDown,
      certChanged: staged.cert_changed,
      pending: pending
        ? { staged_run_id: pending.staged_run_id, first_installed_at: pending.last_installed_at, launched: !!pending.launched }
        : null,
      stagedRunId: staged.run_id,
      now: this.now(),
    })
    if (d.action === 'skip') this.soft(d.reason)
    if (d.action === 'hard') {
      this.hard(
        d.class,
        staged.cert_sha1
          ? 'the signing certificate changed: install when you can tap Trust on the phone'
          : 'the signing certificate could not be read, so it is treated as changed: install when you can tap Trust on the phone',
      )
    }
    if (d.action === 'relaunch_only') {
      // Already launched once: the app's own hello confirms it. Relaunching
      // every 15 min would kill the app (and its couriers) each time.
      if (pending?.launched) throw new Stop('installed_unconfirmed', 'awaiting the app hello (installed and launched)')
      this.note('install gate: same staged build installed recently, launch failed: relaunch only')
    }
    return d.action
  }

  // 13
  private blockers(pf: ResignPreflight | null): void {
    if (!pf) this.soft('daemon_down')
    if (pf.blocker) {
      const b = this.st.counters.blocked
      b[pf.blocker.reason] = (b[pf.blocker.reason] ?? 0) + 1
      this.soft('blocked', pf.blocker.reason)
    }
  }

  // 14
  private async probes(): Promise<string> {
    const udid = this.cfg!.device_udid
    if (!udid) this.hard('device_setup', 'resign.device_udid is not set')
    const l = await listDevices(this.runDir, { exec: this.exec })
    if (l.json === undefined) {
      const c = classifyInstall(l.text, { timedOut: l.timedOut })
      if (c.class === 'devicectl_unreachable' || c.class === 'xcode_setup') this.hard(c.class, `devicectl list: ${c.why}`)
      this.soft('unreachable', `devicectl list: ${l.timedOut ? 'timeout' : c.why}`)
    }
    const m = parseDevices(l.json, udid)
    if (!m.device) this.soft('unreachable', `device ${m.reason}`)
    this.note(`device: transport ${m.device.transport_type ?? '?'}, tunnel ${m.device.tunnel_state ?? '?'}`)

    const ls = await lockState(udid, this.runDir, { exec: this.exec })
    if (!ls.ok) this.soft('unreachable', `lockState ${ls.timedOut ? 'timeout' : `exit ${ls.code}`}`)
    const parsed = parseLockState(ls.json ?? ls.stdout)
    if (parsed.state === 'unknown') {
      try {
        writeFileSync(join(this.runDir, 'lock.raw.txt'), ls.text)
      } catch {
        // the json file is still there
      }
      this.streakFail('lockstate_unknown', `lockState shape unknown (${parsed.why}; keys ${parsed.keys.join(',') || 'none'})`)
    }
    this.st.streaks.lockstate_unknown = 0
    this.clearEpisodeIf((c) => c === 'lockstate_unparsed')
    if (parsed.state === 'locked') this.soft('locked', parsed.field)
    // 'unverified' (the real devicectl shape cannot tell unlocked-now from
    // locked-since-unlock): attempt the install; a locked phone fails it
    // cleanly and classifyInstall maps that to the soft 'locked' skip.
    if (parsed.state === 'unverified') this.note('lockState unverified (passcodeRequired is not a proven lock signal): attempting the install, a locked phone fails it softly')
    return udid
  }

  // 15
  private async toctou(): Promise<void> {
    const pf = await this.d.preflight()
    if (!pf) this.soft('daemon_down', 'second preflight')
    this.pf = pf
    this.blockers(pf)
  }

  private async install(udid: string, staged: StagedInfo): Promise<void> {
    this.checkAborted('install')
    await this.toctou()
    this.checkLock('install')
    const r = await deviceInstall(udid, staged.app_path, APP_BUNDLE_ID, this.runDir, { exec: this.exec })
    if (!r.installed) {
      if (r.ok) this.streakFail('install_failed', 'devicectl exited 0 without App installed')
      this.fail(classifyInstall(r.text, { timedOut: r.timedOut }), 'install')
    }
    this.st.streaks.install_failed = 0
    this.st.counters.installs++
    const prev = this.st.pending_confirm
    const same = prev?.staged_run_id === staged.run_id
    const at = this.iso()
    this.st.pending_confirm = {
      staged_run_id: staged.run_id,
      first_installed_at: same ? prev!.first_installed_at : at,
      last_installed_at: at,
      expected_until: minIso(staged.app_expiry, staged.widget_expiry),
      version: staged.version,
      old_signed_until: same ? prev!.old_signed_until : this.signedUntil,
      launched: false,
    }
    // Clear what the install itself fixed, but never the post-install
    // classes: a reinstall followed by the same launch failure must keep the
    // SAME episode (one alert), not open a fresh one every run.
    this.clearEpisodeIf((c) => !POST_INSTALL_CLASSES.has(c))
    this.save()
    this.note(`installed ${staged.run_id} (${staged.version})`)
    const info = await appInfo(udid, APP_BUNDLE_ID, this.runDir, { exec: this.exec })
    this.note(`info apps: ${info.ok ? 'recorded' : 'failed'} (${info.jsonPath})`)
  }

  private async launch(udid: string): Promise<void> {
    this.checkAborted('launch')
    this.checkLock('launch')
    const r = await deviceLaunch(udid, APP_BUNDLE_ID, this.runDir, { exec: this.exec })
    const p = this.st.pending_confirm
    if (!r.ok) {
      if (p) p.launched = false
      const c = classifyLaunch(r.text, { timedOut: r.timedOut })
      if (c.hard) this.hard(c.class, `launch: ${c.why}`)
      this.soft(c.class, `launch: ${c.why}`)
    }
    if (p) p.launched = true
    // A launch that works proves the developer (and any new cert) is trusted.
    this.clearEpisodeIf((c) => c === 'untrusted_developer' || c === 'new_certificate')
    this.save()
  }

  // 16
  private async confirm(): Promise<void> {
    const p = this.st.pending_confirm
    if (!p) throw new Stop('installed_unconfirmed', 'no pending install to confirm')
    const expected = toMs(p.expected_until) ?? Infinity
    const total = this.d.confirmTotalMs ?? TIMEOUTS.confirm_total
    const poll = this.d.confirmPollMs ?? TIMEOUTS.confirm_poll
    const sleep = this.d.sleep ?? ((ms: number) => Bun.sleep(ms))
    for (let waited = 0; waited < total; waited += poll) {
      await sleep(poll)
      if (this.aborted) throw new Stop('run_timeout', 'aborted')
      const pf = await this.d.preflight()
      const t = toMs(pf?.signed_until ?? null)
      if (t != null && t >= expected - CONFIRM_SLACK_MS) {
        this.signedUntil = pf!.signed_until
        this.hoursLeft = pf!.hours_left
        this.st.signed_until = this.signedUntil
        this.st.hours_left = this.hoursLeft
        this.success()
        throw new Stop('confirmed', null)
      }
    }
    throw new Stop('installed_unconfirmed', 'confirm_timeout')
  }

  // ── dry run and plan: every read probe, no mutation ──

  private async inspect(): Promise<void> {
    const cfg = (this.cfg = this.d.loadConfig())
    this.note(`config: enabled ${cfg.enabled}, device_udid ${cfg.device_udid ? 'set' : 'MISSING'}, window ${cfg.window_hours}h, build ${cfg.build_hours.join('-')}, install ${cfg.install_hours.join('-')}`)
    if (this.mode === 'dry') {
      this.st.last_run_at = this.iso(this.t0)
      this.st.enabled = cfg.enabled
      this.st.dry_run = true
    }
    await this.clock()
    this.note(`clock: signed_until ${this.signedUntil ?? 'unknown'}, hours_left ${this.hoursLeft ?? 'unknown'}, phone ${this.phoneVersion ?? '?'}${this.daemonDown ? ' (daemon down)' : ''}`)
    if (this.pf) this.note(`daemon: system.health ${this.pf.system_health_enabled ? 'on' : 'OFF'}, blocker ${this.pf.blocker ? this.pf.blocker.reason : 'none'}`)
    this.save()

    if (this.st.profiles_moved) {
      this.note(`would recover: profiles moved by run ${this.st.profiles_moved.run_id} (${this.st.mint_verified?.run_id === this.st.profiles_moved.run_id ? 'mint verified: leave in backup' : 'restore'})`)
    }
    const v = reconcilePending({
      pending: this.st.pending_confirm,
      signedUntil: this.signedUntil,
      oldSignedUntil: this.st.pending_confirm?.old_signed_until ?? null,
      lastHelloAt: this.helloAt,
    })
    this.note(`pending: ${v.verdict}`)
    const g = clockGate(this.hoursLeft, cfg, !!this.o.forced)
    this.note(`gate: ${g.proceed ? 'proceed' : g.outcome}`)

    const source = readSource(this.p)
    const sg = snapshotGuard({ source, phoneVersion: this.phoneVersion, now: this.now() })
    this.note(`snapshot: ${source ? `${source.version} (${source.git_commit ?? '?'}${source.dirty ? ', dirty' : ''}, captured ${source.captured_at})` : 'MISSING'}: ${sg.ok ? 'matches the phone' : sg.class}`)

    const staged = source ? await this.stagedCheck(source).catch(() => null) : null

    const xcodeRunning = (await this.pgrep('xcodebuild')) || (await this.pgrep('Xcode'))
    const b = buildAllowed({
      hoursLeft: this.hoursLeft,
      localHour: this.localHour(),
      forced: !!this.o.forced,
      cfg,
      accountBrokenAt: this.st.account_broken_at,
      now: this.now(),
      xcodeRunning,
    })
    this.note(`build gate: ${staged ? 'not needed (staged valid)' : b.allowed ? 'would build' : `would skip (${b.reason})`}`)

    let yml = ''
    try {
      yml = readFileSync(join(this.p.sourceDir, 'project.yml'), 'utf8')
    } catch {
      // reported below
    }
    const teamId = parseTeamId(yml)
    this.note(`team: ${teamId ? 'found in the snapshot project.yml' : 'MISSING (no snapshot or no DEVELOPMENT_TEAM)'}`)

    // Tool preflight, read-only (a hard failure here is a finding, not a stop).
    const probe = async (label: string, argv: string[], timeoutMs: number) => {
      const r = await this.exec(argv, { timeoutMs })
      return { r, label }
    }
    const find = await probe('xcrun', ['/usr/bin/xcrun', '--find', 'xcodebuild'], TIMEOUTS.find_xcodebuild)
    const xcodebuild = find.r.stdout.trim()
    this.note(`xcodebuild: ${find.r.code === 0 ? xcodebuild : `NOT FOUND (${find.r.timedOut ? 'timeout' : find.r.tail.trim().slice(-120)})`}`)
    if (find.r.code === 0) {
      const ver = await probe('version', [xcodebuild, '-version'], TIMEOUTS.xcodebuild_version)
      this.note(`xcode: ${ver.r.code === 0 ? ver.r.stdout.trim().split('\n').join(' ') : `FAILED (${ver.r.timedOut ? 'timeout' : ver.r.tail.trim().slice(-120)})`}`)
    }
    const ids = await probe('ids', ['/usr/bin/security', 'find-identity', '-v', '-p', 'codesigning'], TIMEOUTS.find_identity)
    const parsed = parseIdentities(ids.r.stdout)
    this.note(`identities: ${ids.r.timedOut ? 'TIMEOUT' : `${parsed.sha1s.length} valid, ${parsed.appleDevelopment} Apple Development`}`)
    const acct = await probe('acct', ['/usr/bin/defaults', 'read', 'com.apple.dt.Xcode', 'DVTDeveloperAccountManagerAppleIDLists'], TIMEOUTS.defaults_read)
    this.note(`xcode account: ${acct.r.timedOut ? 'TIMEOUT' : hasXcodeAccount(acct.r.code, acct.r.stdout) ? 'present' : 'NONE (would be account_broken)'}`)
    const batt = await probe('batt', ['/usr/bin/pmset', '-g', 'batt'], TIMEOUTS.pmset)
    const bp = parseBattery(batt.r.stdout)
    this.note(`power: ${bp.onBattery ? 'battery' : 'AC'} ${bp.pct ?? '?'}%`)

    // What the quarantine WOULD move (decode only).
    const found = await findOurProfiles(this.p.profileDirs, [APP_BUNDLE_ID, WIDGET_BUNDLE_ID], {
      exec: this.exec,
      tmpDir: this.d.tmpDir,
      teamId,
    })
    for (const u of found.undecodable) this.note(`profile ${u.path.split('/').pop()}: UNDECODABLE (${u.error.slice(0, 120)})`)
    for (const p of found.matches) {
      this.note(`would move: ${p.path.split('/').pop()} (${p.appId?.split('.').slice(1).join('.')}, expires ${p.expirationDate})`)
    }
    this.note(`quarantine: would move ${found.matches.length}`)

    if (staged) {
      const d = installAllowed({
        hoursLeft: this.hoursLeft,
        localHour: this.localHour(),
        forced: !!this.o.forced,
        cfg,
        daemonReachable: !this.daemonDown,
        certChanged: staged.cert_changed,
        pending: this.st.pending_confirm
          ? {
              staged_run_id: this.st.pending_confirm.staged_run_id,
              first_installed_at: this.st.pending_confirm.last_installed_at,
              launched: !!this.st.pending_confirm.launched,
            }
          : null,
        stagedRunId: staged.run_id,
        now: this.now(),
      })
      this.note(`install gate: ${d.action}${d.action === 'skip' ? ` (${d.reason})` : d.action === 'hard' ? ` (${d.class})` : ''}`)
    } else {
      this.note('install gate: after a build')
    }

    // Device probes: list always, lockState on a dry run or plan --probe-lock.
    if (cfg.device_udid) {
      const l = await listDevices(this.runDir, { exec: this.exec })
      const m = parseDevices(l.json, cfg.device_udid)
      this.note(
        `device: ${m.device ? `found (${m.device.transport_type ?? '?'}, tunnel ${m.device.tunnel_state ?? '?'})` : `not usable (${m.reason}${l.timedOut ? ', timeout' : ''})`}, ${m.devices.length} listed`,
      )
      if (this.mode === 'dry' || this.o.probeLock) {
        const ls = await lockState(cfg.device_udid, this.runDir, { exec: this.exec })
        const p = parseLockState(ls.json ?? ls.stdout)
        try {
          writeFileSync(join(this.runDir, 'lock.raw.txt'), ls.text)
        } catch {
          // the json file is still there
        }
        this.note(`lockState: ${ls.ok ? p.state : `FAILED (${ls.timedOut ? 'timeout' : `exit ${ls.code}`})`}${p.field ? ` via ${p.field}` : ''}${p.why ? ` (${p.why}; keys ${p.keys.join(',') || 'none'})` : ''}; raw JSON at ${ls.jsonPath}`)
      }
    } else {
      this.note('device: resign.device_udid not set, probes skipped')
    }
  }
}

// ── defaults ──────────────────────────────────────────────────────

async function defaultCommOf(pid: number): Promise<{ comm: string; command: string } | null> {
  const r = await realExec(['/bin/ps', '-o', 'comm=', '-o', 'command=', '-p', String(pid)], { timeoutMs: 5_000 })
  const line = r.stdout.trim()
  if (r.code !== 0 || !line) return null
  const [comm] = line.split(/\s+/)
  return { comm, command: line }
}

/** caffeinate -i -w <our pid>, non-detached: it exits with us either way. */
function defaultKeepAwake(): () => void {
  try {
    const p = Bun.spawn(['/usr/bin/caffeinate', '-i', '-w', String(process.pid)], {
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    })
    return () => {
      try {
        p.kill()
      } catch {
        // gone
      }
    }
  } catch {
    return () => {}
  }
}
