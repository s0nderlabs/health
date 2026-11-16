// S400 body-fat calibration against a reference scale app (Xiaomi Home).
//
// The S400 BLE leg derives body fat from the 50 kHz impedance with the open
// Mi Scale formula; Xiaomi Home (synced through Apple Health) uses its own,
// unpublished one, so the same weigh-in reads differently in the two. No
// public formula reproduces Xiaomi's, so this module learns the mapping from
// the weigh-ins both paths saw:
//   - RAW: every S400 reading lands in scale_readings with its impedances and
//     the open formula's fat % (fat_raw_pct, full precision). The raw value is
//     never lost. Rows backfilled from an old 0.1-resolution sample are
//     flagged raw_from_sample = 1 (their raw is quantized).
//   - PAIRS: a reference mass + fat weigh-in (a non-S400 source, or only the
//     configured scale.reference_sources) within 180 s and 0.2 kg of an S400
//     reading is the same weigh-in; closest in time wins, one-to-one. Test or
//     excluded readings pair too: they are calibration data, not trend data.
//     Each pair records its reference source.
//   - MODEL over the 30 most recent pairs: n = 0 none; 1-2 pairs offset only
//     (mean difference, "provisional"); 3+ pairs a + b * raw where b is the
//     Theil-Sen slope SHRUNK toward 1 by the raw spread (b' = 1 + (b - 1) *
//     sxx / (sxx + 4)) and clamped to [0, 1.4] (Xiaomi may barely follow impedance); raw SD under 1 point = offset
//     only (a slope fitted on a few tenths of a point is noise). Outside the
//     fitted raw range a linear model continues with slope 1 (no
//     extrapolation of a slope beyond the data).
//   - The S400 fat SAMPLE (what body_samples, the trend, and body.weighin
//     read) carries the calibrated value, written at ingest from the stored
//     model and rewritten when the model changes; each reading stores the
//     model it was calibrated with (cal_kind / cal_a / cal_b / cal_fitted_at).
//     Once the fit window is full (30 pairs), readings OLDER than its oldest
//     pair keep the calibration they already have (frozen): a refit on recent
//     pairs never rewrites a different body composition's history.
// Fat % is a trend signal only (never a goal check), calibrated or not.

import type { Database } from 'bun:sqlite'
import { SCALE_SOURCE } from './scale.js'

/** Pair window: the two records of one weigh-in. */
export const PAIR_WINDOW_MS = 180_000
export const PAIR_KG = 0.2
/** Only the most recent pairs feed the fit (the scale and body drift). */
export const FIT_MAX_PAIRS = 30
export const LINEAR_MIN_PAIRS = 3
export const SLOPE_MIN = 0
export const SLOPE_MAX = 1.4
/** A slope needs raw spread: below this variance (pct^2, i.e. SD 1 point)
 *  the fit is offset only. */
export const MIN_RAW_VAR = 1
/** Shrinkage prior (pct^2): b' = 1 + (b - 1) * sxx / (sxx + SLOPE_PRIOR_SXX). */
export const SLOPE_PRIOR_SXX = 4
/** Theil-Sen ignores pairs of pairs closer than this in raw (pct). */
const THEIL_SEN_MIN_DX = 0.5
export const CAL_META = 'scale_fat_calibration'
/** Same clamp as the formula: a calibrated value never leaves 5-75 %. */
const FAT_MIN_PCT = 5
const FAT_MAX_PCT = 75
/** Float slack on the window edges (180 s and 0.2 kg are inclusive). */
const EPS = 1e-9

export const SCALE_READINGS_SCHEMA = `
CREATE TABLE IF NOT EXISTS scale_readings (
  uuid TEXT PRIMARY KEY,
  measured_at TEXT NOT NULL,
  kg REAL NOT NULL,
  impedance_low REAL,
  impedance_high REAL,
  hr INTEGER,
  scale_ts INTEGER,
  fat_raw_pct REAL,
  fat_cal_pct REAL,
  calibration_n INTEGER NOT NULL DEFAULT 0,
  received_at TEXT NOT NULL,
  pair_uuid TEXT,
  pair_fat_pct REAL
);
CREATE INDEX IF NOT EXISTS idx_scale_readings_at ON scale_readings (measured_at);
`

