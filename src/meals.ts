// Food log: meals, items, presets, weigh-ins, and the maintenance baseline.
//
// Contract highlights (the parts other code leans on):
// - A meal's item list is only ever FULLY REPLACED (estimate). A correction is
//   a re-send of the whole corrected list; revision++ and the previous list is
//   kept in meal_revisions. Callers pass expected_revision so two sessions
//   estimating the same meal cannot silently overwrite each other.
// - Totals and ranges are ALWAYS computed here from items; no caller ever
//   supplies a total, so the cached sums on meals cannot drift from the items.
// - The food day rolls over at rollover_hour local time (default 04:00): a
//   00:30 dinner belongs to the previous day. Weigh-ins use the same day key.
// - Presets are expanded at write time (numbers copied onto the item), so
//   editing a preset later never rewrites a meal already logged.

import type { Database } from 'bun:sqlite'
import { ensureScaleReadingsSchema } from './scalecal.js'

export const FOOD_SCHEMA = `
CREATE TABLE IF NOT EXISTS meals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT UNIQUE,
  source TEXT NOT NULL,
  logged_at TEXT NOT NULL,
  eaten_at TEXT NOT NULL,
  date TEXT NOT NULL,
  note TEXT,
  label TEXT,
  status TEXT NOT NULL,
  confidence TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  kcal REAL, kcal_lo REAL, kcal_hi REAL,
  protein_g REAL, carbs_g REAL, fat_g REAL,
  estimated_at TEXT,
  fix_text TEXT, fix_at TEXT,
  void_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_meals_date ON meals (date);
CREATE TABLE IF NOT EXISTS meal_photos (
  meal_id INTEGER NOT NULL,
  idx INTEGER NOT NULL,
  path TEXT NOT NULL,
  thumb_path TEXT NOT NULL,
  PRIMARY KEY (meal_id, idx)
);
CREATE TABLE IF NOT EXISTS meal_items (
  meal_id INTEGER NOT NULL,
  idx INTEGER NOT NULL,
  name TEXT NOT NULL,
  grams REAL,
  kcal REAL NOT NULL, kcal_lo REAL NOT NULL, kcal_hi REAL NOT NULL,
  protein_g REAL NOT NULL, carbs_g REAL, fat_g REAL,
  preset_slug TEXT, servings REAL,
  PRIMARY KEY (meal_id, idx)
);
CREATE TABLE IF NOT EXISTS meal_revisions (
  meal_id INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  label TEXT,
  items_json TEXT NOT NULL,
  at TEXT NOT NULL,
  reason TEXT,
  PRIMARY KEY (meal_id, revision)
);
CREATE TABLE IF NOT EXISTS meal_presets (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  aliases_json TEXT NOT NULL,
  items_json TEXT NOT NULL,
  uses INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS food_days (
  date TEXT PRIMARY KEY,
  complete INTEGER NOT NULL,
  set_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS body_samples (
  uuid TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  value REAL NOT NULL,
  source TEXT,
  received_at TEXT NOT NULL,
  excluded TEXT
);
CREATE INDEX IF NOT EXISTS idx_body_samples_ts ON body_samples (ts);
CREATE TABLE IF NOT EXISTS confounders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  date TEXT NOT NULL,
  details TEXT NOT NULL,
  window_end TEXT NOT NULL,
  closed_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (kind, date)
);
`

// ── types ─────────────────────────────────────────────────────────

export type MealSource = 'app' | 'chat'
export type MealStatus = 'pending' | 'estimated' | 'void'
export type Confidence = 'low' | 'medium' | 'high'

export interface MealItem {
  name: string
  grams: number | null
  kcal: number
  kcal_lo: number
  kcal_hi: number
  protein_g: number
  carbs_g: number | null
  fat_g: number | null
  preset_slug: string | null
  servings: number | null
}

export interface Totals {
  kcal: number
  kcal_lo: number
  kcal_hi: number
  protein_g: number
  carbs_g: number | null
  fat_g: number | null
}

export interface MealRow {
  id: number
  client_id: string | null
  source: MealSource
  logged_at: string
  eaten_at: string
  date: string
  note: string | null
  label: string | null
  status: MealStatus
  confidence: Confidence | null
  revision: number
  kcal: number | null
  kcal_lo: number | null
  kcal_hi: number | null
  protein_g: number | null
  carbs_g: number | null
  fat_g: number | null
  estimated_at: string | null
  fix_text: string | null
  fix_at: string | null
  void_reason: string | null
}

export interface MealPhoto {
  idx: number
  path: string
  thumb_path: string
}

export interface Meal extends MealRow {
  items: MealItem[]
  photos: MealPhoto[]
}

export interface Preset {
  slug: string
  name: string
  aliases: string[]
  items: MealItem[]
  totals: Totals
  uses: number
}

// ── pure helpers (unit tested) ────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, '0')

/** Local food-day key: the calendar date of (t - rolloverHour). */
export function foodDay(ms: number, rolloverHour: number): string {
  const d = new Date(ms - rolloverHour * 3_600_000)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function isDayKey(s: unknown): s is string {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s))
}

/** Day key arithmetic on YYYY-MM-DD (UTC math: no DST or offset involved). */
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000)
}

const round1 = (n: number) => Math.round(n * 10) / 10

function num(v: unknown, field: string, min: number, max: number): number {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new Error(`${field} must be a number`)
  if (n < min || n > max) throw new Error(`${field} out of range (${min}-${max}): ${n}`)
  return n
}

