// The sideload clock, daemon side. iOS kills a free-team sideload seven days
// after Xcode minted its profile, silently. The phone reports the date at
// hello (see live.ts parseSignedUntil); these pure helpers turn it into a
// countdown and a bounded daily nag so the session can plan the re-sign
// around training instead of discovering a dead relayer at the gym.
//
// With auto re-sign (src/resign/), the daemon is still the ONLY alerter: the
// runner writes facts to state.json and resignAlerts() turns them into
// system.health problems. The legacy nag stays the backstop: it defers only
// while the automation owns the alerts (enabled, not a dry run, a fresh
// heartbeat), and resignAlerts' clock tiers fire in exactly that case, so the
// two are complementary and a runner bug can never silence the expiry
// warnings. While the feature is on, both use the same per-day tier keys, so
// a hand-off between them inside one day never doubles an alert.

import type { ResignState } from './resign/state.js'
import { ALERT_HOURS, URGENT_HOURS, windowOpen as policyWindowOpen } from './resign/policy.js'

/** Nag from this many hours out. */
export const SIGNING_NAG_HOURS = 48
/** Stop nagging this many days after death: a phone that never hellos again
 *  (leg retired, weekend away) must not produce a system.health event every
 *  day forever, budget-exempt. A fresh hello resets the clock. */
export const SIGNING_EXPIRED_NAG_DAYS = 7

/** The runner's heartbeat must be younger than this for the legacy nag to defer. */
export const RESIGN_HEARTBEAT_MS = 2 * 3_600_000
/** Wake grace: for this long after a wake or a daemon restart a STALE
 *  heartbeat is not yet evidence of a dead timer (launchd runs the missed
 *  interval on wake), so the automation keeps the alerts and timer_dead
 *  holds off. A fresh heartbeat never needs the grace. */
export const RESIGN_AWAKE_MS = 45 * 60_000
/** Clock tiers. */
// The 48h tier IS the legacy nag window: one constant, so the hand-off
// between them can never open a gap.
const TIER_NOTABLE_H = SIGNING_NAG_HOURS
// The tier thresholds live in policy.ts (one source of truth).
const TIER_URGENT_H = URGENT_HOURS
const TIER_CRITICAL_H = ALERT_HOURS
/** A pending install unconfirmed this long after its first install alerts. */
const UNCONFIRMED_AFTER_MS = 6 * 3_600_000
/** The resolved line only follows a success this recent. */
const RESOLVED_WITHIN_MS = 24 * 3_600_000

export const RESIGN_LOG_HINT = '~/.claude/channels/health/resign/resign.log'

const REINSTALL =
  'Re-sign and reinstall: with the phone unlocked on the same Wi-Fi, run scripts/build-phone.sh install (wireless works; it clears the cached profiles itself), or enable auto re-sign (bun run resign install-agent). Cable only if Wi-Fi pairing fails.'

/** Local calendar date YYYY-MM-DD (the alert keys are local-day scoped). */
export function localDate(ms: number): string {
  return new Date(ms).toLocaleDateString('sv')
}

function localHm(iso: string | null | undefined): string | null {
  const t = iso ? Date.parse(iso) : NaN
  if (!Number.isFinite(t)) return null
  const d = new Date(t)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** No emdash ever reaches an alert (tool output can carry one). */
function clean(s: string): string {
  return s.replace(/\u2014/g, '-')
}

/** Hours until the signature dies (negative once dead), one decimal, or null
 *  when the value is missing or unparseable. */
export function signedHoursLeft(iso: string | null | undefined, now = Date.now()): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  return Math.round(((t - now) / 3_600_000) * 10) / 10
}

/** What signingNag needs to know about the automation. */
export interface ResignNagContext {
  /** config resign.enabled (the kill switch, authoritative over state). */
  enabled: boolean
  /** state.json, null when missing or unreadable. */
  state: ResignState | null
  daemonAwakeMs: number
}