/** Columns added after the table first shipped (idempotent migrations). */
const LATER_COLUMNS: Array<[string, string]> = [
  ['raw_from_sample', 'INTEGER NOT NULL DEFAULT 0'],
  ['pair_source', 'TEXT'],
  ['cal_kind', 'TEXT'],
  ['cal_a', 'REAL'],
  ['cal_b', 'REAL'],
  ['cal_fitted_at', 'TEXT'],
  // Body composition (bodycomp.ts): the formula metrics as JSON, and whether
  // the 50 kHz impedance behind them was inferred from fat_raw_pct (rows
  // stored before impedances were).
  ['metrics', 'TEXT'],
  ['impedance_inferred', 'INTEGER NOT NULL DEFAULT 0'],
]

/** Manual reference values (health__meal weighin_pair): one value per
 *  reading + metric, copied from the Xiaomi report; a re-submit replaces. */
export const SCALE_REF_VALUES_SCHEMA = `
CREATE TABLE IF NOT EXISTS scale_ref_values (
  reading_uuid TEXT NOT NULL,
  metric TEXT NOT NULL,
  value REAL NOT NULL,
  source TEXT NOT NULL,
  ref_measured_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (reading_uuid, metric)
);
`

/** Create / migrate scale_readings, then backfill pre-table S400 rows. */
export function ensureScaleReadingsSchema(db: Database): void {
  db.run(SCALE_READINGS_SCHEMA)
  const cols = new Set((db.query('PRAGMA table_info(scale_readings)').all() as Array<{ name: string }>).map((c) => c.name))
  for (const [name, decl] of LATER_COLUMNS) if (!cols.has(name)) db.run(`ALTER TABLE scale_readings ADD COLUMN ${name} ${decl}`)
  db.run(SCALE_REF_VALUES_SCHEMA)
  backfillScaleReadings(db)
}

/** One S400 reading as the scale leg hands it over. uuid = the mass sample
 *  uuid stem (the mass sample is `${uuid}-m`, the fat one `${uuid}-f`). */
export interface ScaleRaw {
  uuid: string
  measured_at: string
  kg: number
  impedance_low: number | null
  impedance_high: number | null
  hr: number | null
  scale_ts: number | null
  /** Open-formula fat %, full precision; null when no 50 kHz impedance. */
  fat_raw_pct: number | null
}

export interface CalModel {
  kind: 'none' | 'offset' | 'linear'
  a: number
  b: number
  n: number
  /** In-sample residual RMS (pct): near zero by construction at small n. */
  residual_rms_pct: number | null
  /** Leave-one-out residual RMS (pct): the honest error; null when n < 2. */
  loo_rms_pct?: number | null
  fitted_at: string
  /** Raw range of the fitted pairs: outside it a linear model uses slope 1. */
  raw_min?: number
  raw_max?: number
  /** The oldest pair in the fit (readings before it freeze once n is full). */
  span_from?: string
  /** Reference source(s) the pairs came from (e.g. "Xiaomi Home"). */
  sources?: string[]
  /** Why a linear fit was reduced (offset only, or a clamped slope). */
  note?: string
}

export interface CalPair {
  reading_uuid: string
  measured_at: string
  kg: number
  raw_pct: number
  ref_uuid: string
  ref_fat_pct: number
  ref_source?: string | null
}

/** What a stored S400 fat value is, for every surface that shows it. */
export interface FatProvenance {
  /** uncalibrated = open formula; provisional = offset from 1-2 pairs;
   *  calibrated = 3+ pairs. */
  status: 'uncalibrated' | 'provisional' | 'calibrated'
  n: number
  /** Leave-one-out RMS of the model that produced it (pct), when known. */
  rms_pct: number | null
  reference: string | null
}

