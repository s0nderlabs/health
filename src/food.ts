// Food service: the one place meals enter, change, and leave.
//
// Two equal front doors, same rules:
//   - the phone (POST /meal, POST /meal/fix over the authed tailnet link)
//   - chat (health__meal log / estimate / void, from the user's own session)
// Both store the meal, normalise photos into meals/<day>/<id>-<n>.jpg, count
// in the same totals, and push meals_updated to the phone so the Food tab
// refreshes. Phone logs additionally raise meal.logged (main estimates it);
// phone fix lines raise meal.amended. Chat-side writes raise no event: the
// session that made them already knows.

import { join } from 'path'
import { readFileSync, rmSync } from 'fs'
import type { Database } from 'bun:sqlite'
import {
  MealBook,
  computeBaseline,
  foodDay,
  isDayKey,
  normalizeItems,
  parseConfidence,
  slugify,
  addDays,
  daysBetween,
  totalsOf,
  weightFit,
  BASELINE_DEFAULTS,
  type Baseline,
  type Meal,
} from './meals.js'
import {
  CALIBRATION_MAX_AGE_MS,
  balanceText,
  burnByDay,
  calibrate,
  dayBounds,
  dayEnergy,
  exclusionStats,
  type Calibration,
  type CycleRec,
  type DayBurn,
  type DayEnergy,
} from './energy.js'
import {
  ConfounderBook,
  computeBracket,
  earlySlope,
  goalView,
  parseGoal,
  viewOf,
  type Bracket,
  withKindDefaults,
  type ConfounderDetails,
  type ConfounderSeed,
  type ConfounderView,
  type GoalRecord,
  type GoalView,
} from './confounders.js'
import { ingestPhoto, PHOTO_MAX_PER_MEAL } from './photos.js'
import {
  CAL_META as SCALE_CAL_META,
  FIT_MAX_PAIRS,
  PAIR_WINDOW_MS,
  ScaleCalBook,
  applyModel,
  backfillScaleReadings,
  calibrationNote,
  fitCalibration,
  pairReadings,
  parseModel,
  provenanceOf,
  readingProvenance,
  readingStemOf,
  referenceName,
  sameModel,
  type CalModel,
  type CalPair,
  type FatProvenance,
  type ScaleRaw,
  type ScaleReadingRow,
} from './scalecal.js'
import { SCALE_SOURCE } from './scale.js'
import {
  METRICS,
  PAIRABLE_METRICS,
  basisOf,
  basisOfProvenance,
  calibrationText,
  bodyEventLine,
  computeMetrics,
  fitMetric,
  metricViews,
  parseMetrics,
  profileKey,
  METRICS_VERSION,
  applyMetric,
  type FatOverride,
  type MetricBasis,
  type MetricKey,
  type MetricView,
} from './bodycomp.js'
import { BadRequest, cleanText, jsonBody, requireClientId, singleFlight } from './http.js'
import { bodyPage } from './bodyview.js'
export { BadRequest } from './http.js'
import type { HealthConfig, ScaleConfig } from './types.js'

export const MAX_PHOTOS_PER_MEAL = PHOTO_MAX_PER_MEAL
/** Meta key prefix that makes POST /meal/photos idempotent per client_id. */
const PHOTO_ADD_META = 'meal_photo_add:'
const HISTORY_DEFAULT_DAYS = 60
const HISTORY_MAX_DAYS = 400
const MAX_BODY_SAMPLES = 5000

type FoodConfig = HealthConfig['food']

export interface FoodDeps {
  db: Database
  photosDir: string
  getConfig: () => FoodConfig
  getMeta: (k: string) => string | null
  setMeta: (k: string, v: string) => void
  /** scale.reference_sources: the HealthKit source name(s) the S400 fat is
   *  calibrated against (e.g. ["Xiaomi Home"]). Unset = any non-S400 source
   *  with mass + fat at one instant. */
  getScaleReferenceSources?: () => string[] | undefined
  /** scale.profile (height, birth date, sex): the body-composition formulas'
   *  inputs. Unset = no metrics beyond weight and fat. */
  getScaleProfile?: () => ScaleConfig['profile'] | undefined
  /** Queue a channel event; returns whether it surfaced. */
  emit: (
    cls: 'meal.logged' | 'meal.amended' | 'body.weighin',
    key: string,
    payload: { content: string; meta: Record<string, string> },
  ) => boolean
  /** Push a message to every connected phone. */
  broadcast: (msg: Record<string, unknown>) => void
  /** WHOOP cycles overlapping [sinceIso, now] (end null = in progress),
   *  kcal = kilojoule / 4.184: the burn side of the energy balance. */
  whoopCyclesSince?: (sinceIso: string) => CycleRec[]
  now?: () => number
  log?: (msg: string) => void
}

/** Exclusion reasons (stored in body_samples.excluded). */
const EXCL_TEST = 'test: '
const EXCL_NOT_MORNING = 'not a morning reading'
const EXCL_REPEAT = 'repeat: a morning reading already counts today'
/** Exported for GET /body: such a row is masked (not his body to show). */
export const EXCL_OUTLIER = 'possible other person'
const EXCL_AFTER_MEAL = 'after a meal'
const EXCL_REPLAY = 'possible replay'
/** The same weigh-in from a second source at the identical instant (S400 BLE
 *  + Xiaomi Home on the scale's own clock): one copy counts. Re-decided on
 *  every pass, so the other copy counts again once the preferred one is
 *  excluded (a replay, by hand, an outlier). */
const EXCL_SAME_INSTANT = 'same weigh-in, other source'
/** The S400 measuring ONE step-on twice: a second S400 BLE reading within
 *  REMEASURE_MS and REMEASURE_KG of another (its own scale timestamp, so not
 *  the same instant). One counts: the more complete one (fat or impedance),
 *  else the first. Re-decided on every pass, like the same-instant rule. */
const EXCL_REMEASURED = 'same weigh-in, re-measured'
const REMEASURE_MS = 60_000
const REMEASURE_KG = 0.2
/** The date rule's own prefix: a weighins_from change re-decides exactly these. */
const EXCL_DATE_RULE = `${EXCL_TEST}before the first fasted weigh-in`
/** The friend rule (housemates use his S400, which has no Visitor mode): a
 *  reading more than NOT_HIS_KG from his ANCHOR (walkNotHis: his most recent
 *  trusted weigh-in before it) is filed as someone else's. Re-decided on
 *  every pass; a manual include always wins and anchors the readings after
 *  it (the escape for a genuine shift past 4 kg). That escape is manual on
 *  purpose (the body.weighin line invites the reply): an automatic one, such
 *  as two agreeing days, would also let in a housemate who weighs twice a
 *  week. */
export const EXCL_NOT_HIS = 'not his (weight outlier)'
const NOT_HIS_KG = 4.0
/** An anchor older than this decides nothing (a long trip). */
const NOT_HIS_ANCHOR_MS = 30 * 86_400_000
/** With no anchor yet: his readings this far AFTER it may decide. */
const NOT_HIS_LOOKAHEAD_MS = 7 * 86_400_000
/** The weigh-in rules re-decide this far back (~13 months). */
const RULES_WINDOW_MS = 400 * 86_400_000
/** A hand reason that SAYS the reading is someone else's: the phrase opens
 *  the reason and ends there (or at punctuation, or "... weighed / reading /
 *  stepped on"). A loose word inside a reason ("after dinner at a friend's",
 *  "guest bathroom scale", "not me being honest, ate late", "not his usual
 *  wake time") never files it. */
const NOT_HIS_TEXT =
  /^\s*(not (his|him|mine|me)|someone else('s)?|(an)?other person('s)?|(a |my |his )?(friend|housemate|roommate|guest|visitor)('s)?)(\s+(weigh\w*|reading|stepped\b.*|on (the|my|his) scale)|\s*[,.;:!()-]|\s*$)/i
/** Filed as someone else's: the friend rule's exact verdict, or a hand
 *  exclusion whose reason SAYS so (NOT_HIS_TEXT). The older outlier rule
 *  ("possible other person") is a softer verdict, but pairing and
 *  calibration skip both (mayNotBeHis). */
export function filedAsNotHis(reason: string | null): boolean {
  if (reason == null || reason.startsWith(EXCL_OUTLIER)) return false
  return reason === EXCL_NOT_HIS || NOT_HIS_TEXT.test(reason)
}
/** Either not-his verdict: such a reading is never his anchor and its
 *  values are masked on the Body tab. */
export function mayNotBeHis(reason: string | null): boolean {
  return reason != null && (reason.startsWith(EXCL_OUTLIER) || filedAsNotHis(reason))
}
/** The marker a hand reason worded like an automatic verdict carries
 *  (setWeighin), so no rule ever mistakes it for its own and lifts or
 *  replaces it. */
const BY_HAND = '(by hand)'
function byHand(reason: string | null): boolean {
  return reason != null && reason.endsWith(BY_HAND)
}
/** day.body: exclusions that still mean HIS body (timing, not identity). */
const BODY_OK_EXCLUSIONS = new Set([EXCL_NOT_MORNING, EXCL_REPEAT, EXCL_AFTER_MEAL, EXCL_REPLAY, EXCL_SAME_INSTANT, EXCL_REMEASURED])
/** Verdicts that still mean HIS body (counted, or excluded only for timing
 *  or a test: the date rule and BODY_OK_EXCLUSIONS): such a reading is
 *  trusted as an anchor. */
function timingVerdict(reason: string | null): boolean {
  if (byHand(reason)) return false
  return reason == null || reason.startsWith(EXCL_DATE_RULE) || BODY_OK_EXCLUSIONS.has(reason)
}
/** Verdicts the friend rule may replace (and gives back when lifted): its
 *  own and the timing ones. Hand verdicts (any "(by hand)" reason included)
 *  and the outlier rule's are kept. */
function notHisCandidate(reason: string | null): boolean {
  return reason === EXCL_NOT_HIS || timingVerdict(reason)
}
/** A HAND verdict that the reading is someone else's (a reason that says
 *  so, or the rule's words with "(by hand)"), never the rule's own. */
function handNotHis(reason: string | null): reason is string {
  return reason != null && reason !== EXCL_NOT_HIS && filedAsNotHis(reason)
}

/** One stored mass reading for the friend rule's walk (t = Date.parse(ts),
 *  parsed once; was = its stored verdict). */
export type NotHisRow = { uuid: string; ts: string; t: number; value: number; source: string | null; was: string | null }

/** Instants he counted by hand: a manual include on any source's copy
 *  covers the whole weigh-in. */
function reclaimedInstants(masses: ReadonlyArray<NotHisRow>, manual: ReadonlySet<string>): Set<string> {
  const out = new Set<string>()
  for (const m of masses) if (manual.has(m.uuid)) out.add(m.ts)
  return out
}
/** Instants he disowned by hand (ts -> that hand reason, the first copy's):
 *  the mirror of reclaimedInstants. A hand verdict that one source's copy is
 *  someone else's covers every source's copy of that weigh-in, including
 *  one that syncs later. A manual include at the same instant wins. */
export function disownedInstants(
  masses: ReadonlyArray<NotHisRow>,
  manual: ReadonlySet<string>,
  reclaimed: ReadonlySet<string> = reclaimedInstants(masses, manual),
): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of masses) if (handNotHis(m.was) && !reclaimed.has(m.ts) && !out.has(m.ts)) out.set(m.ts, m.was)
  return out
}

/** The friend rule's walk: ONE pass over `masses` (sorted by
 *  compareWeighins: ts, S400 BLE first, uuid), carrying his ANCHOR forward.
 *  The anchor for a reading = his most recent TRUSTED weigh-in before its
 *  instant, within NOT_HIS_ANCHOR_MS: a manual include (every source's copy
 *  of that weigh-in), a reading this walk kept, or one older than `sinceMs`
 *  whose stored verdict is a timing one. Never a not-his or hand-excluded
 *  one. A reading more than NOT_HIS_KG from the anchor is filed; within it,
 *  it becomes the new anchor (a slow trend follows him).
 *  Bootstrapping: an anchor nothing ever corroborated (his first reading, or
 *  the first after a gap past NOT_HIS_ANCHOR_MS) is WEAK: it never files
 *  anything on its own. With no strong anchor, a reading is judged against
 *  the readings in the NOT_HIS_LOOKAHEAD_MS after it, only when 2+ of them
 *  exist and all agree within NOT_HIS_KG (a housemate's reading with nothing
 *  before it is filed once his own follow); else agreeing with the weak
 *  anchor makes it strong, disagreeing leaves both undecided.
 *  Only rows at or after `sinceMs` with a candidate verdict are decided;
 *  older rows are anchors by their stored verdict, never re-decided. A
 *  weigh-in he disowned by hand (disownedInstants) is skipped in EVERY
 *  source's copy: never judged, never an anchor.
 *  Returns the filed uuids, each with how far it sits from its reference,
 *  and the disowned instants it skipped (so the caller never recomputes
 *  them). */
export function walkNotHis(
  masses: ReadonlyArray<NotHisRow>,
  sinceMs: number,
  manual: ReadonlySet<string>,
): { filed: Map<string, number>; disowned: Map<string, string> } {
  const reclaimed = reclaimedInstants(masses, manual)
  const disowned = disownedInstants(masses, manual, reclaimed)
  // mine = he counted this weigh-in by hand; fixed = older than the walk
  // window; judge = this walk decides it; skip = a hand or outlier verdict,
  // or another source's copy of a weigh-in he said was someone else's.
  const roles = masses.map((m) =>
    reclaimed.has(m.ts) ? 'mine' : disowned.has(m.ts) ? 'skip' : m.t < sinceMs ? 'fixed' : notHisCandidate(m.was) ? 'judge' : 'skip',
  )
  // Only a reading that could COUNT may anchor: measured in the morning
  // window or the late fasted band. The date rule's tests anchor at any hour
  // (his deliberate readings before the protocol began: day one's afternoon
  // tests corroborate each other into the first strong anchor). An evening
  // "not a morning reading" is still judged (and filed when far off) but
  // never anchors and never corroborates a look-ahead: housemates weigh in at
  // night, and Nov 20 a housemate's 80.2 kg at 19:17 (3.8 kg off, so not
  // filed) became the anchor and filed his fasted 85.0 the next morning.
  const anchorable = (m: NotHisRow) =>
    inMorningWindow(m.t) || inLateFastedBand(m.t) || (m.was != null && m.was.startsWith(EXCL_DATE_RULE))
  const lookAhead = (from: number, t: number): number | null => {
    let first: number | null = null, lo = Infinity, hi = -Infinity, n = 0, lastTs = ''
    for (let k = from; k < masses.length && masses[k].t <= t + NOT_HIS_LOOKAHEAD_MS; k++) {
      if (roles[k] === 'skip' || masses[k].ts === lastTs || !anchorable(masses[k])) continue
      lastTs = masses[k].ts
      const v = masses[k].value
      if (first == null) first = v
      lo = Math.min(lo, v)
      hi = Math.max(hi, v)
      n++
    }
    return n >= 2 && hi - lo <= NOT_HIS_KG ? first : null
  }
  type Anchor = { t: number; v: number; strong: boolean }
  const filed = new Map<string, number>()
  let anchor = null as Anchor | null
  for (let i = 0; i < masses.length; ) {
    // One instant at a time: two sources' copies of one weigh-in are judged
    // against the same anchor and never corroborate each other.
    let j = i
    while (j < masses.length && masses[j].ts === masses[i].ts) j++
    const t = masses[i].t
    const a: Anchor | null = anchor != null && anchor.t >= t - NOT_HIS_ANCHOR_MS ? anchor : null
    let next = null as Anchor | null
    for (let k = i; k < j; k++) {
      const m = masses[k]
      let strong: boolean | null = null // null = not trusted
      if (roles[k] === 'mine') strong = true
      else if (roles[k] === 'fixed') strong = timingVerdict(m.was) && anchorable(m) ? true : null
      else if (roles[k] === 'judge') {
        const ref = a?.strong ? a.v : lookAhead(j, t)
        if (ref != null) {
          const off = Math.abs(m.value - ref)
          if (off > NOT_HIS_KG) filed.set(m.uuid, off)
          else strong = true
        } else strong = a != null && Math.abs(m.value - a.v) <= NOT_HIS_KG
        if (!anchorable(m)) strong = null
      }
      if (strong != null && (next == null || (strong && !next.strong))) next = { t, v: m.value, strong }
    }
    if (next) anchor = next
    i = j
  }
  return { filed, disowned }
}
/** Derived verdicts every re-classification pass lifts and re-decides. */
const REDECIDED_EXCLUSIONS = [EXCL_AFTER_MEAL, EXCL_REPLAY, EXCL_SAME_INSTANT, EXCL_REMEASURED]
/** Every automatic verdict (or its prefix: the test and date rules): a hand
 *  reason that opens with one is stored with BY_HAND. */