/** Does the automation own the expiry alerts? Enabled, not a dry run, and a
 *  heartbeat under 2h old; or, inside the wake grace (daemon awake under 45
 *  min), any heartbeat at all, since staleness right after a wake is not yet
 *  evidence. Anything else (disabled, kill switch, dry run, never ran, stale
 *  past the grace, unreadable state) hands the job back to the legacy nag.
 *  resignAlerts' clock tiers fire exactly when this is true, so one of the
 *  two always speaks: the grace can delay nothing, only pick the voice. */
export function resignHealthy(ctx: ResignNagContext | null | undefined, now = Date.now()): boolean {
  if (!ctx || !ctx.enabled || !ctx.state) return false
  if (ctx.state.dry_run) return false
  const beat = ctx.state.last_run_at ? Date.parse(ctx.state.last_run_at) : NaN
  if (!Number.isFinite(beat)) return false
  if (now - beat < RESIGN_HEARTBEAT_MS) return true
  return ctx.daemonAwakeMs < RESIGN_AWAKE_MS
}

/** The clock tier for hours left, or null outside the nag window. */
function clockTier(left: number): 'expired' | 'critical' | 'urgent' | 'expiry' {
  if (left <= 0) return 'expired'
  if (left <= TIER_CRITICAL_H) return 'critical'
  if (left <= TIER_URGENT_H) return 'urgent'
  return 'expiry'
}

/** The per-day key of a clock tier (shared by the legacy nag, while the
 *  feature is on, and resignAlerts (C), so a hand-off never doubles up). */
function tierKey(left: number, day: string): string {
  return `phone-sign-${clockTier(left)}:${day}`
}

/** The daily nag, if one is due: a dedupe key scoped to the local day (so the
 *  engine emits at most one per day) and the problem text. null when the
 *  signature is healthy, unknown, dead for longer than the nag window, or
 *  when a healthy auto re-sign owns the alerts (resignAlerts). */
export function signingNag(
  iso: string | null | undefined,
  now = Date.now(),
  resign?: ResignNagContext | null,
): { key: string; problem: string; priority?: 'alert' } | null {
  const left = signedHoursLeft(iso, now)
  if (left == null || left > SIGNING_NAG_HOURS) return null
  if (left <= -SIGNING_EXPIRED_NAG_DAYS * 24) return null
  if (resignHealthy(resign, now)) return null
  const day = localDate(now)
  // Feature on (but not owning the alerts right now): share the tier keys
  // with resignAlerts (C) so a hand-off inside one day never doubles up, keep
  // the critical tier's priority, and never advise a reinstall while an
  // auto install is waiting for its confirming hello. Feature off or a dry
  // run: exactly the pre-automation behaviour.
  const owned = !!resign?.enabled && !resign.state?.dry_run
  const pending = owned && !!resign?.state?.pending_confirm
  const advice = pending ? PENDING_ADVICE : REINSTALL
  if (left <= 0) {
    return {
      key: owned ? tierKey(left, day) : `phone-sign-expired:${day}`,
      problem: clean(
        `Phone relayer: the HealthRelay app's sideload signature EXPIRED at ${iso} (${Math.abs(left)}h ago). iOS will not launch it, so the phone leg is dead until ${pending ? 'the new build reports in' : 'it is reinstalled'}. ${advice}`,
      ),
    }
  }
  return {
    key: owned ? tierKey(left, day) : `phone-sign-expiry:${day}`,
    ...(owned && left <= TIER_CRITICAL_H ? { priority: 'alert' as const } : {}),
    problem: clean(
      `Phone relayer: the HealthRelay app's sideload signature expires in ${left}h (at ${iso}). ${advice} Plan it around training: the phone leg is the only live HR away from the Mac.`,
    ),
  }
}

// ── Auto re-sign alerts ───────────────────────────────────────────

export interface ResignAlert {
  key: string
  problem: string
  priority: 'notable' | 'alert'
}

export interface ResignAlertContext {
  /** config resign.enabled; defaults to state.enabled. */
  enabled?: boolean
  windowHours?: number
  /** Did any re-sign or signing alert fire between these instants? Feeds the
   *  one resolved line after a success. */
  alertedBetween?: (fromIso: string, toIso: string) => boolean
}