const round2 = (n: number) => Math.round(n * 100) / 100
const clampPct = (v: number) => (v < FAT_MIN_PCT ? FAT_MIN_PCT : v > FAT_MAX_PCT ? FAT_MAX_PCT : v)
const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length
const median = (v: number[]) => {
  const s = [...v].sort((x, y) => x - y)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** The stem a sample uuid shares with its reading ("s400-t...-f" -> "s400-t..."). */
export function readingStemOf(sampleUuid: string): string {
  return /-[mf]$/.test(sampleUuid) ? sampleUuid.slice(0, -2) : sampleUuid
}

/** Calibrated fat %, unrounded (clamped 5-75); the raw value when there is
 *  no model. A linear model continues with slope 1 outside its raw range. */
export function calibratedPct(model: CalModel | null, rawPct: number): number {
  if (!model || model.kind === 'none') return rawPct
  return clampPct(calibratedValue(model, rawPct))
}

/** The model applied to any metric's raw value, unclamped (the fat path
 *  clamps 5-75 on top). A linear model continues with slope 1 outside its
 *  raw range. */
export function calibratedValue(model: CalModel | null, raw: number): number {
  if (!model || model.kind === 'none') return raw
  let edge = raw
  if (model.kind === 'linear' && Number.isFinite(model.raw_min) && Number.isFinite(model.raw_max))
    edge = raw < model.raw_min! ? model.raw_min! : raw > model.raw_max! ? model.raw_max! : raw
  return model.a + model.b * edge + (raw - edge)
}

/** Calibrated fat % (2 dp, clamped 5-75); the raw value when there is no model. */
export function applyModel(model: CalModel | null, rawPct: number): number {
  return round2(calibratedPct(model, rawPct))
}

/** A fat % as the HealthKit-style fraction body_samples stores (0.1-point
 *  resolution, like the uncalibrated path: fatFraction rounds the same way). */
export function pctToFraction(pct: number): number {
  return Math.round(pct * 10) / 1000
}

/**
 * Pair S400 readings with reference weigh-ins: |dt| <= 180 s and
 * |dkg| <= 0.2 kg, closest in time first (then closest in kg), each side
 * used at most once.
 */
export function pairReadings(
  readings: Array<{ uuid: string; measured_at: string; kg: number; fat_raw_pct: number }>,
  refs: Array<{ uuid: string; ts: string; kg: number; fat_pct: number; source?: string | null }>,
): CalPair[] {
  const cands: Array<{ r: (typeof readings)[number]; f: (typeof refs)[number]; dt: number; dkg: number }> = []
  for (const r of readings) {
    const rt = Date.parse(r.measured_at)
    for (const f of refs) {
      const dt = Math.abs(Date.parse(f.ts) - rt)
      const dkg = Math.abs(f.kg - r.kg)
      if (dt <= PAIR_WINDOW_MS && dkg <= PAIR_KG + EPS) cands.push({ r, f, dt, dkg })
    }
  }
  cands.sort((x, y) => x.dt - y.dt || x.dkg - y.dkg || x.r.uuid.localeCompare(y.r.uuid) || x.f.uuid.localeCompare(y.f.uuid))
  const usedR = new Set<string>()
  const usedF = new Set<string>()
  const out: CalPair[] = []
  for (const c of cands) {
    if (usedR.has(c.r.uuid) || usedF.has(c.f.uuid)) continue
    usedR.add(c.r.uuid)
    usedF.add(c.f.uuid)
    out.push({
      reading_uuid: c.r.uuid,
      measured_at: c.r.measured_at,
      kg: c.r.kg,
      raw_pct: c.r.fat_raw_pct,
      ref_uuid: c.f.uuid,
      ref_fat_pct: c.f.fat_pct,
      ref_source: c.f.source ?? null,
    })
  }
  return out.sort((x, y) => x.measured_at.localeCompare(y.measured_at))
}

/** The fit itself (no bookkeeping): offset below 3 pairs or under 1 point of
 *  raw SD, else the shrunk, clamped Theil-Sen slope through the means. */
function fitCore(xs: number[], ys: number[]): { kind: 'none' | 'offset' | 'linear'; a: number; b: number; note?: string } {
  const n = xs.length
  if (n === 0) return { kind: 'none', a: 0, b: 1 }
  const offset = (note?: string) => ({ kind: 'offset' as const, a: mean(ys.map((y, i) => y - xs[i])), b: 1, ...(note ? { note } : {}) })
  if (n < LINEAR_MIN_PAIRS) return offset()
  const mx = mean(xs)
  const my = mean(ys)
  let sxx = 0
  for (const x of xs) sxx += (x - mx) ** 2
  if (sxx / n < MIN_RAW_VAR) return offset('raw values spread under 1 point, offset only')
  // Theil-Sen: the median of pairwise slopes, so one bad pair cannot set it.
  const slopes: number[] = []
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      const dx = xs[j] - xs[i]
      if (Math.abs(dx) >= THEIL_SEN_MIN_DX) slopes.push((ys[j] - ys[i]) / dx)
    }
  if (!slopes.length) return offset('raw values spread under 1 point, offset only')
  const raw = median(slopes)
  const shrunk = 1 + (raw - 1) * (sxx / (sxx + SLOPE_PRIOR_SXX))
  const b = Math.min(SLOPE_MAX, Math.max(SLOPE_MIN, shrunk))
  const note = b !== shrunk ? `slope ${shrunk.toFixed(2)} clamped to ${b.toFixed(1)}` : undefined
  return { kind: 'linear', a: my - b * mx, b, ...(note ? { note } : {}) }
}