const AUTO_VERDICTS = [EXCL_TEST, EXCL_NOT_MORNING, EXCL_REPEAT, EXCL_OUTLIER, EXCL_NOT_HIS, ...REDECIDED_EXCLUSIONS]
/** weighin_pair: a value further than this many fit units (METRICS fitUnit:
 *  1 fat point, 1 kg, 0.1 kg bone, 15 kcal) from the formula is refused
 *  without force:true. */
const IMPLAUSIBLE_FIT_UNITS = 10
/** Replay guard tolerance: identical to the scale's resolution. */
const REPLAY_KG = 0.005
const REPLAY_FAT = 0.00005
/** S400 against S400: the raw open-formula fat % at 2 dp. */
const REPLAY_RAW_PCT = 0.005
const CAL_META = 'food_energy_calibration'
const GOAL_META = 'food_goal'
/** The outlier rule: active from 3 included readings; a reading further from
 *  the latest included one than 2.5 kg + 0.3 kg per day elapsed (capped at
 *  5 kg) is probably someone else on the scale (no Visitor mode). */
const OUTLIER_MIN_N = 3
const OUTLIER_BASE_KG = 2.5
const OUTLIER_PER_DAY_KG = 0.3
const OUTLIER_CAP_KG = 5

export function outlierLimitKg(daysGap: number): number {
  return Math.min(OUTLIER_BASE_KG + OUTLIER_PER_DAY_KG * Math.max(0, daysGap), OUTLIER_CAP_KG)
}

/** The weigh-in walk order: time, then the S400 BLE copy of a shared
 *  instant first, then uuid. Total and deterministic, so which copy of a
 *  same-instant weigh-in counts never depends on storage order. */
function compareWeighins(a: { ts: string; uuid: string; source: string | null }, b: { ts: string; uuid: string; source: string | null }): number {
  if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1
  const sa = a.source === SCALE_SOURCE ? 0 : 1
  const sb = b.source === SCALE_SOURCE ? 0 : 1
  if (sa !== sb) return sa - sb
  return a.uuid < b.uuid ? -1 : a.uuid > b.uuid ? 1 : 0
}

/** A real shift, not a visitor: an earlier outlier on ANOTHER day within
 *  the last 3 days that agrees with this one (within 1 kg). */
const SHIFT_AGREE_KG = 1
const SHIFT_LOOKBACK_MS = 3 * 86_400_000

function isOutlier(book: MealBook, m: { ts: string; value?: number }): boolean {
  if (m.value == null) return false
  if (book.includedMassCountBefore(m.ts) < OUTLIER_MIN_N) return false
  const prev = book.previousMass(m.ts)
  if (!prev) return false
  const days = (Date.parse(m.ts) - Date.parse(prev.ts)) / 86_400_000
  if (Math.abs(m.value - prev.value) <= outlierLimitKg(days)) return false
  const ms = Date.parse(m.ts)
  const day = foodDay(ms, 0)
  const agree = book
    .outlierMassBetween(new Date(ms - SHIFT_LOOKBACK_MS).toISOString(), m.ts)
    .some((o) => foodDay(Date.parse(o.ts), 0) !== day && Math.abs(o.value - m.value!) <= SHIFT_AGREE_KG)
  return !agree
}
/** The morning window, local minutes: 03:30 to 09:00. */
const MORNING_FROM_MIN = 3 * 60 + 30
const MORNING_TO_MIN = 9 * 60
/** Where the fasted check starts looking for a meal before a reading: the
 *  later of the reading's food-day start and its own morning (local 03:30).
 *  A 03:45 reading sits on the PREVIOUS food day (04:00 rollover), but last
 *  night's dinner never makes it "after a meal". */
export function fastedFromMs(ms: number, rolloverHour: number): number {
  const d = new Date(ms)
  const morning = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, MORNING_FROM_MIN).getTime()
  const dayStart = dayBounds(foodDay(ms, rolloverHour), rolloverHour).start
  return Math.max(dayStart, morning > ms ? morning - 86_400_000 : morning)
}

const MANUAL_INCLUDE_META = 'weighin_manual_include'
/** Per-metric body-composition models (JSON {metric: CalModel}); fat keeps
 *  its own record (scalecal CAL_META). */
export const METRIC_CAL_META = 'scale_metric_calibration'
/** day.body looks this far back for the latest S400 weigh-in. */
const DAY_BODY_WINDOW_MS = 7 * 86_400_000
/** Metrics with their own calibration (fat has scalecal's; bmi has none). */
const CALIBRATED_METRICS: readonly MetricKey[] = PAIRABLE_METRICS.filter((k) => k !== 'fat_pct' && k !== 'bmi')

/** "Creatine start" -> "creatine_start": the one spelling add and close share. */
function normKind(k: unknown): string {
  return typeof k === 'string' ? k.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) : ''
}
function dayStartIso(ms: number): string {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString()
}
/** The next local midnight after ms (the exclusive end of its day). */
function dayEndIso(ms: number): string {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).toISOString()
}
export function inMorningWindow(ms: number): boolean {
  const d = new Date(ms)
  const min = d.getHours() * 60 + d.getMinutes()
  return min >= MORNING_FROM_MIN && min < MORNING_TO_MIN
}
/** Past the morning window but before 14:00 local: a late first reading
 *  still counts when no meal was eaten before it (he went back to sleep
 *  after fajr). The fasted check then decides it: a meal before it, even one
 *  logged later, files it "after a meal" (re-decided on every pass, so a
 *  voided or re-timed meal lifts it again). */
const LATE_FASTED_TO_MIN = 14 * 60
export function inLateFastedBand(ms: number): boolean {
  const d = new Date(ms)
  const min = d.getHours() * 60 + d.getMinutes()
  return min >= MORNING_TO_MIN && min < LATE_FASTED_TO_MIN
}

const WEIGHIN_RECENT_MS = 36 * 3_600_000
const WEIGHIN_MAX_PER_BATCH = 3

/** "Weigh-in 05:02 WIB: 75.0 kg, 20.0% fat (Synthetic Scale). Previous: 75.5 kg
 *  on Sun 16 Nov 13:56 (-0.5 kg)." Minimal by design: the energy-balance
 *  release upgrades the same class with the 7-day trend and confounders. */
export function weighinEvent(
  m: { ts: string; value: number; source: string | null },
  fat: { value: number } | null,
  prev: { ts: string; value: number } | null,
  excluded: string | null = null,
  extras: {
    avg7?: { kg: number; n: number; delta_kg: number | null } | null
    confounders?: string | null
    /** S400 fat provenance: replaces the bare source in the parenthetical. */
    fatCalibration?: FatProvenance | null
    /** S400 body composition (visceral + muscle), one compact line. */
    body?: { line: string; visceral?: number; muscle_kg?: number } | null
    /** The friend rule: how far this reading sits from his anchor. */
    notHisOffKg?: number | null
  } = {},
): { content: string; meta: Record<string, string> } {
  const t = new Date(m.ts)
  // The zone label is only claimed when true (the Mac on WIB, UTC+7).
  const hhmm = `${t.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}${t.getTimezoneOffset() === -420 ? '' : ' local'}`
  const kg = m.value.toFixed(1)
  const fatPct = fat ? (fat.value * 100).toFixed(1) : null
  const src = m.source ?? 'unknown source'
  const cal = fatPct && extras.fatCalibration ? extras.fatCalibration : undefined
  const srcText = cal !== undefined ? calibrationNote(cal) : src
  let content = `Weigh-in ${hhmm.endsWith(' local') ? hhmm : `${hhmm} WIB`}: ${kg} kg${fatPct ? `, ${fatPct}% fat` : ''} (${srcText}).`
  if (excluded) {
    content += excluded.startsWith(EXCL_TEST)
      ? ` Test reading, excluded (${excluded.slice(EXCL_TEST.length)}).`
      : excluded === EXCL_NOT_MORNING
        ? ' Not a morning reading, excluded from the trend.'
        : excluded === EXCL_REPEAT
          ? ' Repeat reading this morning, excluded from the trend (the first one counts).'
          : excluded === EXCL_SAME_INSTANT
            ? ' The same weigh-in as another source\'s copy at this instant, counted once (from the other copy).'
          : excluded === EXCL_REMEASURED
            ? ' The scale measured the same step-on twice, counted once (from the other reading).'
          : excluded === EXCL_NOT_HIS
            ? ` ${kg} kg is ${extras.notHisOffKg != null ? `${extras.notHisOffKg.toFixed(1)} kg` : 'far'} off your recent weigh-ins, so it is filed as someone else's; reply if it was you.`
          : excluded === EXCL_OUTLIER
            ? ` ${prev ? `${Math.abs(m.value - prev.value).toFixed(1)} kg off your last reading, likely` : 'Likely'} someone else; excluded. Reply if it was you.`
            : excluded === EXCL_AFTER_MEAL
              ? ' Taken after a meal logged this food day, excluded from the trend (not fasted).'
              : excluded === EXCL_REPLAY
                ? ' Identical to the previous reading in both weight and fat, possibly a re-synced copy; excluded. Reply if it was a real weigh-in.'
                : ` Excluded from the trend (${excluded}).`
  } else if (prev) {
    const d = m.value - prev.value
    const when = new Date(prev.ts).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    content += ` Previous: ${prev.value.toFixed(1)} kg on ${when} (${d >= 0 ? '+' : '-'}${Math.abs(d).toFixed(1)} kg).`
  } else {
    content += ' First reading on record.'
  }
  if (!excluded && inLateFastedBand(Date.parse(m.ts))) {
    content += ' Counted as a late fasted reading (no meal logged before it); log an earlier meal and it drops out.'
  }
  const a = excluded ? null : extras.avg7
  if (a) {
    const d = a.delta_kg
    content += ` 7-day average ${a.kg.toFixed(1)} kg over ${a.n} readings${d != null ? ` (${d >= 0 ? '+' : '-'}${Math.abs(d).toFixed(1)} kg vs the 7 days before)` : ''}.`
  }
  const conf = excluded ? null : extras.confounders
  if (conf) content += ` Confounders: ${conf}.`
  const body = extras.body ?? null
  if (body) content += `\n${body.line}`
  const meta: Record<string, string> = { kg, measured_at: m.ts, source: src }
  if (fatPct) meta.fat_pct = fatPct
  if (cal !== undefined) {
    meta.fat_calibration = cal.status
    meta.calibration_pairs = String(cal.n)
    if (cal.rms_pct != null) meta.calibration_rms_pct = cal.rms_pct.toFixed(2)
  }
  if (excluded) meta.excluded = excluded
  if (a) {
    meta.avg7_kg = a.kg.toFixed(1)
    meta.avg7_n = String(a.n)
    if (a.delta_kg != null) meta.avg7_delta_kg = a.delta_kg.toFixed(1)
  }
  if (conf) meta.confounders = conf
  if (body?.visceral != null) meta.visceral = String(Math.round(body.visceral))
  if (body?.muscle_kg != null) meta.muscle_kg = body.muscle_kg.toFixed(1)
  return { content, meta }
}

const fmtK = (n: number | null | undefined) => (n == null ? '?' : Math.round(n).toLocaleString('en-US'))
const fmtG = (n: number | null | undefined) => (n == null ? '?' : `${Math.round(n)} g`)

/** "1,335 kcal (1,200-1,500)" or just "1,335 kcal" when the range is a point. */
export function kcalText(k: number | null, lo: number | null, hi: number | null): string {
  if (k == null) return '? kcal'
  if (lo == null || hi == null || (Math.round(lo) === Math.round(k) && Math.round(hi) === Math.round(k)))
    return `${fmtK(k)} kcal`
  return `${fmtK(k)} kcal (${fmtK(lo)}-${fmtK(hi)})`
}

export interface BaselineReport extends Baseline {
  /** provisional = a confounder window is open; collecting = not ready; ready. */
  status: 'provisional' | 'collecting' | 'ready'
  status_reason: string | null
  /** Bracket-central maintenance minus the deficit, while provisional
   *  (accept:true takes it; never applied without that). */
  provisional_suggested_target: number | null
  /** After every window closed: the clean fit uses days from here on. */
  clean_from: string | null
  bracket: Bracket | null
  early_slope: ReturnType<typeof earlySlope>
  confounders: ConfounderView[]
  energy: {
    calibrated: boolean
    factor: number | null
    factor_lo: number | null
    factor_hi: number | null
    calibration: Calibration | null
    /** Why there is no (new) factor, e.g. too few covered days or an
     *  implausible value; null when the factor stands. */
    calibration_issue: string | null
    /** Mean WHOOP burn over the window's fully covered days. */
    burn_kcal: number | null
    burn_days: number
    coverage: ReturnType<typeof exclusionStats>
    days: Array<{
      date: string
      intake_kcal: number | null
      complete: boolean
      burn_kcal: number | null
      coverage: DayEnergy['coverage']
      reason: DayBurn['reason']
      balance_kcal: number | null
      balance_lo: number | null
      balance_hi: number | null
      so_far: boolean
      note: string | null
    }>
  }
  goal: GoalView | null
}

/** A ScaleRaw from the scale leg, sanity-checked (null = dropped). */
function cleanScaleRaw(r: unknown): ScaleRaw | null {
  if (typeof r !== 'object' || r == null) return null
  const o = r as Record<string, unknown>
  const fin = (v: unknown, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : null)
  const uuid = typeof o.uuid === 'string' && o.uuid.length >= 6 && o.uuid.length <= 62 ? o.uuid : null
  const t = typeof o.measured_at === 'string' ? Date.parse(o.measured_at) : NaN
  const kg = fin(o.kg, 20, 400)
  if (!uuid || !Number.isFinite(t) || kg == null) return null
  return {
    uuid,
    measured_at: new Date(t).toISOString(),
    kg,
    impedance_low: fin(o.impedance_low, 0, 5000),
    impedance_high: fin(o.impedance_high, 0, 5000),
    hr: fin(o.hr, 20, 250),
    scale_ts: fin(o.scale_ts, 0, 0xffffffff),
    fat_raw_pct: fin(o.fat_raw_pct, 1, 80),
  }
}

export class FoodService {
  readonly book: MealBook
  readonly confounders: ConfounderBook
  readonly scaleCal: ScaleCalBook
  private now: () => number
  private log: (msg: string) => void
  /** The last friend-rule walk's filed readings: uuid -> kg off its reference. */
  private notHisOff = new Map<string, number>()

  constructor(private deps: FoodDeps) {
    this.book = new MealBook(deps.db)
    this.confounders = new ConfounderBook(deps.db)
    this.scaleCal = new ScaleCalBook(deps.db)
    this.now = deps.now ?? Date.now
    this.log = deps.log ?? (() => {})
  }

  // ── time ────────────────────────────────────────────────────────

  today(): string {
    return foodDay(this.now(), this.deps.getConfig().rollover_hour)
  }

  /**
   * When a meal was eaten. ISO (with offset) or local "HH:MM" (today; a time
   * still ahead of now means last night). Bounded to the last 14 days, so a
   * typo cannot file a meal into a year that never happened.
   */
  parseAt(v: unknown): { iso: string; date: string } | null {
    if (v == null || v === '') return null
    const now = this.now()
    let t: number
    if (typeof v === 'string' && /^\d{1,2}:\d{2}$/.test(v.trim())) {
      const [h, m] = v.trim().split(':').map(Number)
      if (h > 23 || m > 59) throw new Error(`bad time "${v}"`)
      const d = new Date(now)
      d.setHours(h, m, 0, 0)
      if (d.getTime() > now + 5 * 60_000) d.setDate(d.getDate() - 1)
      t = d.getTime()
    } else if (typeof v === 'string') {
      t = Date.parse(v)
      if (!Number.isFinite(t)) throw new Error(`bad timestamp "${v}" (ISO 8601 or HH:MM)`)
    } else {
      throw new Error('at must be an ISO timestamp or HH:MM')
    }
    if (t > now + 60 * 60_000) throw new Error('at is in the future')
    if (t < now - 14 * 86_400_000) throw new Error('at is more than 14 days ago')
    return { iso: new Date(t).toISOString(), date: foodDay(t, this.deps.getConfig().rollover_hour) }
  }

  // ── photos ──────────────────────────────────────────────────────