function optNum(v: unknown, field: string, min: number, max: number): number | null {
  return v == null || v === '' ? null : num(v, field, min, max)
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

export function totalsOf(items: MealItem[]): Totals {
  const sum = (f: (i: MealItem) => number) => round1(items.reduce((n, i) => n + f(i), 0))
  // Carbs / fat are optional per item: a total is only honest when every item has it.
  const sumOpt = (f: (i: MealItem) => number | null) =>
    items.length > 0 && items.every((i) => f(i) != null) ? round1(items.reduce((n, i) => n + (f(i) ?? 0), 0)) : null
  return {
    kcal: sum((i) => i.kcal),
    kcal_lo: sum((i) => i.kcal_lo),
    kcal_hi: sum((i) => i.kcal_hi),
    protein_g: sum((i) => i.protein_g),
    carbs_g: sumOpt((i) => i.carbs_g),
    fat_g: sumOpt((i) => i.fat_g),
  }
}

/**
 * Validate caller items and expand preset references. `preset` + optional
 * `servings` pulls the numbers from the saved preset (scaled); explicit
 * numbers on a preset item are ignored, so a preset means one thing.
 */
export function normalizeItems(
  raw: unknown,
  getPreset: (slug: string) => Preset | null,
): MealItem[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('items must be a non-empty array')
  if (raw.length > 40) throw new Error('too many items (max 40)')
  return raw.map((r, idx) => {
    if (typeof r !== 'object' || r == null) throw new Error(`items[${idx}] must be an object`)
    const o = r as Record<string, unknown>
    const at = `items[${idx}]`
    if (o.preset != null && o.preset !== '') {
      const slug = String(o.preset)
      const p = getPreset(slug)
      if (!p) throw new Error(`${at}: unknown preset "${slug}" (see action preset_list)`)
      const servings = o.servings == null ? 1 : num(o.servings, `${at}.servings`, 0.05, 20)
      const t = p.totals
      const scale = (n: number | null) => (n == null ? null : round1(n * servings))
      const grams = p.items.every((i) => i.grams != null)
        ? round1(p.items.reduce((n, i) => n + (i.grams ?? 0), 0) * servings)
        : null
      return {
        name: typeof o.name === 'string' && o.name.trim() ? o.name.trim().slice(0, 80) : p.name,
        grams,
        kcal: round1(t.kcal * servings),
        kcal_lo: round1(t.kcal_lo * servings),
        kcal_hi: round1(t.kcal_hi * servings),
        protein_g: round1(t.protein_g * servings),
        carbs_g: scale(t.carbs_g),
        fat_g: scale(t.fat_g),
        preset_slug: p.slug,
        servings,
      }
    }
    const name = typeof o.name === 'string' ? o.name.trim().slice(0, 80) : ''
    if (!name) throw new Error(`${at}.name is required`)
    const kcal = num(o.kcal, `${at}.kcal`, 0, 5000)
    let lo = optNum(o.kcal_lo, `${at}.kcal_lo`, 0, 5000) ?? kcal
    let hi = optNum(o.kcal_hi, `${at}.kcal_hi`, 0, 6000) ?? kcal
    if (lo > kcal) lo = kcal
    if (hi < kcal) hi = kcal
    return {
      name,
      grams: optNum(o.grams, `${at}.grams`, 0, 5000),
      kcal: round1(kcal),
      kcal_lo: round1(lo),
      kcal_hi: round1(hi),
      protein_g: round1(num(o.protein_g ?? 0, `${at}.protein_g`, 0, 400)),
      carbs_g: optNum(o.carbs_g, `${at}.carbs_g`, 0, 800),
      fat_g: optNum(o.fat_g, `${at}.fat_g`, 0, 400),
      preset_slug: null,
      servings: null,
    }
  })
}

export function parseConfidence(v: unknown): Confidence | null {
  return v === 'low' || v === 'medium' || v === 'high' ? v : null
}

// ── baseline math (pure, unit tested) ─────────────────────────────

export interface BaselineDay {
  date: string
  kcal: number
  kcal_lo: number
  kcal_hi: number
  complete: boolean
  /** Meals logged but not yet estimated (their kcal is missing from the sums). */
  pending?: number
}

export interface BaselineOpts {
  today: string // current food day; excluded (still in progress)
  windowDays: number // look-back window ending yesterday
  minCompleteDays: number
  minWeighIns: number
  minWeighSpanDays: number
  kcalPerKg: number
  deficitKcal: number
}

export const BASELINE_DEFAULTS: Omit<BaselineOpts, 'today' | 'deficitKcal'> = {
  windowDays: 28,
  minCompleteDays: 14,
  minWeighIns: 8,
  minWeighSpanDays: 14,
  kcalPerKg: 7700,
}

export interface Baseline {
  ready: boolean
  window: { from: string; to: string }
  complete_days: number
  logged_days: number
  weigh_ins: number
  weigh_span_days: number
  needs: string[] // what is still missing before a target exists
  mean_intake: number | null
  mean_intake_lo: number | null
  mean_intake_hi: number | null
  weight_trend_kg_per_week: number | null
  weight_trend_se_kg_per_week: number | null
  weekly_weights: Array<{ week_from: string; avg_kg: number; n: number }>
  maintenance: number | null
  maintenance_lo: number | null
  maintenance_hi: number | null
  suggested_target: number | null
  whoop_kcal_avg: number | null
  whoop_days: number
}

/** Ordinary least squares slope + its standard error. */
export function olsSlope(xs: number[], ys: number[]): { slope: number; se: number } | null {
  const n = xs.length
  if (n < 3) return null
  const mx = xs.reduce((a, b) => a + b, 0) / n
  const my = ys.reduce((a, b) => a + b, 0) / n
  let sxx = 0
  let sxy = 0
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) ** 2
    sxy += (xs[i] - mx) * (ys[i] - my)
  }
  if (sxx === 0) return null
  const slope = sxy / sxx
  let sse = 0
  for (let i = 0; i < n; i++) sse += (ys[i] - (my + slope * (xs[i] - mx))) ** 2
  const se = Math.sqrt(sse / (n - 2) / sxx)
  return { slope, se }
}