/** Fit reference_pct = a + b * raw_pct over the 30 most recent pairs. */
export function fitCalibration(pairs: CalPair[], nowIso: string): CalModel {
  const used = [...pairs].sort((x, y) => x.measured_at.localeCompare(y.measured_at)).slice(-FIT_MAX_PAIRS)
  const n = used.length
  if (n === 0) return { kind: 'none', a: 0, b: 1, n: 0, residual_rms_pct: null, loo_rms_pct: null, fitted_at: nowIso }
  const xs = used.map((p) => p.raw_pct)
  const ys = used.map((p) => p.ref_fat_pct)
  const core = fitCore(xs, ys)
  const r3 = (v: number) => Math.round(v * 1000) / 1000
  const rms = r3(Math.sqrt(mean(xs.map((x, i) => (ys[i] - (core.a + core.b * x)) ** 2))))
  // Leave-one-out: predict each pair from a fit on the others.
  let loo: number | null = null
  if (n >= 2) {
    const errs = xs.map((x, i) => {
      const f = fitCore(xs.filter((_, j) => j !== i), ys.filter((_, j) => j !== i))
      return ys[i] - (f.a + f.b * x)
    })
    loo = r3(Math.sqrt(mean(errs.map((e) => e * e))))
  }
  const sources = [...new Set(used.map((p) => p.ref_source).filter((s): s is string => typeof s === 'string' && s.length > 0))].sort()
  return {
    kind: core.kind,
    a: core.a,
    b: core.b,
    n,
    residual_rms_pct: rms,
    loo_rms_pct: loo,
    fitted_at: nowIso,
    raw_min: Math.min(...xs),
    raw_max: Math.max(...xs),
    span_from: used[0].measured_at,
    ...(sources.length ? { sources } : {}),
    ...(core.note ? { note: core.note } : {}),
  }
}

export function sameModel(x: CalModel | null, y: CalModel | null): boolean {
  if (!x || !y) return x === y
  const near = (p: number | undefined, q: number | undefined) => (p == null || q == null ? p == q : Math.abs(p - q) < 1e-9)
  return (
    x.kind === y.kind &&
    x.n === y.n &&
    near(x.a, y.a) &&
    near(x.b, y.b) &&
    near(x.raw_min, y.raw_min) &&
    near(x.raw_max, y.raw_max) &&
    x.span_from === y.span_from &&
    (x.sources ?? []).join('|') === (y.sources ?? []).join('|')
  )
}

export function parseModel(raw: string | null): CalModel | null {
  if (!raw) return null
  try {
    const m = JSON.parse(raw) as CalModel
    if ((m.kind === 'none' || m.kind === 'offset' || m.kind === 'linear') && Number.isFinite(m.a) && Number.isFinite(m.b) && Number.isInteger(m.n))
      return m
  } catch {
    // a corrupt record is refitted on the next ingest
  }
  return null
}

/** The reference a model was fitted against ("Xiaomi Home", or "A / B"). */
export function referenceName(model: CalModel | null): string | null {
  return model?.sources?.length ? model.sources.join(' / ') : null
}

/** Provenance of values the CURRENT model writes. */
export function provenanceOf(model: CalModel | null): FatProvenance {
  if (!model || model.kind === 'none' || model.n === 0) return { status: 'uncalibrated', n: 0, rms_pct: null, reference: null }
  return {
    status: model.n >= LINEAR_MIN_PAIRS ? 'calibrated' : 'provisional',
    n: model.n,
    rms_pct: model.loo_rms_pct ?? null,
    reference: referenceName(model),
  }
}

/** "1 pair" / "4 pairs": every calibration caveat words the count this way. */
export function pairCount(n: number): string {
  return `${n} pair${n === 1 ? '' : 's'}`
}

/** "S400 BLE, uncalibrated: no Xiaomi pair yet" / "S400 BLE, provisional
 *  offset to Xiaomi Home from 1 pair" / "S400 BLE, calibrated to Xiaomi Home
 *  from 4 pairs, +/-0.3 pt". */
