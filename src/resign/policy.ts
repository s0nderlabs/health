// Auto re-sign, the PURE core. Every decision the runner makes about WHEN to
// build, WHEN to install, WHAT blocks an install, whether a minted profile is
// really fresh, and how an error string maps to a failure class lives here as
// a side-effect-free function over plain inputs, so the whole decision table
// is unit-testable without Xcode, a phone, or a clock.
//
// Conventions: every time is epoch ms (toMs() converts the ISO strings that
// plutil and the daemon hand back); hours_left is the daemon's one-decimal
// countdown (negative once the signature is dead, null when unknown); local
// hours are 0..23 from the caller's clock (the bands are local wall time).

// ── Config ────────────────────────────────────────────────────────

export interface ResignConfig {
  /** Master switch. Off = the runner writes a heartbeat and exits; the daemon
   *  falls back to the legacy 48h nag. Enabling is refused while system.health
   *  events are off (enforced by config_set, not here). */
  enabled: boolean
  /** Hardware UDID of the phone (devicectl hardwareProperties.udid), local only. */
  device_udid: string | null
  /** The re-sign window opens this many hours before the signature dies. */
  window_hours: number
  /** Local-hour band [start, end) for the normal (unforced) build. */
  build_hours: [number, number]
  /** Local-hour band [start, end) for installs, bypassed under critical_hours. */
  install_hours: [number, number]
  /** Kick a run 90s after a phone hello (daemon side). */
  install_on_hello: boolean
  /** Under this many hours left, installs ignore install_hours, yield and the
   *  phone-writer blocker, the new-certificate gate and the pending rule. */
  critical_hours: number
}

export const DEFAULT_RESIGN: ResignConfig = {
  enabled: false,
  device_udid: null,
  window_hours: 72,
  build_hours: [2, 5],
  install_hours: [7, 23],
  install_on_hello: true,
  critical_hours: 12,
}

function isHour(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 24
}

function band(v: unknown, fallback: [number, number]): [number, number] {
  if (Array.isArray(v) && v.length === 2 && isHour(v[0]) && isHour(v[1])) return [v[0], v[1]]
  return [...fallback] as [number, number]
}

function posNum(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback
}

/** Tolerant resolve of a raw `resign` config block (or a partial patch over a
 *  base): every malformed field falls back to the base value, never a throw. */
export function resolveResignConfig(raw: unknown, base: ResignConfig = DEFAULT_RESIGN): ResignConfig {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : base.enabled,
    device_udid:
      r.device_udid === null
        ? null
        : typeof r.device_udid === 'string' && r.device_udid.trim()
          ? r.device_udid.trim()
          : base.device_udid,
    window_hours: posNum(r.window_hours, base.window_hours),
    build_hours: band(r.build_hours, base.build_hours),
    install_hours: band(r.install_hours, base.install_hours),
    install_on_hello: typeof r.install_on_hello === 'boolean' ? r.install_on_hello : base.install_on_hello,
    critical_hours: posNum(r.critical_hours, base.critical_hours),
  }
}

// ── Constants ─────────────────────────────────────────────────────

const MIN = 60_000
const HOUR = 3_600_000
const DAY = 24 * HOUR

export const APP_BUNDLE_ID = 'com.s0nderlabs.HealthRelay'
export const WIDGET_BUNDLE_ID = 'com.s0nderlabs.HealthRelay.widgets'

/** Under this many hours left a build runs at any hour (a 72h window always
 *  holds one build band, so the normal build lands with 48-72h left). */
export const BUILD_ANYTIME_HOURS = 48
/** A running Xcode/xcodebuild only defers the build while more than this many
 *  hours are left (the GUI shares the profile cache). */
export const BUSY_DEFER_HOURS = 24
/** Clock escalation tiers (daemon alerting). */
export const URGENT_HOURS = 24
export const ALERT_HOURS = 8
/** Stop entirely this far past death. Mirrors -SIGNING_EXPIRED_NAG_DAYS * 24
 *  in src/signing.ts (kept literal here to avoid an import cycle; a test pins
 *  the two together). */
export const STOP_HOURS = -168
/** account_broken suppresses unforced builds for this long. */
export const ACCOUNT_BROKEN_COOLOFF_MS = 20 * HOUR
/** A staged bundle must still have this long on both profiles. */
export const STAGED_MIN_LIFE_MS = 5 * DAY
/** ...and must outlive the signature on the phone by at least this much. */
export const STAGED_MARGIN_MS = 24 * HOUR
/** No reinstall of the same staged build within this long of its last install. */
export const PENDING_NO_REINSTALL_MS = 24 * HOUR
/** Under critical_hours the floor shrinks to this, but never to zero: a
 *  confirming hello that cannot land (a link outage) must not turn into a
 *  reinstall plus --terminate-existing every 15 min, all night. */
export const PENDING_CRITICAL_REINSTALL_MS = 2 * HOUR
/** signed_until within this of expected_until counts as confirmed. */
export const CONFIRM_SLACK_MS = 15 * MIN
/** A fresh profile was created no earlier than run start minus this. */
export const FRESH_CREATION_SLACK_MS = 5 * MIN
/** Fresh profile expiry floor: min(now + 6.9d, cert notAfter - 1h). */
export const FRESH_EXPIRY_FLOOR_MS = 6.9 * DAY
export const CERT_EXPIRY_SLACK_MS = HOUR
/** A source snapshot younger than this whose version does not match the phone
 *  is a soft awaiting_hello (the manual install's hello may not have landed). */