/** The exact fix per hard class. */
export const RESIGN_FIX: Record<string, string> = {
  account_broken: 'Xcode > Settings > Accounts, sign in + 2FA, then bun run resign kick --force',
  new_certificate:
    'the signing certificate changed: install when you can tap Trust (bun run resign kick --force, then on the phone Settings > General > VPN & Device Management, trust the developer)',
  untrusted_developer:
    'on the phone: Settings > General > VPN & Device Management, trust the developer, then open HealthRelay once',
  profile_not_fresh:
    'Xcode reused a cached profile twice in a row: check ~/Library/Developer/Xcode/UserData/Provisioning Profiles, then bun run resign kick --force --build-only',
  device_not_in_profile:
    'the phone is not in the team device list: build once from Xcode with the phone attached (registers it), then bun run resign kick --force',
  keychain_prompt: 'a keychain prompt blocked codesign: at the desk run bun run resign kick --force and answer Always Allow',
  prompt_hang:
    'a hidden prompt hung the run: at the desk run bun run resign kick --force and answer any keychain or Local Network prompt',
  xcode_setup: 'Xcode needs attention (license, platform or command line tools): open Xcode once, then bun run resign kick --force',
  device_setup:
    'phone setup: Developer Mode on, paired with this Mac, resign.device_udid set (health__config); then bun run resign kick --force',
  free_tier_limit:
    'free-team limit hit (App IDs or app slots): wait out the 7-day window or remove another sideloaded app, then bun run resign kick --force',
  snapshot_mismatch: 'the build snapshot does not match the phone: bun run resign seed --ref <commit of the installed build>',
  install_did_not_take:
    'the phone still reports the old signature after the install: open HealthRelay once; if it persists, scripts/build-phone.sh install',
  devicectl_unreachable: 'CoreDevice is not answering: restart Xcode (or the Mac), then bun run resign kick --force',
  lockstate_unparsed:
    'devicectl lockState output is not understood: capture it with bun run resign plan --probe-lock and pin the parser',
  install_failed: 'devicectl install failed 3 runs in a row: read the run log, then scripts/build-phone.sh install',
  build_incomplete:
    'the re-signed build lacked App Intents metadata (the Money shortcut would break), so it was NOT installed: read the run log, then bun run resign kick --force (it always builds clean)',
  run_timeout: 'the re-sign run hit its 40-min watchdog twice in a row: the run log names the step that hung',
  other: 'read the run log',
}

function clockLine(left: number | null, signedUntil: string | null | undefined): string {
  if (left == null) return 'The signature date is unknown.'
  if (left <= 0) return `The signature EXPIRED at ${signedUntil} (${Math.abs(left)}h ago).`
  return `The signature expires in ${left}h (at ${signedUntil}).`
}

function attemptsLine(s: ResignState): string {
  const c = s.counters
  const blockedTotal = Object.values(c.blocked ?? {}).reduce((a, b) => a + (Number(b) || 0), 0)
  const topBlock = Object.entries(c.blocked ?? {}).sort((a, b) => (Number(b[1]) || 0) - (Number(a[1]) || 0))[0]?.[0]
  const last = localHm(c.last_attempt_at)
  return (
    `Auto re-sign has not landed: ${c.attempts} attempts since the window opened ` +
    `(locked ${c.locked}, away ${c.unreachable}, blocked ${blockedTotal}${topBlock ? `: ${topBlock}` : ''})` +
    `${last ? `; last try ${last}` : ''}${c.last_skip_reason ? ` (${c.last_skip_reason})` : ''}.`
  )
}

const ADVICE =
  'Unlock the phone at home on Wi-Fi and it installs within 15 min (or open the app to trigger an attempt), or run bun run resign kick --force. Cable fallback: scripts/build-phone.sh install.'
const PENDING_ADVICE = 'Auto re-sign installed, unconfirmed: open the app once so it reports the new signature.'

/** Every re-sign alert due right now. The engine dedupes by key (a delivered
 *  key never re-sends), so this is called on every tick and stays quiet. */