export function calibrationNote(p: FatProvenance | null): string {
  if (!p || p.status === 'uncalibrated') return `${SCALE_SOURCE}, uncalibrated: no Xiaomi pair yet`
  const ref = p.reference ?? 'Xiaomi Home'
  const pairs = pairCount(p.n)
  if (p.status === 'provisional') return `${SCALE_SOURCE}, provisional offset to ${ref} from ${pairs}`
  return `${SCALE_SOURCE}, calibrated to ${ref} from ${pairs}${p.rms_pct != null ? `, +/-${p.rms_pct.toFixed(1)} pt` : ''}`
}

// ── DB layer ────────────────────────────────────────────────────────

/** Backfill: an S400 BLE fat sample stored before scale_readings existed gets
 *  a row with fat_raw_pct from the sample (impedances unknown, raw quantized
 *  to the sample's 0.1 point: raw_from_sample = 1). Also covers an S400
 *  sample that arrives without its raw reading. Idempotent. */
export function backfillScaleReadings(db: Database): number {
  return db.run(
    `INSERT OR IGNORE INTO scale_readings (uuid, measured_at, kg, fat_raw_pct, calibration_n, received_at, raw_from_sample)
     SELECT substr(f.uuid, 1, length(f.uuid) - 2), f.ts, m.value, round(f.value * 100, 2), 0, f.received_at, 1
     FROM body_samples f
     JOIN body_samples m ON m.kind = 'mass' AND m.ts = f.ts AND m.source = f.source
     WHERE f.kind = 'fat' AND f.source = ? AND f.uuid LIKE '%-f'
       AND NOT EXISTS (SELECT 1 FROM scale_readings r WHERE r.uuid = substr(f.uuid, 1, length(f.uuid) - 2))`,
    [SCALE_SOURCE],
  ).changes
}

export interface ScaleReadingRow {
  uuid: string
  measured_at: string
  kg: number
  impedance_low: number | null
  impedance_high: number | null
  hr: number | null
  scale_ts: number | null
  fat_raw_pct: number | null
  fat_cal_pct: number | null
  calibration_n: number
  received_at: string
  pair_uuid: string | null
  pair_fat_pct: number | null
  raw_from_sample: number
  pair_source: string | null
  cal_kind: string | null
  cal_a: number | null
  cal_b: number | null
  cal_fitted_at: string | null
  metrics: string | null
  impedance_inferred: number
}

export interface RefValueRow {
  reading_uuid: string
  metric: string
  value: number
  source: string
  ref_measured_at: string
  created_at: string
}

/** Provenance of one stored reading (what its fat sample carries). */
export function readingProvenance(row: Pick<ScaleReadingRow, 'fat_cal_pct' | 'calibration_n' | 'cal_kind' | 'cal_fitted_at'> | null, current: CalModel | null): FatProvenance {
  if (!row || row.fat_cal_pct == null || (row.cal_kind !== 'offset' && row.cal_kind !== 'linear') || row.calibration_n <= 0)
    return { status: 'uncalibrated', n: 0, rms_pct: null, reference: null }
  const sameFit = current != null && current.fitted_at === row.cal_fitted_at
  return {
    status: row.calibration_n >= LINEAR_MIN_PAIRS ? 'calibrated' : 'provisional',
    n: row.calibration_n,
    rms_pct: sameFit ? (current!.loo_rms_pct ?? null) : null,
    reference: sameFit ? referenceName(current) : null,
  }
}

export class ScaleCalBook {
  constructor(private db: Database) {}

  upsertReading(r: ScaleRaw, receivedAt: string): void {
    // A re-ingest of the same weigh-in (scanner retry, daemon restart) keeps
    // what the first copy knew when the retry is partial.
    this.db.run(
      `INSERT INTO scale_readings (uuid, measured_at, kg, impedance_low, impedance_high, hr, scale_ts, fat_raw_pct, calibration_n, received_at, raw_from_sample)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0)
       ON CONFLICT(uuid) DO UPDATE SET measured_at = excluded.measured_at, kg = excluded.kg,
         impedance_low = COALESCE(excluded.impedance_low, scale_readings.impedance_low),
         impedance_high = COALESCE(excluded.impedance_high, scale_readings.impedance_high),
         hr = COALESCE(excluded.hr, scale_readings.hr),
         scale_ts = COALESCE(excluded.scale_ts, scale_readings.scale_ts),
         raw_from_sample = CASE WHEN excluded.fat_raw_pct IS NOT NULL THEN 0 ELSE scale_readings.raw_from_sample END,
         fat_raw_pct = COALESCE(excluded.fat_raw_pct, scale_readings.fat_raw_pct),
         metrics = NULL, impedance_inferred = 0`,
      [r.uuid, r.measured_at, r.kg, r.impedance_low, r.impedance_high, r.hr, r.scale_ts, r.fat_raw_pct, receivedAt],
    )
  }