export const SNAPSHOT_GRACE_MS = 24 * HOUR
/** installBlocker windows. */
export const BLOCK_INTENT_MS = 3 * HOUR
export const BLOCK_REST_MS = 60 * MIN
export const PHONE_WRITER_SEEN_S = 120
/** The run watchdog and the stale-lock age. */
export const RUN_WATCHDOG_MS = 40 * MIN
export const LOCK_STALE_MS = 50 * MIN
/** On battery below this percent, a build is a soft battery skip. */
export const BATTERY_MIN_PCT = 30
/** Streak escalations: a soft failure turns hard on its Nth consecutive run. */
export const HARD_AFTER = {
  profile_not_fresh: 2,
  install_failed: 3,
  run_timeout: 2,
  lockstate_unknown: 3,
} as const

/** Wall timeouts for every external command (ms). */
export const TIMEOUTS = {
  find_xcodebuild: 10_000,
  xcodebuild_version: 20_000,
  find_identity: 10_000,
  defaults_read: 10_000,
  pmset: 10_000,
  plutil: 10_000,
  xcodebuild_wall: 20 * MIN,
  xcodebuild_idle: 5 * MIN,
  codesign_verify: 60_000,
  codesign_extract: 30_000,
  ditto: 60_000,
  confirm_total: 180_000,
  confirm_poll: 5_000,
  pgrep: 10_000,
} as const

// devicectl timeouts live in device.ts (DEVICE_TIMEOUTS) and the kill grace
// in exec.ts (KILL_GRACE_MS): one source of truth each.

// ── Failure classes ───────────────────────────────────────────────

/** Hard classes alert once per episode (daemon side). */
export type HardClass =
  | 'account_broken'
  | 'new_certificate'
  | 'untrusted_developer'
  | 'profile_not_fresh'
  | 'device_not_in_profile'
  | 'keychain_prompt'
  | 'prompt_hang'
  | 'xcode_setup'
  | 'device_setup'
  | 'free_tier_limit'
  | 'snapshot_mismatch'
  | 'install_did_not_take'
  | 'devicectl_unreachable'
  | 'lockstate_unparsed'
  | 'install_failed'
  | 'run_timeout'
  | 'build_incomplete'
  | 'other'

/** Soft skips never alert on their own. outside_build_hours (waiting for the
 *  build band), daemon_down, lockstate_unknown, launch_failed and
 *  profile_not_fresh / install_failed / run_timeout below their streak are
 *  soft too. */
export type SoftClass =
  | 'locked'
  | 'unreachable'
  | 'night'
  | 'blocked'
  | 'busy'
  | 'battery'
  | 'apple_unreachable'
  | 'awaiting_hello'
  | 'outside_build_hours'
  | 'daemon_down'
  | 'lockstate_unknown'
  | 'launch_failed'

export type FailClass = HardClass | SoftClass

export interface Classified {
  class: FailClass
  hard: boolean
  /** The matched evidence (a pattern or 'timeout'), for the log line. */
  why: string
}

/** Does a soft-until-streak class turn hard at this consecutive count (the
 *  count INCLUDING the current failure)? lockstate_unknown escalates under a
 *  different name, see escalatedClass. Classes without a streak rule keep
 *  their intrinsic severity. */
export function hardAtStreak(cls: FailClass, streak: number): boolean {
  const n = (HARD_AFTER as Record<string, number>)[cls]
  return n !== undefined && streak >= n
}

/** The class to RECORD for a failure given its streak: lockstate_unknown
 *  becomes lockstate_unparsed on the 3rd in a row; the other streak classes
 *  keep their name and only change severity. */
export function escalatedClass(cls: FailClass, streak: number): { class: FailClass; hard: boolean } {
  if (cls === 'lockstate_unknown') {
    return hardAtStreak(cls, streak) ? { class: 'lockstate_unparsed', hard: true } : { class: cls, hard: false }
  }
  if (cls in HARD_AFTER) return { class: cls, hard: hardAtStreak(cls, streak) }
  return { class: cls, hard: isHardClass(cls) }
}

const HARD_SET = new Set<string>([
  'account_broken',
  'new_certificate',
  'untrusted_developer',
  'profile_not_fresh',
  'device_not_in_profile',
  'keychain_prompt',
  'prompt_hang',
  'xcode_setup',
  'device_setup',
  'free_tier_limit',
  'snapshot_mismatch',
  'install_did_not_take',
  'devicectl_unreachable',
  'lockstate_unparsed',
  'install_failed',
  'run_timeout',
  'build_incomplete',
  'other',
])

/** Intrinsic severity of a class with no streak context. Streak classes
 *  (profile_not_fresh, install_failed, run_timeout) report true here; the
 *  runner downgrades them with escalatedClass on the first occurrences. */
export function isHardClass(cls: FailClass): cls is HardClass {
  return HARD_SET.has(cls)
}

// ── Small helpers ─────────────────────────────────────────────────

/** ISO string or epoch ms to epoch ms; null when missing or unparseable. */
export function toMs(v: string | number | Date | null | undefined): number | null {
  if (v == null || v === '') return null
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.getTime() : null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : null
}

/** Is a local hour inside [start, end)? A band whose start is after its end
 *  wraps midnight; an empty band (start == end) contains nothing. */
