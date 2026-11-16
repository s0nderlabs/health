// Auto re-sign, the DAEMON side (pure pieces). The daemon is the only alerter
// and the only process that knows live state (open session, intents, yield,
// which leg writes), so it answers the runner's resign_preflight RPC, adds a
// `resign` block to status, and kicks a run shortly after a phone hello. The
// glue in daemon.ts only gathers inputs; every decision lives here, tested.

import type { Blocker, BlockerInput, ResignConfig } from './policy.js'
import { installBlocker, toMs } from './policy.js'
import type { ResignState } from './state.js'

export const RESIGN_LABEL = 'com.s0nderlabs.health.resign'
/** Kick this long after a phone hello (the app is foreground, so likely
 *  unlocked, and the hello has had time to land its new clock). */
export const HELLO_KICK_DELAY_MS = 90_000
/** Never kick more often than this. */
export const HELLO_KICK_MIN_GAP_MS = 15 * 60_000

/** What resign_preflight returns. */
export interface ResignPreflight {
  signed_until: string | null
  hours_left: number | null
  phone_app_version: string | null
  /** Any phone contact (throttled frames included). */
  phone_last_seen: string | null
  /** The last phone HELLO (the moment the app reported its clock). */
  phone_hello_at: string | null
  blocker: Blocker | null
  system_health_enabled: boolean
  resign_enabled: boolean
}

/** Latest intent timestamp from the engine's intent_log meta (JSON array of
 *  {ts, ...}); null when absent or unreadable. */
export function lastIntentTs(intentLogRaw: string | null): string | null {
  if (!intentLogRaw) return null
  try {
    const log = JSON.parse(intentLogRaw) as Array<{ ts?: unknown }>
    if (!Array.isArray(log)) return null
    let best: number | null = null
    let bestIso: string | null = null
    for (const it of log) {
      const t = typeof it?.ts === 'string' ? Date.parse(it.ts) : NaN
      if (Number.isFinite(t) && (best == null || t > best)) {
        best = t
        bestIso = it.ts as string
      }
    }
    return bestIso
  } catch {
    return null
  }
}

/** The subset of LiveFeedStatus the blocker reads. */
export interface LiveStatusLike {
  active_source: string | null
  relayers: Array<{ source: string; band_seen_ago_s: number | null }>
  yield: { active: boolean }
}

export function blockerInputFrom(input: {
  now: number
  hoursLeft: number | null
  liveSessionOpen: boolean
  intentLogRaw: string | null
  lastScoredWorkoutAt: string | null
  lastRestAt: string | null
  live: LiveStatusLike
}): BlockerInput {
  // The phone leg's freshness: any non-mac source (the phone reports its own
  // name; 'unknown' is a pre-protocol relayer, never the phone).
  const phone = input.live.relayers.find((r) => r.source !== 'mac' && r.source !== 'unknown')
  return {
    now: input.now,
    hoursLeft: input.hoursLeft,
    liveSessionOpen: input.liveSessionOpen,
    lastIntentAt: lastIntentTs(input.intentLogRaw),
    lastScoredWorkoutAt: input.lastScoredWorkoutAt,
    lastRestAt: input.lastRestAt,
    yieldActive: input.live.yield.active,
    // installBlocker matches 'phone' literally: map any phone-side source.
    activeSource:
      input.live.active_source && input.live.active_source !== 'mac' && input.live.active_source !== 'unknown'
        ? 'phone'
        : input.live.active_source,
    phoneBandSeenAgoS: phone?.band_seen_ago_s ?? null,
  }
}

export function buildPreflight(input: {
  signedUntil: string | null
  hoursLeft: number | null
  phoneVersion: string | null
  phoneLastSeen: string | null
  phoneHelloAt: string | null
  blockerInput: BlockerInput
  cfg: ResignConfig
  systemHealthEnabled: boolean
}): ResignPreflight {
  return {
    signed_until: input.signedUntil,
    hours_left: input.hoursLeft,
    phone_app_version: input.phoneVersion,
    phone_last_seen: input.phoneLastSeen,
    phone_hello_at: input.phoneHelloAt,
    blocker: installBlocker(input.blockerInput, input.cfg.critical_hours),
    system_health_enabled: input.systemHealthEnabled,
    resign_enabled: input.cfg.enabled,
  }
}

export type KickDecision = { kick: true } | { kick: false; reason: string }