export function resignAlerts(
  state: ResignState | null,
  signedUntil: string | null | undefined,
  now: number,
  daemonAwakeMs: number,
  ctx: ResignAlertContext = {},
): ResignAlert[] {
  const enabled = ctx.enabled ?? state?.enabled ?? false
  // A missing state.json with the feature on is NOT a reason for silence: the
  // agent never ran (or its state was removed), which is exactly timer_dead.
  if (!enabled || state?.dry_run) return []
  const out: ResignAlert[] = []
  const left = signedHoursLeft(signedUntil, now)
  const day = localDate(now)
  const windowHours = ctx.windowHours ?? 72
  const urgentPriority: 'notable' | 'alert' = left != null && left <= TIER_CRITICAL_H ? 'alert' : 'notable'
  const pending = state?.pending_confirm ?? null

  // (A) a hard episode: once per episode.
  const ep = state?.episode ?? null
  if (ep && ep.hard) {
    const fix = RESIGN_FIX[ep.class] ?? RESIGN_FIX.other
    out.push({
      key: `resign-fail:${ep.class}:${ep.since}`,
      priority: urgentPriority,
      problem: clean(
        `Phone relayer: auto re-sign failed (${ep.class}${ep.detail ? `: ${ep.detail.slice(0, 200)}` : ''}). ${clockLine(left, signedUntil)} Fix: ${fix}. Log: ${RESIGN_LOG_HINT}`,
      ),
    })
  }

  // (D) the timer stopped beating while the window is open.
  const beat = state?.last_run_at ? Date.parse(state.last_run_at) : NaN
  const windowOpen = left != null && policyWindowOpen(left, windowHours)
  if (windowOpen && daemonAwakeMs >= RESIGN_AWAKE_MS && (!Number.isFinite(beat) || now - beat >= RESIGN_HEARTBEAT_MS)) {
    const ago = Number.isFinite(beat) ? `${Math.round((now - beat) / 3_600_000)}h` : 'ever'
    out.push({
      key: `resign-timer-dead:${day}`,
      priority: 'notable',
      problem: `Phone relayer: the auto re-sign timer has not run in ${ago} while the re-sign window is open. ${clockLine(left, signedUntil)} Check: launchctl print gui/$UID/com.s0nderlabs.health.resign and ${RESIGN_LOG_HINT} (reinstall with bun run resign install-agent).`,
    })
  }

  // (D) unknown expiry while enabled: ONE notable per stretch, not one a day
  // (bypassCooldown exempts it from the budget). The key moves only when a
  // re-sign lands, so a later unknown stretch after a success alerts again.
  if (left == null) {
    out.push({
      key: `resign-unknown-expiry:${state?.last_success?.at ?? 'never'}`,
      priority: 'notable',
      problem:
        'Phone relayer: auto re-sign is on but the phone has not reported its signature date: open HealthRelay once so its hello carries it (builds before the sideload clock never report it).',
    })
  }

  // (D) installed, still unconfirmed 6h after the first install.
  if (pending) {
    const first = Date.parse(pending.first_installed_at)
    if (Number.isFinite(first) && now - first >= UNCONFIRMED_AFTER_MS) {
      out.push({
        key: `resign-unconfirmed:${pending.first_installed_at}`,
        priority: 'notable',
        problem: `Phone relayer: ${PENDING_ADVICE} Installed at ${pending.first_installed_at} (${pending.version}). ${clockLine(left, signedUntil)}`,
      })
    }
  }

  // (C) clock escalation, exactly while the automation owns the alerts (else
  // the legacy nag fires). One key per local day per tier; only the highest.
  // No "a success covers it" escape: a success inside this window already
  // moved signed_until about 168h out, and an older success (the previous
  // window's, whose expiry IS today's signed_until) must never silence the
  // run-up to death.
  const healthy = resignHealthy({ enabled, state, daemonAwakeMs }, now)
  const success = state?.last_success ?? null
  if (state && healthy && left != null && left <= TIER_NOTABLE_H && left > -SIGNING_EXPIRED_NAG_DAYS * 24) {
    const what = pending ? PENDING_ADVICE : `${attemptsLine(state)} ${ADVICE}`
    const lastHard = state.last_hard_class ? ` Last hard failure: ${state.last_hard_class}.` : ''
    const tier = clockTier(left)
    const lead =
      tier === 'expired'
        ? `Phone relayer: the HealthRelay app's sideload signature EXPIRED at ${signedUntil} (${Math.abs(left)}h ago). iOS will not launch the expired build.`
        : tier === 'critical'
          ? `Phone relayer: CRITICAL, the HealthRelay signature expires in ${left}h (at ${signedUntil}).`
          : `Phone relayer: the HealthRelay signature expires in ${left}h (at ${signedUntil}).`
    out.push({
      // tierKey: the SAME key the legacy nag uses, so a hand-off never doubles.
      key: tierKey(left, day),
      priority: tier === 'critical' ? 'alert' : 'notable',
      problem: clean(`${lead} ${what}${tier === 'expiry' ? '' : lastHard}`),
    })
  }

  // (E) resolved: one line, only when something alerted this window.
  if (success) {
    const at = Date.parse(success.at)
    if (Number.isFinite(at) && now - at >= 0 && now - at < RESOLVED_WITHIN_MS && ctx.alertedBetween) {
      const from = success.window_since ?? new Date(at - (windowHours + 24) * 3_600_000).toISOString()
      if (ctx.alertedBetween(from, success.at)) {
        out.push({
          key: `resign-resolved:${localDate(at)}`,
          priority: 'notable',
          problem: `Phone relayer: auto re-sign landed, the phone is signed until ${success.expiry}.`,
        })
      }
    }
  }
  return out
}