export function hourInBand(hour: number, [start, end]: [number, number]): boolean {
  if (start === end) return false
  if (start < end) return hour >= start && hour < end
  return hour >= start || hour < end
}

/** The development team from a project.yml (DEVELOPMENT_TEAM: XXXXXXXXXX).
 *  null when absent or ambiguous (two different teams). */
export function parseTeamId(projectYml: string): string | null {
  const teams = new Set<string>()
  for (const m of projectYml.matchAll(/^\s*DEVELOPMENT_TEAM:\s*["']?([A-Z0-9]{10})["']?\s*$/gm)) teams.add(m[1])
  return teams.size === 1 ? [...teams][0] : null
}

// ── Versions ──────────────────────────────────────────────────────

export interface ParsedVersion {
  parts: number[]
  build: number | null
}

/** Parse 'X.Y.Z (N)' (the phone's hello format and source.json's), also
 *  tolerating 'X.Y.Z' and 'X.Y.Z(N)'. null when unparseable. */
export function parseVersion(v: string | null | undefined): ParsedVersion | null {
  if (typeof v !== 'string') return null
  const m = v.trim().match(/^(\d+(?:\.\d+){0,3})\s*(?:\(\s*(\d+)\s*\))?$/)
  if (!m) return null
  return { parts: m[1].split('.').map(Number), build: m[2] === undefined ? null : Number(m[2]) }
}

/** -1 | 0 | 1 by marketing version, then build number (a missing build only
 *  equals a missing build, and sorts below any present one). Trailing zero
 *  components are insignificant (0.17 == 0.17.0). null when either side is
 *  unparseable: callers must treat that as a mismatch, never as equal. */
export function compareVersion(a: string | null | undefined, b: string | null | undefined): -1 | 0 | 1 | null {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) return null
  const len = Math.max(pa.parts.length, pb.parts.length)
  for (let i = 0; i < len; i++) {
    const x = pa.parts[i] ?? 0
    const y = pb.parts[i] ?? 0
    if (x !== y) return x < y ? -1 : 1
  }
  if (pa.build === pb.build) return 0
  if (pa.build === null) return -1
  if (pb.build === null) return 1
  return pa.build < pb.build ? -1 : 1
}

export function sameVersion(a: string | null | undefined, b: string | null | undefined): boolean {
  return compareVersion(a, b) === 0
}

// ── Step 5: the clock gate ────────────────────────────────────────

/** Is the re-sign window open? Unknown clocks and long-dead signatures are
 *  closed. */
export function windowOpen(hoursLeft: number | null, windowHours: number = DEFAULT_RESIGN.window_hours): boolean {
  return hoursLeft != null && hoursLeft <= windowHours && hoursLeft > STOP_HOURS
}

export type ClockGate =
  | { proceed: true }
  | { proceed: false; outcome: 'unknown_expiry' | 'noop' | 'stopped' }

/** Step 5. forced bypasses only the window, never an unknown clock or the
 *  -168h stop. */
export function clockGate(hoursLeft: number | null, cfg: Pick<ResignConfig, 'window_hours'>, forced: boolean): ClockGate {
  if (hoursLeft == null) return { proceed: false, outcome: 'unknown_expiry' }
  if (hoursLeft <= STOP_HOURS) return { proceed: false, outcome: 'stopped' }
  if (hoursLeft > cfg.window_hours && !forced) return { proceed: false, outcome: 'noop' }
  return { proceed: true }
}

// ── Step 4: pending reconciliation ────────────────────────────────

export interface PendingConfirmLike {
  staged_run_id: string
  first_installed_at: string
  expected_until: string
  version: string
}

export type PendingVerdict =
  | { verdict: 'none' }
  | { verdict: 'confirmed' }
  | { verdict: 'superseded' }
  | { verdict: 'did_not_take' }
  | { verdict: 'waiting' }

/** Step 4. confirmed: the phone reports the new date (within 15 min slack).
 *  superseded: it reports some other NEWER date (a manual install). did_not_take:
 *  a hello after the first install still reports the old date. waiting: no
 *  hello since the install yet. */
export function reconcilePending(input: {
  pending: PendingConfirmLike | null
  signedUntil: string | number | null
  /** The signature the phone reported BEFORE the first install, when known. */
  oldSignedUntil?: string | number | null
  /** When the daemon last saw a phone hello. */
  lastHelloAt: string | number | null
}): PendingVerdict {
  const p = input.pending
  if (!p) return { verdict: 'none' }
  const signed = toMs(input.signedUntil)
  const expected = toMs(p.expected_until)
  const first = toMs(p.first_installed_at)
  if (signed != null && expected != null && signed >= expected - CONFIRM_SLACK_MS) return { verdict: 'confirmed' }
  const old = toMs(input.oldSignedUntil ?? null)
  if (signed != null && old != null && signed > old) return { verdict: 'superseded' }
  // A hello after the install that still does not report the new date: the
  // install did not take (the superseded case already returned above).
  const hello = toMs(input.lastHelloAt)
  if (hello != null && first != null && hello > first) return { verdict: 'did_not_take' }
  return { verdict: 'waiting' }
}

// ── Step 6: the snapshot guard ────────────────────────────────────

export type SnapshotVerdict =
  | { ok: true }
  | { ok: false; class: 'awaiting_hello'; hard: false }
  | { ok: false; class: 'snapshot_mismatch'; hard: true; why: 'missing' | 'version' }

export function snapshotGuard(input: {
  source: { version: string; captured_at: string } | null
  phoneVersion: string | null
  now: number
}): SnapshotVerdict {
  if (!input.source) return { ok: false, class: 'snapshot_mismatch', hard: true, why: 'missing' }
  if (sameVersion(input.source.version, input.phoneVersion)) return { ok: true }
  const captured = toMs(input.source.captured_at)
  if (captured != null && input.now - captured < SNAPSHOT_GRACE_MS) {
    return { ok: false, class: 'awaiting_hello', hard: false }
  }
  return { ok: false, class: 'snapshot_mismatch', hard: true, why: 'version' }
}

// ── Step 7: staged validity ───────────────────────────────────────

export type StagedVerdict =
  | { valid: true }
  | { valid: false; reason: 'missing' | 'app_short' | 'widget_short' | 'not_past_signed' | 'version' }

/** Step 7. Inputs come from re-decoding BOTH embedded profiles in the staged
 *  bundle (the bundle is the truth, not staged.json). */
export function stagedValid(input: {
  appExpiry: string | number | null
  widgetExpiry: string | number | null
  stagedVersion: string | null
  sourceVersion: string | null
  signedUntil: string | number | null
  now: number
}): StagedVerdict {
  const app = toMs(input.appExpiry)
  const widget = toMs(input.widgetExpiry)
  if (app == null || widget == null || !input.stagedVersion) return { valid: false, reason: 'missing' }
  const floor = input.now + STAGED_MIN_LIFE_MS
  if (app < floor) return { valid: false, reason: 'app_short' }
  if (widget < floor) return { valid: false, reason: 'widget_short' }
  const signed = toMs(input.signedUntil)
  // Unknown signed_until never reaches here in a normal run (the gate stops
  // it); a daemon-down build-only run skips just this criterion.
  if (signed != null && app < signed + STAGED_MARGIN_MS) return { valid: false, reason: 'not_past_signed' }
  if (!sameVersion(input.stagedVersion, input.sourceVersion)) return { valid: false, reason: 'version' }
  return { valid: true }
}

// ── Step 8: the build gate ────────────────────────────────────────

export type BuildDecision =
  | { allowed: true; clear_account_broken: boolean }
  | { allowed: false; reason: 'outside_build_hours' | 'account_broken_cooloff'; clear_account_broken: false }
  /** A forced run always clears the account breaker, even when it ends busy
   *  (the account fix happens in Xcode, so Xcode is usually still open). */
  | { allowed: false; reason: 'busy'; clear_account_broken: boolean }

export function buildAllowed(input: {
  hoursLeft: number | null
  localHour: number
  forced: boolean
  cfg: Pick<ResignConfig, 'build_hours'>
  accountBrokenAt: string | number | null
  now: number
  /** pgrep -x xcodebuild or pgrep -x Xcode matched. */
  xcodeRunning?: boolean
}): BuildDecision {
  const brokenAt = toMs(input.accountBrokenAt)
  if (!input.forced && brokenAt != null && input.now - brokenAt < ACCOUNT_BROKEN_COOLOFF_MS) {
    return { allowed: false, reason: 'account_broken_cooloff', clear_account_broken: false }
  }
  const inBand = hourInBand(input.localHour, input.cfg.build_hours)
  const late = input.hoursLeft != null && input.hoursLeft <= BUILD_ANYTIME_HOURS
  if (!inBand && !late && !input.forced) {
    return { allowed: false, reason: 'outside_build_hours', clear_account_broken: false }
  }
  if (input.xcodeRunning && (input.hoursLeft == null || input.hoursLeft > BUSY_DEFER_HOURS)) {
    return { allowed: false, reason: 'busy', clear_account_broken: input.forced && brokenAt != null }
  }
  return { allowed: true, clear_account_broken: input.forced && brokenAt != null }
}

// ── Step 12: the install gate ─────────────────────────────────────

export type InstallDecision =
  | { action: 'install' }
  /** Same staged build installed too recently (24h, or 2h when critical),
   *  or already installed AND launched after expiry: retry only the relaunch
   *  (step 15), never the install. */
  | { action: 'relaunch_only' }
  | { action: 'skip'; reason: 'night' | 'daemon_down' }
  | { action: 'hard'; class: 'new_certificate' }

export function installAllowed(input: {
  hoursLeft: number | null
  localHour: number
  forced: boolean
  cfg: Pick<ResignConfig, 'install_hours' | 'critical_hours'>
  daemonReachable: boolean
  certChanged: boolean
  /** first_installed_at here is the LAST install of that staged build. */
  pending: (Pick<PendingConfirmLike, 'staged_run_id' | 'first_installed_at'> & { launched?: boolean }) | null
  stagedRunId: string | null
  now: number
}): InstallDecision {
  if (!input.daemonReachable) return { action: 'skip', reason: 'daemon_down' }
  const critical = input.hoursLeft != null && input.hoursLeft < input.cfg.critical_hours
  if (!critical && !input.forced && !hourInBand(input.localHour, input.cfg.install_hours)) {
    return { action: 'skip', reason: 'night' }
  }
  if (input.certChanged && !critical && !input.forced) return { action: 'hard', class: 'new_certificate' }
  const p = input.pending
  if (p && input.stagedRunId && p.staged_run_id === input.stagedRunId) {
    const last = toMs(p.first_installed_at)
    const floor = critical ? PENDING_CRITICAL_REINSTALL_MS : PENDING_NO_REINSTALL_MS
    if (last != null && input.now - last < floor) return { action: 'relaunch_only' }
    // Dead already, and this exact build is on the phone and was launched:
    // another reinstall cannot produce the missing hello. Stop (the
    // unconfirmed and clock alerts carry it) instead of looping for 7 days.
    const expired = input.hoursLeft != null && input.hoursLeft <= 0
    if (expired && p.launched) return { action: 'relaunch_only' }
  }
  return { action: 'install' }
}

// ── Step 13: install blockers ─────────────────────────────────────

export type BlockReason = 'live_session' | 'recent_intent' | 'recent_rest' | 'yield' | 'phone_writer'

export interface BlockerInput {
  now: number
  hoursLeft: number | null
  /** An open live session in the daemon's live state. */
  liveSessionOpen: boolean
  /** Latest workout.intent. */
  lastIntentAt: string | number | null
  /** Latest scored workout (its end, or when it was scored). An intent with a
   *  scored workout at or after it is resolved and no longer blocks. */
  lastScoredWorkoutAt: string | number | null
  /** Latest live.rest. */
  lastRestAt: string | number | null
  yieldActive: boolean
  /** LiveFeedStatus.active_source: the WRITER ('mac' | 'phone' | null). */
  activeSource: string | null
  /** band_seen_ago_s of the phone relayer. */
  phoneBandSeenAgoS: number | null
}

export interface Blocker {
  reason: BlockReason
  /** true when the reason would lift under critical_hours. */
  overridable: boolean
}

/** Step 13, the pure blocker. Always blocks: an open live session, a
 *  workout.intent in the last 3h with no scored workout since, a live.rest in
 *  the last 60 min. Blocks unless hours_left < critical: an active yield, the
 *  phone as the WRITER with fresh band frames. A dual hold where the Mac
 *  writes does NOT block (both legs see frames; only the writer matters). */
export function installBlocker(input: BlockerInput, criticalHours: number = DEFAULT_RESIGN.critical_hours): Blocker | null {
  if (input.liveSessionOpen) return { reason: 'live_session', overridable: false }
  const intent = toMs(input.lastIntentAt)
  if (intent != null && input.now - intent < BLOCK_INTENT_MS) {
    const scored = toMs(input.lastScoredWorkoutAt)
    if (scored == null || scored < intent) return { reason: 'recent_intent', overridable: false }
  }
  const rest = toMs(input.lastRestAt)
  if (rest != null && input.now - rest < BLOCK_REST_MS) return { reason: 'recent_rest', overridable: false }
  const critical = input.hoursLeft != null && input.hoursLeft < criticalHours
  if (critical) return null
  if (input.yieldActive) return { reason: 'yield', overridable: true }
  if (input.activeSource === 'phone' && input.phoneBandSeenAgoS != null && input.phoneBandSeenAgoS < PHONE_WRITER_SEEN_S) {
    return { reason: 'phone_writer', overridable: true }
  }
  return null
}

// ── Step 11d: freshness of a minted profile ───────────────────────

/** The keys step 10/11d read off a decoded embedded.mobileprovision. */
export interface DecodedProfile {
  uuid: string | null
  creation_date: string | number | null
  expiration_date: string | number | null
  /** TeamIdentifier array (TeamIdentifier.0 is the team). */
  team_ids: string[]
  /** Entitlements.application-identifier, e.g. TEAMID.com.example.App. */
  application_identifier: string | null
  provisioned_devices: string[]
}

export type FreshReason =
  | 'reused_uuid'
  | 'old_creation'
  | 'short_expiry'
  | 'team_mismatch'
  | 'app_id_mismatch'
  | 'device_missing'
  | 'unreadable'

export interface FreshContext {
  runStart: number
  now: number
  /** UUIDs of the profiles quarantined before the build. */
  movedUuids: string[]
  /** Signing cert notAfter, when known (caps the expiry floor). */
  certNotAfter: string | number | null
  teamId: string
  bundleId: string
  deviceUdid: string
}

export type FreshVerdict =
  | { fresh: true }
  | { fresh: false; reasons: FreshReason[]; class: 'profile_not_fresh' | 'device_not_in_profile' }

/** The expiry floor a fresh profile must reach. */
export function freshExpiryFloor(now: number, certNotAfter: string | number | null): number {
  const base = now + FRESH_EXPIRY_FLOOR_MS
  const cert = toMs(certNotAfter)
  return cert == null ? base : Math.min(base, cert - CERT_EXPIRY_SLACK_MS)
}

export function isFreshProfile(p: DecodedProfile, ctx: FreshContext): FreshVerdict {
  const reasons: FreshReason[] = []
  const created = toMs(p.creation_date)
  const expires = toMs(p.expiration_date)
  if (!p.uuid || created == null || expires == null) reasons.push('unreadable')
  if (p.uuid && ctx.movedUuids.some((u) => u.toLowerCase() === p.uuid!.toLowerCase())) reasons.push('reused_uuid')
  if (created != null && created < ctx.runStart - FRESH_CREATION_SLACK_MS) reasons.push('old_creation')
  if (expires != null && expires < freshExpiryFloor(ctx.now, ctx.certNotAfter)) reasons.push('short_expiry')
  if (p.team_ids[0] !== ctx.teamId) reasons.push('team_mismatch')
  if (p.application_identifier !== `${ctx.teamId}.${ctx.bundleId}`) reasons.push('app_id_mismatch')
  const udid = ctx.deviceUdid.toLowerCase()
  if (!p.provisioned_devices.some((d) => d.toLowerCase() === udid)) reasons.push('device_missing')
  if (reasons.length === 0) return { fresh: true }
  // A missing device is its own hard class: re-minting cannot fix it.
  return { fresh: false, reasons, class: reasons.includes('device_missing') ? 'device_not_in_profile' : 'profile_not_fresh' }
}

export type PairVerdict =
  | { fresh: true }
  | {
      fresh: false
      class: 'profile_not_fresh' | 'device_not_in_profile'
      failures: Array<{ bundle: 'app' | 'widget'; reasons: FreshReason[] }>
    }

/** Step 11d over BOTH bundles: the app and the widget extension each carry
 *  their own profile, and a stale widget alone fails the mint. */
export function checkFreshPair(
  profiles: { app: DecodedProfile; widget: DecodedProfile },
  ctx: Omit<FreshContext, 'bundleId'> & { appBundleId?: string; widgetBundleId?: string },
): PairVerdict {
  const failures: Array<{ bundle: 'app' | 'widget'; reasons: FreshReason[] }> = []
  const app = isFreshProfile(profiles.app, { ...ctx, bundleId: ctx.appBundleId ?? APP_BUNDLE_ID })
  if (!app.fresh) failures.push({ bundle: 'app', reasons: app.reasons })
  const widget = isFreshProfile(profiles.widget, { ...ctx, bundleId: ctx.widgetBundleId ?? WIDGET_BUNDLE_ID })
  if (!widget.fresh) failures.push({ bundle: 'widget', reasons: widget.reasons })
  if (failures.length === 0) return { fresh: true }
  const device = failures.some((f) => f.reasons.includes('device_missing'))
  return { fresh: false, class: device ? 'device_not_in_profile' : 'profile_not_fresh', failures }
}

/** Is this cached profile one of OURS (step 10 quarantine filter)? Matches
 *  TEAM.bundle exactly for the app and the widget; never a wildcard. */
export function isOurProfile(applicationIdentifier: string | null, teamId: string): boolean {
  if (!applicationIdentifier) return false
  return applicationIdentifier === `${teamId}.${APP_BUNDLE_ID}` || applicationIdentifier === `${teamId}.${WIDGET_BUNDLE_ID}`
}

// ── Classifiers ───────────────────────────────────────────────────

type Rule = [FailClass, RegExp]

function firstMatch(text: string, rules: Rule[]): { class: FailClass; why: string } | null {
  for (const [cls, re] of rules) {
    const m = text.match(re)
    if (m) return { class: cls, why: m[0].slice(0, 120) }
  }
  return null
}

function done(cls: FailClass, why: string): Classified {
  return { class: cls, hard: isHardClass(cls), why }
}

// Order matters: the specific beats the generic (an App ID limit message also
// says "Communication with Apple failed").
const BUILD_RULES: Rule[] = [
  ['free_tier_limit', /maximum App ID limit|App ID limit|maximum number of (?:apps|App IDs)|You may create up to \d+ App IDs/i],
  ['account_broken', /No Accounts?\b|No Account for Team|session has expired|Please (?:sign|log) in|Unable to log in|authentication (?:failed|required)|account .{0,40}(?:expired|invalid|needs? attention)/i],
  ['device_not_in_profile', /has no devices|doesn'?t include the (?:currently selected )?device|No (?:registered )?devices? (?:for|in) (?:your )?team/i],
  ['keychain_prompt', /errSecInternalComponent|errSecInteractionNotAllowed|User interaction is not allowed|keychain/i],
  ['xcode_setup', /xcode-select: error|agreed to the Xcode (?:and Apple SDKs )?license|license agreement|unable to find utility|requires a development team|is not installed\. (?:To use with Xcode|Please download)|Unable to find a destination|platform .{0,30}not installed|No such file or directory.{0,40}xcodeproj|does not contain a scheme|xcodebuild: error: .{0,40}project/i],
  ['apple_unreachable', /Communication with Apple failed|Internet connection appears to be offline|Could not resolve host|NSURLErrorDomain|network connection was lost|developerservices2\.apple\.com|connection to the server/i],
]

/** Map an xcodebuild failure (output tail) to a class. Text beats timing: a
 *  timeout whose tail names a specific cause gets that cause; an otherwise
 *  silent idle or wall timeout is a hidden prompt (prompt_hang). */
export function classifyBuild(text: string, opts: { timedOut?: boolean; idledOut?: boolean; productMissing?: boolean } = {}): Classified {
  const m = firstMatch(text, BUILD_RULES)
  if (m) return done(m.class, m.why)
  if (opts.idledOut || opts.timedOut) return done('prompt_hang', opts.idledOut ? 'idle timeout' : 'wall timeout')
  if (opts.productMissing) return done('other', 'product missing')
  return done('other', 'unrecognised')
}

// 4016 "not able to fulfill the requested usage assertion requirements" is
// what a LOCKED phone answers to a wireless install (observed Nov 16 2026,
// iOS 27.2: six straight failures while locked, success once unlocked).
const LOCKED_RE = /usage assertion requirements|CoreDeviceError error 4016|device is (?:currently )?locked|passcode[- ]protected|\bis locked\b|unlock (?:the|your) device|DeviceLocked|kAMDMobileImageMounterDeviceLocked|0xe800800e/i
const UNTRUSTED_RE = /untrusted|not (?:been )?explicitly trusted|Verify the Developer App certificate|invalid code signature, inadequate entitlements or its profile has not been explicitly trusted/i

const INSTALL_RULES: Rule[] = [
  ['locked', LOCKED_RE],
  ['free_tier_limit', /maximum number of (?:installed )?apps|free development profiles|0xe800801c/i],
  ['device_not_in_profile', /ApplicationVerificationFailed|valid provisioning profile for this executable was not found|0xe8008015|not included in the provisioning profile/i],
  ['untrusted_developer', UNTRUSTED_RE],
  ['device_setup', /Developer Mode (?:is )?(?:disabled|not enabled|off)|enable Developer Mode|not paired|pairing (?:failed|record|is required)|Trust This Computer|DDI .{0,30}(?:failed|not mounted)|developer disk image/i],
  ['xcode_setup', /unable to find utility "?devicectl|xcrun: error/i],
  ['devicectl_unreachable', /CoreDeviceService|Could not establish a connection to (?:the )?CoreDevice|remote service|RemoteServiceDiscovery|XPC connection (?:was )?(?:interrupted|invalidated)/i],
  ['unreachable', /Unable to locate (?:a )?device|No devices? (?:found|matched)|device (?:was )?not found|is not connected|not reachable|unavailable|Failed to connect|could not connect|tunnel|timed out|connection (?:refused|reset|lost)|offline/i],
]

/** Map a devicectl install failure to a class. Unrecognised failures are
 *  install_failed (soft until 3 in a row, see escalatedClass). A wall timeout
 *  without text is unreachable (soft). */
export function classifyInstall(text: string, opts: { timedOut?: boolean } = {}): Classified {
  const m = firstMatch(text, INSTALL_RULES)
  if (m) return done(m.class, m.why)
  if (opts.timedOut) return done('unreachable', 'timeout')
  return { class: 'install_failed', hard: false, why: 'unrecognised' }
}

/** Map a devicectl launch failure. Only an untrusted-developer error is hard;
 *  everything else is soft and the relaunch is retried on a later unlocked
 *  probe. */
export function classifyLaunch(text: string, opts: { timedOut?: boolean } = {}): Classified {
  const u = text.match(UNTRUSTED_RE)
  if (u) return done('untrusted_developer', u[0].slice(0, 120))
  const l = text.match(LOCKED_RE)
  if (l) return done('locked', l[0].slice(0, 120))
  if (opts.timedOut) return done('unreachable', 'timeout')
  return done('launch_failed', text.trim().split('\n').pop()?.slice(0, 120) || 'unrecognised')
}

/** Step 15 success test: the text says 'App installed' AND the install JSON
 *  names our bundle id somewhere under a bundle-id-like key. Both, never one. */
export function installConfirmed(output: string, installJson: unknown, bundleId: string = APP_BUNDLE_ID): boolean {
  if (!/App installed/.test(output)) return false
  return jsonHasBundle(installJson, bundleId, 0)
}

function jsonHasBundle(v: unknown, bundleId: string, depth: number): boolean {
  if (depth > 12 || v == null) return false
  if (Array.isArray(v)) return v.some((x) => jsonHasBundle(x, bundleId, depth + 1))
  if (typeof v === 'object') {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (/^bundle_?id(entifier)?$/i.test(k) && x === bundleId) return true
      if (jsonHasBundle(x, bundleId, depth + 1)) return true
    }
  }
  return false
}

// ── Step 14: devicectl JSON parsers ───────────────────────────────

export interface DeviceInfo {
  udid: string | null
  /** CoreDevice identifier (NOT the udid; never match on it). */
  identifier: string | null
  reality: string | null
  pairing_state: string | null
  transport_type: string | null
  tunnel_state: string | null
  platform: string | null
}

export interface DeviceMatch {
  device: DeviceInfo | null
  reason: null | 'unreadable' | 'no_udid_configured' | 'not_found' | 'not_physical' | 'not_paired'
  /** Every device in the listing (simulators included), for the run log. */
  devices: DeviceInfo[]
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null
}

function asJson(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/** One device entry. Reads the current `properties` dictionary first and the
 *  deprecated hardwareProperties / connectionProperties as fallback (devicectl
 *  651 emits both and announces the old ones will go). */
function readDevice(d: Record<string, unknown>): DeviceInfo {
  const props = obj(d.properties)
  const hw = obj(props?.hardware)
  const conn = obj(props?.connection)
  const oldHw = obj(d.hardwareProperties)
  const oldConn = obj(d.connectionProperties)
  return {
    udid: str(hw?.udid) ?? str(oldHw?.udid),
    identifier: str(d.identifier),
    reality: str(hw?.reality) ?? str(oldHw?.reality),
    pairing_state: str(conn?.pairingState) ?? str(oldConn?.pairingState),
    transport_type: str(conn?.transportType) ?? str(oldConn?.transportType),
    tunnel_state: str(oldConn?.tunnelState) ?? str(conn?.state),
    platform: str(hw?.platform) ?? str(oldHw?.platform),
  }
}

/** Parse `devicectl list devices --json-output` and find the configured phone
 *  by HARDWARE udid. Requires reality physical and pairingState paired; the
 *  tunnel state and transport are informational only. Simulators never match
 *  (a simulator can carry the same marketing name). */
export function parseDevices(raw: unknown, udid: string | null): DeviceMatch {
  const json = obj(asJson(raw))
  const list = obj(json?.result)?.devices
  if (!Array.isArray(list)) return { device: null, reason: 'unreadable', devices: [] }
  const devices = list.map((d) => obj(d)).filter((d): d is Record<string, unknown> => d !== null).map(readDevice)
  if (!udid) return { device: null, reason: 'no_udid_configured', devices }
  const want = udid.toLowerCase()
  const same = devices.filter((d) => d.udid?.toLowerCase() === want)
  if (same.length === 0) return { device: null, reason: 'not_found', devices }
  const physical = same.filter((d) => d.reality === 'physical')
  if (physical.length === 0) return { device: null, reason: 'not_physical', devices }
  const paired = physical.find((d) => d.pairing_state === 'paired')
  if (!paired) return { device: null, reason: 'not_paired', devices }
  return { device: paired, reason: null, devices }
}

export type LockState = 'locked' | 'unlocked' | 'unverified' | 'unknown'

export interface LockStateResult {
  state: LockState
  /** The field that decided it (dotted path), null when unknown. */
  field: string | null
  /** Why unknown: unreadable JSON, a failed outcome, no recognised field, or
   *  recognised fields that disagree. */
  why: string | null
  /** Top-level keys of the result object, for pinning the real shape. */
  keys: string[]
}

// Fields whose boolean value means LOCKED when true.
// NOT passcodeRequired: on the real device (iPhone 12, iOS 27.2, devicectl
// 651.32, observed Nov 16 2026) it read true on every probe for 10 minutes,
// including right after successful wireless installs, so it is not proven to
// mean "locked right now" (it may mean "a passcode is set"). See
// OBSERVED_SHAPE below.
const LOCKED_TRUE = ['isLocked', 'locked', 'deviceLocked', 'isDeviceLocked']
// Fields whose boolean value means UNLOCKED when true.
const UNLOCKED_TRUE = ['isUnlocked', 'unlocked', 'deviceUnlocked']
// Fields carrying a string state.
const STATE_STRINGS = ['lockState', 'lockedState', 'state', 'deviceLockState']

/** Parse `devicectl device info lockState --json-output`. The real JSON has
 *  never been observed, so this NEVER guesses: it reads only explicit fields
 *  (booleans like isLocked / passcodeRequired, or a lockState string that is
 *  exactly locked / unlocked), and anything else, including the known-but-
 *  insufficient unlockedSinceBoot (unlocked once since boot is not unlocked
 *  now), is unknown. Conflicting explicit fields are unknown too. */
export function parseLockState(raw: unknown): LockStateResult {
  const json = obj(asJson(raw))
  if (!json) return { state: 'unknown', field: null, why: 'unreadable', keys: [] }
  const outcome = str(obj(json.info)?.outcome)
  const result = obj(json.result)
  const keys = result ? Object.keys(result) : []
  if (outcome && outcome !== 'success') return { state: 'unknown', field: null, why: `outcome:${outcome}`, keys }
  if (!result) return { state: 'unknown', field: null, why: 'no_result', keys }
  // Look in result and one level down (result.lockState: {...}, result.device: {...}).
  const scopes: Array<[string, Record<string, unknown>]> = [['result', result]]
  for (const [k, v] of Object.entries(result)) {
    const o = obj(v)
    if (o) scopes.push([`result.${k}`, o])
  }
  const votes: Array<{ state: 'locked' | 'unlocked'; field: string }> = []
  for (const [path, scope] of scopes) {
    for (const k of LOCKED_TRUE) {
      if (typeof scope[k] === 'boolean') votes.push({ state: scope[k] ? 'locked' : 'unlocked', field: `${path}.${k}` })
    }
    for (const k of UNLOCKED_TRUE) {
      if (typeof scope[k] === 'boolean') votes.push({ state: scope[k] ? 'unlocked' : 'locked', field: `${path}.${k}` })
    }
    for (const k of STATE_STRINGS) {
      const s = typeof scope[k] === 'string' ? (scope[k] as string).trim().toLowerCase() : null
      if (s === 'locked' || s === 'unlocked') votes.push({ state: s, field: `${path}.${k}` })
    }
  }
  if (votes.length === 0) {
    // The real shape: {deviceIdentifier, passcodeRequired, unlockedSinceBoot}.
    // unlockedSinceBoot=false is unambiguous (before first unlock nothing can
    // install). Otherwise the probe cannot tell "unlocked now" from "locked
    // but unlocked since boot": 'unverified', and the caller attempts the
    // install, whose own locked error is classified soft.
    if (typeof result.unlockedSinceBoot === 'boolean') {
      if (result.unlockedSinceBoot === false) return { state: 'locked', field: 'result.unlockedSinceBoot', why: null, keys }
      return { state: 'unverified', field: 'result.passcodeRequired', why: 'observed_shape', keys }
    }
    return { state: 'unknown', field: null, why: 'no_known_field', keys }
  }
  const first = votes[0]
  if (votes.some((v) => v.state !== first.state)) return { state: 'unknown', field: null, why: 'conflict', keys }
  return { state: first.state, field: first.field, why: null, keys }
}