  reading(uuid: string): ScaleReadingRow | null {
    return (this.db.query('SELECT * FROM scale_readings WHERE uuid = ?').get(uuid) as ScaleReadingRow | null) ?? null
  }

  readingsWithRaw(sinceIso: string): Array<{ uuid: string; measured_at: string; kg: number; fat_raw_pct: number }> {
    return this.db
      .query('SELECT uuid, measured_at, kg, fat_raw_pct FROM scale_readings WHERE fat_raw_pct IS NOT NULL AND measured_at >= ? ORDER BY measured_at')
      .all(sinceIso) as Array<{ uuid: string; measured_at: string; kg: number; fat_raw_pct: number }>
  }

  /** Reference mass + fat weigh-ins (any verdict) in [fromIso, toIso]: every
   *  non-S400 source, or only `sources` when given. */
  referenceWeighins(fromIso: string, toIso: string, sources?: string[] | null): Array<{ uuid: string; ts: string; kg: number; fat_pct: number; source: string | null }> {
    const only = sources?.filter((s) => typeof s === 'string' && s.length > 0) ?? []
    const rows = this.db
      .query(
        `SELECT m.uuid AS uuid, m.ts AS ts, m.value AS kg, f.value AS fat, m.source AS source
         FROM body_samples m
         JOIN body_samples f ON f.kind = 'fat' AND f.ts = m.ts AND f.source IS m.source
         WHERE m.kind = 'mass' AND (m.source IS NULL OR m.source != ?) AND m.ts >= ? AND m.ts <= ?
         ORDER BY m.ts`,
      )
      .all(SCALE_SOURCE, fromIso, toIso) as Array<{ uuid: string; ts: string; kg: number; fat: number; source: string | null }>
    // One fat per mass (two fat rows at one instant would double a reference).
    const seen = new Set<string>()
    const out: Array<{ uuid: string; ts: string; kg: number; fat_pct: number; source: string | null }> = []
    for (const r of rows) {
      if (seen.has(r.uuid)) continue
      if (only.length && (r.source == null || !only.includes(r.source))) continue
      seen.add(r.uuid)
      out.push({ uuid: r.uuid, ts: r.ts, kg: r.kg, fat_pct: Math.round(r.fat * 10000) / 100, source: r.source })
    }
    return out
  }

  setPairs(pairs: CalPair[]): void {
    this.db.transaction(() => {
      this.db.run('UPDATE scale_readings SET pair_uuid = NULL, pair_fat_pct = NULL, pair_source = NULL WHERE pair_uuid IS NOT NULL')
      const up = this.db.prepare('UPDATE scale_readings SET pair_uuid = ?, pair_fat_pct = ?, pair_source = ? WHERE uuid = ?')
      for (const p of pairs) up.run(p.ref_uuid, p.ref_fat_pct, p.ref_source ?? null, p.reading_uuid)
    })()
  }

  /** Is this reading frozen under `model` (older than a FULL fit window and
   *  already calibrated)? A frozen reading keeps its stored calibration. */
  private frozen(row: { measured_at: string; cal_kind: string | null; fat_cal_pct: number | null }, model: CalModel | null): boolean {
    return (
      !!model &&
      model.n >= FIT_MAX_PAIRS &&
      typeof model.span_from === 'string' &&
      row.measured_at < model.span_from &&
      row.fat_cal_pct != null &&
      (row.cal_kind === 'offset' || row.cal_kind === 'linear')
    )
  }

  /** Write `model` onto one reading row and return the fat FRACTION its
   *  sample must carry (null = leave the sample as written: no model, the
   *  scale leg's own formula value; or no raw). Frozen rows keep theirs. */
  calibrateReading(uuid: string, model: CalModel | null): number | null {
    const row = this.reading(uuid)
    if (!row || row.fat_raw_pct == null) return null
    if (this.frozen(row, model)) return pctToFraction(row.fat_cal_pct!)
    this.writeRow(row, model)
    if (!model || model.kind === 'none') return null
    return pctToFraction(calibratedPct(model, row.fat_raw_pct))
  }