// ── Loud pushes (phone + Mac notifications) ───────────────────────
//
// An ADDITIONAL delivery path on top of the system.health events, which stay
// exactly as they are: only the alerts that must reach him away from a CC
// session become a notification. Loud = (a) the clock tiers urgent (<=24h),
// critical (<=8h) or expired, or (b) a hard re-sign failure episode while
// 24h or less are left. The 48h tier, a hard episode with more than 24h left,
// and every other re-sign alert stay channel-only. "No confirmed success this
// window" needs no extra input: a confirmed success moves signed_until about
// 168h out, so no clock tier fires after one.

export interface SigningPush {
  /** The notification identifier (a resend REPLACES, never stacks). */
  id: string
  title: string
  body: string
  level: 'loud' | 'critical'
}

/** Max phone-notification body. */
export const PUSH_BODY_MAX = 180

/** Phone-length fix per hard class (RESIGN_FIX, shortened). */
export const RESIGN_FIX_SHORT: Record<string, string> = {
  account_broken: 'At the Mac: Xcode > Settings > Accounts, sign in, then resign kick --force.',
  new_certificate: 'At the Mac: resign kick --force, then trust the developer in VPN & Device Management.',
  untrusted_developer: 'On the phone: trust the developer in VPN & Device Management, open HealthRelay.',
  profile_not_fresh: 'At the Mac: Xcode reused a cached profile, run resign kick --force --build-only.',
  device_not_in_profile: 'At the Mac: build once from Xcode with the phone attached, then resign kick --force.',
  keychain_prompt: 'At the Mac: run resign kick --force and answer Always Allow.',
  prompt_hang: 'At the Mac: run resign kick --force and answer any prompt.',
  xcode_setup: 'At the Mac: open Xcode once, then resign kick --force.',
  device_setup: 'Check Developer Mode and pairing, then resign kick --force.',
  free_tier_limit: 'Free-team limit hit: remove another sideloaded app, then resign kick --force.',
  snapshot_mismatch: 'At the Mac: the build snapshot does not match, run resign seed.',
  install_did_not_take: 'Open HealthRelay once so it reports the new signature.',
  devicectl_unreachable: 'At the Mac: restart Xcode, then resign kick --force.',
  lockstate_unparsed: 'At the Mac: run resign plan --probe-lock and read the log.',
  install_failed: 'At the Mac: scripts/build-phone.sh install.',
  build_incomplete: 'At the Mac: read the run log, then resign kick --force.',
  run_timeout: 'At the Mac: read the run log, a step keeps hanging.',
  other: 'At the Mac: read the re-sign run log.',
}