  private photoPaths(meal: { id: number; date: string }, n: number) {
    const dir = join(this.deps.photosDir, meal.date)
    return { path: join(dir, `${meal.id}-${n}.jpg`), thumb: join(dir, `${meal.id}-${n}.thumb.jpg`) }
  }

  private async attachPhotos(meal: { id: number; date: string }, srcs: Array<string | Uint8Array>): Promise<void> {
    const start = this.book.nextPhotoIdx(meal.id)
    for (let k = 0; k < srcs.length; k++) {
      const { path, thumb } = this.photoPaths(meal, start + k)
      await ingestPhoto(srcs[k], path, thumb)
      this.book.addPhoto(meal.id, start + k, path, thumb)
    }
  }

  /** Undo a half-ingested meal: its photo files and its rows. */
  private discard(meal: { id: number; date: string }): void {
    for (let n = 0; n < MAX_PHOTOS_PER_MEAL * 2; n++) {
      const { path, thumb } = this.photoPaths(meal, n)
      rmSync(path, { force: true })
      rmSync(thumb, { force: true })
    }
    this.book.deleteMeal(meal.id)
  }

  // ── front door 1: the phone ─────────────────────────────────────

  private inflight = new Map<string, Promise<{ meal_id: number; duplicate: boolean; date: string }>>()

  /** POST /meal. Idempotent on client_id: a retried upload returns the same
   *  meal, and a retry that races the first upload's photo ingest waits for
   *  it (and shares its failure) instead of reporting a meal that may yet be
   *  discarded. */
  async logFromApp(body: Record<string, unknown>): Promise<{ meal_id: number; duplicate: boolean; date: string }> {
    return singleFlight(this.inflight, requireClientId(body), {
      done: (id) => {
        const existing = this.book.getByClientId(id)
        return existing ? { meal_id: existing.id, duplicate: true, date: existing.date } : null
      },
      run: (id) => this.ingestAppMeal(id, body),
    })
  }

  private async ingestAppMeal(
    clientId: string,
    body: Record<string, unknown>,
  ): Promise<{ meal_id: number; duplicate: boolean; date: string }> {

    const note = cleanNote(body.note)
    const photos = decodePhotos(body)
    if (!note && photos.length === 0) throw new BadRequest('a meal needs a photo or a note')
    const nowIso = new Date(this.now()).toISOString()
    let eaten: { iso: string; date: string }
    try {
      eaten = this.parseAt(body.eaten_at ?? body.captured_at) ?? { iso: nowIso, date: this.today() }
    } catch (err) {
      throw new BadRequest((err as Error).message)
    }

    const id = this.book.insertMeal({
      client_id: clientId,
      source: 'app',
      logged_at: nowIso,
      eaten_at: eaten.iso,
      date: eaten.date,
      note,
    })
    try {
      await this.attachPhotos({ id, date: eaten.date }, photos)
    } catch (err) {
      this.discard({ id, date: eaten.date })
      throw err
    }
    const meal = this.book.getMeal(id)!
    this.afterMealWrite()
    this.deps.emit('meal.logged', `meal.logged:${id}`, this.loggedEvent(meal))
    this.changed(meal.date)
    this.log(`meal #${id} logged from the app (${photos.length} photo(s), note=${note ? 'yes' : 'no'})`)
    return { meal_id: id, duplicate: false, date: meal.date }
  }

  /** POST /meal/fix: a correction line typed on the phone. */
  fixFromApp(body: Record<string, unknown>): { ok: true } {
    const id = Number(body.meal_id)
    const text = cleanNote(body.text)
    if (!Number.isInteger(id) || id <= 0) throw new BadRequest('meal_id is required')
    if (!text) throw new BadRequest('text is required')
    const meal = this.book.getMeal(id)
    if (!meal) throw new BadRequest(`no meal #${id}`)
    if (meal.status === 'void') throw new BadRequest(`meal #${id} was removed`)
    // Same line re-sent (outbox retry) = same fix, not a second event.
    if (meal.fix_text === text) return { ok: true }
    const at = new Date(this.now()).toISOString()
    this.book.setFix(id, text, at)
    const updated = this.book.getMeal(id)!
    this.deps.emit('meal.amended', `meal.amended:${id}:${at}`, this.amendedEvent(updated, text))
    this.changed(meal.date)
    return { ok: true }
  }

  private photoAdds = new Map<string, Promise<{ meal_id: number; added: number; total: number; duplicate: boolean }>>()

  /** POST /meal/photos: more photos for a meal already logged (from the
   *  phone's meal detail). Idempotent on client_id (one per add action, the
   *  outbox reuses it on retry); at most MAX_PHOTOS_PER_MEAL photos per meal
   *  in total; a half-ingested batch is undone. Claude gets a meal.amended
   *  event with the new photos to re-estimate from. */
  async addPhotosFromApp(body: Record<string, unknown>): Promise<{ meal_id: number; added: number; total: number; duplicate: boolean }> {
    return singleFlight(this.photoAdds, requireClientId(body), {
      done: (id) => {
        const raw = this.deps.getMeta(`${PHOTO_ADD_META}${id}`)
        if (!raw) return null
        const d = JSON.parse(raw) as { meal_id: number; added: number }
        return { meal_id: d.meal_id, added: d.added, total: this.book.photoCount(d.meal_id), duplicate: true }
      },
      run: (id) => this.ingestPhotoAdd(id, body),
    })
  }

  private async ingestPhotoAdd(
    clientId: string,
    body: Record<string, unknown>,
  ): Promise<{ meal_id: number; added: number; total: number; duplicate: boolean }> {
    const id = Number(body.meal_id)
    if (!Number.isInteger(id) || id <= 0) throw new BadRequest('meal_id is required')
    const meal = this.book.getMeal(id)
    if (!meal) throw new BadRequest(`no meal #${id}`)
    if (meal.status === 'void') throw new BadRequest(`meal #${id} was removed`)
    const photos = decodePhotos(body)
    if (photos.length === 0) throw new BadRequest('photos are required')
    const have = this.book.photoCount(id)
    if (have + photos.length > MAX_PHOTOS_PER_MEAL) {
      throw new BadRequest(`meal #${id} has ${have} photo(s); at most ${MAX_PHOTOS_PER_MEAL} per meal`)
    }
    const start = this.book.nextPhotoIdx(id)
    try {
      await this.attachPhotos(meal, photos)
    } catch (err) {
      for (let n = start; n < start + photos.length; n++) {
        const { path, thumb } = this.photoPaths(meal, n)
        rmSync(path, { force: true })
        rmSync(thumb, { force: true })
      }
      this.book.deletePhotosFrom(id, start)
      throw err
    }
    this.deps.setMeta(`${PHOTO_ADD_META}${clientId}`, JSON.stringify({ meal_id: id, added: photos.length }))
    const updated = this.book.getMeal(id)!
    this.deps.emit('meal.amended', `meal.amended:${id}:photos:${clientId}`, this.photosAddedEvent(updated, photos.length))
    this.changed(updated.date)
    this.log(`meal #${id}: ${photos.length} photo(s) added from the app (${updated.photos.length} total)`)
    return { meal_id: id, added: photos.length, total: updated.photos.length, duplicate: false }
  }

  /** GET /meals/history?days=N: the PAST food days (today excluded: the Food
   *  tab is today) of the last N that have a meal, newest first, each with its intake (estimated meals only), today's targets
   *  (targets are not versioned, so a past day is read against the current
   *  ones), counts, a cover thumbnail and completeness. */
  history(rawDays: unknown) {
    const n = Number(rawDays ?? HISTORY_DEFAULT_DAYS)
    const days = Number.isInteger(n) && n >= 1 ? Math.min(n, HISTORY_MAX_DAYS) : HISTORY_DEFAULT_DAYS
    const today = this.today()
    const cfg = this.deps.getConfig()
    const kcalTarget = this.targetKcal()
    return {
      today,
      days: this.book.historyDays(addDays(today, -days), today).map((d) => ({
        date: d.date,
        kcal: d.kcal,
        kcal_target: kcalTarget,
        protein_g: d.protein_g,
        protein_target_g: cfg.protein_target_g,
        meals: d.meals,
        photos: d.photos,
        cover_thumb_url: d.cover ? `/meal-photo?meal=${d.cover.meal_id}&n=${d.cover.idx}&thumb=1` : null,
        complete: d.complete,
      })),
    }
  }

  // ── front door 2: chat (health__meal) ───────────────────────────

  /**
   * Chat's log. Photos arrive ONLY as `photo_data` (base64 bytes, read by
   * readPhotoFiles in the MCP server, inside the user's own session). The
   * launchd daemon must never be the process that opens files in the user's
   * folders: macOS privacy control (TCC) parks that open() behind a consent
   * prompt nobody sees, and the request hangs forever (found live on the
   * first real backfill, Nov 16).
   */
  async logFromChat(p: Record<string, unknown>): Promise<Meal> {
    const note = cleanNote(p.note)
    if (p.photos != null) throw new Error('photos must arrive as photo_data bytes (health__meal converts paths in your session)')
    const photoSrcs = p.photo_data == null ? [] : decodePhotos({ photos: p.photo_data })
    const items = p.items == null ? null : normalizeItems(p.items, (s) => this.book.getPreset(s))
    if (!items && !note && photoSrcs.length === 0) throw new Error('log needs items, a note, or photos')
    const nowIso = new Date(this.now()).toISOString()
    const eaten = this.parseAt(p.at) ?? { iso: nowIso, date: this.today() }
    const id = this.book.insertMeal({
      client_id: null,
      source: 'chat',
      logged_at: nowIso,
      eaten_at: eaten.iso,
      date: eaten.date,
      note,
    })
    try {
      await this.attachPhotos({ id, date: eaten.date }, photoSrcs)
      if (items) {
        this.book.setItems(id, {
          label: labelOf(p.label, items),
          items,
          confidence: parseConfidence(p.confidence),
          reason: 'logged from chat',
          now: nowIso,
        })
      }
    } catch (err) {
      this.discard({ id, date: eaten.date })
      throw err
    }
    this.afterMealWrite()
    this.changed(eaten.date)
    return this.book.getMeal(id)!
  }

  /** A meal was logged, voided or re-timed: the fasted verdicts follow the
   *  meal log both ways (re-running the rules lifts and re-decides them).
   *  Never the friend walk: a meal cannot move it (it reads masses and
   *  identity verdicts; "after a meal" is a timing verdict like counting). */
  private afterMealWrite(): void {
    try {
      if (this.reclassifyWeighins({ friendRule: false })) this.recalibrateQuietly()
    } catch (err) {
      this.log(`weigh-in re-classification after a meal write failed: ${err}`)
    }
  }

  estimate(p: Record<string, unknown>): Meal {
    const id = Number(p.meal_id)
    if (!Number.isInteger(id) || id <= 0) throw new Error('meal_id is required')
    const before = this.book.getMeal(id)
    if (!before) throw new Error(`no meal #${id}`)
    const items = normalizeItems(p.items, (s) => this.book.getPreset(s))
    const eatenAt = this.parseAt(p.at)
    const expected = p.expected_revision == null ? null : Number(p.expected_revision)
    if (expected != null && !Number.isInteger(expected)) throw new Error('expected_revision must be an integer')
    this.book.setItems(id, {
      label: labelOf(p.label, items),
      items,
      confidence: parseConfidence(p.confidence),
      expectedRevision: expected,
      reason: typeof p.reason === 'string' ? p.reason.slice(0, 200) : null,
      eatenAt,
      now: new Date(this.now()).toISOString(),
    })
    const after = this.book.getMeal(id)!
    if (eatenAt) this.afterMealWrite()
    this.changed(before.date)
    if (after.date !== before.date) this.changed(after.date)
    return after
  }

  void(p: Record<string, unknown>): Meal {
    const id = Number(p.meal_id)
    if (!Number.isInteger(id) || id <= 0) throw new Error('meal_id is required')
    const reason = cleanNote(p.reason) ?? 'removed'
    this.book.voidMeal(id, reason)
    const meal = this.book.getMeal(id)!
    // A voided meal no longer makes a weigh-in "after a meal".
    this.afterMealWrite()
    this.changed(meal.date)
    return meal
  }

  presetSave(p: Record<string, unknown>): ReturnType<MealBook['getPreset']> {
    const name = typeof p.name === 'string' ? p.name.trim().slice(0, 80) : ''
    if (!name) throw new Error('name is required')
    const slug = slugify(typeof p.slug === 'string' && p.slug.trim() ? p.slug : name)
    if (!slug) throw new Error('slug is empty after normalising')
    // A preset is built from plain items only: nesting presets would let an
    // edit to one silently change the meaning of another.
    const raw = Array.isArray(p.items) ? p.items : []
    if (raw.some((i) => typeof i === 'object' && i != null && (i as Record<string, unknown>).preset)) {
      throw new Error('preset items must be plain items, not preset references')
    }
    const items = normalizeItems(raw, () => null)
    const aliases = Array.isArray(p.aliases)
      ? p.aliases.filter((a): a is string => typeof a === 'string' && a.trim().length > 0).map((a) => a.trim().slice(0, 60)).slice(0, 12)
      : []
    this.book.savePreset({ slug, name, aliases, items, now: new Date(this.now()).toISOString() })
    return this.book.getPreset(slug)
  }

  setDayComplete(p: Record<string, unknown>): { date: string; complete: boolean } {
    const date = isDayKey(p.date) ? p.date : this.today()
    const complete = p.complete !== false
    this.book.setDayComplete(date, complete, new Date(this.now()).toISOString())
    this.changed(date)
    return { date, complete }
  }

  // ── reads ───────────────────────────────────────────────────────