/** Mean logged intake over complete days in [from, to]. */
export function completeIntake(
  days: BaselineDay[],
  from: string,
  to: string,
): { n: number; logged: number; mean: number | null; lo: number | null; hi: number | null } {
  const logged = days.filter((d) => d.date >= from && d.date <= to && d.kcal > 0)
  const complete = logged.filter((d) => d.complete)
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
  return {
    n: complete.length,
    logged: logged.length,
    mean: mean(complete.map((d) => d.kcal)),
    lo: mean(complete.map((d) => d.kcal_lo)),
    hi: mean(complete.map((d) => d.kcal_hi)),
  }
}

/** OLS over DAILY MEAN weights in [from, to] (kg per day, x = days since from). */
export function weightFit(
  weights: Array<{ date: string; kg: number }>,
  from: string,
  to: string,
): { slope: number; se: number } | null {
  const byDay = new Map<string, number[]>()
  for (const x of weights) {
    if (x.date < from || x.date > to || !(x.kg > 20 && x.kg < 400)) continue
    byDay.set(x.date, [...(byDay.get(x.date) ?? []), x.kg])
  }
  const dailyDates = [...byDay.keys()].sort()
  const xs = dailyDates.map((d) => daysBetween(from, d))
  const ys = dailyDates.map((d) => byDay.get(d)!.reduce((a, b) => a + b, 0) / byDay.get(d)!.length)
  return olsSlope(xs, ys)
}

/**
 * maintenance = mean intake on complete days - weight slope (kg/day) x 7,700.
 * The slope is OLS over DAILY MEAN weights across the window: every weigh-in
 * pulls on the fit, so a ~2 kg water / creatine swing on one morning moves it
 * far less than an endpoint-to-endpoint weekly comparison would. Weekly
 * averages are reported alongside for the human read.
 */
export function computeBaseline(
  days: BaselineDay[],
  weights: Array<{ date: string; kg: number }>, // raw weigh-ins, day-keyed
  whoop: Array<{ date: string; kcal: number }>,
  opts: BaselineOpts,
): Baseline {
  const to = addDays(opts.today, -1)
  const from = addDays(opts.today, -opts.windowDays)
  const inWindow = (d: string) => d >= from && d <= to

  const intake = completeIntake(days, from, to)
  const w = weights.filter((x) => inWindow(x.date) && x.kg > 20 && x.kg < 400)
  const wDates = [...new Set(w.map((x) => x.date))].sort()
  const span = wDates.length ? daysBetween(wDates[0], wDates[wDates.length - 1]) : 0

  const needs: string[] = []
  if (intake.n < opts.minCompleteDays)
    needs.push(`${opts.minCompleteDays - intake.n} more complete logged day(s)`)
  if (w.length < opts.minWeighIns) needs.push(`${opts.minWeighIns - w.length} more weigh-in(s)`)
  if (span < opts.minWeighSpanDays) needs.push(`weigh-ins spanning ${opts.minWeighSpanDays}+ days (now ${span})`)

  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
  const meanIntake = intake.mean
  const meanLo = intake.lo
  const meanHi = intake.hi
  const fit = weightFit(w, from, to)

  const weekly: Baseline['weekly_weights'] = []
  for (let start = from; start <= to; start = addDays(start, 7)) {
    const end = addDays(start, 6)
    const vals = w.filter((x) => x.date >= start && x.date <= end).map((x) => x.kg)
    if (vals.length) weekly.push({ week_from: start, avg_kg: round1(mean(vals)!), n: vals.length })
  }

  const whoopIn = whoop.filter((x) => inWindow(x.date) && x.kcal > 0)
  const whoopAvg = mean(whoopIn.map((x) => x.kcal))

  const ready = needs.length === 0 && meanIntake != null && fit != null
  let maintenance: number | null = null
  let mLo: number | null = null
  let mHi: number | null = null
  if (meanIntake != null && fit) {
    maintenance = Math.round(meanIntake - fit.slope * opts.kcalPerKg)
    // Band: the logging range (what each meal could plausibly have been) plus
    // one standard error of the weight trend, compounded in the same direction.
    mLo = Math.round((meanLo ?? meanIntake) - (fit.slope + fit.se) * opts.kcalPerKg)
    mHi = Math.round((meanHi ?? meanIntake) - (fit.slope - fit.se) * opts.kcalPerKg)
  }

  return {
    ready,
    window: { from, to },
    complete_days: intake.n,
    logged_days: intake.logged,
    weigh_ins: w.length,
    weigh_span_days: span,
    needs,
    mean_intake: meanIntake == null ? null : Math.round(meanIntake),
    mean_intake_lo: meanLo == null ? null : Math.round(meanLo),
    mean_intake_hi: meanHi == null ? null : Math.round(meanHi),
    weight_trend_kg_per_week: fit ? Math.round(fit.slope * 7 * 100) / 100 : null,
    weight_trend_se_kg_per_week: fit ? Math.round(fit.se * 7 * 100) / 100 : null,
    weekly_weights: weekly,
    maintenance,
    maintenance_lo: mLo,
    maintenance_hi: mHi,
    suggested_target: ready && maintenance != null ? Math.round(maintenance - opts.deficitKcal) : null,
    whoop_kcal_avg: whoopAvg == null ? null : Math.round(whoopAvg),
    whoop_days: whoopIn.length,
  }
}

