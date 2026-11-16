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
import { BadRequest, cleanText, jsonBody } from './http.js'
export { BadRequest } from './http.js'
import type { HealthConfig } from './types.js'

export const MAX_PHOTOS_PER_MEAL = PHOTO_MAX_PER_MEAL
const MAX_BODY_SAMPLES = 5000

type FoodConfig = HealthConfig['food']

export interface FoodDeps {
  db: Database
  photosDir: string
  getConfig: () => FoodConfig
  getMeta: (k: string) => string | null
  setMeta: (k: string, v: string) => void
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
const EXCL_OUTLIER = 'possible other person'
const EXCL_AFTER_MEAL = 'after a meal'
const EXCL_REPLAY = 'possible replay'
/** The date rule's own prefix: a weighins_from change re-decides exactly these. */
const EXCL_DATE_RULE = `${EXCL_TEST}before the first fasted weigh-in`
/** Replay guard tolerance: identical to the scale's resolution. */
const REPLAY_KG = 0.005
const REPLAY_FAT = 0.00005
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

/** "Creatine start" -> "creatine_start": the one spelling add and close share. */
function normKind(k: unknown): string {
  return typeof k === 'string' ? k.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) : ''
}
function dayStartIso(ms: number): string {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString()
}
export function inMorningWindow(ms: number): boolean {
  const d = new Date(ms)
  const min = d.getHours() * 60 + d.getMinutes()
  return min >= MORNING_FROM_MIN && min < MORNING_TO_MIN
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
  extras: { avg7?: { kg: number; n: number; delta_kg: number | null } | null; confounders?: string | null } = {},
): { content: string; meta: Record<string, string> } {
  const t = new Date(m.ts)
  // The zone label is only claimed when true (the Mac on WIB, UTC+7).
  const hhmm = `${t.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}${t.getTimezoneOffset() === -420 ? '' : ' local'}`
  const kg = m.value.toFixed(1)
  const fatPct = fat ? (fat.value * 100).toFixed(1) : null
  const src = m.source ?? 'unknown source'
  let content = `Weigh-in ${hhmm.endsWith(' local') ? hhmm : `${hhmm} WIB`}: ${kg} kg${fatPct ? `, ${fatPct}% fat` : ''} (${src}).`
  if (excluded) {
    content += excluded.startsWith(EXCL_TEST)
      ? ` Test reading, excluded (${excluded.slice(EXCL_TEST.length)}).`
      : excluded === EXCL_NOT_MORNING
        ? ' Not a morning reading, excluded from the trend.'
        : excluded === EXCL_REPEAT
          ? ' Repeat reading this morning, excluded from the trend (the first one counts).'
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
  const a = excluded ? null : extras.avg7
  if (a) {
    const d = a.delta_kg
    content += ` 7-day average ${a.kg.toFixed(1)} kg over ${a.n} readings${d != null ? ` (${d >= 0 ? '+' : '-'}${Math.abs(d).toFixed(1)} kg vs the 7 days before)` : ''}.`
  }
  const conf = excluded ? null : extras.confounders
  if (conf) content += ` Confounders: ${conf}.`
  const meta: Record<string, string> = { kg, measured_at: m.ts, source: src }
  if (fatPct) meta.fat_pct = fatPct
  if (excluded) meta.excluded = excluded
  if (a) {
    meta.avg7_kg = a.kg.toFixed(1)
    meta.avg7_n = String(a.n)
    if (a.delta_kg != null) meta.avg7_delta_kg = a.delta_kg.toFixed(1)
  }
  if (conf) meta.confounders = conf
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

export class FoodService {
  readonly book: MealBook
  readonly confounders: ConfounderBook
  private now: () => number
  private log: (msg: string) => void

  constructor(private deps: FoodDeps) {
    this.book = new MealBook(deps.db)
    this.confounders = new ConfounderBook(deps.db)
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
    const start = this.book.photoCount(meal.id)
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
    const clientId = typeof body.client_id === 'string' ? body.client_id.trim() : ''
    if (!/^[A-Za-z0-9-]{8,64}$/.test(clientId)) throw new BadRequest('client_id (8-64 chars, UUID) is required')
    const running = this.inflight.get(clientId)
    if (running) return running.then((r) => ({ ...r, duplicate: true }))
    const existing = this.book.getByClientId(clientId)
    if (existing) return { meal_id: existing.id, duplicate: true, date: existing.date }
    const job = this.ingestAppMeal(clientId, body)
    this.inflight.set(clientId, job)
    try {
      return await job
    } finally {
      this.inflight.delete(clientId)
    }
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
   *  meal log both ways (re-running the rules lifts and re-decides them). */
  private afterMealWrite(): void {
    try {
      this.reclassifyWeighins()
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

  /** Config changed (config_set): a new weighins_from re-decides the date rule. */
  onConfigChanged(prev: FoodConfig, next: FoodConfig): void {
    if ((prev.weighins_from ?? null) !== (next.weighins_from ?? null)) {
      this.reclassifyWeighins({ dateRuleChanged: true })
      this.changed(this.today())
    }
  }

  targetKcal(): number | null {
    const v = Number(this.deps.getMeta('food_target_kcal') || NaN)
    return Number.isFinite(v) && v > 0 ? v : null
  }

  latestWeight(): { kg: number; at: string; fat_pct: number | null } | null {
    const since = new Date(this.now() - 30 * 86_400_000).toISOString()
    const s = this.book.bodySamplesSince(since)
    const mass = s.filter((x) => x.kind === 'mass').at(-1)
    if (!mass) return null
    const fat = s.filter((x) => x.kind === 'fat').at(-1)
    return { kg: Math.round(mass.value * 10) / 10, at: mass.ts, fat_pct: fat ? Math.round(fat.value * 1000) / 10 : null }
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

  ingestBodySamples(raw: unknown, rawDeleted: unknown): { received: number; added: number; deleted: number } | null {
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
    const known = this.book.unknownBodyUuids(clean.map((s) => s.uuid))
    const freshRows = clean.filter((s) => known.has(s.uuid))
    const added = this.book.upsertBodySamples(clean, nowIso)
    // Deletions FIRST: a reading he removed in Apple Health must not make his
    // re-weigh in the same batch a "repeat" (or an outlier reference).
    const removed = this.book.deleteBodySamples(deleted)
    this.reclassifyWeighins()
    if (added > 0 || removed > 0) this.changed(this.today())
    this.announceWeighins(freshRows, now)
    return { received: clean.length, added, deleted: removed }
  }

  private manualIncludes(): Set<string> {
    try {
      const v = JSON.parse(this.deps.getMeta(MANUAL_INCLUDE_META) ?? '[]')
      return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
    } catch {
      return new Set()
    }
  }

  /** Recent weigh-ins (excluded ones too) for review: one row per weigh-in. */
  weighins(days = 14): Array<{ measured_at: string; kg: number; fat_pct: number | null; source: string | null; excluded: string | null; uuids: string[] }> {
    const since = new Date(this.now() - Math.max(1, Math.min(days, 365)) * 86_400_000).toISOString()
    const rows = this.book.bodySamplesAll(since)
    const out: Array<{ measured_at: string; kg: number; fat_pct: number | null; source: string | null; excluded: string | null; uuids: string[] }> = []
    for (const m of rows.filter((r) => r.kind === 'mass')) {
      const fat = rows.find((r) => r.kind === 'fat' && r.ts === m.ts && r.source === m.source) ?? null
      out.push({
        measured_at: m.ts,
        kg: m.value,
        fat_pct: fat ? Math.round(fat.value * 1000) / 10 : null,
        source: m.source,
        excluded: m.excluded,
        uuids: fat ? [m.uuid, fat.uuid] : [m.uuid],
      })
    }
    return out
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
    let pair: Array<{ uuid: string; ts: string; kind: string; value: number; source: string | null }> = []
    if (typeof p.uuid === 'string' && p.uuid.length >= 8) {
      const row = this.book.bodySampleByUuid(p.uuid)
      if (row) pair = this.book.weighinNear(row.ts, 0)
    } else if (typeof p.measured_at === 'string' && Number.isFinite(Date.parse(p.measured_at))) {
      pair = this.book.weighinNear(new Date(Date.parse(p.measured_at)).toISOString(), 3 * 60_000)
    } else {
      throw new BadRequest('give uuid or measured_at (ISO time of the weigh-in)')
    }
    if (!pair.length) return { changed: 0, weighin: null }
    let reason = p.include ? null : cleanText(p.reason, 120, false) || 'excluded by hand'
    // A hand verdict must never look like a derived one the next pass lifts.
    if (reason === EXCL_AFTER_MEAL || reason === EXCL_REPLAY) reason = `${reason} (by hand)`
    const changed = this.book.setBodyExcluded(pair.map((r) => r.uuid), reason)
    // Remember manual INCLUDES, so the re-classification pass never excludes
    // them again (an exclusion carries its own reason and needs no memory).
    const manual = this.manualIncludes()
    for (const r of pair) {
      if (p.include) manual.add(r.uuid)
      else manual.delete(r.uuid)
    }
    this.deps.setMeta(MANUAL_INCLUDE_META, JSON.stringify([...manual].slice(-500)))
    this.changed(this.today())
    const mass = pair.find((r) => r.kind === 'mass') ?? null
    return { changed, weighin: { measured_at: pair[0].ts, kg: mass?.value ?? null, excluded: reason } }
  }

  /** Exclusion rules, applied to every reading that currently COUNTS, in
   *  time order (stored ones too: rows synced before the rules existed, or
   *  before weighins_from was set). Manual includes are never re-excluded;
   *  an exclusion is never lifted automatically, except the derived ones
   *  below (after a meal, possible replay) and the date rule on a
   *  weighins_from change. In order:
   *  1. date rule: before food.weighins_from = a TEST reading;
   *  2. window: measured outside 03:30-09:00 local = not a morning reading;
   *  3. outlier: far from the last counted reading = possible other person
   *     (from 3 earlier counted readings; two agreeing days = a real shift);
   *  4. repeat: a morning reading already counts for that day (the FIRST one).
   *  A fat sample shares its mass sample's verdict (same source + instant).
   *  Energy-balance release (in order, after the window rule):
   *  replay: identical to the previous reading in BOTH mass and fat;
   *  after a meal: a meal was eaten before it, on its food day and its own
   *  morning (from the later of the food-day start and local 03:30).
   *  These two are re-decided on every pass (they follow the data). */
  reclassifyWeighins(opts: { dateRuleChanged?: boolean } = {}): void {
    // A new weighins_from re-decides the date rule's own verdicts (and only
    // those).
    if (opts.dateRuleChanged) this.book.liftExclusions(EXCL_DATE_RULE)
    const rollover = this.deps.getConfig().rollover_hour
    const sinceIso = new Date(this.now() - 400 * 86_400_000).toISOString()
    // "after a meal" and "possible replay" are derived from data that can
    // change under them (a meal voided or re-timed, a reference reading
    // deleted): lift them and let this pass re-decide (manual verdicts carry
    // their own reasons and are never touched).
    this.book.liftExactExclusions([EXCL_AFTER_MEAL, EXCL_REPLAY], sinceIso)
    const from = this.deps.getConfig().weighins_from ?? null
    const validFrom = isDayKey(from) ? from : null
    const manual = this.manualIncludes()
    // Every reading that currently COUNTS, oldest first (bounded to ~13
    // months), minus the ones he included by hand: stored rows from before the
    // rules existed, or before weighins_from was set, get classified too.
    const counting = this.book.includedSamplesSince(sinceIso)
    const masses = counting.filter((s) => s.kind === 'mass' && !manual.has(s.uuid))
    for (const m of masses) {
      const ms = Date.parse(m.ts)
      const day = foodDay(ms, 0)
      let reason: string | null = null
      if (validFrom && day < validFrom) {
        const label = new Date(`${validFrom}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
        reason = `${EXCL_DATE_RULE} on ${label}`
      } else if (!inMorningWindow(ms)) {
        reason = EXCL_NOT_MORNING
      } else if (this.isReplay(m)) {
        // A re-synced copy of the previous reading must never count twice.
        reason = EXCL_REPLAY
      } else if (this.book.mealBetween(new Date(fastedFromMs(ms, rollover)).toISOString(), m.ts)) {
        reason = EXCL_AFTER_MEAL
      } else if (isOutlier(this.book, m)) {
        // BEFORE the repeat rule: a friend stepping on first must never
        // count and push his real reading out as the "repeat".
        reason = EXCL_OUTLIER
      } else if (this.book.includedMassOnDayBefore(dayStartIso(ms), m.ts)) {
        reason = EXCL_REPEAT
      }
      if (!reason) continue
      const pair = counting.filter((s) => s.ts === m.ts && s.source === m.source).map((s) => s.uuid)
      this.book.setBodyExcluded(pair, reason)
    }
  }

  /** Identical to the previous reading (any verdict) in BOTH mass and fat. */
  private isReplay(m: { ts: string; value: number; source: string | null }): boolean {
    const prev = this.book.previousMassAny(m.ts)
    if (!prev || prev.fat == null) return false
    const fat = this.book.fatAt(m.ts, m.source)
    if (fat == null) return false
    return Math.abs(prev.value - m.value) < REPLAY_KG && Math.abs(prev.fat - fat) < REPLAY_FAT
  }

  /** 7-day average of INCLUDED readings up to this one (n >= 3), and its
   *  change vs the 7 days before (when that week also has n >= 3). */
  avg7(tsIso: string): { kg: number; n: number; delta_kg: number | null } | null {
    const t = Date.parse(tsIso)
    const iso = (ms: number) => new Date(ms).toISOString()
    const cur = this.book.includedMassBetween(iso(t - 7 * 86_400_000), tsIso)
    if (cur.length < 3) return null
    const prev = this.book.includedMassBetween(iso(t - 14 * 86_400_000), iso(t - 7 * 86_400_000))
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
    const kg = Math.round(mean(cur) * 10) / 10
    return { kg, n: cur.length, delta_kg: prev.length >= 3 ? Math.round((mean(cur) - mean(prev)) * 10) / 10 : null }
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
    for (const m of masses) {
      const fat = fresh.find((s) => s.kind === 'fat' && s.ts === m.ts && s.source === m.source) ?? null
      const excluded = this.book.bodyExcluded(m.uuid)
      // An outlier still names how far off it is (vs the last included reading).
      const prev = !excluded || excluded === EXCL_OUTLIER ? this.book.previousMass(m.ts) : null
      const extras = excluded
        ? {}
        : { avg7: this.avg7(m.ts), confounders: this.activeConfoundersLine(foodDay(Date.parse(m.ts), this.deps.getConfig().rollover_hour)) }
      this.deps.emit('body.weighin', `body.weighin:${m.source ?? '?'}:${m.ts}`, weighinEvent(m, fat, prev, excluded, extras))
    }
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
      if (req.method === 'GET' && path === '/meals') {
        return Response.json(this.day(url.searchParams.get('date'), { forPhone: true }))
      }
      if (req.method === 'GET' && path === '/meal-photo') {
        return this.servePhoto(url)
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