  /**
   * The baseline read: maintenance (intake vs weight trend), the confounder
   * status + bracket, the WHOOP calibration, and the goal record.
   * refreshCalibration: recompute + store the factor now (an explicit
   * recalibrate); otherwise the stored factor is reused for up to a week
   * (the weekly cadence), or until a provisional one outlives its window.
   */
  baseline(opts: { refreshCalibration?: boolean } = {}): BaselineReport {
    const cfg = this.deps.getConfig()
    const R = cfg.rollover_hour
    const today = this.today()
    const yesterday = addDays(today, -1)
    const fullFrom = addDays(today, -BASELINE_DEFAULTS.windowDays)
    const from = addDays(today, -BASELINE_DEFAULTS.windowDays - 1)
    const sinceIso = new Date(Date.parse(`${from}T00:00:00Z`) - 86_400_000).toISOString()
    const weights = this.book
      .bodySamplesSince(sinceIso)
      .filter((s) => s.kind === 'mass')
      .map((s) => ({ date: foodDay(Date.parse(s.ts), R), kg: s.value }))
    const intake = this.book.dailyIntake(from)

    // Confounders: any open window = PROVISIONAL. Once all are closed, the
    // clean estimate uses only days after the last one closed.
    const confs = this.confounderViews(today)
    const active = confs.filter((c) => c.status === 'active')
    const provisional = active.length > 0
    let windowDays = BASELINE_DEFAULTS.windowDays
    let cleanFrom: string | null = null
    const closedRecent = confs.filter((c) => c.status === 'closed' && c.window.to >= fullFrom)
    if (!provisional && closedRecent.length) {
      cleanFrom = addDays(closedRecent.map((c) => c.window.to).sort().at(-1)!, 1)
      windowDays = Math.max(0, Math.min(windowDays, daysBetween(cleanFrom, today)))
    }

    const dayList: string[] = []
    for (let d = fullFrom; d <= today; d = addDays(d, 1)) dayList.push(d)
    const burns = this.burnFor(dayList)
    const fullBurns = [...burns.values()]
      .filter((x) => x.coverage === 'full' && x.burn_kcal != null)
      .map((x) => ({ date: x.date, kcal: x.burn_kcal! }))
    const base = computeBaseline(intake, weights, fullBurns, {
      ...BASELINE_DEFAULTS,
      windowDays,
      today,
      deficitKcal: cfg.deficit_kcal,
    })

    // The bracket runs on the full window (the raw data the confounders bend).
    const bracketRecs = confs.filter((c) => c.bracket && c.date <= yesterday && c.date >= addDays(fullFrom, -56))
    const bracket = computeBracket(intake, weights, bracketRecs, { from: fullFrom, to: yesterday }, BASELINE_DEFAULTS.kcalPerKg)
    const activeBracketed = active.filter((c) => c.bracket).map((c) => c.date).sort()
    const early = provisional && activeBracketed.length ? earlySlope(weights, activeBracketed[0]) : null

    let status: BaselineReport['status']
    let reason: string | null = null
    if (provisional) {
      status = 'provisional'
      const binding = [...active].sort((x, y) => y.window.to.localeCompare(x.window.to))[0]
      reason = binding.label
    } else if (base.ready) {
      status = 'ready'
    } else {
      status = 'collecting'
      if (cleanFrom) reason = `clean fit on weigh-ins from ${cleanFrom} only (after the confounder windows): needs ${base.needs.join(', ')}`
    }

    // Calibration: the SAME complete, fully covered days as the maintenance.
    const fit = weightFit(weights, base.window.from, base.window.to)
    let slope: { central: number; lo: number; hi: number } | null = null
    if (provisional && bracket) {
      const c = bracket.central_slope_kg_per_day
      const se = bracket.central_se_kg_per_day
      slope = { central: c, lo: Math.min(c - se, bracket.slope_kg_per_day.lo), hi: Math.max(c + se, bracket.slope_kg_per_day.hi) }
    } else if (fit) {
      slope = { central: fit.slope, lo: fit.slope - fit.se, hi: fit.slope + fit.se }
    }
    const { cal, issue: calIssue } = this.calibration(
      () =>
        base.ready && slope
          ? calibrate({
              days: intake,
              burns,
              window: base.window,
              slope,
              kcalPerKg: BASELINE_DEFAULTS.kcalPerKg,
              provisional,
              nowIso: new Date(this.now()).toISOString(),
            })
          : { cal: null, issue: base.ready ? 'no weight trend to fit' : `baseline not ready: needs ${base.needs.join(', ')}` },
      provisional,
      opts.refreshCalibration === true,
    )

    const baselineDays = intake.filter((d) => d.date >= base.window.from && d.date <= base.window.to && d.complete && d.kcal > 0).map((d) => d.date)
    const byDate = new Map(intake.map((d) => [d.date, d]))
    const rows: BaselineReport['energy']['days'] = []
    for (const d of dayList) {
      const day = byDate.get(d)
      const burn = burns.get(d) ?? null
      if (!day && burn?.burn_kcal == null) continue
      const e = dayEnergy({
        date: d,
        today,
        intake: {
          kcal: day?.kcal ?? 0,
          kcal_lo: day?.kcal_lo ?? 0,
          kcal_hi: day?.kcal_hi ?? 0,
          estimated: day && day.kcal > 0 ? 1 : 0,
          pending: day?.pending ?? 0,
          complete: day?.complete ?? false,
        },
        burn,
        cal,
      })
      rows.push({
        date: d,
        intake_kcal: day ? Math.round(day.kcal) : null,
        complete: day?.complete ?? false,
        burn_kcal: e.burn_kcal,
        coverage: e.coverage,
        reason: burn?.reason ?? null,
        balance_kcal: e.balance_kcal,
        balance_lo: e.balance_lo,
        balance_hi: e.balance_hi,
        so_far: e.so_far,
        note: e.note,
      })
    }
    const meanBurn = fullBurns.filter((x) => x.date >= base.window.from && x.date <= base.window.to)

    return {
      ...base,
      suggested_target: provisional ? null : base.suggested_target,
      status,
      status_reason: reason,
      provisional_suggested_target:
        provisional && base.ready && bracket ? Math.round(bracket.central - cfg.deficit_kcal) : null,
      clean_from: cleanFrom,
      bracket,
      early_slope: early,
      confounders: confs,
      energy: {
        calibrated: cal != null,
        factor: cal?.factor ?? null,
        factor_lo: cal?.factor_lo ?? null,
        factor_hi: cal?.factor_hi ?? null,
        calibration: cal,
        calibration_issue: calIssue,
        burn_kcal: meanBurn.length ? Math.round(meanBurn.reduce((n, x) => n + x.kcal, 0) / meanBurn.length) : null,
        burn_days: meanBurn.length,
        coverage: exclusionStats(baselineDays, burns),
        days: rows,
      },
      goal: this.goal(confs),
    }
  }

  /** The stored factor while fresh (< 7 days, and not a provisional one
   *  outliving its confounder window); otherwise recompute and store. A
   *  failed recompute keeps the last good factor (a provisional one stays
   *  flagged provisional on every day it feeds). */
  private calibration(
    compute: () => { cal: Calibration | null; issue: string | null },
    provisional: boolean,
    refresh: boolean,
  ): { cal: Calibration | null; issue: string | null } {
    let stored: Calibration | null = null
    try {
      const raw = this.deps.getMeta(CAL_META)
      stored = raw ? (JSON.parse(raw) as Calibration) : null
      if (stored && !(typeof stored.factor === 'number' && stored.factor > 0)) stored = null
    } catch {
      stored = null
    }
    const fresh =
      stored != null && this.now() - Date.parse(stored.computed_at) < CALIBRATION_MAX_AGE_MS && !(stored.provisional && !provisional)
    if (fresh && !refresh) return { cal: stored, issue: null }
    const c = compute()
    if (c.cal) {
      this.deps.setMeta(CAL_META, JSON.stringify(c.cal))
      return c
    }
    return { cal: stored, issue: c.issue }
  }

  /** WHOOP burn mapped onto these food days (see energy.ts for the rules). */
  burnFor(days: string[]): Map<string, DayBurn> {
    if (!days.length) return new Map()
    const R = this.deps.getConfig().rollover_hour
    const first = [...days].sort()[0]
    const since = new Date(dayBounds(first, R).start - 3 * 86_400_000).toISOString()
    let cycles: CycleRec[] = []
    try {
      cycles = this.deps.whoopCyclesSince?.(since) ?? []
    } catch (err) {
      this.log(`whoop cycles read failed: ${err}`)
    }
    return burnByDay(cycles, days, { nowMs: this.now(), rolloverHour: R, today: this.today() })
  }

  /** Accept the suggested target (or an explicit one) as THE kcal budget.
   *  While the baseline is provisional, accept:true takes the bracket-central
   *  suggestion and the target is marked provisional. */
  acceptTarget(p: Record<string, unknown>): { target_kcal: number; maintenance: number | null; provisional: boolean; baseline: BaselineReport } {
    // The maintenance stored next to the target is the one it came from:
    // the bracket central while provisional, the measured one otherwise.
    const b = this.baseline()
    let target: number
    let provisional = false
    if (p.target_kcal != null) {
      target = Number(p.target_kcal)
      if (!Number.isFinite(target) || target < 1200 || target > 5000) throw new Error('target_kcal out of range (1200-5000)')
    } else {
      if (!b.ready) throw new Error(`baseline not ready: needs ${b.needs.join(', ')}`)
      if (b.suggested_target != null) target = b.suggested_target
      else if (p.accept === true && b.provisional_suggested_target != null) {
        target = b.provisional_suggested_target
        provisional = true
      } else throw new Error(`baseline is ${b.status}${b.status_reason ? ` (${b.status_reason})` : ''}: no suggested target`)
    }
    this.deps.setMeta('food_target_kcal', String(Math.round(target)))
    this.deps.setMeta('food_target_set_at', new Date(this.now()).toISOString())
    const maintenance = provisional ? (b.bracket?.central ?? null) : b.maintenance
    this.deps.setMeta('food_target_maintenance', maintenance == null ? '' : String(maintenance))
    this.deps.setMeta('food_target_provisional', provisional ? '1' : '')
    this.changed(this.today())
    return { target_kcal: Math.round(target), maintenance, provisional, baseline: b }
  }

  // ── confounders + goal ──────────────────────────────────────────

  confounderViews(today = this.today()): ConfounderView[] {
    return this.confounders.list().map((c) => viewOf(c, today))
  }

  /** Seed records (kind defaults filled in); idempotent on (kind, date).
   *  The personal records are added at runtime, never from source. */
  seedConfounders(records: ConfounderSeed[]): number {
    return this.confounders.seed(records, new Date(this.now()).toISOString())
  }

  addConfounder(p: Record<string, unknown>): { id: number; created: boolean; confounder: ConfounderView } {
    const kind = normKind(p.kind)
    if (kind.length < 2) throw new Error('kind is required (e.g. "creatine_start", "illness", "travel")')
    const date = p.date == null ? this.today() : isDayKey(p.date) ? p.date : null
    if (!date) throw new Error('date must be YYYY-MM-DD')
    // Like a close, a start is a fact: a future start would make the baseline
    // provisional before anything changed. Add it on the day it starts.
    if (date > this.today()) throw new Error(`start date ${date} is in the future (today is ${this.today()}): add it on the day it starts`)
    const windowArg = p.window_days == null ? null : Number(p.window_days)
    if (windowArg != null && (!Number.isInteger(windowArg) || windowArg < 1 || windowArg > 120)) throw new Error('window_days must be an integer 1-120')
    let details: ConfounderDetails
    if (typeof p.details === 'string') details = { summary: p.details.trim().slice(0, 200) }
    else if (p.details && typeof p.details === 'object' && !Array.isArray(p.details)) details = { ...(p.details as ConfounderDetails) }
    else details = {}
    if (JSON.stringify(details).length > 2000) throw new Error('details too large')
    if (p.bracket != null) details.bracket = p.bracket as ConfounderDetails['bracket']
    // A known kind (creatine_start, intake_step_down) brings its generic
    // window, effect, label and bracket; the caller's own fields win.
    const filled = withKindDefaults(kind, windowArg, details)
    const r = this.confounders.add({ kind, date, window_days: filled.window_days, details: filled.details, now: new Date(this.now()).toISOString() })
    this.changed(this.today())
    return { ...r, confounder: viewOf(this.confounders.get(r.id)!, this.today()) }
  }

  closeConfounder(p: Record<string, unknown>): { confounder: ConfounderView } {
    const today = this.today()
    let row = p.id != null ? this.confounders.get(Number(p.id)) : null
    if (!row && typeof p.kind === 'string') {
      const kind = normKind(p.kind)
      row = this.confounders.list().filter((c) => c.kind === kind && c.closed_at == null).at(-1) ?? null
    }
    if (!row) throw new Error('no such confounder (give id, or kind of an open one)')
    const date = p.date == null ? today : isDayKey(p.date) ? p.date : null
    if (!date) throw new Error('date must be YYYY-MM-DD')
    if (date < row.date) throw new Error(`close date ${date} is before the record's start ${row.date}`)
    // A close is a fact, not a plan: a date ahead would end the provisional
    // status today (and empty the clean window). Close it on the day.
    if (date > today) throw new Error(`close date ${date} is in the future (today is ${today}): close it on the day it ends`)
    this.confounders.close(row.id, date)
    this.changed(today)
    return { confounder: viewOf(this.confounders.get(row.id)!, today) }
  }

  goalRecord(): GoalRecord | null {
    try {
      const raw = this.deps.getMeta(GOAL_META)
      return raw ? (JSON.parse(raw) as GoalRecord) : null
    } catch {
      return null
    }
  }

  goal(confs: ConfounderView[] = this.confounderViews()): GoalView | null {
    const g = this.goalRecord()
    if (!g) return null
    // Creatine water stays while he keeps taking it: only a hand-closed record means he stopped.
    const creatine = confs.find((c) => c.kind === 'creatine_start' && c.bracket && this.confounders.get(c.id)?.closed_at == null)
    return goalView(g, this.latestWeight()?.kg ?? null, creatine ? creatine.bracket!.kg[1] : null)
  }

  setGoal(p: Record<string, unknown>): { goal: GoalView | null } {
    const g = parseGoal(p, this.goalRecord(), new Date(this.now()).toISOString())
    this.deps.setMeta(GOAL_META, JSON.stringify(g))
    return { goal: this.goal() }
  }

  clearGoal(): { goal: null; cleared: boolean } {
    const had = this.goalRecord() != null
    this.deps.setMeta(GOAL_META, '')
    return { goal: null, cleared: had }
  }

  /** Config changed (config_set): a new weighins_from re-decides the date
   *  rule (every rule runs, friend rule first; the calibration follows
   *  whenever a not-his verdict moved). */
  onConfigChanged(prev: FoodConfig, next: FoodConfig): void {
    if ((prev.weighins_from ?? null) !== (next.weighins_from ?? null)) {
      this.settleWeighins({ dateRuleChanged: true, recalibrate: false })
      this.changed(this.today())
    }
  }

  targetKcal(): number | null {
    const v = Number(this.deps.getMeta('food_target_kcal') || NaN)
    return Number.isFinite(v) && v > 0 ? v : null
  }

  latestWeight(): {
    kg: number
    at: string
    fat_pct: number | null
    fat_at?: string
    fat_source?: string | null
    fat_basis?: 'device' | 'raw' | 'provisional' | 'calibrated' | null
    fat_raw_pct?: number | null
  } | null {
    const since = new Date(this.now() - 30 * 86_400_000).toISOString()
    const s = this.book.bodySamplesAll(since).filter((x) => x.excluded == null)
    const mass = s.filter((x) => x.kind === 'mass').at(-1)
    if (!mass) return null
    // The latest weigh-in's own fat when it has one, else the latest fat; it
    // names its source and what the value is (device, raw, calibrated).
    const fat = s.find((x) => x.kind === 'fat' && x.ts === mass.ts && x.source === mass.source) ?? s.filter((x) => x.kind === 'fat').at(-1)
    if (!fat) return { kg: Math.round(mass.value * 10) / 10, at: mass.ts, fat_pct: null }
    return {
      kg: Math.round(mass.value * 10) / 10,
      at: mass.ts,
      fat_pct: Math.round(fat.value * 1000) / 10,
      fat_at: fat.ts,
      fat_source: fat.source,
      ...this.fatBasis(fat),
    }
  }

  /** One day of food: meals, totals, targets, baseline progress. */
  day(date?: unknown, opts: { forPhone?: boolean } = {}) {
    const d = isDayKey(date) ? date : this.today()
    const cfg = this.deps.getConfig()
    const meals = this.book.mealsOn(d)
    const estimated = meals.filter((m) => m.status === 'estimated')
    const t = totalsOf(estimated.flatMap((m) => m.items))
    const b = this.baseline()
    const flag = this.book.dayFlag(d)
    const energy: DayEnergy = dayEnergy({
      date: d,
      today: this.today(),
      intake: {
        kcal: t.kcal,
        kcal_lo: t.kcal_lo,
        kcal_hi: t.kcal_hi,
        estimated: estimated.length,
        pending: meals.length - estimated.length,
        complete: flag ?? meals.length - estimated.length === 0,
      },
      burn: this.burnFor([d]).get(d) ?? null,
      cal: b.energy.calibration,
    })
    return {
      date: d,
      today: this.today(),
      rollover_hour: cfg.rollover_hour,
      meals: meals.map((m) => this.mealView(m, opts.forPhone === true)),
      totals: {
        kcal: t.kcal,
        kcal_lo: t.kcal_lo,
        kcal_hi: t.kcal_hi,
        protein_g: t.protein_g,
        estimated: estimated.length,
        pending: meals.length - estimated.length,
      },
      complete: flag ?? meals.length - estimated.length === 0,
      targets: {
        protein_g: cfg.protein_target_g,
        kcal: this.targetKcal(),
        kcal_set_at: this.deps.getMeta('food_target_set_at') || null,
        kcal_provisional: this.targetKcal() != null && this.deps.getMeta('food_target_provisional') === '1',
      },
      baseline: {
        ready: b.ready,
        complete_days: b.complete_days,
        days_needed: BASELINE_DEFAULTS.minCompleteDays,
        weigh_ins: b.weigh_ins,
        weigh_ins_needed: BASELINE_DEFAULTS.minWeighIns,
        status: b.status,
        // The binding (latest) open confounder window's end, while provisional.
        provisional_until:
          b.status === 'provisional'
            ? (b.confounders.filter((c) => c.status === 'active').map((c) => c.window.to).sort().at(-1) ?? null)
            : null,
      },
      energy,
      weight: this.latestWeight(),
      body: this.dayBody(),
    }
  }

  mealView(m: Meal, forPhone = false) {
    return {
      id: m.id,
      source: m.source,
      status: m.status,
      eaten_at: m.eaten_at,
      logged_at: m.logged_at,
      label: m.label,
      note: m.note,
      confidence: m.confidence,
      revision: m.revision,
      kcal: m.kcal,
      kcal_lo: m.kcal_lo,
      kcal_hi: m.kcal_hi,
      protein_g: m.protein_g,
      carbs_g: m.carbs_g,
      fat_g: m.fat_g,
      fix_text: m.fix_text,
      items: m.items,
      photos: m.photos.map((p) =>
        forPhone
          ? { n: p.idx, url: `/meal-photo?meal=${m.id}&n=${p.idx}`, thumb_url: `/meal-photo?meal=${m.id}&n=${p.idx}&thumb=1` }
          : { n: p.idx, path: p.path },
      ),
    }
  }