// ── the book (DB layer) ───────────────────────────────────────────

export class MealBook {
  constructor(private db: Database) {}

  /** Create the food tables. Called by Store on every writable open. */
  static ensureSchema(db: Database): void {
    db.run(FOOD_SCHEMA)
    // v0.18.1: a per-sample exclusion reason (test / non-fasted). Additive,
    // idempotent on archives created before the column existed.
    const cols = db.query("PRAGMA table_info(body_samples)").all() as Array<{ name: string }>
    if (!cols.some((c) => c.name === 'excluded')) db.run('ALTER TABLE body_samples ADD COLUMN excluded TEXT')
    // v0.19.1: raw S400 readings (impedances, open-formula fat %) and their
    // Xiaomi calibration. S400 fat samples stored before the table existed
    // get a row with the raw value taken from the sample (impedances null).
    ensureScaleReadingsSchema(db)
  }

  // meals

  getMeal(id: number): Meal | null {
    const row = this.db.query('SELECT * FROM meals WHERE id = ?').get(id) as MealRow | null
    return row ? this.hydrate(row) : null
  }

  getByClientId(clientId: string): Meal | null {
    const row = this.db.query('SELECT * FROM meals WHERE client_id = ?').get(clientId) as MealRow | null
    return row ? this.hydrate(row) : null
  }

  private hydrate(row: MealRow): Meal {
    const items = this.db
      .query(
        `SELECT name, grams, kcal, kcal_lo, kcal_hi, protein_g, carbs_g, fat_g, preset_slug, servings
         FROM meal_items WHERE meal_id = ? ORDER BY idx`,
      )
      .all(row.id) as MealItem[]
    const photos = this.db
      .query('SELECT idx, path, thumb_path FROM meal_photos WHERE meal_id = ? ORDER BY idx')
      .all(row.id) as MealPhoto[]
    return { ...row, items, photos }
  }

  insertMeal(m: {
    client_id: string | null
    source: MealSource
    logged_at: string
    eaten_at: string
    date: string
    note: string | null
  }): number {
    this.db.run(
      `INSERT INTO meals (client_id, source, logged_at, eaten_at, date, note, status, revision)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', 0)`,
      [m.client_id, m.source, m.logged_at, m.eaten_at, m.date, m.note],
    )
    return Number((this.db.query('SELECT last_insert_rowid() AS id').get() as { id: number | bigint }).id)
  }

  /** Remove a meal that never finished ingesting (photo failure). */
  deleteMeal(id: number): void {
    this.db.transaction(() => {
      for (const t of ['meal_items', 'meal_photos', 'meal_revisions']) {
        this.db.run(`DELETE FROM ${t} WHERE meal_id = ?`, [id])
      }
      this.db.run('DELETE FROM meals WHERE id = ?', [id])
    })()
  }

  addPhoto(mealId: number, idx: number, path: string, thumbPath: string): void {
    this.db.run('INSERT OR REPLACE INTO meal_photos (meal_id, idx, path, thumb_path) VALUES (?, ?, ?, ?)', [
      mealId,
      idx,
      path,
      thumbPath,
    ])
  }

  photoCount(mealId: number): number {
    return (this.db.query('SELECT COUNT(*) AS n FROM meal_photos WHERE meal_id = ?').get(mealId) as { n: number }).n
  }

  /** Next free photo index for a meal (indexes are never reused). */
  nextPhotoIdx(mealId: number): number {
    const r = this.db.query('SELECT MAX(idx) AS m FROM meal_photos WHERE meal_id = ?').get(mealId) as { m: number | null }
    return r.m == null ? 0 : r.m + 1
  }

  /** Drop a meal's photo rows from `fromIdx` up (undo a half-added batch). */
  deletePhotosFrom(mealId: number, fromIdx: number): void {
    this.db.run('DELETE FROM meal_photos WHERE meal_id = ? AND idx >= ?', [mealId, fromIdx])
  }