const UNLOCK_ACTION = 'Unlock your phone at home on Wi-Fi for a minute so it re-signs.'
const PENDING_ACTION = 'Open HealthRelay once so it reports the new signature.'
const REINSTALL_ACTION = 'At the Mac: scripts/build-phone.sh install, phone unlocked on Wi-Fi.'

/** The expiry as local HH:MM, labelled WIB when the clock runs on WIB. */
export function pushClock(iso: string | null | undefined, offsetMin?: number): string | null {
  const hm = localHm(iso)
  if (!hm) return null
  const off = offsetMin ?? new Date(Date.parse(iso as string)).getTimezoneOffset()
  return off === -420 ? `${hm} WIB` : hm
}

/** Phone-length, emdash-free, capped at PUSH_BODY_MAX. */
function pushBody(s: string): string {
  const t = clean(s).replace(/\s+/g, ' ').trim()
  return t.length <= PUSH_BODY_MAX ? t : `${t.slice(0, PUSH_BODY_MAX - 3).trimEnd()}...`
}

function leftPhrase(left: number, clock: string | null): string {
  const at = clock ? ` (${clock})` : ''
  return left <= 0 ? `expired ${Math.abs(left)}h ago${at}` : `${left}h left${at}`
}

/** The push id of a clock tier: scoped to the SIGNATURE, never the calendar
 *  day, so an unchanged tier never re-posts at local midnight (a middle-of-
 *  the-night ding with no new information). Each tier pushes once per
 *  signature; a reinstall (new signed_until) starts a fresh set. The phone
 *  replaces an older phone-sign-* banner on escalation (RelayController). */
export function clockPushId(left: number, signedUntil: string): string {
  return `phone-sign-${clockTier(left)}:${signedUntil}`
}

/** The subset of the alerts the watchdog is about to emit that also goes out
 *  as a notification, deduped by id. Pure: alerts in, pushes out. The clock
 *  tiers are classified from hours left (the legacy nag's unowned key covers
 *  every positive tier with one daily key), and their id is clockPushId, so
 *  an urgent -> critical escalation is a NEW notification while a tier that
 *  merely crosses midnight is not. Nothing pushes once the signature has
 *  been dead for SIGNING_EXPIRED_NAG_DAYS (the clock tiers already stop
 *  there; a hard episode would otherwise outlive the 10-day push ledgers and
 *  re-post on the Mac every 10 days forever). */
export function loudSigningPush(
  alerts: ReadonlyArray<{ key: string; problem: string }>,
  signedUntil: string | null | undefined,
  now = Date.now(),
): SigningPush[] {
  const left = signedHoursLeft(signedUntil, now)
  if (left == null || left > TIER_URGENT_H) return []
  if (left <= -SIGNING_EXPIRED_NAG_DAYS * 24) return []
  const clock = pushClock(signedUntil)
  const level: SigningPush['level'] = left <= TIER_CRITICAL_H ? 'critical' : 'loud'
  const out = new Map<string, SigningPush>()
  for (const a of alerts) {
    if (a.key.startsWith('phone-sign-')) {
      const action = a.problem.includes(PENDING_ADVICE)
        ? PENDING_ACTION
        : a.problem.includes(REINSTALL)
          ? REINSTALL_ACTION
          : UNLOCK_ACTION
      const lead =
        left <= 0
          ? `Signature expired ${Math.abs(left)}h ago${clock ? ` (${clock})` : ''}, the phone leg is dead.`
          : `Signature expires in ${left}h${clock ? ` (${clock})` : ''}.`
      const id = clockPushId(left, signedUntil as string)
      out.set(id, { id, title: 'Health app signature', body: pushBody(`${lead} ${action}`), level })
    } else if (a.key.startsWith('resign-fail:')) {
      const cls = a.key.split(':')[1] ?? 'other'
      const fix = RESIGN_FIX_SHORT[cls] ?? RESIGN_FIX_SHORT.other
      out.set(a.key, {
        id: a.key,
        title: 'Health app: re-sign failed',
        body: pushBody(`Re-sign failed (${cls}), ${leftPhrase(left, clock)}. ${fix}`),
        level,
      })
    }
  }
  return [...out.values()]
}