  /** One-line summary for tool results, so chat can answer straight from it. */
  summary(meal: Meal | null): string {
    return this.summaryOf(meal, this.day(meal?.date))
  }

  /** Same, over a day already read (no second baseline pass). */
  summaryOf(meal: Meal | null, day: ReturnType<FoodService['day']>): string {
    const cfg = this.deps.getConfig()
    const parts: string[] = []
    if (meal) {
      if (meal.status === 'void') parts.push(`Meal #${meal.id} removed.`)
      else if (meal.status === 'pending') parts.push(`Meal #${meal.id} logged, pending estimate (revision 0).`)
      else
        parts.push(
          `Meal #${meal.id} "${meal.label}" rev ${meal.revision}: ${kcalText(meal.kcal, meal.kcal_lo, meal.kcal_hi)}, ${fmtG(meal.protein_g)} protein.`,
        )
    }
    const target = day.targets.kcal
    parts.push(
      `${day.date === day.today ? 'Today' : day.date}: ${kcalText(day.totals.kcal, day.totals.kcal_lo, day.totals.kcal_hi)}${target ? ` of ${fmtK(target)}` : ''}, ${fmtG(day.totals.protein_g)} of ${cfg.protein_target_g} g protein${day.totals.pending ? `, ${day.totals.pending} pending` : ''}.`,
    )
    const e = day.energy
    if (e.burn_kcal != null) {
      if (!e.calibrated) parts.push(`Burned (WHOOP, uncalibrated): ${fmtK(e.burn_kcal)} kcal${e.so_far ? ' so far' : ''}.`)
      else if (e.balance_kcal != null)
        parts.push(`Balance${e.so_far ? ' so far' : ''}: ${balanceText(e)} (WHOOP ${fmtK(e.burn_kcal)} kcal x ${e.factor}).`)
    }
    if (!day.baseline.ready)
      parts.push(`Baseline: ${day.baseline.complete_days}/${day.baseline.days_needed} complete days, ${day.baseline.weigh_ins}/${day.baseline.weigh_ins_needed} weigh-ins.`)
    else if (day.baseline.status === 'provisional') parts.push('Baseline: provisional (confounder window open).')
    return parts.join(' ')
  }

  // ── weigh-ins (HealthKit via the phone) ─────────────────────────

  ingestBodySamples(
    raw: unknown,
    rawDeleted: unknown,
    scaleRaw?: ScaleRaw | ScaleRaw[] | null,
  ): { received: number; added: number; deleted: number } | null {
    if (!Array.isArray(raw) || raw.length > MAX_BODY_SAMPLES) return null
    if (rawDeleted != null && (!Array.isArray(rawDeleted) || rawDeleted.length > MAX_BODY_SAMPLES)) return null
    const now = this.now()
    const clean: Array<{ uuid: string; ts: string; kind: 'mass' | 'fat'; value: number; source: string | null }> = []
    for (const s of raw) {
      if (typeof s !== 'object' || s == null) continue
      const r = s as Record<string, unknown>
      const uuid = typeof r.uuid === 'string' && r.uuid.length >= 8 && r.uuid.length <= 64 ? r.uuid : null
      const t = typeof r.ts === 'string' ? Date.parse(r.ts) : NaN
      const kind = r.kind === 'mass' || r.kind === 'fat' ? r.kind : null
      const value = typeof r.value === 'number' && Number.isFinite(r.value) ? r.value : NaN
      if (!uuid || !Number.isFinite(t) || !kind || t > now + 86_400_000) continue
      // kg for mass, a 0-1 fraction for body fat (HealthKit's own unit).
      if (kind === 'mass' && !(value > 20 && value < 400)) continue
      if (kind === 'fat' && !(value > 0.01 && value < 0.8)) continue
      const source = typeof r.source === 'string' ? r.source.slice(0, 80) : null
      clean.push({ uuid, ts: new Date(t).toISOString(), kind, value, source })
    }
    const deleted = Array.isArray(rawDeleted)
      ? rawDeleted.filter((u): u is string => typeof u === 'string' && u.length >= 8 && u.length <= 64)
      : []
    const nowIso = new Date(now).toISOString()
    // The S400 leg's raw reading lands BEFORE its samples: the raw fat % is
    // the calibration input and must never be read back from a sample the
    // calibration has already rewritten.
    for (const r of scaleRaw == null ? [] : Array.isArray(scaleRaw) ? scaleRaw : [scaleRaw]) {
      const ok = cleanScaleRaw(r)
      if (ok) this.scaleCal.upsertReading(ok, nowIso)
    }
    // An S400 fat sample is stored CALIBRATED with the stored model (never
    // raw next to calibrated ones, even if the refit below fails), and a
    // re-ingest never puts the raw value back over a calibrated one.
    const s400Fat = clean.filter((s) => s.kind === 'fat' && s.source === SCALE_SOURCE && /-f$/.test(s.uuid))
    if (s400Fat.length) {
      const model = this.scaleModel()
      for (const s of s400Fat) {
        const v = this.scaleCal.calibrateReading(readingStemOf(s.uuid), model)
        if (v != null) s.value = v
      }
    }
    const known = this.book.unknownBodyUuids(clean.map((s) => s.uuid))
    const freshRows = clean.filter((s) => known.has(s.uuid))
    const added = this.book.upsertBodySamples(clean, nowIso)
    // Deletions FIRST: a reading he removed in Apple Health must not make his
    // re-weigh in the same batch a "repeat" (or an outlier reference).
    const removed = this.book.deleteBodySamples(deleted)
    // Pairs and the S400 fat calibration follow EVERY body ingest, from
    // either source: the Xiaomi copy of a weigh-in usually arrives minutes
    // after the S400 one (when the app is opened). settleWeighins runs the
    // friend rule once, FIRST (a housemate's weigh-in never pairs), then the
    // calibration, then the timing rules (the replay rule reads the
    // calibrated fat), then the calibration again if those filed one.
    this.settleWeighins()
    if (added > 0 || removed > 0) this.changed(this.today())
    this.announceWeighins(freshRows, now)
    return { received: clean.length, added, deleted: removed }
  }

  /** recalibrateScale, logged instead of thrown (an ingest never fails on it). */
  private recalibrateQuietly(): void {
    try {
      this.recalibrateScale()
    } catch (err) {
      this.log(`scale calibration failed: ${err instanceof Error ? err.message : 'error'}`)
    }
  }

  private manualIncludes(): Set<string> {
    try {
      const v = JSON.parse(this.deps.getMeta(MANUAL_INCLUDE_META) ?? '[]')
      return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
    } catch {
      return new Set()
    }
  }

  /** What a stored fat value is: 'device' = the source's own number (Xiaomi
   *  Home, any HealthKit app); for S400 rows 'raw' (open formula) or
   *  'calibrated' / 'provisional' (to the reference), with the raw value. */
  private fatBasis(fat: { uuid: string; source: string | null } | null, rows?: Map<string, ScaleReadingRow>): {
    fat_basis: 'device' | 'raw' | 'provisional' | 'calibrated' | null
    fat_raw_pct?: number | null
  } {
    if (!fat) return { fat_basis: null }
    if (fat.source !== SCALE_SOURCE) return { fat_basis: 'device' }
    const stem = readingStemOf(fat.uuid)
    const row = rows ? (rows.get(stem) ?? null) : this.scaleCal.reading(stem)
    const p = readingProvenance(row, null)
    return { fat_basis: p.status === 'uncalibrated' ? 'raw' : p.status, fat_raw_pct: row?.fat_raw_pct != null ? Math.round(row.fat_raw_pct * 100) / 100 : null }
  }

  /** Recent weigh-ins (excluded ones too) for review: one row per weigh-in. */
  weighins(days = 14): Array<{
    measured_at: string
    kg: number
    fat_pct: number | null
    fat_basis: 'device' | 'raw' | 'provisional' | 'calibrated' | null
    fat_raw_pct?: number | null
    source: string | null
    excluded: string | null
    uuids: string[]
    metrics?: Array<MetricView & { raw?: number }>
    impedance_inferred?: boolean
  }> {
    const since = new Date(this.now() - Math.max(1, Math.min(days, 365)) * 86_400_000).toISOString()
    const rows = this.book.bodySamplesAll(since)
    const readings = this.scaleCal.readingsByUuid(rows.filter((r) => r.source === SCALE_SOURCE).map((r) => readingStemOf(r.uuid)))
    const models = rows.some((r) => r.source === SCALE_SOURCE) ? this.metricModels() : {}
    const fatModel = rows.some((r) => r.source === SCALE_SOURCE) ? this.scaleModel() : null
    const out: ReturnType<FoodService['weighins']> = []
    for (const m of rows.filter((r) => r.kind === 'mass')) {
      const fat = rows.find((r) => r.kind === 'fat' && r.ts === m.ts && r.source === m.source) ?? null
      const row = m.source === SCALE_SOURCE ? (readings.get(readingStemOf(m.uuid)) ?? null) : null
      out.push({
        measured_at: m.ts,
        kg: m.value,
        fat_pct: fat ? Math.round(fat.value * 1000) / 10 : null,
        ...this.fatBasis(fat, readings),
        source: m.source,
        excluded: m.excluded,
        uuids: fat ? [m.uuid, fat.uuid] : [m.uuid],
        // S400 rows: the formula body composition (calibrated where a model
        // exists), each with its formula value.
        ...(row ? { metrics: this.readingViews(row, models, fatModel, fat?.value ?? null), impedance_inferred: row.impedance_inferred === 1 } : {}),
      })
    }
    return out
  }

  /** One weigh-in (mass + its fat pair) by sample uuid (that row's own
   *  source only: another source's copy at the same instant is a separate
   *  record with its own verdict) or by measured time (nearest within 3 min). */
  private findWeighin(p: { uuid?: unknown; measured_at?: unknown }, missing: string): Array<{ uuid: string; ts: string; kind: string; value: number; source: string | null; excluded: string | null }> {
    if (typeof p.uuid === 'string' && p.uuid.length >= 8) {
      const row = this.book.bodySampleByUuid(p.uuid)
      return row ? this.book.weighinAt(row.ts, row.source) : []
    }
    if (typeof p.measured_at === 'string' && Number.isFinite(Date.parse(p.measured_at)))
      return this.book.weighinNear(new Date(Date.parse(p.measured_at)).toISOString(), 3 * 60_000)
    throw new BadRequest(missing)
  }

  /** Manual include / exclude of ONE weigh-in (mass + its fat pair), found
   *  by uuid or by measured time (nearest within 3 min). include:true clears
   *  the exclusion; include:false sets `reason` (default "excluded by hand").
   *  A manual verdict is never overwritten by a resend. */
  setWeighin(p: { uuid?: unknown; measured_at?: unknown; include?: unknown; reason?: unknown }): {
    changed: number
    weighin: { measured_at: string; kg: number | null; excluded: string | null } | null
  } {
    if (typeof p.include !== 'boolean') throw new BadRequest('include must be true or false')
    const pair = this.findWeighin(p, 'give uuid or measured_at (ISO time of the weigh-in)')
    if (!pair.length) return { changed: 0, weighin: null }
    // An exclusion with no reason on a weigh-in already filed as not his
    // KEEPS that verdict (now by hand): "exclude it" there means "yes, not
    // mine", never a reason that would show its values and let it pair.
    const notHisNow = pair.map((r) => r.excluded).find((x) => mayNotBeHis(x)) ?? null
    const keepNotHis = notHisNow == null ? null : filedAsNotHis(notHisNow) ? `${EXCL_NOT_HIS} (by hand)` : `${EXCL_OUTLIER} (by hand)`
    let reason = p.include ? null : cleanText(p.reason, 120, false) || keepNotHis || 'excluded by hand'
    // A hand verdict must never look like an automatic one: a rule would
    // lift it (the derived ones, the date rule) or replace it (the friend
    // rule judges the timing ones). Any reason worded like one is marked.
    if (reason != null && !byHand(reason) && AUTO_VERDICTS.some((v) => reason!.startsWith(v))) reason = `${reason} ${BY_HAND}`
    const wasNotHis = notHisNow != null
    // "Someone else's" is about the weigh-in, not one source's record: like
    // a manual include (which spreads through `reclaimed`), it covers every
    // source's copy at that instant (a copy that syncs later gets it from
    // classifyNotHis). An include lifts that hand verdict from the other
    // copies too; the pass then counts the weigh-in once.
    const others = this.book.samplesAt(pair[0].ts).filter((r) => !pair.some((q) => q.uuid === r.uuid))
    const targets = !p.include && filedAsNotHis(reason) ? [...pair, ...others] : pair
    const lifted = p.include ? others.filter((r) => handNotHis(r.excluded)) : []
    const changed = this.book.setBodyExcluded(targets.map((r) => r.uuid), reason) + (lifted.length ? this.book.setBodyExcluded(lifted.map((r) => r.uuid), null) : 0)
    // Remember manual INCLUDES, so the re-classification pass never excludes
    // them again (an exclusion carries its own reason and needs no memory).
    const manual = this.manualIncludes()
    for (const r of targets) {
      if (p.include) manual.add(r.uuid)
      else manual.delete(r.uuid)
    }
    this.deps.setMeta(MANUAL_INCLUDE_META, JSON.stringify([...manual].slice(-500)))
    // Re-decide the derived verdicts this one feeds (the other source's copy
    // at the same instant counts again once this copy is excluded).
    const notHisMoved = this.reclassifyWeighins()
    // A reading that may not be his never pairs: when that set moved (this
    // one, or the rules re-deciding around it), the calibration follows.
    if (wasNotHis || lifted.length > 0 || mayNotBeHis(reason) || notHisMoved) this.recalibrateQuietly()
    this.changed(this.today())
    const mass = pair.find((r) => r.kind === 'mass') ?? null
    return { changed, weighin: { measured_at: pair[0].ts, kg: mass?.value ?? null, excluded: reason } }
  }

  /** "Count this reading instead": the given weigh-in replaces the one that
   *  counts for its local day (a redo after a clothed or botched first
   *  reading, on his word). Every other counted weigh-in that day (every
   *  source's copy) is excluded by hand as "replaced by the HH:MM reading",
   *  then this one is included by hand (so the repeat rule never pushes it
   *  out again). Found by uuid or measured_at like weighin_set. */
  replaceWeighin(p: { uuid?: unknown; measured_at?: unknown; reason?: unknown }): {
    replaced: Array<{ measured_at: string; kg: number | null; source: string | null }>
    weighin: { measured_at: string; kg: number | null; excluded: string | null } | null
  } {
    const pair = this.findWeighin(p, 'give uuid or measured_at (ISO time of the weigh-in that should count)')
    const target = pair.find((r) => r.kind === 'mass')
    if (!target) return { replaced: [], weighin: null }
    const t = Date.parse(target.ts)
    const start = dayStartIso(t)
    const end = dayEndIso(t)
    const counted = this.book
      .bodySamplesAll(start)
      .filter((r) => r.kind === 'mass' && r.excluded == null && r.ts < end && r.ts !== target.ts)
    const at = new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    const why = cleanText(p.reason, 80, false)
    const reason = `replaced by the ${at} reading${why ? `: ${why}` : ''} ${BY_HAND}`
    const manual = this.manualIncludes()
    const replaced: Array<{ measured_at: string; kg: number | null; source: string | null }> = []
    for (const ts of new Set(counted.map((r) => r.ts))) {
      const copies = this.book.samplesAt(ts)
      this.book.setBodyExcluded(copies.map((r) => r.uuid), reason)
      for (const r of copies) manual.delete(r.uuid)
      const m = counted.find((r) => r.ts === ts)!
      replaced.push({ measured_at: ts, kg: m.value, source: m.source })
    }
    this.deps.setMeta(MANUAL_INCLUDE_META, JSON.stringify([...manual].slice(-500)))
    // The include re-runs every rule and the calibration, and announces the change.
    const res = this.setWeighin({ uuid: target.uuid, include: true })
    if (replaced.length) this.log(`weigh-in ${target.ts} now counts for its day, replacing ${replaced.map((r) => r.measured_at).join(', ')}`)
    return { replaced, weighin: res.weighin }
  }