  /** One row per food day with at least one live meal in [fromDate,
   *  beforeDate), newest first: intake over ESTIMATED meals (null when none is), meal and
   *  photo counts, the day's first photo (earliest meal, lowest index) and
   *  the day's completeness (explicit flag, else no pending meal). */
  historyDays(fromDate: string, beforeDate: string): Array<{
    date: string
    kcal: number | null
    protein_g: number | null
    meals: number
    photos: number
    cover: { meal_id: number; idx: number } | null
    complete: boolean
  }> {
    const rows = this.db
      .query(
        `SELECT m.date AS date,
                SUM(CASE WHEN m.status = 'estimated' THEN m.kcal END) AS kcal,
                SUM(CASE WHEN m.status = 'estimated' THEN m.protein_g END) AS protein_g,
                COUNT(*) AS meals,
                SUM(CASE WHEN m.status = 'pending' THEN 1 ELSE 0 END) AS pending,
                (SELECT COUNT(*) FROM meal_photos p JOIN meals mm ON mm.id = p.meal_id
                  WHERE mm.date = m.date AND mm.status != 'void') AS photos,
                f.complete AS flag
         FROM meals m LEFT JOIN food_days f ON f.date = m.date
         WHERE m.date >= ? AND m.date < ? AND m.status != 'void'
         GROUP BY m.date ORDER BY m.date DESC`,
      )
      .all(fromDate, beforeDate) as Array<{ date: string; kcal: number | null; protein_g: number | null; meals: number; pending: number; photos: number; flag: number | null }>
    const coverQ = this.db.query(
      `SELECT p.meal_id AS meal_id, p.idx AS idx FROM meal_photos p JOIN meals m ON m.id = p.meal_id
       WHERE m.date = ? AND m.status != 'void' ORDER BY m.eaten_at ASC, m.id ASC, p.idx ASC LIMIT 1`,
    )
    return rows.map((r) => ({
      date: r.date,
      kcal: r.kcal,
      protein_g: r.protein_g,
      meals: r.meals,
      photos: r.photos,
      cover: (coverQ.get(r.date) as { meal_id: number; idx: number } | null) ?? null,
      complete: r.flag == null ? r.pending === 0 : r.flag === 1,
    }))
  }