  /** Write `model` onto a row the caller already loaded. Skipped when the row
   *  already carries exactly what this model writes (same fit, same value):
   *  applyToAll runs on every ingest across the whole history. */
  private writeRow(
    row: Pick<ScaleReadingRow, 'uuid' | 'fat_raw_pct' | 'fat_cal_pct' | 'calibration_n' | 'cal_kind' | 'cal_fitted_at'>,
    model: CalModel | null,
  ): void {
    if (row.fat_raw_pct == null) return
    const calibrated = !!model && model.kind !== 'none'
    const fatCal = calibrated ? applyModel(model, row.fat_raw_pct) : null
    const fittedAt = model ? model.fitted_at : null
    if (
      row.cal_fitted_at === fittedAt &&
      row.cal_kind === (model ? model.kind : null) &&
      row.fat_cal_pct === fatCal &&
      row.calibration_n === (calibrated ? model!.n : 0)
    )
      return
    this.db.run(
      'UPDATE scale_readings SET fat_cal_pct = ?, calibration_n = ?, cal_kind = ?, cal_a = ?, cal_b = ?, cal_fitted_at = ? WHERE uuid = ?',
      [fatCal, calibrated ? model!.n : 0, model ? model.kind : null, calibrated ? model!.a : null, calibrated ? model!.b : null, fittedAt, row.uuid],
    )
  }

  /** Write the model onto every reading with a raw value (frozen ones
   *  excepted): fat_cal_pct + the model's identity, and the S400 fat SAMPLE
   *  (fraction; the exact open-formula value when there is no model).
   *  Rows already written by this model are left alone. Returns the
   *  timestamps of the fat samples whose value changed. */
  applyToAll(model: CalModel | null): string[] {
    const rows = this.db
      .query(
        'SELECT uuid, measured_at, fat_raw_pct, fat_cal_pct, calibration_n, cal_kind, cal_fitted_at FROM scale_readings WHERE fat_raw_pct IS NOT NULL',
      )
      .all() as Array<{
      uuid: string
      measured_at: string
      fat_raw_pct: number
      fat_cal_pct: number | null
      calibration_n: number
      cal_kind: string | null
      cal_fitted_at: string | null
    }>
    const upSample = this.db.prepare(
      "UPDATE body_samples SET value = ? WHERE uuid = ? AND kind = 'fat' AND source = ? AND value != ? RETURNING ts",
    )
    return this.db.transaction(() => {
      const changed: string[] = []
      for (const r of rows) {
        if (this.frozen(r, model)) continue
        this.writeRow(r, model)
        const frac = pctToFraction(calibratedPct(model, r.fat_raw_pct))
        for (const s of upSample.all(frac, `${r.uuid}-f`, SCALE_SOURCE, frac) as Array<{ ts: string }>) changed.push(s.ts)
      }
      return changed
    })()
  }

  /** Rows whose formula metrics may need (re)computing: every reading. */
  metricInputs(): Array<{ uuid: string; measured_at: string; kg: number; impedance_low: number | null; fat_raw_pct: number | null; metrics: string | null; impedance_inferred: number }> {
    return this.db
      .query('SELECT uuid, measured_at, kg, impedance_low, fat_raw_pct, metrics, impedance_inferred FROM scale_readings')
      .all() as Array<{ uuid: string; measured_at: string; kg: number; impedance_low: number | null; fat_raw_pct: number | null; metrics: string | null; impedance_inferred: number }>
  }

  setMetrics(uuid: string, metricsJson: string | null, inferred: boolean): void {
    this.db.run('UPDATE scale_readings SET metrics = ?, impedance_inferred = ? WHERE uuid = ?', [metricsJson, inferred ? 1 : 0, uuid])
  }