  /** Every weigh-in rule, in the one order that keeps a housemate out of
   *  the calibration: the friend rule FIRST (masses only), then the S400 fat
   *  calibration (recalibrate:false = only when the friend rule moved
   *  something), then the timing rules (the replay rule reads the
   *  calibrated fat), then the calibration AGAIN when those filed a reading
   *  that may not be his. Used by every body ingest, the daemon boot and a
   *  weighins_from change. Returns whether any not-his verdict moved. */
  settleWeighins(opts: { dateRuleChanged?: boolean; recalibrate?: boolean } = {}): boolean {
    const notHisMoved = this.classifyNotHis()
    if (opts.recalibrate !== false || notHisMoved) this.recalibrateQuietly()
    const ruleMoved = this.reclassifyWeighins({ dateRuleChanged: opts.dateRuleChanged, friendRule: false })
    if (ruleMoved) this.recalibrateQuietly()
    return notHisMoved || ruleMoved
  }

  /** Exclusion rules, applied to every reading that currently COUNTS, in
   *  time order (stored ones too: rows synced before the rules existed, or
   *  before weighins_from was set). Manual includes are never re-excluded;
   *  an exclusion is never lifted automatically, except the derived ones
   *  below (after a meal, possible replay) and the date rule on a
   *  weighins_from change. In order:
   *  1. date rule: before food.weighins_from = a TEST reading;
   *  2. window: measured outside 03:30-14:00 local = not a morning reading
   *     (09:00-14:00 is the late fasted band: it counts only when no meal
   *     came before it, which the after-a-meal rule below decides);
   *  3. outlier: far from the last counted reading = possible other person
   *     (from 3 earlier counted readings; two agreeing days = a real shift);
   *  3b. re-measured: the S400's second take of one step-on (another S400
   *     BLE reading within 60 s and 0.2 kg counts: the more complete one,
   *     else the first); re-decided on every pass;
   *  4. repeat: a morning reading already counts for that day (the FIRST one);
   *  5. same instant: another source's copy of this weigh-in counts (walk
   *     order = ts, then S400 BLE first, then uuid: the first one wins).
   *  A fat sample shares its mass sample's verdict (same source + instant).
   *  Energy-balance release (in order, after the window rule):
   *  replay: identical to the previous reading in BOTH mass and fat;
   *  after a meal: a meal was eaten before it, on its food day and its own
   *  morning (from the later of the food-day start and local 03:30).
   *  These two and the same-instant rule are re-decided on every pass (they
   *  follow the data).
   *  Before all of them (unless friendRule:false), the friend rule
   *  (classifyNotHis): more than 4 kg from his anchor = not his (weight
   *  outlier). A copy of a weigh-in he reclaimed by hand (another source's
   *  copy at the same instant is a manual include) is that weigh-in
   *  delivered twice: "same weigh-in, other source", never judged as
   *  someone else. friendRule:false is for callers that cannot move it (a
   *  meal write: the walk reads only masses and identity verdicts) or that
   *  ran it already (settleWeighins). Returns whether the set of readings
   *  that may not be his moved (the calibration skips them). */
  reclassifyWeighins(opts: { dateRuleChanged?: boolean; friendRule?: boolean } = {}): boolean {
    // A new weighins_from re-decides the date rule's own verdicts (and only
    // those).
    if (opts.dateRuleChanged) this.book.liftExclusions(EXCL_DATE_RULE)
    const notHisMoved = opts.friendRule === false ? false : this.classifyNotHis()
    const rollover = this.deps.getConfig().rollover_hour
    const sinceIso = new Date(this.now() - RULES_WINDOW_MS).toISOString()
    // "after a meal", "possible replay" and "same weigh-in, other source" are
    // derived from data that can change under them (a meal voided or
    // re-timed, a reference reading deleted, the preferred copy excluded):
    // lift them and let this pass re-decide (manual verdicts carry their own
    // reasons and are never touched).
    this.book.liftExactExclusions(REDECIDED_EXCLUSIONS, sinceIso)
    const from = this.deps.getConfig().weighins_from ?? null
    const validFrom = isDayKey(from) ? from : null
    // The late fasted band (09:00-14:00) came after some readings in it were
    // stored "not a morning reading": re-judge those (the meal check decides
    // them now). Only on or after weighins_from: before it every reading is a
    // test anyway, and with no date rule set, older rows predate meal logging
    // ("no meal logged" would mean nothing), so their verdicts stay.
    if (validFrom) {
      const stale = this.book
        .bodySamplesAll(sinceIso)
        .filter((r) => r.excluded === EXCL_NOT_MORNING && foodDay(Date.parse(r.ts), 0) >= validFrom && inLateFastedBand(Date.parse(r.ts)))
        .map((r) => r.uuid)
      if (stale.length) this.book.setBodyExcluded(stale, null)
    }
    const manual = this.manualIncludes()
    let outlierFiled = false
    // Normally one walk. A take filed re-measured against a rival that this
    // same walk then excludes (the window, the date, a meal, an outlier: the
    // rival is judged after it) would leave no take of the step-on counting:
    // such a take is lifted and the walk runs again (bounded; each round only
    // lifts takes whose every outranking rival no longer counts).
    for (let round = 0; round < 3; round++) {
      // Every reading that currently COUNTS, oldest first (bounded to ~13
      // months), minus the ones he included by hand: stored rows from before the
      // rules existed, or before weighins_from was set, get classified too.
      const counting = this.book.includedSamplesSince(sinceIso)
      // Same-instant copies in a FIXED order (S400 BLE first, then uuid), the
      // order sameInstantLoses ranks them in.
      const masses = counting.filter((s) => s.kind === 'mass' && !manual.has(s.uuid)).sort(compareWeighins)
      const reclaimed = new Set(counting.filter((s) => s.kind === 'mass' && manual.has(s.uuid)).map((s) => s.ts))
      const remeasured: Array<{ m: (typeof masses)[number]; pair: string[] }> = []
      for (const m of masses) {
        const ms = Date.parse(m.ts)
        const day = foodDay(ms, 0)
        let reason: string | null = null
        if (validFrom && day < validFrom) {
          const label = new Date(`${validFrom}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
          reason = `${EXCL_DATE_RULE} on ${label}`
        } else if (!inMorningWindow(ms) && !inLateFastedBand(ms)) {
          reason = EXCL_NOT_MORNING
        } else if (this.isReplay(m)) {
          // A re-synced copy of the previous reading must never count twice.
          reason = EXCL_REPLAY
        } else if (this.book.mealBetween(new Date(fastedFromMs(ms, rollover)).toISOString(), m.ts)) {
          reason = EXCL_AFTER_MEAL
        } else if (reclaimed.has(m.ts)) {
          // He counted another source's copy of this very weigh-in by hand.
          reason = EXCL_SAME_INSTANT
        } else if (isOutlier(this.book, m)) {
          // BEFORE the repeat rule: a friend stepping on first must never
          // count and push his real reading out as the "repeat".
          reason = EXCL_OUTLIER
          outlierFiled = true
        } else if (this.remeasureLoses(m)) {
          // BEFORE the repeat rule: the scale's second take of one step-on is
          // the same weigh-in (the more complete one counts), never a repeat.
          reason = EXCL_REMEASURED
        } else if (this.book.includedMassOnDayBefore(dayStartIso(ms), m.ts)) {
          reason = EXCL_REPEAT
        } else if (this.sameInstantLoses(m)) {
          reason = EXCL_SAME_INSTANT
        }
        if (!reason) continue
        const pair = counting.filter((s) => s.ts === m.ts && s.source === m.source).map((s) => s.uuid)
        this.book.setBodyExcluded(pair, reason)
        if (reason === EXCL_REMEASURED) remeasured.push({ m, pair })
      }
      const orphaned = remeasured.filter((r) => !this.remeasureLoses(r.m))
      if (!orphaned.length) break
      for (const r of orphaned) this.book.setBodyExcluded(r.pair, null)
    }
    return notHisMoved || outlierFiled
  }

  /** The friend rule (housemates step on his S400): walkNotHis over every
   *  mass reading of the last ~13 months (plus NOT_HIS_ANCHOR_MS before, as
   *  anchors only), once, oldest first. A reading whose verdict is null, a
   *  timing one or the rule's own is filed as "not his (weight outlier)" when
   *  more than 4 kg from his anchor, and lifted back to counting otherwise
   *  (the timing rules after this re-apply). Manual includes, hand verdicts,
   *  the outlier rule's and every row older than the walk window keep their
   *  stored verdict. Another source's copy of a weigh-in he disowned by hand
   *  (one that synced after his verdict) takes that same hand verdict when
   *  its own is a candidate one. Returns whether the set of readings filed
   *  as not his changed. */
  private classifyNotHis(): boolean {
    const sinceMs = this.now() - RULES_WINDOW_MS
    const rows = this.book.bodySamplesAll(new Date(sinceMs - NOT_HIS_ANCHOR_MS).toISOString())
    const masses: NotHisRow[] = rows
      .filter((r) => r.kind === 'mass')
      .map((r) => ({ uuid: r.uuid, ts: r.ts, t: Date.parse(r.ts), value: r.value, source: r.source, was: r.excluded }))
      .sort(compareWeighins)
    const manual = this.manualIncludes()
    const { filed, disowned } = walkNotHis(masses, sinceMs, manual)
    this.notHisOff = filed
    // A weigh-in = its mass + fat samples (same source + instant).
    const weighins = new Map<string, string[]>()
    for (const r of rows) {
      const key = `${r.ts}\n${r.source ?? ''}`
      const list = weighins.get(key)
      if (list) list.push(r.uuid)
      else weighins.set(key, [r.uuid])
    }
    // Local days on which a reading was filed or lifted: their repeat
    // verdicts were decided against the old set and are re-decided below.
    const days = new Set<number>()
    for (const m of masses) {
      if (m.t < sinceMs) continue // outside the walk: its verdict stands
      const samples = weighins.get(`${m.ts}\n${m.source ?? ''}`) ?? [m.uuid]
      const hand = disowned.get(m.ts)
      if (hand != null) {
        if (!notHisCandidate(m.was)) continue
        this.book.setBodyExcluded(samples, hand)
        days.add(Date.parse(dayStartIso(m.t)))
        continue
      }
      const isFiled = filed.has(m.uuid)
      if (isFiled === (m.was === EXCL_NOT_HIS)) continue
      // Lifted: back to counting; the timing rules after this re-apply (the
      // date rule, the window, repeat, ...).
      this.book.setBodyExcluded(samples, isFiled ? EXCL_NOT_HIS : null)
      days.add(Date.parse(dayStartIso(m.t)))
    }
    // A housemate's reading filed after the fact must not keep his own
    // reading of that morning a "repeat" of it: lift the rule's repeat
    // verdicts on each moved day (a hand one carries BY_HAND and stays), and
    // the timing pass that always follows this one re-decides them.
    for (const start of days) {
      this.book.liftExactExclusions([EXCL_REPEAT], new Date(Math.max(start, sinceMs)).toISOString(), dayEndIso(start))
    }
    return days.size > 0
  }

  /** How far a filed reading sat from its reference on the last friend-rule
   *  walk, for the body.weighin line (null = not filed by that walk). */
  private notHisOffKg(m: { uuid: string }): number | null {
    return this.notHisOff.get(m.uuid) ?? null
  }

  /** Identical to the previous reading OF THE SAME SOURCE (any verdict) in
   *  BOTH mass and fat. A replay is one path re-delivering its own record:
   *  the S400 BLE leg and another app are independent paths (the same
   *  weigh-in on both is the same-instant rule's job), so another source's
   *  reading is never the reference. S400 against S400 compares the RAW
   *  open-formula value (stable; the calibrated fat moves with every refit);
   *  any other source compares its stored fat. */
  private isReplay(m: { uuid: string; ts: string; value: number; source: string | null }): boolean {
    const prev = this.book.previousMassOfSource(m.ts, m.source)
    if (!prev || Math.abs(prev.value - m.value) >= REPLAY_KG) return false
    if (m.source === SCALE_SOURCE) {
      const a = this.scaleCal.reading(readingStemOf(prev.uuid))?.fat_raw_pct
      const b = this.scaleCal.reading(readingStemOf(m.uuid))?.fat_raw_pct
      return a != null && b != null && Math.abs(a - b) < REPLAY_RAW_PCT
    }
    const fat = this.book.fatAt(m.ts, m.source)
    return prev.fat != null && fat != null && Math.abs(prev.fat - fat) < REPLAY_FAT
  }

  /** Two included masses at the SAME instant are one weigh-in delivered
   *  twice (the S400 and Xiaomi Home both stamp the scale's own clock): only
   *  one counts. Ranked like the pass walks them (compareWeighins: S400 BLE
   *  first, then the lower uuid); this one loses when a preferred copy still
   *  counts. */
  private sameInstantLoses(m: { uuid: string; ts: string; source: string | null }): boolean {
    return this.book.includedMassesAt(m.ts, m.uuid).some((o) => compareWeighins({ ...o, ts: m.ts }, m) < 0)
  }

  /** The S400 readings (other than this one) that are the same step-on:
   *  S400 BLE, a different instant within REMEASURE_MS, within REMEASURE_KG,
   *  any verdict. */
  private remeasureSiblings(m: { uuid: string; ts: string; value: number; source: string | null }): Array<{ uuid: string; ts: string; value: number; excluded: string | null }> {
    if (m.source !== SCALE_SOURCE) return []
    const t = Date.parse(m.ts)
    return this.book
      .massesOfSourceBetween(SCALE_SOURCE, new Date(t - REMEASURE_MS).toISOString(), new Date(t + REMEASURE_MS).toISOString())
      .filter((o) => o.uuid !== m.uuid && o.ts !== m.ts && Math.abs(o.value - m.value) <= REMEASURE_KG + 1e-9)
  }

  /** Does a counted re-measure of this S400 step-on outrank it? Rank: the
   *  more complete reading (a fat sample, or impedance in its raw row)
   *  first, then the earlier one, then the lower uuid. */
  private remeasureLoses(m: { uuid: string; ts: string; value: number; source: string | null }): boolean {
    const rivals = this.remeasureSiblings(m).filter((o) => o.excluded == null)
    if (!rivals.length) return false
    const complete = (r: { uuid: string; ts: string }) =>
      this.book.fatAt(r.ts, SCALE_SOURCE) != null || this.scaleCal.reading(readingStemOf(r.uuid))?.impedance_low != null ? 0 : 1
    const mine = complete(m)
    return rivals.some((o) => {
      const c = complete(o)
      if (c !== mine) return c < mine
      return compareWeighins({ ...o, source: SCALE_SOURCE }, m) < 0
    })
  }

  // ── S400 fat calibration (against Xiaomi Home) ─────────────────

  /** The stored calibration model, or null before the first fit. */
  scaleModel(): CalModel | null {
    return parseModel(this.deps.getMeta(SCALE_CAL_META))
  }

  /** Re-pair S400 readings with non-S400 weigh-ins, refit, store the model
   *  when it changed, and write the calibrated value onto every S400 fat
   *  sample (paired or not: one consistent series). Raw values stay in
   *  scale_readings. */
  recalibrateScale(): CalModel {
    backfillScaleReadings(this.deps.db)
    // Body-composition formula values first (new rows, a changed profile):
    // the per-metric refits at the end read them.
    try {
      this.refreshMetrics()
    } catch (err) {
      this.log(`scale: body metrics failed: ${err instanceof Error ? err.message : 'error'}`)
    }
    const nowIso = new Date(this.now()).toISOString()
    const sinceIso = new Date(this.now() - RULES_WINDOW_MS).toISOString()
    const readings = this.scaleCal.readingsWithRaw(sinceIso)
    // One query for every check below (pairs, manual fat, each metric).
    const notHis = this.notHisMassUuids()
    let pairs: ReturnType<typeof pairReadings> = []
    if (readings.length) {
      const first = Date.parse(readings[0].measured_at) - PAIR_WINDOW_MS
      const last = Date.parse(readings[readings.length - 1].measured_at) + PAIR_WINDOW_MS
      const refs = this.scaleCal.referenceWeighins(new Date(first).toISOString(), new Date(last).toISOString(), this.deps.getScaleReferenceSources?.())
      // A reading that may not be his never pairs (either side).
      pairs = pairReadings(
        readings.filter((r) => !notHis.has(`${r.uuid}-m`)),
        refs.filter((r) => !notHis.has(r.uuid)),
      )
    }
    // Manual fat values (weighin_pair metric fat_pct) join the automatic
    // HealthKit pairs; for the same reading the manual one wins.
    const manualFat = this.scaleCal.refValues('fat_pct').filter((r) => r.fat_raw_pct != null && !notHis.has(`${r.reading_uuid}-m`))
    if (manualFat.length) {
      const byReading = new Map(pairs.map((p) => [p.reading_uuid, p]))
      for (const r of manualFat)
        byReading.set(r.reading_uuid, {
          reading_uuid: r.reading_uuid,
          measured_at: r.measured_at,
          kg: r.kg,
          raw_pct: r.fat_raw_pct!,
          ref_uuid: `manual:fat_pct:${r.reading_uuid}`,
          ref_fat_pct: r.value,
          ref_source: r.source,
        })
      pairs = [...byReading.values()].sort((x, y) => x.measured_at.localeCompare(y.measured_at))
    }
    this.scaleCal.setPairs(pairs)
    const prev = this.scaleModel()
    let model = fitCalibration(pairs, nowIso)
    const refit = !sameModel(prev, model)
    if (!refit) model = prev!
    else {
      this.deps.setMeta(SCALE_CAL_META, JSON.stringify(model))
      if (prev || model.kind !== 'none')
        this.log(`scale: fat calibration ${model.kind} from ${model.n} pair(s)`) // no body numbers
    }
    // Every food day whose stored S400 fat moved is re-sent, not only today.
    const changedTs = this.scaleCal.applyToAll(model)
    if (changedTs.length) {
      const R = this.deps.getConfig().rollover_hour
      const days = [...new Set(changedTs.map((ts) => foodDay(Date.parse(ts), R)))].sort()
      for (const d of days) this.changed(d)
      this.log(`scale: fat calibration rewrote ${changedTs.length} S400 fat sample(s) on ${days.length} day(s)`) // counts only
    }
    try {
      for (const k of CALIBRATED_METRICS) this.refitMetric(k, notHis)
    } catch (err) {
      this.log(`scale: body metric calibration failed: ${err instanceof Error ? err.message : 'error'}`)
    }
    return model
  }

  // ── S400 body composition (bodycomp.ts) ─────────────────────────

  /** (Re)compute the formula metrics of every reading whose stored ones are
   *  missing or were computed with another profile. Returns rows written. */
  refreshMetrics(): number {
    const profile = this.deps.getScaleProfile?.()
    const key = profileKey(profile)
    const rows = this.scaleCal.metricInputs()
    let n = 0
    this.deps.db.transaction(() => {
      for (const r of rows) {
        const cur = parseMetrics(r.metrics)
        if (cur && cur.v === METRICS_VERSION && cur.profile === key) continue
        if (!key && r.metrics == null && r.impedance_inferred === 0) continue
        const m = computeMetrics(r, profile)
        this.scaleCal.setMetrics(r.uuid, m ? JSON.stringify(m) : null, m?.impedance_inferred ?? false)
        n++
      }
    })()
    return n
  }

  /** Mass sample uuids that may not be his (any age: a manual pair can sit
   *  on an old reading): filed as someone else's, or the outlier rule's
   *  "possible other person" (the phone hides those values too, so they
   *  never move his calibration). An S400 reading's mass is `${stem}-m`. */
  private notHisMassUuids(): Set<string> {
    return new Set(this.book.excludedMasses().filter((r) => mayNotBeHis(r.excluded)).map((r) => r.uuid))
  }

  /** The stored per-metric models (fat excluded: scaleModel()). */
  metricModels(): Partial<Record<MetricKey, CalModel>> {
    try {
      const raw = this.deps.getMeta(METRIC_CAL_META)
      const v = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
      const out: Partial<Record<MetricKey, CalModel>> = {}
      for (const k of CALIBRATED_METRICS) {
        const m = v[k] == null ? null : parseModel(JSON.stringify(v[k]))
        if (m) out[k] = m
      }
      return out
    } catch {
      return {}
    }
  }

  /** The manual pairs of one metric: formula value (raw) vs his value. */
  private metricPairs(metric: MetricKey, notHis: ReadonlySet<string> = this.notHisMassUuids()): Array<CalPair & { impedance_inferred: boolean }> {
    const out: Array<CalPair & { impedance_inferred: boolean }> = []
    for (const r of this.scaleCal.refValues(metric)) {
      // Maybe someone else's: never calibrates, even a forced pair.
      if (notHis.has(`${r.reading_uuid}-m`)) continue
      const raw = parseMetrics(r.metrics)?.values[metric]
      if (raw == null) continue
      out.push({
        reading_uuid: r.reading_uuid,
        measured_at: r.measured_at,
        kg: r.kg,
        raw_pct: raw,
        ref_uuid: `manual:${metric}:${r.reading_uuid}`,
        ref_fat_pct: r.value,
        ref_source: r.source,
        impedance_inferred: r.impedance_inferred === 1,
      })
    }
    return out
  }

  /** Refit one metric from its manual pairs; stored when it changed. */
  refitMetric(metric: MetricKey, notHis?: ReadonlySet<string>): CalModel {
    const models = this.metricModels()
    const prev = models[metric] ?? null
    const model = fitMetric(metric, this.metricPairs(metric, notHis), new Date(this.now()).toISOString())
    if (sameModel(prev, model)) return prev!
    if (model.kind === 'none' && !prev) return model
    const all: Record<string, CalModel> = { ...models }
    if (model.kind === 'none') delete all[metric]
    else all[metric] = model
    this.deps.setMeta(METRIC_CAL_META, JSON.stringify(all))
    this.log(`scale: ${metric} calibration ${model.kind} from ${model.n} pair(s)`) // no body numbers
    this.changed(this.today())
    return model
  }

  /** The views of one stored reading (fat from the fat calibration). */
  private readingViews(
    row: ScaleReadingRow,
    models: Partial<Record<MetricKey, CalModel>>,
    fatModel: CalModel | null,
    fatSample: number | null,
  ): Array<MetricView & { raw?: number }> {
    return metricViews(parseMetrics(row.metrics), models, this.fatOverride(row, fatModel, fatSample), row.kg)
  }

  /** The fat view: the stored S400 fat sample (what the trend reads) when
   *  there is one, else the calibrated / raw value of the row. */
  private fatOverride(row: ScaleReadingRow, fatModel: CalModel | null, fatSample: number | null): FatOverride | null {
    const p = readingProvenance(row, fatModel)
    const pct =
      fatSample != null
        ? fatSample * 100
        : p.status !== 'uncalibrated' && row.fat_cal_pct != null
          ? row.fat_cal_pct
          : (row.fat_raw_pct ?? parseMetrics(row.metrics)?.values.fat_pct ?? null)
    if (pct == null) return null
    const basis = basisOfProvenance(p)
    const note = calibrationText('fat_pct', p)
    // raw = the row's open-formula fat, never the displayed (calibrated) one.
    return { value: pct, basis, note, raw: row.fat_raw_pct ?? null }
  }

  /** day.body: the latest S400 weigh-in of the last 7 days that is his (an
   *  outlier, test, or hand-excluded reading is skipped), with its metrics
   *  in the iOS order. Null when there is none. */
  dayBody(): { measured_at: string; kg: number; metrics: MetricView[] } | null {
    const rows = this.scaleCal.recentReadingsWithVerdict(new Date(this.now() - DAY_BODY_WINDOW_MS).toISOString())
    // Never the losing take of a re-measured step-on: its counted sibling
    // (the more complete one) sits within a minute of it.
    const row = rows.find((r) => r.mass_excluded == null || (r.mass_excluded !== EXCL_REMEASURED && BODY_OK_EXCLUSIONS.has(r.mass_excluded)))
    if (!row) return null
    const views = this.readingViews(row, this.metricModels(), this.scaleModel(), this.book.fatAt(row.measured_at, SCALE_SOURCE))
    return {
      measured_at: row.measured_at,
      kg: Math.round(row.kg * 10) / 10,
      metrics: views.map(({ key, label, value, unit, basis, note }) => ({ key, label, value, unit, basis, note })),
    }
  }

  /** health__meal weighin_pair: one value from the Xiaomi report for the
   *  S400 weigh-in within 180 s of measured_at. Stored (a re-submit
   *  replaces it), then THAT metric is refitted. BMI is never calibrated: a
   *  BMI pair reports the difference (a height check).
   *
   *  Guards, each overridable with force:true once he confirms: the matched
   *  reading must be his (not excluded as someone else / a test / by hand;
   *  the same filter as day.body), and the value must sit within 10 fit
   *  units of the formula (a lb-for-kg slip or the wrong metric, which one
   *  pair would otherwise turn straight into an offset model). */
  weighinPair(p: { measured_at?: unknown; metric?: unknown; value?: unknown; source?: unknown; force?: unknown }): Record<string, unknown> {
    const metric = typeof p.metric === 'string' ? (p.metric.trim().toLowerCase() as MetricKey) : ('' as MetricKey)
    if (metric === 'lean_kg') throw new BadRequest('lean_kg is not paired: it is weight x (1 - body fat) and follows the fat calibration; pair fat_pct instead')
    if (!PAIRABLE_METRICS.includes(metric)) throw new BadRequest(`metric must be one of ${PAIRABLE_METRICS.join(', ')}`)
    const t = typeof p.measured_at === 'string' ? Date.parse(p.measured_at) : NaN
    if (!Number.isFinite(t)) throw new BadRequest('measured_at must be the ISO time of the weigh-in (body.weighin meta measured_at)')
    const value = typeof p.value === 'number' ? p.value : typeof p.value === 'string' && p.value.trim() ? Number(p.value) : NaN
    const [lo, hi] = METRICS[metric].range
    if (!Number.isFinite(value) || value < lo || value > hi) throw new BadRequest(`value for ${metric} must be a number in ${lo}-${hi}`)
    const force = p.force === true
    const source = cleanText(p.source, 60) ?? 'xiaomi report'
    const atIso = new Date(t).toISOString()
    this.refreshMetrics()
    const row = this.scaleCal.readingNear(atIso)
    if (!row) throw new BadRequest(`no S400 weigh-in within ${PAIR_WINDOW_MS / 1000} s of ${atIso}`)
    const excluded = row.mass_excluded
    if (excluded != null && !BODY_OK_EXCLUSIONS.has(excluded) && !force)
      throw new BadRequest(
        `the S400 weigh-in at ${row.measured_at} is excluded ("${excluded}"), so it may not be his; check weighins, and re-send with force:true only if it is${mayNotBeHis(excluded) ? ' (filed as maybe someone else\'s, it never calibrates until weighin_set include:true counts it)' : ''}`,
      )
    const formula = metric === 'fat_pct' ? (row.fat_raw_pct ?? parseMetrics(row.metrics)?.values.fat_pct ?? null) : (parseMetrics(row.metrics)?.values[metric] ?? null)
    const maxDiff = IMPLAUSIBLE_FIT_UNITS * METRICS[metric].fitUnit
    if (formula != null && metric !== 'bmi' && Math.abs(value - formula) > maxDiff && !force) {
      const unit = METRICS[metric].unit
      throw new BadRequest(
        `implausible: ${metric} ${value} is ${Math.round(Math.abs(value - formula) * 100) / 100}${unit ? ` ${unit}` : ''} from the formula's ${Math.round(formula * 100) / 100} (limit ${maxDiff}); check the metric and the unit (kg, not lb), and re-send with force:true only if it is right`,
      )
    }
    const nowIso = new Date(this.now()).toISOString()
    this.scaleCal.upsertRefValue({ reading_uuid: row.uuid, metric, value, source, ref_measured_at: atIso }, nowIso)
    const reading = { uuid: row.uuid, measured_at: row.measured_at, kg: row.kg, impedance_inferred: row.impedance_inferred === 1, excluded, forced: force }
    const noFormula = formula == null ? `no formula ${metric} for that reading yet (needs scale.profile${METRICS[metric].usesImpedance ? ' and an impedance' : ''}); stored, it joins the fit once there is one` : null
    if (metric === 'bmi') {
      const h = this.deps.getScaleProfile?.()?.height_cm
      return {
        metric,
        reading,
        stored: { value, source },
        calibrated: false,
        formula_bmi: formula == null ? null : Math.round(formula * 100) / 100,
        diff: formula == null ? null : Math.round((value - formula) * 100) / 100,
        implied_height_cm: Math.round(Math.sqrt(row.kg / value) * 1000) / 10,
        profile_height_cm: typeof h === 'number' ? h : null,
        note: 'BMI is not calibrated: the difference is a height check (implied_height_cm is the height the reference BMI implies at this weight).',
      }
    }
    if (metric === 'fat_pct') {
      const model = this.recalibrateScale()
      const prov = provenanceOf(model)
      return {
        metric,
        reading,
        stored: { value, source },
        formula_value: formula == null ? null : Math.round(formula * 100) / 100,
        calibrated_value: formula == null ? null : applyModel(model, formula),
        residual: formula == null ? null : Math.round((value - applyModel(model, formula)) * 100) / 100,
        model,
        status: basisOf(model),
        label: calibrationNote(prov),
        note: noFormula ?? 'Manual fat pairs join the automatic HealthKit pairs; for the same weigh-in the manual value wins.',
      }
    }
    const model = this.refitMetric(metric)
    const cal = formula == null ? null : applyMetric(model, formula)
    return {
      metric,
      reading,
      stored: { value, source },
      formula_value: formula == null ? null : Math.round(formula * 10000) / 10000,
      calibrated_value: cal == null ? null : Math.round(cal * 1000) / 1000,
      residual: cal == null ? null : Math.round((value - cal) * 1000) / 1000,
      model,
      status: basisOf(model),
      note: noFormula,
    }
  }

  /** health__meal weighin_unpair: remove the manual value of one metric for
   *  the S400 weigh-in within 180 s of measured_at (a typo, the wrong metric,
   *  the wrong weigh-in), then refit that metric. Matches regardless of the
   *  reading's verdict, so a pair on an excluded reading can be taken back. */
  weighinUnpair(p: { measured_at?: unknown; metric?: unknown }): Record<string, unknown> {
    const metric = typeof p.metric === 'string' ? (p.metric.trim().toLowerCase() as MetricKey) : ('' as MetricKey)
    if (!PAIRABLE_METRICS.includes(metric) && metric !== 'lean_kg') throw new BadRequest(`metric must be one of ${PAIRABLE_METRICS.join(', ')}`)
    const t = typeof p.measured_at === 'string' ? Date.parse(p.measured_at) : NaN
    if (!Number.isFinite(t)) throw new BadRequest('measured_at must be the ISO time of the weigh-in (body.weighin meta measured_at)')
    const row = this.scaleCal.readingNear(new Date(t).toISOString())
    if (!row) throw new BadRequest(`no S400 weigh-in within ${PAIR_WINDOW_MS / 1000} s of ${new Date(t).toISOString()}`)
    const prev = this.scaleCal.refValue(row.uuid, metric)
    const removed = this.scaleCal.deleteRefValue(row.uuid, metric)
    const reading = { uuid: row.uuid, measured_at: row.measured_at, kg: row.kg, excluded: row.mass_excluded }
    if (!removed) return { metric, reading, removed: false, note: 'no manual value for that weigh-in and metric' }
    // bmi has no model; lean_kg (no longer pairable) only had legacy values.
    if (metric === 'bmi' || metric === 'lean_kg') return { metric, reading, removed: { value: prev?.value ?? null, source: prev?.source ?? null } }
    const model = metric === 'fat_pct' ? this.recalibrateScale() : this.refitMetric(metric)
    return { metric, reading, removed: { value: prev?.value ?? null, source: prev?.source ?? null }, model, status: basisOf(model) }
  }

  /** health__meal scale_calibration: the model, and per pair the Xiaomi
   *  value, the open-formula raw, the calibrated value, and the residual. */
  scaleCalibration(): {
    model: CalModel | null
    status: FatProvenance['status']
    reference: string | null
    readings: { total: number; with_impedance: number; paired: number }
    pairs: Array<{
      measured_at: string
      kg: number
      ref_source: string | null
      ref_fat_pct: number
      raw_pct: number
      /** The raw came from an old 0.1-point sample (backfill), not the formula. */
      raw_quantized: boolean
      calibrated_pct: number
      residual_pct: number
      in_fit: boolean
    }>
    note: string
    metrics: Record<
      string,
      {
        label: string
        unit: string
        formula: string
        model: CalModel | null
        status: MetricBasis
        pairs: Array<{
          measured_at: string
          reading_uuid: string
          source: string | null
          ref_value: number
          formula_value: number
          calibrated_value: number
          residual: number
          impedance_inferred: boolean
          in_fit: boolean
        }>
      }
    >
    bmi_checks: Array<{ measured_at: string; source: string; ref_bmi: number; formula_bmi: number | null; diff: number | null; implied_height_cm: number }>
    body_note: string
  } {
    const model = this.scaleModel()
    const rows = this.scaleCal.pairedReadings(100)
    const c = this.scaleCal.counts()
    const prov = provenanceOf(model)
    return {
      model,
      status: prov.status,
      reference: referenceName(model),
      readings: { total: c.readings ?? 0, with_impedance: c.with_impedance ?? 0, paired: c.paired ?? 0 },
      pairs: rows
        .filter((r) => r.fat_raw_pct != null && r.pair_fat_pct != null)
        .map((r, i) => {
          const cal = applyModel(model, r.fat_raw_pct!)
          return {
            measured_at: r.measured_at,
            kg: r.kg,
            ref_source: r.pair_source ?? null,
            ref_fat_pct: r.pair_fat_pct!,
            raw_pct: Math.round(r.fat_raw_pct! * 100) / 100,
            raw_quantized: r.raw_from_sample === 1,
            calibrated_pct: cal,
            residual_pct: Math.round((r.pair_fat_pct! - cal) * 100) / 100,
            in_fit: i < FIT_MAX_PAIRS,
          }
        }),
      note:
        'The S400 open formula differs from the reference app\'s; the calibrated value tracks the reference (status provisional = offset from 1-2 pairs; loo_rms_pct = the out-of-sample error). Manual fat values (weighin_pair) join the automatic pairs, ref_source names them. Fat % is a trend only, never a goal check.',
      metrics: this.metricCalibrationReport(),
      bmi_checks: this.scaleCal.refValues('bmi').map((r) => {
        const f = parseMetrics(r.metrics)?.values.bmi ?? null
        return {
          measured_at: r.measured_at,
          source: r.source,
          ref_bmi: r.value,
          formula_bmi: f == null ? null : Math.round(f * 100) / 100,
          diff: f == null ? null : Math.round((r.value - f) * 100) / 100,
          implied_height_cm: Math.round(Math.sqrt(r.kg / r.value) * 1000) / 10,
        }
      }),
      body_note:
        'Body composition beyond fat is Mi Scale formula estimates from weight + 50 kHz impedance + profile (trend only, never a measurement). muscle_kg is Xiaomi-style (fat-free mass minus bone, what Xiaomi Home calls muscle); smm_kg is Janssen skeletal muscle, a different, smaller quantity. Per metric: formula (no pair), provisional (offset from 1-2 manual pairs), calibrated (3+ pairs, loo_rms_pct in the metric\'s unit). BMI is never calibrated (a pair is a height check). No body age or body score (no published method).',
    }
  }

  /** Per-metric models and their manual pairs, with residuals. */
  private metricCalibrationReport(): ReturnType<FoodService['scaleCalibration']>['metrics'] {
    const models = this.metricModels()
    const out: ReturnType<FoodService['scaleCalibration']>['metrics'] = {}
    const notHis = this.notHisMassUuids()
    for (const k of CALIBRATED_METRICS) {
      const model = models[k] ?? null
      const pairs = this.metricPairs(k, notHis)
      const dp = (v: number) => Math.round(v * 1000) / 1000
      out[k] = {
        label: METRICS[k].label,
        unit: METRICS[k].unit,
        formula: METRICS[k].ref,
        model,
        status: basisOf(model),
        pairs: pairs.map((p, i) => {
          const cal = applyMetric(model, p.raw_pct)
          return {
            measured_at: p.measured_at,
            reading_uuid: p.reading_uuid,
            source: p.ref_source ?? null,
            ref_value: p.ref_fat_pct,
            formula_value: dp(p.raw_pct),
            calibrated_value: dp(cal),
            residual: dp(p.ref_fat_pct - cal),
            impedance_inferred: p.impedance_inferred,
            in_fit: i >= pairs.length - FIT_MAX_PAIRS,
          }
        }),
      }
    }
    return out
  }

  /** 7-day average of INCLUDED readings up to this one (n >= 3), and its
   *  change vs the 7 days before (when that week also has n >= 3). */
  avg7(tsIso: string): { kg: number; n: number; delta_kg: number | null; prev_kg: number | null } | null {
    const t = Date.parse(tsIso)
    const iso = (ms: number) => new Date(ms).toISOString()
    const cur = this.book.includedMassBetween(iso(t - 7 * 86_400_000), tsIso)
    if (cur.length < 3) return null
    const prev = this.book.includedMassBetween(iso(t - 14 * 86_400_000), iso(t - 7 * 86_400_000))
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
    const kg = Math.round(mean(cur) * 10) / 10
    const hasPrev = prev.length >= 3
    return {
      kg,
      n: cur.length,
      delta_kg: hasPrev ? Math.round((mean(cur) - mean(prev)) * 10) / 10 : null,
      prev_kg: hasPrev ? Math.round(mean(prev) * 10) / 10 : null,
    }
  }

  /** "creatine saturation through ~Dec 13, weight trend inflated; ..." */
  activeConfoundersLine(day: string): string | null {
    const active = this.confounderViews(day).filter((c) => c.status === 'active')
    return active.length ? active.map((c) => c.label).join('; ') : null
  }

  /** One body.weighin event per NEW weigh-in: a mass sample, merged with the
   *  fat sample of the same source and instant. Only recent ones (a first
   *  sync can carry years of history: those are archived, never announced),
   *  at most 3 per batch. */
  private announceWeighins(
    fresh: Array<{ uuid: string; ts: string; kind: 'mass' | 'fat'; value: number; source: string | null }>,
    now: number,
  ): void {
    const masses = fresh
      .filter((s) => s.kind === 'mass' && now - Date.parse(s.ts) <= WEIGHIN_RECENT_MS)
      .sort((a, b) => a.ts.localeCompare(b.ts))
      .slice(-WEIGHIN_MAX_PER_BATCH)
    const model = masses.some((m) => m.source === SCALE_SOURCE) ? this.scaleModel() : null
    const freshUuids = new Set(fresh.map((s) => s.uuid))
    for (const m of masses) {
      // One step-on the S400 measured twice is announced once: never the
      // copy that does not count, and never a later take of a step-on an
      // earlier batch already announced.
      const excluded = this.book.bodyExcluded(m.uuid)
      if (excluded === EXCL_REMEASURED || this.remeasureSiblings(m).some((o) => !freshUuids.has(o.uuid) && o.ts < m.ts)) continue
      const freshFat = fresh.find((s) => s.kind === 'fat' && s.ts === m.ts && s.source === m.source) ?? null
      // The label follows what THIS reading's sample carries (its own row),
      // never just the global model.
      const provenance =
        m.source === SCALE_SOURCE && freshFat ? readingProvenance(this.scaleCal.reading(readingStemOf(freshFat.uuid)), model) : null
      // The stored value: an S400 fat sample may have just been calibrated.
      const fat = freshFat ? { value: this.book.fatAt(m.ts, m.source) ?? freshFat.value } : null
      // An outlier still names how far off it is (vs the last included reading).
      const prev = !excluded || excluded === EXCL_OUTLIER ? this.book.previousMass(m.ts) : null
      // Maybe someone else's (filed as not his, or a possible other person):
      // never his composition line either, as on the Body tab.
      const notHis = mayNotBeHis(excluded)
      const extras = {
        ...(excluded
          ? {}
          : { avg7: this.avg7(m.ts), confounders: this.activeConfoundersLine(foodDay(Date.parse(m.ts), this.deps.getConfig().rollover_hour)) }),
        ...(provenance ? { fatCalibration: provenance } : {}),
        ...(m.source === SCALE_SOURCE && !notHis ? { body: this.bodyLineFor(m.uuid, freshFat ? (this.book.fatAt(m.ts, m.source) ?? freshFat.value) : null) } : {}),
        ...(excluded === EXCL_NOT_HIS ? { notHisOffKg: this.notHisOffKg(m) } : {}),
      }
      this.deps.emit('body.weighin', `body.weighin:${m.source ?? '?'}:${m.ts}`, weighinEvent(m, fat, prev, excluded, extras))
    }
  }

  /** The body.weighin extra line of one S400 reading (visceral + muscle). */
  private bodyLineFor(massUuid: string, fatSample: number | null): { line: string; visceral?: number; muscle_kg?: number } | null {
    const row = this.scaleCal.reading(readingStemOf(massUuid))
    if (!row) return null
    const views = this.readingViews(row, this.metricModels(), this.scaleModel(), fatSample)
    const line = bodyEventLine(views)
    if (!line) return null
    const v = views.find((x) => x.key === 'visceral')
    const mu = views.find((x) => x.key === 'muscle_kg')
    return { line, ...(v ? { visceral: v.value } : {}), ...(mu ? { muscle_kg: mu.value } : {}) }
  }

  // ── HTTP (mounted on the live listener, behind its token) ───────

  async handleHttp(req: Request, url: URL): Promise<Response | null> {
    const path = url.pathname
    try {
      if (req.method === 'POST' && path === '/meal') {
        return Response.json(await this.logFromApp(await jsonBody(req, MAX_JSON_BYTES)))
      }
      if (req.method === 'POST' && path === '/meal/fix') {
        return Response.json(this.fixFromApp(await jsonBody(req, MAX_JSON_BYTES)))
      }
      if (req.method === 'POST' && path === '/meal/photos') {
        return Response.json(await this.addPhotosFromApp(await jsonBody(req, MAX_JSON_BYTES)))
      }
      if (req.method === 'GET' && path === '/meals') {
        return Response.json(this.day(url.searchParams.get('date'), { forPhone: true }))
      }
      if (req.method === 'GET' && path === '/meals/history') {
        return Response.json(this.history(url.searchParams.get('days')))
      }
      if (req.method === 'GET' && path === '/meal-photo') {
        return this.servePhoto(url)
      }
      if (req.method === 'GET' && path === '/body') {
        return Response.json(bodyPage(this))
      }
    } catch (err) {
      if (err instanceof BadRequest) return Response.json({ error: err.message }, { status: 400 })
      this.log(`food http ${req.method} ${path} failed: ${err}`)
      return Response.json({ error: 'internal error' }, { status: 500 })
    }
    return null
  }

  private servePhoto(url: URL): Response {
    const id = Number(url.searchParams.get('meal'))
    const n = Number(url.searchParams.get('n') ?? 0)
    if (!Number.isInteger(id) || !Number.isInteger(n)) return Response.json({ error: 'bad photo ref' }, { status: 400 })
    const meal = this.book.getMeal(id)
    const photo = meal?.photos.find((p) => p.idx === n)
    if (!photo) return Response.json({ error: 'no such photo' }, { status: 404 })
    const file = url.searchParams.get('thumb') === '1' ? photo.thumb_path : photo.path
    try {
      return new Response(readFileSync(file), {
        headers: { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=31536000, immutable' },
      })
    } catch {
      return Response.json({ error: 'photo file missing' }, { status: 404 })
    }
  }

  // ── events ──────────────────────────────────────────────────────

  private changed(date: string): void {
    try {
      this.deps.broadcast({ type: 'meals_updated', date })
    } catch (err) {
      this.log(`meals_updated push failed: ${err}`)
    }
  }

  private dayLine(date: string): string {
    const d = this.day(date)
    const cfg = this.deps.getConfig()
    const target = d.targets.kcal
    return `Day so far (${date}): ${kcalText(d.totals.kcal, d.totals.kcal_lo, d.totals.kcal_hi)}${target ? ` of ${fmtK(target)} budget` : ' (baseline phase, no kcal target yet)'}, ${fmtG(d.totals.protein_g)} of ${cfg.protein_target_g} g protein, ${d.totals.pending} meal(s) awaiting an estimate.`
  }

  private presetHint(text: string | null): string {
    const matches = text ? this.book.matchPresets(text) : []
    if (matches.length) {
      return ` Saved presets that match the note: ${matches.map((p) => `${p.slug} ("${p.name}", ${fmtK(p.totals.kcal)} kcal, ${fmtG(p.totals.protein_g)} protein)`).join('; ')}. Use {preset, servings} items for these.`
    }
    const n = this.book.listPresets().length
    return n ? ` ${n} saved preset(s) exist (health__meal preset_list).` : ''
  }

  loggedEvent(meal: Meal): { content: string; meta: Record<string, string> } {
    const when = new Date(meal.eaten_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    const photoLine = meal.photos.length
      ? ` Photo${meal.photos.length > 1 ? 's' : ''}: ${meal.photos.map((p) => p.path).join(', ')} (Read to view).`
      : ' No photo: estimate from the note.'
    const content =
      `Meal #${meal.id} logged on the phone at ${when}.` +
      (meal.note ? ` Note: "${meal.note}".` : '') +
      photoLine +
      ` ${this.dayLine(meal.date)}` +
      this.presetHint(meal.note) +
      ` Estimate it, write it back with health__meal action=estimate meal_id=${meal.id} expected_revision=${meal.revision}, then answer in chat with the per-item read (kcal range + protein).`
    return {
      content,
      meta: {
        class: 'meal.logged',
        meal_id: String(meal.id),
        kind: meal.photos.length ? 'photo' : 'text',
        date: meal.date,
        ...(meal.photos[0] ? { photo: meal.photos[0].path } : {}),
        ...(meal.photos.length > 1 ? { photos: meal.photos.map((p) => p.path).join(',') } : {}),
      },
    }
  }

  photosAddedEvent(meal: Meal, added: number): { content: string; meta: Record<string, string> } {
    const fresh = meal.photos.slice(-added)
    const current =
      meal.status === 'estimated'
        ? ` Current estimate (rev ${meal.revision}): "${meal.label}" ${kcalText(meal.kcal, meal.kcal_lo, meal.kcal_hi)}, ${fmtG(meal.protein_g)} protein.`
        : ' It has not been estimated yet.'
    return {
      content:
        `${added} more photo${added > 1 ? 's' : ''} added from the phone to meal #${meal.id}: ${fresh.map((p) => p.path).join(', ')} (Read to view; all photos: ${meal.photos.map((p) => p.path).join(', ')}).${current}` +
        ` Re-estimate with health__meal action=estimate meal_id=${meal.id} expected_revision=${meal.revision} (full item list) if the new photos change it, and say so in chat; if they change nothing, one line.`,
      meta: {
        class: 'meal.amended',
        meal_id: String(meal.id),
        date: meal.date,
        revision: String(meal.revision),
        photos_added: String(added),
      },
    }
  }

  amendedEvent(meal: Meal, text: string): { content: string; meta: Record<string, string> } {
    const current =
      meal.status === 'estimated'
        ? ` Current estimate (rev ${meal.revision}): "${meal.label}" ${kcalText(meal.kcal, meal.kcal_lo, meal.kcal_hi)}, ${fmtG(meal.protein_g)} protein; items: ${meal.items.map((i) => `${i.name}${i.grams != null ? ` ${i.grams} g` : ''} ${fmtK(i.kcal)} kcal`).join('; ')}.`
        : ' It has not been estimated yet.'
    const photos = meal.photos.length ? ` Photo(s): ${meal.photos.map((p) => p.path).join(', ')}.` : ''
    return {
      content:
        `Correction from the phone for meal #${meal.id}: "${text}".${current}${photos}` +
        this.presetHint(`${meal.note ?? ''} ${text}`) +
        ` Re-estimate with health__meal action=estimate meal_id=${meal.id} expected_revision=${meal.revision} (full corrected item list), or action=void if it should not count. Confirm in chat.`,
      meta: { class: 'meal.amended', meal_id: String(meal.id), date: meal.date, revision: String(meal.revision) },
    }
  }
}

// ── helpers ───────────────────────────────────────────────────────

const cleanNote = (v: unknown) => cleanText(v, 300)

function labelOf(v: unknown, items: Array<{ name: string }>): string {
  if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 80)
  return items.map((i) => i.name).join(' + ').slice(0, 80)
}

const MAX_JSON_BYTES = 6 * 12 * 1024 * 1024 // six base64 photos at the phone's cap, plus slack


function decodePhotos(body: Record<string, unknown>): Uint8Array[] {
  const raw = Array.isArray(body.photos) ? body.photos : body.photo != null ? [body.photo] : []
  if (raw.length > MAX_PHOTOS_PER_MEAL) throw new BadRequest(`at most ${MAX_PHOTOS_PER_MEAL} photos per meal`)
  return raw.map((b64, i) => {
    if (typeof b64 !== 'string' || b64.length < 100) throw new BadRequest(`photos[${i}] must be base64 image data`)
    const buf = Buffer.from(b64, 'base64')
    if (buf.length < 100) throw new BadRequest(`photos[${i}] is not valid base64`)
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.length)
  })
}