  /**
   * Full replace of a meal's items. Throws on a revision conflict (another
   * writer got there first) or a void meal. Returns the new revision.
   */
  setItems(
    id: number,
    p: {
      label: string
      items: MealItem[]
      confidence: Confidence | null
      expectedRevision?: number | null
      reason?: string | null
      eatenAt?: { iso: string; date: string } | null
      now: string
    },
  ): number {
    return this.db.transaction(() => {
      const row = this.db.query('SELECT revision, status FROM meals WHERE id = ?').get(id) as
        | { revision: number; status: MealStatus }
        | null
      if (!row) throw new Error(`no meal #${id}`)
      if (row.status === 'void') throw new Error(`meal #${id} is void; log a new one instead`)
      if (p.expectedRevision != null && p.expectedRevision !== row.revision) {
        throw new Error(
          `revision conflict on meal #${id}: expected ${p.expectedRevision}, it is now ${row.revision} (another session wrote it; re-read with action day and decide)`,
        )
      }
      const rev = row.revision + 1
      const t = totalsOf(p.items)
      this.db.run('DELETE FROM meal_items WHERE meal_id = ?', [id])
      const ins = this.db.prepare(
        `INSERT INTO meal_items (meal_id, idx, name, grams, kcal, kcal_lo, kcal_hi, protein_g, carbs_g, fat_g, preset_slug, servings)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      p.items.forEach((i, idx) =>
        ins.run(id, idx, i.name, i.grams, i.kcal, i.kcal_lo, i.kcal_hi, i.protein_g, i.carbs_g, i.fat_g, i.preset_slug, i.servings),
      )
      this.db.run(
        `INSERT INTO meal_revisions (meal_id, revision, label, items_json, at, reason) VALUES (?, ?, ?, ?, ?, ?)`,
        [id, rev, p.label, JSON.stringify(p.items), p.now, p.reason ?? null],
      )
      this.db.run(
        `UPDATE meals SET label = ?, status = 'estimated', confidence = ?, revision = ?,
           kcal = ?, kcal_lo = ?, kcal_hi = ?, protein_g = ?, carbs_g = ?, fat_g = ?, estimated_at = ?
           ${p.eatenAt ? ', eaten_at = ?, date = ?' : ''}
         WHERE id = ?`,
        [
          p.label,
          p.confidence,
          rev,
          t.kcal,
          t.kcal_lo,
          t.kcal_hi,
          t.protein_g,
          t.carbs_g,
          t.fat_g,
          p.now,
          ...(p.eatenAt ? [p.eatenAt.iso, p.eatenAt.date] : []),
          id,
        ],
      )
      const presetUse = this.db.prepare('UPDATE meal_presets SET uses = uses + 1 WHERE slug = ?')
      for (const slug of new Set(p.items.map((i) => i.preset_slug).filter((s): s is string => !!s))) presetUse.run(slug)
      return rev
    })()
  }

  voidMeal(id: number, reason: string): void {
    const res = this.db.run(`UPDATE meals SET status = 'void', void_reason = ? WHERE id = ? AND status != 'void'`, [
      reason,
      id,
    ])
    if (res.changes === 0 && !this.getMeal(id)) throw new Error(`no meal #${id}`)
  }

  setFix(id: number, text: string, at: string): void {
    this.db.run('UPDATE meals SET fix_text = ?, fix_at = ? WHERE id = ?', [text, at, id])
  }

  mealsOn(date: string, includeVoid = false): Meal[] {
    const rows = this.db
      .query(
        `SELECT * FROM meals WHERE date = ? ${includeVoid ? '' : "AND status != 'void'"} ORDER BY eaten_at ASC, id ASC`,
      )
      .all(date) as MealRow[]
    return rows.map((r) => this.hydrate(r))
  }

  /** Per-day intake sums over estimated meals since `fromDate`. */
  dailyIntake(fromDate: string): BaselineDay[] {
    const rows = this.db
      .query(
        `SELECT m.date AS date, SUM(m.kcal) AS kcal, SUM(m.kcal_lo) AS kcal_lo, SUM(m.kcal_hi) AS kcal_hi,
                SUM(CASE WHEN m.status = 'pending' THEN 1 ELSE 0 END) AS pending,
                f.complete AS flag
         FROM meals m LEFT JOIN food_days f ON f.date = m.date
         WHERE m.date >= ? AND m.status != 'void'
         GROUP BY m.date ORDER BY m.date`,
      )
      .all(fromDate) as Array<{
      date: string
      kcal: number | null
      kcal_lo: number | null
      kcal_hi: number | null
      pending: number
      flag: number | null
    }>
    return rows.map((r) => ({
      date: r.date,
      kcal: r.kcal ?? 0,
      kcal_lo: r.kcal_lo ?? 0,
      kcal_hi: r.kcal_hi ?? 0,
      pending: r.pending ?? 0,
      // A day with an unestimated meal is not a complete record yet; an
      // explicit flag (day_complete) overrides in both directions.
      complete: r.flag == null ? r.pending === 0 : r.flag === 1,
    }))
  }

  setDayComplete(date: string, complete: boolean, now: string): void {
    this.db.run(
      `INSERT INTO food_days (date, complete, set_at) VALUES (?, ?, ?)
       ON CONFLICT(date) DO UPDATE SET complete = excluded.complete, set_at = excluded.set_at`,
      [date, complete ? 1 : 0, now],
    )
  }

  dayFlag(date: string): boolean | null {
    const r = this.db.query('SELECT complete FROM food_days WHERE date = ?').get(date) as { complete: number } | null
    return r ? r.complete === 1 : null
  }

  // presets

  getPreset(slug: string): Preset | null {
    const r = this.db.query('SELECT * FROM meal_presets WHERE slug = ?').get(slug) as
      | { slug: string; name: string; aliases_json: string; items_json: string; uses: number }
      | null
    if (!r) return null
    const items = JSON.parse(r.items_json) as MealItem[]
    return { slug: r.slug, name: r.name, aliases: JSON.parse(r.aliases_json), items, totals: totalsOf(items), uses: r.uses }
  }

  listPresets(): Preset[] {
    const slugs = this.db.query('SELECT slug FROM meal_presets ORDER BY uses DESC, name ASC').all() as Array<{ slug: string }>
    return slugs.map((s) => this.getPreset(s.slug)!).filter(Boolean)
  }

  savePreset(p: { slug: string; name: string; aliases: string[]; items: MealItem[]; now: string }): void {
    this.db.run(
      `INSERT INTO meal_presets (slug, name, aliases_json, items_json, uses, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, ?, ?)
       ON CONFLICT(slug) DO UPDATE SET name = excluded.name, aliases_json = excluded.aliases_json,
         items_json = excluded.items_json, updated_at = excluded.updated_at`,
      [p.slug, p.name, JSON.stringify(p.aliases), JSON.stringify(p.items), p.now, p.now],
    )
  }

  deletePreset(slug: string): boolean {
    return this.db.run('DELETE FROM meal_presets WHERE slug = ?', [slug]).changes > 0
  }

  /** Presets whose name, slug, or an alias appears in the free text. */
  matchPresets(text: string): Preset[] {
    const t = ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `
    if (!t.trim()) return []
    return this.listPresets().filter((p) =>
      [p.name, p.slug.replace(/-/g, ' '), ...p.aliases].some((k) => {
        const key = k.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
        return key.length >= 3 && t.includes(` ${key} `)
      }),
    )
  }

  // weigh-ins (HealthKit body mass / body fat %, relayed by the phone)

  upsertBodySamples(
    samples: Array<{ uuid: string; ts: string; kind: 'mass' | 'fat'; value: number; source: string | null }>,
    now: string,
  ): number {
    const exists = this.db.query('SELECT 1 FROM body_samples WHERE uuid = ?')
    const ins = this.db.prepare(
      `INSERT INTO body_samples (uuid, ts, kind, value, source, received_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(uuid) DO UPDATE SET ts = excluded.ts, kind = excluded.kind, value = excluded.value,
         source = excluded.source, received_at = excluded.received_at`,
    )
    return this.db.transaction(() => {
      let added = 0
      for (const s of samples) {
        if (!exists.get(s.uuid)) added++
        ins.run(s.uuid, s.ts, s.kind, s.value, s.source, now)
      }
      return added
    })()
  }

  deleteBodySamples(uuids: string[]): number {
    const del = this.db.prepare('DELETE FROM body_samples WHERE uuid = ?')
    return this.db.transaction(() => uuids.reduce((n, u) => n + del.run(u).changes, 0))()
  }

  /** Body samples for the baseline: EXCLUDED rows (test, non-fasted) never count. */
  bodySamplesSince(sinceIso: string): Array<{ ts: string; kind: 'mass' | 'fat'; value: number; source: string | null }> {
    return this.db
      .query('SELECT ts, kind, value, source FROM body_samples WHERE ts >= ? AND excluded IS NULL ORDER BY ts ASC')
      .all(sinceIso) as Array<{ ts: string; kind: 'mass' | 'fat'; value: number; source: string | null }>
  }

  /** Which of these uuids are not stored yet (the weigh-in event fires once). */
  unknownBodyUuids(uuids: string[]): Set<string> {
    const q = this.db.query('SELECT 1 FROM body_samples WHERE uuid = ?')
    return new Set(uuids.filter((u) => !q.get(u)))
  }

  /** The latest NON-excluded mass reading strictly before `beforeIso`. */
  previousMass(beforeIso: string): { ts: string; value: number } | null {
    return (
      (this.db
        .query("SELECT ts, value FROM body_samples WHERE kind = 'mass' AND excluded IS NULL AND ts < ? ORDER BY ts DESC LIMIT 1")
        .get(beforeIso) as { ts: string; value: number } | null) ?? null
    )
  }

  /** Is there an INCLUDED mass reading in [dayStartIso, beforeIso)? */
  includedMassOnDayBefore(dayStartIso: string, beforeIso: string): boolean {
    return !!this.db
      .query("SELECT 1 FROM body_samples WHERE kind = 'mass' AND excluded IS NULL AND ts >= ? AND ts < ? LIMIT 1")
      .get(dayStartIso, beforeIso)
  }

  /** How many INCLUDED mass readings exist strictly before `beforeIso` (the
   *  outlier rule needs >= 3 REAL priors, never this batch's unclassified rows). */
  includedMassCountBefore(beforeIso: string): number {
    return (
      this.db.query("SELECT COUNT(*) AS n FROM body_samples WHERE kind = 'mass' AND excluded IS NULL AND ts < ?").get(beforeIso) as {
        n: number
      }
    ).n
  }

  /** Outlier-excluded mass readings in [fromIso, beforeIso): the "a real
   *  shift, not a visitor" check looks for an earlier one that agrees. */
  outlierMassBetween(fromIso: string, beforeIso: string): Array<{ ts: string; value: number }> {
    return this.db
      .query("SELECT ts, value FROM body_samples WHERE kind = 'mass' AND excluded = 'possible other person' AND ts >= ? AND ts < ?")
      .all(fromIso, beforeIso) as Array<{ ts: string; value: number }>
  }

  /** One sample by uuid (primary key), or null. */
  bodySampleByUuid(uuid: string): { uuid: string; ts: string; kind: string; source: string | null } | null {
    return (
      (this.db.query('SELECT uuid, ts, kind, source FROM body_samples WHERE uuid = ?').get(uuid) as {
        uuid: string
        ts: string
        kind: string
        source: string | null
      } | null) ?? null
    )
  }

  /** Mass + fat samples that currently COUNT (excluded IS NULL), oldest first
   *  (uuid breaks a tie): what the re-classification pass walks. */
  includedSamplesSince(sinceIso: string): Array<{ uuid: string; ts: string; kind: 'mass' | 'fat'; value: number; source: string | null }> {
    return this.db
      .query('SELECT uuid, ts, kind, value, source FROM body_samples WHERE excluded IS NULL AND ts >= ? ORDER BY ts ASC, uuid ASC')
      .all(sinceIso) as Array<{ uuid: string; ts: string; kind: 'mass' | 'fat'; value: number; source: string | null }>
  }

  /** Every body sample since `sinceIso`, excluded ones included (for review). */
  bodySamplesAll(sinceIso: string): Array<{ uuid: string; ts: string; kind: 'mass' | 'fat'; value: number; source: string | null; excluded: string | null }> {
    return this.db
      .query('SELECT uuid, ts, kind, value, source, excluded FROM body_samples WHERE ts >= ? ORDER BY ts ASC')
      .all(sinceIso) as Array<{ uuid: string; ts: string; kind: 'mass' | 'fat'; value: number; source: string | null; excluded: string | null }>
  }

  /** The samples of the weigh-in nearest `atIso` within `tolMs` (mass + its
   *  fat pair: same source + instant), or [] when none is that close. */
  weighinNear(atIso: string, tolMs: number): Array<{ uuid: string; ts: string; kind: string; value: number; source: string | null; excluded: string | null }> {
    const t = Date.parse(atIso)
    const lo = new Date(t - tolMs).toISOString()
    const hi = new Date(t + tolMs).toISOString()
    const masses = this.db
      .query("SELECT uuid, ts, source FROM body_samples WHERE kind = 'mass' AND ts >= ? AND ts <= ?")
      .all(lo, hi) as Array<{ uuid: string; ts: string; source: string | null }>
    if (!masses.length) return []
    const best = masses.sort((a, b) => Math.abs(Date.parse(a.ts) - t) - Math.abs(Date.parse(b.ts) - t))[0]
    return this.db
      .query('SELECT uuid, ts, kind, value, source, excluded FROM body_samples WHERE ts = ? AND source IS ?')
      .all(best.ts, best.source) as Array<{ uuid: string; ts: string; kind: string; value: number; source: string | null; excluded: string | null }>
  }

  /** The samples of ONE weigh-in: mass + fat of this source at this instant
   *  (weighin_set by uuid: never the other source's copy at the same time). */
  weighinAt(ts: string, source: string | null): Array<{ uuid: string; ts: string; kind: string; value: number; source: string | null; excluded: string | null }> {
    return this.db
      .query('SELECT uuid, ts, kind, value, source, excluded FROM body_samples WHERE ts = ? AND source IS ?')
      .all(ts, source) as Array<{ uuid: string; ts: string; kind: string; value: number; source: string | null; excluded: string | null }>
  }

  /** Every sample at exactly this instant, any source: one weigh-in as each
   *  source delivered it (S400 BLE + Xiaomi Home on the scale's own clock). */
  samplesAt(ts: string): Array<{ uuid: string; ts: string; kind: string; value: number; source: string | null; excluded: string | null }> {
    return this.db
      .query('SELECT uuid, ts, kind, value, source, excluded FROM body_samples WHERE ts = ?')
      .all(ts) as Array<{ uuid: string; ts: string; kind: string; value: number; source: string | null; excluded: string | null }>
  }

  /** INCLUDED mass readings at exactly this instant, other than `uuid` (the
   *  same weigh-in delivered twice, e.g. S400 BLE + Xiaomi Home on the scale's
   *  own clock). */
  includedMassesAt(ts: string, uuid: string): Array<{ uuid: string; source: string | null }> {
    return this.db
      .query("SELECT uuid, source FROM body_samples WHERE kind = 'mass' AND excluded IS NULL AND ts = ? AND uuid != ?")
      .all(ts, uuid) as Array<{ uuid: string; source: string | null }>
  }

  /** The latest mass reading of `source` strictly before `beforeIso`, ANY
   *  verdict, with its fat pair (same source + instant): the replay guard's
   *  reference. Only the same source: a replay is one path re-delivering its
   *  own record, and another source's copy of the same weigh-in is not one. */
  previousMassOfSource(
    beforeIso: string,
    source: string | null,
  ): { uuid: string; ts: string; value: number; source: string | null; fat: number | null } | null {
    const m = this.db
      .query("SELECT uuid, ts, value, source FROM body_samples WHERE kind = 'mass' AND source IS ? AND ts < ? ORDER BY ts DESC, uuid DESC LIMIT 1")
      .get(source, beforeIso) as { uuid: string; ts: string; value: number; source: string | null } | null
    if (!m) return null
    return { ...m, fat: this.fatAt(m.ts, m.source) }
  }

  /** Mass readings of `source` in [loIso, hiIso], ANY verdict, oldest first
   *  (uuid breaks a tie): the S400 re-measure rule's neighbours. */
  massesOfSourceBetween(source: string | null, loIso: string, hiIso: string): Array<{ uuid: string; ts: string; value: number; excluded: string | null }> {
    return this.db
      .query("SELECT uuid, ts, value, excluded FROM body_samples WHERE kind = 'mass' AND source IS ? AND ts >= ? AND ts <= ? ORDER BY ts ASC, uuid ASC")
      .all(source, loIso, hiIso) as Array<{ uuid: string; ts: string; value: number; excluded: string | null }>
  }

  /** The fat fraction stored at this instant + source, or null. */
  fatAt(ts: string, source: string | null): number | null {
    const r = this.db
      .query("SELECT value FROM body_samples WHERE kind = 'fat' AND ts = ? AND source IS ? LIMIT 1")
      .get(ts, source) as { value: number } | null
    return r?.value ?? null
  }

  /** INCLUDED mass readings in (afterIso, toIso]. */
  includedMassBetween(afterIso: string, toIso: string): number[] {
    return (
      this.db
        .query("SELECT value FROM body_samples WHERE kind = 'mass' AND excluded IS NULL AND ts > ? AND ts <= ?")
        .all(afterIso, toIso) as Array<{ value: number }>
    ).map((r) => r.value)
  }

  /** Was a (non-void) meal eaten in [fromIso, beforeIso)? */
  mealBetween(fromIso: string, beforeIso: string): boolean {
    return !!this.db
      .query("SELECT 1 FROM meals WHERE status != 'void' AND eaten_at >= ? AND eaten_at < ? LIMIT 1")
      .get(fromIso, beforeIso)
  }

  /** Clear every exclusion whose reason starts with `prefix` (a rule whose
   *  input changed re-decides those rows), never a hand one worded like it
   *  (it ends "(by hand)"). Returns the rows lifted. */
  liftExclusions(prefix: string): number {
    return this.db.run(
      "UPDATE body_samples SET excluded = NULL WHERE substr(excluded, 1, ?) = ? AND excluded NOT LIKE '%(by hand)'",
      [prefix.length, prefix],
    ).changes
  }

  /** Clear exclusions whose reason is EXACTLY one of `reasons`, on samples at
   *  or after `sinceIso` (and before `beforeIso` when given): derived
   *  verdicts the next pass re-decides. */
  liftExactExclusions(reasons: string[], sinceIso: string, beforeIso?: string): number {
    if (!reasons.length) return 0
    const upper = beforeIso == null ? '' : ' AND ts < ?'
    return this.db.run(
      `UPDATE body_samples SET excluded = NULL WHERE ts >= ?${upper} AND excluded IN (${reasons.map(() => '?').join(', ')})`,
      [sinceIso, ...(beforeIso == null ? [] : [beforeIso]), ...reasons],
    ).changes
  }

  /** Every excluded mass sample (any age), with its verdict. */
  excludedMasses(): Array<{ uuid: string; excluded: string }> {
    return this.db
      .query("SELECT uuid, excluded FROM body_samples WHERE kind = 'mass' AND excluded IS NOT NULL")
      .all() as Array<{ uuid: string; excluded: string }>
  }

  /** A sample's exclusion reason, or null when it counts. */
  bodyExcluded(uuid: string): string | null {
    return ((this.db.query('SELECT excluded FROM body_samples WHERE uuid = ?').get(uuid) as { excluded: string | null } | null)?.excluded) ?? null
  }

  /** Mark samples excluded (reason) or include them again (null). */
  setBodyExcluded(uuids: string[], reason: string | null): number {
    const up = this.db.prepare('UPDATE body_samples SET excluded = ? WHERE uuid = ?')
    return this.db.transaction(() => uuids.reduce((n, u) => n + up.run(reason, u).changes, 0))()
  }
}