  /** The S400 reading closest to `atIso` within PAIR_WINDOW_MS, or null,
   *  with the verdict of its mass sample (mass_excluded: null = counted; the
   *  sample may be gone, then null too). The caller decides whether an
   *  excluded reading (someone else, a test) may be paired. */
  readingNear(atIso: string): (ScaleReadingRow & { mass_excluded: string | null }) | null {
    const t = Date.parse(atIso)
    const rows = this.db
      .query(
        `SELECT r.*, m.excluded AS mass_excluded FROM scale_readings r
         LEFT JOIN body_samples m ON m.uuid = r.uuid || '-m' AND m.kind = 'mass'
         WHERE r.measured_at >= ? AND r.measured_at <= ?`,
      )
      .all(new Date(t - PAIR_WINDOW_MS).toISOString(), new Date(t + PAIR_WINDOW_MS).toISOString()) as Array<ScaleReadingRow & { mass_excluded: string | null }>
    rows.sort((a, b) => Math.abs(Date.parse(a.measured_at) - t) - Math.abs(Date.parse(b.measured_at) - t) || a.uuid.localeCompare(b.uuid))
    return rows[0] ?? null
  }

  /** S400 readings measured at or after `sinceIso`, newest first, with the
   *  verdict of their mass sample (readings whose sample is gone are left
   *  out). */
  recentReadingsWithVerdict(sinceIso: string): Array<ScaleReadingRow & { mass_excluded: string | null }> {
    return this.db
      .query(
        `SELECT r.*, m.excluded AS mass_excluded FROM scale_readings r
         JOIN body_samples m ON m.uuid = r.uuid || '-m' AND m.kind = 'mass'
         WHERE r.measured_at >= ? ORDER BY r.measured_at DESC`,
      )
      .all(sinceIso) as Array<ScaleReadingRow & { mass_excluded: string | null }>
  }

  /** Store (or replace) one manual reference value. */
  upsertRefValue(r: Omit<RefValueRow, 'created_at'>, nowIso: string): void {
    this.db.run(
      `INSERT INTO scale_ref_values (reading_uuid, metric, value, source, ref_measured_at, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(reading_uuid, metric) DO UPDATE SET value = excluded.value, source = excluded.source,
         ref_measured_at = excluded.ref_measured_at, created_at = excluded.created_at`,
      [r.reading_uuid, r.metric, r.value, r.source, r.ref_measured_at, nowIso],
    )
  }

  /** Remove one manual reference value; true when a row was deleted. */
  deleteRefValue(readingUuid: string, metric: string): boolean {
    return this.db.run('DELETE FROM scale_ref_values WHERE reading_uuid = ? AND metric = ?', [readingUuid, metric]).changes > 0
  }

  /** The manual reference value of one reading + metric, if any. */
  refValue(readingUuid: string, metric: string): RefValueRow | null {
    return (this.db.query('SELECT * FROM scale_ref_values WHERE reading_uuid = ? AND metric = ?').get(readingUuid, metric) as RefValueRow | null) ?? null
  }

  /** Manual reference values of one metric, with their reading, oldest first. */
  refValues(metric: string): Array<RefValueRow & { measured_at: string; kg: number; fat_raw_pct: number | null; metrics: string | null; impedance_inferred: number }> {
    return this.db
      .query(
        `SELECT v.*, r.measured_at AS measured_at, r.kg AS kg, r.fat_raw_pct AS fat_raw_pct, r.metrics AS metrics, r.impedance_inferred AS impedance_inferred
         FROM scale_ref_values v JOIN scale_readings r ON r.uuid = v.reading_uuid
         WHERE v.metric = ? ORDER BY r.measured_at`,
      )
      .all(metric) as Array<RefValueRow & { measured_at: string; kg: number; fat_raw_pct: number | null; metrics: string | null; impedance_inferred: number }>
  }

  pairedReadings(limit = 100): ScaleReadingRow[] {
    return this.db
      .query('SELECT * FROM scale_readings WHERE pair_uuid IS NOT NULL ORDER BY measured_at DESC LIMIT ?')
      .all(limit) as ScaleReadingRow[]
  }

  /** Reading rows by stem, for joining provenance onto sample lists. */
  readingsByUuid(uuids: string[]): Map<string, ScaleReadingRow> {
    const out = new Map<string, ScaleReadingRow>()
    for (const u of new Set(uuids)) {
      const r = this.reading(u)
      if (r) out.set(u, r)
    }
    return out
  }

  counts(): { readings: number; with_impedance: number; paired: number } {
    return this.db
      .query(
        `SELECT COUNT(*) AS readings,
                SUM(CASE WHEN impedance_low IS NOT NULL THEN 1 ELSE 0 END) AS with_impedance,
                SUM(CASE WHEN pair_uuid IS NOT NULL THEN 1 ELSE 0 END) AS paired
         FROM scale_readings`,
      )
      .get() as { readings: number; with_impedance: number; paired: number }
  }
}