/** Should a phone hello kick a run? Only when resign is enabled with
 *  install_on_hello, a staged build is ready and not already installed and
 *  awaiting its confirm, the window is open, nothing blocks, and the last kick
 *  was over 15 min ago. */
export function helloKickDecision(input: {
  cfg: ResignConfig
  state: ResignState | null
  hoursLeft: number | null
  blocker: Blocker | null
  lastKickAt: number | null
  now: number
}): KickDecision {
  if (!input.cfg.enabled) return { kick: false, reason: 'disabled' }
  if (!input.cfg.install_on_hello) return { kick: false, reason: 'install_on_hello_off' }
  const s = input.state
  if (!s?.staged) return { kick: false, reason: 'nothing_staged' }
  if (s.pending_confirm && s.pending_confirm.staged_run_id === s.staged.run_id) {
    return { kick: false, reason: 'pending_confirm' }
  }
  if (input.hoursLeft == null) return { kick: false, reason: 'unknown_expiry' }
  if (input.hoursLeft > input.cfg.window_hours) return { kick: false, reason: 'window_closed' }
  if (input.blocker) return { kick: false, reason: `blocked:${input.blocker.reason}` }
  if (input.lastKickAt != null && input.now - input.lastKickAt < HELLO_KICK_MIN_GAP_MS) {
    return { kick: false, reason: 'recent_kick' }
  }
  return { kick: true }
}

/** Debounced delayed kick after a hello. evaluate() runs AT FIRE TIME (the
 *  hello's clock has landed by then); a second hello while one is pending is
 *  absorbed. Timers and the kick are injected so tests drive it. */
export class HelloKicker {
  lastKickAt: number | null = null
  private pending = false

  constructor(
    private deps: {
      evaluate: () => KickDecision
      kick: () => void
      delayMs?: number
      now?: () => number
      setTimer?: (fn: () => void, ms: number) => unknown
      log?: (msg: string) => void
    },
  ) {}

  onHello(): void {
    if (this.pending) return
    this.pending = true
    const set = this.deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    set(() => this.fire(), this.deps.delayMs ?? HELLO_KICK_DELAY_MS)
  }

  private fire(): void {
    this.pending = false
    const now = (this.deps.now ?? Date.now)()
    let d: KickDecision
    try {
      d = this.deps.evaluate()
    } catch (err) {
      this.deps.log?.(`resign hello kick: evaluate failed: ${err}`)
      return
    }
    if (!d.kick) {
      this.deps.log?.(`resign hello kick skipped: ${d.reason}`)
      return
    }
    this.lastKickAt = now
    try {
      this.deps.kick()
      this.deps.log?.('resign hello kick: kickstarted')
    } catch (err) {
      this.deps.log?.(`resign hello kick failed: ${err}`)
    }
  }
}

/** The `resign` block of the status RPC: the facts, compact. */
export function resignStatus(state: ResignState | null, cfg: ResignConfig, now: number): Record<string, unknown> {
  const lastRun = toMs(state?.last_run_at ?? null)
  return {
    enabled: cfg.enabled,
    device_udid_set: !!cfg.device_udid,
    window_hours: cfg.window_hours,
    state: state ? 'present' : 'none',
    dry_run: state?.dry_run ?? null,
    last_run_at: state?.last_run_at ?? null,
    last_run_ago_min: lastRun == null ? null : Math.round((now - lastRun) / 60_000),
    last_trigger: state?.trigger ?? null,
    last_outcome: state?.last_outcome ?? null,
    last_reason: state?.last_reason ?? null,
    daemon_down_at_last_run: state?.daemon_down ?? null,
    staged: state?.staged
      ? {
          run_id: state.staged.run_id,
          version: state.staged.version,
          app_expiry: state.staged.app_expiry,
          cert_changed: state.staged.cert_changed,
        }
      : null,
    pending_confirm: state?.pending_confirm
      ? {
          staged_run_id: state.pending_confirm.staged_run_id,
          first_installed_at: state.pending_confirm.first_installed_at,
          expected_until: state.pending_confirm.expected_until,
          launched: state.pending_confirm.launched ?? null,
        }
      : null,
    last_success: state?.last_success ?? null,
    episode: state?.episode
      ? { class: state.episode.class, since: state.episode.since, hard: state.episode.hard }
      : null,
    profiles_moved: state?.profiles_moved ? state.profiles_moved.run_id : null,
    counters: state?.counters ?? null,
  }
}
