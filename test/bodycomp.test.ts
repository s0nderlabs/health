// S400 body composition: the Mi Scale formula ports (against the reference's
// own worked numbers, MiScaleLibTest.kt @ openScale 2f5eeb7, and hand-computed
// values for the bodyMetrics-only functions), impedance inversion, manual
// Xiaomi pairs (weighin_pair), per-metric calibration labels, the body.weighin
// line, day.body, and the scale_calibration report.
// Every profile, weight, impedance and value here is synthetic.
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Database } from 'bun:sqlite'
import { Store } from '../src/store.js'
import { FoodService } from '../src/food.js'
import { DEFAULT_CONFIG } from '../src/types.js'
import { fatPercent, SCALE_SOURCE } from '../src/scale.js'
import { ensureScaleReadingsSchema, fitCalibration, pctToFraction, provenanceOf, LINEAR_MIN_PAIRS, type CalPair, type ScaleRaw } from '../src/scalecal.js'
import { MealBook } from '../src/meals.js'
import {
  DAY_BODY_ORDER,
  basisOf,
  bmiOf,
  bmrKcal,
  bodyEventLine,
  boneMassKg,
  calibrationText,
  computeMetrics,
  fitMetric,
  inferImpedance,
  metricViews,
  janssenSmmKg,
  proteinPct,
  visceralFatRaw,
  waterPct,
  xiaomiMuscleKg,
  type MetricView,
} from '../src/bodycomp.js'

const local = (y: number, mo: number, d: number, h: number, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime()
const iso = (ms: number) => new Date(ms).toISOString()

// The three MiScaleLibTest subjects (sex coded male = 1, female = 0 there).
const M30 = { kg: 80, h: 180, age: 30, sex: 'male' as const, imp: 500 }
const F28 = { kg: 60, h: 165, age: 28, sex: 'female' as const, imp: 520 }
const M45 = { kg: 95, h: 175, age: 45, sex: 'male' as const, imp: 430 }

// Kotlin Float vs our doubles: the reference asserts within 1e-3.
const near = (got: number | null, want: number, tol = 2e-3) => {
  expect(got).not.toBeNull()
  expect(Math.abs((got as number) - want)).toBeLessThan(tol)
}

describe('formulas vs MiScaleLibTest worked numbers', () => {
  const cases = [
    { s: M30, bmi: 24.691359, fat: 23.315107, bone: 3.1254203, lbm: 58.222496, musclePct: 40.977253, water: 52.605835, vf: 13.359997 },
    { s: F28, bmi: 22.038567, fat: 30.361998, bone: 2.4865808, lbm: 39.29622, musclePct: 40.181103, water: 49.72153, vf: -36.555004 },
    { s: M45, bmi: 31.020409, fat: 32.41778, bone: 3.2726917, lbm: 60.93042, musclePct: 36.096416, water: 48.2537, vf: 24.462498 },
  ]
  for (const c of cases) {
    test(`${c.s.sex} ${c.s.age}y ${c.s.h}cm ${c.s.kg}kg ${c.s.imp} ohm`, () => {
      const { kg, h, age, sex, imp } = c.s
      near(bmiOf(kg, h), c.bmi) // getBMI
      const fat = fatPercent(kg, h, age, sex, imp)! // getBodyFat
      near(fat, c.fat)
      near(boneMassKg(kg, h, age, sex, imp), c.bone) // getBoneMass
      near(xiaomiMuscleKg(kg, h, age, sex, imp, fat), c.lbm) // getLBM = Xiaomi "muscle"
      near((janssenSmmKg(h, age, sex, imp)! / kg) * 100, c.musclePct) // getMuscle SMM path, as % of weight
      near(waterPct(fat), c.water) // getWater
      near(visceralFatRaw(kg, h, age, sex), c.vf) // getVisceralFat (unclamped)
    })
  }

  test('bodyMetrics.getBMR, hand-computed, with its male > 2322 -> 5000 cap', () => {
    // 877.8 + 80*14.916 - 180*0.726 - 30*8.976 = 1671.12
    near(bmrKcal(80, 180, 30, 'male'), 1671.12, 1e-6)
    // 864.6 + 60*10.2036 - 165*0.39336 - 28*6.204 = 1238.1996
    near(bmrKcal(60, 165, 28, 'female'), 1238.1996, 1e-6)
    // 877.8 + 150*14.916 - 130.68 - 269.28 = 2715.24 > 2322 -> 5000 (the reference's quirk, ported)
    expect(bmrKcal(150, 180, 30, 'male')).toBe(5000)
    // clamp 500
    expect(bmrKcal(10, 200, 99, 'female')).toBe(500)
  })

  test('bodyMetrics.getProteinPercentage(orig), hand-computed', () => {
    // muscle = 80 - 23.315107% * 80 - 3.1254203 = 58.222494 -> 72.778117 %
    // water  = (100 - 23.315107) * 0.7 = 53.679425 > 50 -> * 0.98 = 52.605837
    // protein = 72.778117 - 52.605837 = 20.172280
    const fat = fatPercent(80, 180, 30, 'male', 500)!
    near(proteinPct(80, 180, 30, 'male', 500, fat), 20.17228, 1e-4)
    // the 5-32 clamp holds for an extreme synthetic subject
    const fatHi = fatPercent(120, 160, 60, 'female', 900)!
    expect(proteinPct(120, 160, 60, 'female', 900, fatHi)).toBeGreaterThanOrEqual(5)
    expect(proteinPct(120, 160, 60, 'female', 900, fatHi)).toBeLessThanOrEqual(32)
  })

  test('Janssen needs a positive impedance (the LBM-ratio fallback is not ported)', () => {
    expect(janssenSmmKg(180, 30, 'male', 0)).toBeNull()
    // 0.401 * 32400 / 500 + 3.825 - 0.071 * 30 + 5.102 = 32.7818
    near(janssenSmmKg(180, 30, 'male', 500), 32.7818, 1e-6)
  })
})

describe('impedance inversion', () => {
  test('round trip: fatPercent(inferImpedance(fat)) == fat, impedance recovered', () => {
    for (const s of [M30, F28, M45])
      for (const imp of [350, 500, 650, 800]) {
        const fat = fatPercent(s.kg, s.h, s.age, s.sex, imp)!
        if (fat <= 5 || fat >= 63) continue
        const got = inferImpedance(fat, s.kg, s.h, s.age, s.sex)!
        near(got, imp, 1e-4)
        near(fatPercent(s.kg, s.h, s.age, s.sex, got), fat, 1e-8)
      }
  })

  test('clamped or unreachable targets are not invertible', () => {
    expect(inferImpedance(5, 80, 180, 30, 'male')).toBeNull()
    expect(inferImpedance(63, 80, 180, 30, 'male')).toBeNull()
    expect(inferImpedance(NaN, 80, 180, 30, 'male')).toBeNull()
    // above what 3000 ohm reaches for this subject
    const top = fatPercent(80, 180, 30, 'male', 3000)!
    if (top < 62) expect(inferImpedance(top + 0.5, 80, 180, 30, 'male')).toBeNull()
  })

  test('computeMetrics infers the impedance from fat_raw_pct and flags it', () => {
    const profile = { height_cm: 180, birth_date: '1996-01-15', sex: 'male' as const }
    const at = iso(local(2026, 11, 10, 6))
    const fat = fatPercent(80, 180, 30, 'male', 500)!
    const measured = computeMetrics({ kg: 80, measured_at: at, impedance_low: 500, fat_raw_pct: fat }, profile)!
    const inferred = computeMetrics({ kg: 80, measured_at: at, impedance_low: null, fat_raw_pct: fat }, profile)!
    expect(measured.impedance_inferred).toBe(false)
    expect(inferred.impedance_inferred).toBe(true)
    near(inferred.impedance_ohm, 500, 0.01)
    for (const k of ['muscle_kg', 'bone_kg', 'water_pct', 'protein_pct', 'lean_kg'] as const) near(inferred.values[k]!, measured.values[k]!, 1e-3)
    // Janssen (H^2 / R) is never computed from an inferred impedance
    expect(measured.values.smm_kg).toBeDefined()
    expect(inferred.values.smm_kg).toBeUndefined()
    expect(measured.basis).toBe('formula')
    expect(measured.refs.muscle_kg).toContain('MiScaleLib.getLBM')
    expect(measured.refs.smm_kg).toContain('Janssen')
    expect(measured.refs.protein_pct).toContain('bodyMetrics.getProteinPercentage')
    expect(measured.refs.bmr_kcal).toContain('bodyMetrics.getBMR')
    // weight-only metrics without any impedance or fat
    const bare = computeMetrics({ kg: 80, measured_at: at, impedance_low: null, fat_raw_pct: null }, profile)!
    expect(Object.keys(bare.values).sort()).toEqual(['bmi', 'bmr_kcal', 'visceral'])
    // lean = kg * (1 - fat); visceral outside 1-50 is the formula failing
    // (female fixture is negative raw): left out, never shown as 1
    near(measured.values.lean_kg!, 80 * (1 - fat / 100), 1e-3)
    const f = computeMetrics({ kg: 60, measured_at: at, impedance_low: 520, fat_raw_pct: null }, { height_cm: 165, birth_date: '1998-03-01', sex: 'female' })!
    expect(f.values.visceral).toBeUndefined()
    expect(f.values.fat_pct).toBeDefined()
    // no profile, no metrics
    expect(computeMetrics({ kg: 80, measured_at: at, impedance_low: 500, fat_raw_pct: fat }, undefined)).toBeNull()
  })
})

describe('per-metric fit labels', () => {
  const pair = (i: number, raw: number, ref: number): CalPair => ({
    reading_uuid: `r${i}`,
    measured_at: iso(local(2026, 10, 1 + i, 6)),
    kg: 70,
    raw_pct: raw,
    ref_uuid: `x${i}`,
    ref_fat_pct: ref,
  })
  const nowIso = iso(local(2026, 11, 16, 12))

  test('formula -> provisional (offset, 1-2 pairs) -> calibrated (3+)', () => {
    expect(basisOf(fitMetric('muscle_kg', [], nowIso))).toBe('formula')
    const one = fitMetric('muscle_kg', [pair(1, 50, 52)], nowIso)
    expect(one.kind).toBe('offset')
    expect(one.a).toBeCloseTo(2, 9)
    expect(basisOf(one)).toBe('provisional')
    expect(calibrationText('muscle_kg', one)).toBe('1 pair')
    const three = fitMetric('muscle_kg', [pair(1, 50, 52), pair(2, 51, 53.1), pair(3, 49, 50.9)], nowIso)
    expect(basisOf(three)).toBe('calibrated')
    expect(calibrationText('muscle_kg', three)).toMatch(/^3 pairs, \+\/-\d+\.\d kg$/)
  })

  test('basis and caveat follow the fat provenance rule (one source of truth)', () => {
    for (let n = 0; n <= LINEAR_MIN_PAIRS + 1; n++) {
      const ps = Array.from({ length: n }, (_, i) => pair(i + 1, 50 + i, 52 + i * 1.05))
      const m = fitMetric('muscle_kg', ps, nowIso)
      const p = provenanceOf(m)
      expect(basisOf(m)).toBe(p.status === 'uncalibrated' ? 'formula' : p.status)
    }
    // the fat view passes a stored reading's provenance, not a model
    expect(calibrationText('fat_pct', { status: 'uncalibrated', n: 0, rms_pct: null, reference: null })).toBeNull()
    expect(calibrationText('fat_pct', { status: 'provisional', n: 1, rms_pct: null, reference: null })).toBe('1 pair')
    expect(calibrationText('fat_pct', { status: 'calibrated', n: 4, rms_pct: 0.34, reference: 'Xiaomi Home' })).toBe('4 pairs, +/-0.3 pt')
    expect(calibrationText('fat_pct', { status: 'calibrated', n: 4, rms_pct: null, reference: null })).toBe('4 pairs')
  })

  test('fit units: kcal pairs are fitted in fat-point-sized units, then scaled back', () => {
    const ps = [pair(1, 1600, 1650), pair(2, 1700, 1745), pair(3, 1800, 1860), pair(4, 1650, 1700)]
    const m = fitMetric('bmr_kcal', ps, nowIso)
    const direct = fitCalibration(ps.map((p) => ({ ...p, raw_pct: p.raw_pct / 15, ref_fat_pct: p.ref_fat_pct / 15 })), nowIso)
    expect(m.kind).toBe(direct.kind)
    expect(m.b).toBeCloseTo(direct.b, 12)
    expect(m.a).toBeCloseTo(direct.a * 15, 9)
    expect(m.raw_min).toBeCloseTo(1600, 9)
    expect(m.raw_max).toBeCloseTo(1800, 9)
  })
})

describe('body.weighin line', () => {
  const v = (key: MetricView['key'], value: number, unit: string, basis: MetricView['basis'], note: string | null, label: string): MetricView => ({ key, label, value, unit, basis, note })
  test('visceral then muscle, basis + note in parentheses', () => {
    expect(
      bodyEventLine([v('visceral', 9.4, '', 'formula', null, 'Visceral fat'), v('muscle_kg', 58.2, 'kg', 'provisional', '1 pair', 'Muscle'), v('fat_pct', 20, '%', 'formula', null, 'Body fat')]),
    ).toBe('Visceral 9 (formula), muscle 58.2 kg (provisional, 1 pair).')
    expect(bodyEventLine([v('visceral', 9, '', 'formula', null, 'Visceral fat')])).toBe('Visceral 9 (formula).')
    expect(bodyEventLine([v('fat_pct', 20, '%', 'formula', null, 'Body fat')])).toBeNull()
  })
})

// ── FoodService integration ───────────────────────────────────────────

const PROFILE = { height_cm: 180, birth_date: '1996-01-15', sex: 'male' as const } // synthetic, age 30 in Nov 2026

function harness(startAt = local(2026, 11, 16, 12), opts: { profile?: typeof PROFILE | undefined } = { profile: PROFILE }) {
  const dir = mkdtempSync(join(tmpdir(), 'health-bodycomp-'))
  const store = new Store(':memory:')
  const meta = new Map<string, string>()
  const events: Array<{ cls: string; key: string; content: string; meta: Record<string, string> }> = []
  let now = startAt
  let profile = opts.profile
  const food = new FoodService({
    db: store.db,
    photosDir: join(dir, 'meals'),
    getConfig: () => DEFAULT_CONFIG.food,
    getMeta: (k) => meta.get(k) ?? null,
    setMeta: (k, val) => void meta.set(k, val),
    emit: (cls, key, p) => {
      events.push({ cls, key, ...p })
      return true
    },
    broadcast: () => {},
    getScaleProfile: () => profile,
    now: () => now,
  })
  /** One S400 weigh-in as the scale leg sends it (raw fat from the formula). */
  const s400 = (stem: string, at: number, kg: number, imp: number | null) => {
    const ts = iso(at)
    const fat = imp != null ? fatPercent(kg, PROFILE.height_cm, 30, 'male', imp) : null
    const samples: Array<{ uuid: string; ts: string; kind: 'mass' | 'fat'; value: number; source: string }> = [
      { uuid: `${stem}-m`, ts, kind: 'mass', value: kg, source: SCALE_SOURCE },
    ]
    if (fat != null) samples.push({ uuid: `${stem}-f`, ts, kind: 'fat', value: pctToFraction(fat), source: SCALE_SOURCE })
    const raw: ScaleRaw = { uuid: stem, measured_at: ts, kg, impedance_low: imp, impedance_high: imp != null ? imp - 40 : null, hr: 60, scale_ts: Math.floor(at / 1000), fat_raw_pct: fat }
    return food.ingestBodySamples(samples, [], raw)
  }
  return {
    store,
    food,
    meta,
    events,
    s400,
    setNow: (ms: number) => (now = ms),
    setProfile: (p: typeof PROFILE | undefined) => (profile = p),
    cleanup: () => {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

describe('metrics stored per S400 weigh-in', () => {
  test('scale_readings.metrics: formula values + reference names; a profile change recomputes', () => {
    const t = local(2026, 11, 16, 6)
    const h = harness(t + 60_000)
    try {
      h.s400('s400-tB1', t, 80, 500)
      const row = h.food.scaleCal.reading('s400-tB1')!
      const m = JSON.parse(row.metrics!)
      expect(m.basis).toBe('formula')
      expect(m.impedance_inferred).toBe(false)
      expect(m.values.muscle_kg).toBeCloseTo(58.2225, 3)
      expect(m.values.visceral).toBeCloseTo(13.36, 2)
      expect(m.refs.visceral).toContain('MiScaleLib.getVisceralFat')
      h.setProfile({ ...PROFILE, height_cm: 170 })
      h.food.refreshMetrics()
      expect(JSON.parse(h.food.scaleCal.reading('s400-tB1')!.metrics!).profile).toBe('170|1996-01-15|male')
      h.setProfile(undefined)
      h.food.refreshMetrics()
      expect(h.food.scaleCal.reading('s400-tB1')!.metrics).toBeNull()
    } finally {
      h.cleanup()
    }
  })

  test('migration is idempotent and adds metrics + impedance_inferred + scale_ref_values', () => {
    const db = new Database(':memory:')
    MealBook.ensureSchema(db)
    ensureScaleReadingsSchema(db)
    ensureScaleReadingsSchema(db)
    const cols = (db.query('PRAGMA table_info(scale_readings)').all() as Array<{ name: string }>).map((c) => c.name)
    expect(cols).toContain('metrics')
    expect(cols).toContain('impedance_inferred')
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'scale_ref_values'").get()).toBeTruthy()
    db.close()
  })

  test('a pre-impedance (backfilled) row gets metrics from an inferred impedance, flagged', () => {
    const t = local(2026, 11, 15, 6)
    const h = harness(t + 60_000)
    try {
      const fat = fatPercent(80, 180, 30, 'male', 500)!
      // An S400 fat sample from before scale_readings existed: no raw row.
      h.food.ingestBodySamples(
        [
          { uuid: 's400-tOLD-m', ts: iso(t), kind: 'mass', value: 80, source: SCALE_SOURCE },
          { uuid: 's400-tOLD-f', ts: iso(t), kind: 'fat', value: pctToFraction(fat), source: SCALE_SOURCE },
        ],
        [],
      )
      const row = h.food.scaleCal.reading('s400-tOLD')!
      expect(row.raw_from_sample).toBe(1)
      expect(row.impedance_low).toBeNull()
      expect(row.impedance_inferred).toBe(1)
      const m = JSON.parse(row.metrics!)
      expect(m.impedance_inferred).toBe(true)
      expect(Math.abs(m.impedance_ohm - 500)).toBeLessThan(6) // the sample's 0.1-point quantization
      const body = h.food.day().body!
      expect(body.metrics.find((x) => x.key === 'muscle_kg')!.note).toBe('inferred impedance')
      // weight-only: never inferred, but always says it is weight-derived
      expect(body.metrics.find((x) => x.key === 'visceral')!.note).toBe('weight-derived, no impedance')
      expect(body.metrics.find((x) => x.key === 'smm_kg')).toBeUndefined() // no Janssen on an inferred impedance
      const e = h.events.filter((x) => x.cls === 'body.weighin').at(-1)!
      expect(e.content).toContain('muscle 58.2 kg (formula, inferred impedance)')
    } finally {
      h.cleanup()
    }
  })
})

describe('weighin_pair', () => {
  test('matches within 180 s, errors outside, a re-submit replaces, then the metric refits', () => {
    const t = local(2026, 11, 16, 6)
    const h = harness(t + 60_000)
    try {
      h.s400('s400-tP1', t, 80, 500)
      expect(() => h.food.weighinPair({ measured_at: iso(t + 181_000), metric: 'muscle_kg', value: 60 })).toThrow(/no S400 weigh-in within 180 s/)
      expect(() => h.food.weighinPair({ measured_at: iso(t), metric: 'body_age', value: 30 })).toThrow(/metric must be one of/)
      expect(() => h.food.weighinPair({ measured_at: iso(t), metric: 'muscle_kg', value: 500 })).toThrow(/must be a number in/)
      expect(() => h.food.weighinPair({ measured_at: 'yesterday', metric: 'muscle_kg', value: 60 })).toThrow(/measured_at/)
      const r1 = h.food.weighinPair({ measured_at: iso(t + 180_000), metric: 'muscle_kg', value: 60 }) as Record<string, any>
      expect(r1.reading.uuid).toBe('s400-tP1')
      expect(r1.stored).toEqual({ value: 60, source: 'xiaomi report' })
      expect(r1.status).toBe('provisional')
      expect(r1.model.kind).toBe('offset')
      expect(r1.model.a).toBeCloseTo(60 - 58.2225, 3)
      expect(r1.calibrated_value).toBeCloseTo(60, 6)
      // re-submit for the same reading + metric replaces (still one pair)
      const r2 = h.food.weighinPair({ measured_at: iso(t - 30_000), metric: 'muscle_kg', value: 59, source: 'Xiaomi Home report' }) as Record<string, any>
      expect(r2.model.n).toBe(1)
      expect(r2.model.a).toBeCloseTo(59 - 58.2225, 3)
      expect(h.store.db.query('SELECT COUNT(*) AS n FROM scale_ref_values').get()).toEqual({ n: 1 })
      expect(h.food.metricModels().muscle_kg!.sources).toEqual(['Xiaomi Home report'])
      // other metrics untouched
      expect(h.food.metricModels().visceral).toBeUndefined()
    } finally {
      h.cleanup()
    }
  })

  test('three pairs = calibrated with a +/- band; the event and day.body say so', () => {
    const h = harness(local(2026, 11, 13, 7))
    try {
      const days = [13, 14, 15]
      const imps = [480, 520, 560]
      days.forEach((d, i) => {
        const t = local(2026, 11, d, 6)
        h.setNow(t + 60_000)
        h.s400(`s400-tC${d}`, t, 80, imps[i])
        const raw = JSON.parse(h.food.scaleCal.reading(`s400-tC${d}`)!.metrics!).values.visceral as number
        h.food.weighinPair({ measured_at: iso(t + 30_000), metric: 'visceral', value: raw + 1 + (i - 1) * 0.1 })
      })
      expect(basisOf(h.food.metricModels().visceral!)).toBe('calibrated')
      const t = local(2026, 11, 16, 6)
      h.setNow(t + 60_000)
      h.s400('s400-tC16', t, 80, 500)
      const e = h.events.filter((x) => x.cls === 'body.weighin').at(-1)!
      expect(e.content).toMatch(/\nVisceral 14 \(calibrated, 3 pairs, \+\/-\d\.\d, weight-derived, no impedance\), muscle 58\.2 kg \(formula\)\.$/)
      expect(e.meta.visceral).toBe('14')
      expect(e.meta.muscle_kg).toBe('58.2')
      const vis = h.food.day().body!.metrics.find((x) => x.key === 'visceral')!
      expect(vis.basis).toBe('calibrated')
      expect(vis.note).toMatch(/^3 pairs, \+\/-\d\.\d, weight-derived, no impedance$/)
      // the same whole index on every surface (event, meta, day.body)
      expect(vis.value).toBe(14)
    } finally {
      h.cleanup()
    }
  })

  test('bmi is a height check only: difference + implied height, no model', () => {
    const t = local(2026, 11, 16, 6)
    const h = harness(t + 60_000)
    try {
      h.s400('s400-tH1', t, 80, 500)
      const r = h.food.weighinPair({ measured_at: iso(t), metric: 'bmi', value: 25.0 }) as Record<string, any>
      expect(r.calibrated).toBe(false)
      expect(r.formula_bmi).toBeCloseTo(24.69, 2)
      expect(r.diff).toBeCloseTo(0.31, 2)
      expect(r.implied_height_cm).toBeCloseTo(178.9, 1) // sqrt(80 / 25) m
      expect(r.profile_height_cm).toBe(180)
      expect(h.meta.get('scale_metric_calibration') ?? null).toBeNull()
      expect(h.food.scaleCalibration().bmi_checks).toEqual([
        { measured_at: iso(t), source: 'xiaomi report', ref_bmi: 25, formula_bmi: 24.69, diff: 0.31, implied_height_cm: 178.9 },
      ])
    } finally {
      h.cleanup()
    }
  })

  test('manual fat joins the HealthKit pairs; for the same reading the manual value wins', () => {
    const t1 = local(2026, 11, 15, 6)
    const h = harness(t1 + 60_000)
    try {
      h.s400('s400-tF1', t1, 80, 500)
      const raw1 = h.food.scaleCal.reading('s400-tF1')!.fat_raw_pct!
      // Xiaomi Home copy via Apple Health: raw + 2
      h.food.ingestBodySamples(
        [
          { uuid: 'xiaomi-f1-m', ts: iso(t1 + 40_000), kind: 'mass', value: 80, source: 'Xiaomi Home' },
          { uuid: 'xiaomi-f1-f', ts: iso(t1 + 40_000), kind: 'fat', value: (raw1 + 2) / 100, source: 'Xiaomi Home' },
        ],
        [],
      )
      expect(h.food.scaleModel()!.a).toBeCloseTo(2, 1)
      const t2 = local(2026, 11, 16, 6)
      h.setNow(t2 + 60_000)
      h.s400('s400-tF2', t2, 80, 520)
      const raw2 = h.food.scaleCal.reading('s400-tF2')!.fat_raw_pct!
      // a manual value for a reading with no HealthKit copy joins: n = 2
      const r = h.food.weighinPair({ measured_at: iso(t2), metric: 'fat_pct', value: Math.round((raw2 + 3) * 10) / 10 }) as Record<string, any>
      expect(r.model.n).toBe(2)
      expect(r.status).toBe('provisional')
      // a manual value for the HealthKit-paired reading replaces that pair
      h.food.weighinPair({ measured_at: iso(t1), metric: 'fat_pct', value: Math.round((raw1 + 3) * 10) / 10 })
      const m = h.food.scaleModel()!
      expect(m.n).toBe(2)
      expect(m.a).toBeCloseTo(3, 1)
      expect(m.sources).toEqual(['xiaomi report'])
      const pairs = h.food.scaleCalibration().pairs
      expect(pairs.map((p) => p.ref_source)).toEqual(['xiaomi report', 'xiaomi report'])
    } finally {
      h.cleanup()
    }
  })
})

describe('day.body (the iOS contract)', () => {
  test('exact shape and order; latest S400 of the last 7 days; null otherwise', () => {
    const t = local(2026, 11, 16, 6)
    const h = harness(t + 60_000)
    try {
      expect(h.food.day().body).toBeNull()
      h.s400('s400-tD1', t, 80, 500)
      h.food.weighinPair({ measured_at: iso(t), metric: 'muscle_kg', value: 60 })
      const body = h.food.day().body!
      expect(Object.keys(body)).toEqual(['measured_at', 'kg', 'metrics'])
      expect(body.measured_at).toBe(iso(t))
      expect(body.kg).toBe(80)
      expect(body.metrics.map((x) => x.key)).toEqual([...DAY_BODY_ORDER])
      for (const x of body.metrics) {
        expect(Object.keys(x)).toEqual(['key', 'label', 'value', 'unit', 'basis', 'note'])
        expect(['formula', 'provisional', 'calibrated']).toContain(x.basis)
        expect(typeof x.value).toBe('number')
        expect(typeof x.unit).toBe('string')
      }
      const by = Object.fromEntries(body.metrics.map((x) => [x.key, x]))
      expect(by.muscle_kg).toEqual({ key: 'muscle_kg', label: 'Muscle', value: 60, unit: 'kg', basis: 'provisional', note: '1 pair' })
      expect(by.visceral).toEqual({ key: 'visceral', label: 'Visceral fat', value: 13, unit: '', basis: 'formula', note: 'weight-derived, no impedance' })
      expect(by.protein_pct.note).toBe('guessed formula')
      expect(by.lean_kg).toEqual({ key: 'lean_kg', label: 'Lean mass', value: 61.4, unit: 'kg', basis: 'formula', note: null }) // 80 x (1 - 0.233), the displayed fat
      expect(by.fat_pct).toMatchObject({ value: 23.3, unit: '%', basis: 'formula' })
      expect(by.smm_kg).toMatchObject({ label: 'Skeletal muscle', value: 32.8, unit: 'kg', note: 'a smaller part of Muscle' })
      expect(by.bmr_kcal).toMatchObject({ value: 1671, unit: 'kcal', note: 'weight-derived, no impedance' })
      expect(by.bone_kg.value).toBe(3.13)
      // 8 days later: nothing recent
      h.setNow(t + 8 * 86_400_000)
      expect(h.food.day().body).toBeNull()
    } finally {
      h.cleanup()
    }
  })

  test('an outlier (someone else) is skipped, a non-morning reading still counts as his', () => {
    const t = local(2026, 11, 16, 6)
    const h = harness(t + 60_000)
    try {
      h.s400('s400-tE1', t, 80, 500)
      h.store.db.run("UPDATE body_samples SET excluded = 'possible other person' WHERE uuid = 's400-tE1-m'")
      expect(h.food.day().body).toBeNull()
      const t2 = local(2026, 11, 16, 14)
      h.setNow(t2 + 60_000)
      h.s400('s400-tE2', t2, 80.4, 505)
      expect(h.food.day().body!.measured_at).toBe(iso(t2))
    } finally {
      h.cleanup()
    }
  })
})

describe('weighins rows and the scale_calibration report carry the metrics', () => {
  test('S400 rows have metrics with formula raw; per-metric pairs + residuals', () => {
    const t = local(2026, 11, 16, 6)
    const h = harness(t + 60_000)
    try {
      h.s400('s400-tW1', t, 80, 500)
      h.food.weighinPair({ measured_at: iso(t), metric: 'water_pct', value: 55 })
      const row = h.food.weighins(7).find((r) => r.source === SCALE_SOURCE)!
      expect(row.impedance_inferred).toBe(false)
      const water = row.metrics!.find((x) => x.key === 'water_pct')!
      expect(water.raw).toBeCloseTo(52.6058, 3)
      expect(water.value).toBe(55)
      expect(water.basis).toBe('provisional')
      const rep = h.food.scaleCalibration()
      expect(Object.keys(rep.metrics).sort()).toEqual(['bmr_kcal', 'bone_kg', 'muscle_kg', 'protein_pct', 'visceral', 'water_pct'])
      expect(rep.metrics.water_pct.status).toBe('provisional')
      expect(rep.metrics.water_pct.pairs).toHaveLength(1)
      expect(rep.metrics.water_pct.pairs[0]).toMatchObject({ reading_uuid: 's400-tW1', ref_value: 55, source: 'xiaomi report', residual: 0, in_fit: true })
      expect(rep.metrics.water_pct.pairs[0].formula_value).toBeCloseTo(52.606, 3)
      expect(rep.metrics.muscle_kg.status).toBe('formula')
      expect(rep.body_note).toContain('No body age or body score')
    } finally {
      h.cleanup()
    }
  })

  test('no profile: no metrics, no body line, fat path unchanged', () => {
    const t = local(2026, 11, 16, 6)
    const h = harness(t + 60_000, { profile: undefined })
    try {
      h.s400('s400-tN1', t, 80, 500)
      const e = h.events.filter((x) => x.cls === 'body.weighin').at(-1)!
      expect(e.content).not.toContain('Visceral')
      expect(e.meta.visceral).toBeUndefined()
      expect(h.food.scaleCal.reading('s400-tN1')!.metrics).toBeNull()
      expect(h.food.day().body!.metrics.map((x) => x.key)).toEqual(['fat_pct'])
    } finally {
      h.cleanup()
    }
  })
})

// ── review fixes (Nov 16 2026) ─────────────────────────────────────────

describe('reference sentinels never become values', () => {
  const at = iso(local(2026, 11, 10, 6))
  const P = (h: number) => ({ height_cm: h, birth_date: '1996-01-15', sex: 'male' as const })

  test('BMR 5000 (bodyMetrics.getBMR male > 2322 cap) is left out', () => {
    expect(bmrKcal(125, 175, 30, 'male')).toBe(5000) // the faithful port keeps the marker
    const m = computeMetrics({ kg: 125, measured_at: at, impedance_low: null, fat_raw_pct: null }, P(175))!
    expect(m.values.bmr_kcal).toBeUndefined()
    expect(m.values.visceral).toBeDefined()
  })

  test('bone 8 (getBoneMass cap) and muscle 120 (getLBM cap) are left out, protein built on them too', () => {
    // synthetic giant: bone > 5.2 -> 8, muscle >= 93.5 -> 120
    expect(boneMassKg(180, 200, 30, 'male', 100)).toBe(8)
    const m = computeMetrics({ kg: 180, measured_at: at, impedance_low: 100, fat_raw_pct: null }, P(200))!
    expect(m.values.bone_kg).toBeUndefined()
    expect(m.values.muscle_kg).toBeUndefined()
    expect(m.values.protein_pct).toBeUndefined()
    expect(m.values.fat_pct).toBeDefined() // fat itself is in range
    expect(Object.values(m.values)).not.toContain(8)
    expect(Object.values(m.values)).not.toContain(120)
  })

  test('fat at the 75 marker drops fat and everything built on it', () => {
    // very high impedance at a light synthetic weight pushes the formula over 63
    const m = computeMetrics({ kg: 120, measured_at: at, impedance_low: 2900, fat_raw_pct: null }, { height_cm: 150, birth_date: '1966-01-15', sex: 'female' })!
    expect(m.values.fat_pct).toBeUndefined()
    expect(m.values.lean_kg).toBeUndefined()
    expect(m.values.water_pct).toBeUndefined()
  })
})

describe('inferred impedance and profile drift', () => {
  test('a profile fix never moves smm_kg on an inferred row (no smm there at all)', () => {
    const at = iso(local(2026, 11, 10, 6))
    // fat stored under a 175 cm profile, metrics recomputed under 180 cm
    const fat175 = fatPercent(80, 175, 30, 'male', 500)!
    const m = computeMetrics({ kg: 80, measured_at: at, impedance_low: null, fat_raw_pct: fat175 }, { height_cm: 180, birth_date: '1996-01-15', sex: 'male' })!
    expect(m.impedance_inferred).toBe(true)
    expect(m.values.smm_kg).toBeUndefined()
    near(m.values.fat_pct!, fat175, 1e-4) // fat-derived metrics only round-trip the stored fat
  })
})

describe('metricViews: fat raw never falls back to the displayed value', () => {
  test('raw = the row formula fat; omitted when there is none', () => {
    const cal = { value: 26.3, basis: 'calibrated' as const, note: '3 pairs, +/-0.5 pt' }
    const a = metricViews(null, {}, { ...cal, raw: 23.3 }, 80)
    expect(a.find((x) => x.key === 'fat_pct')).toMatchObject({ value: 26.3, raw: 23.3, basis: 'calibrated' })
    const b = metricViews(null, {}, { ...cal, raw: null }, 80)
    const fb = b.find((x) => x.key === 'fat_pct')!
    expect(fb.value).toBe(26.3)
    expect('raw' in fb).toBe(false)
  })
})

describe('calibrated fat: the card adds up', () => {
  test('lean follows the displayed fat; muscle / water / protein name the formula fat they assume', () => {
    const h = harness(local(2026, 11, 13, 7))
    try {
      const imps = [480, 520, 560]
      ;[13, 14, 15].forEach((d, i) => {
        const t = local(2026, 11, d, 6)
        h.setNow(t + 60_000)
        h.s400(`s400-tL${d}`, t, 80, imps[i])
        const raw = h.food.scaleCal.reading(`s400-tL${d}`)!.fat_raw_pct!
        h.food.weighinPair({ measured_at: iso(t), metric: 'fat_pct', value: Math.round((raw + 3) * 10) / 10 })
      })
      expect(h.food.scaleModel()!.n).toBe(3)
      const body = h.food.day().body!
      const by = Object.fromEntries(body.metrics.map((x) => [x.key, x]))
      expect(by.fat_pct.basis).toBe('calibrated')
      // fat mass + lean mass = weight (to display rounding)
      expect(Math.abs(by.lean_kg.value + (body.kg * by.fat_pct.value) / 100 - body.kg)).toBeLessThan(0.1)
      expect(by.lean_kg.basis).toBe('calibrated')
      expect(by.lean_kg.note).toBe('from calibrated fat')
      const raw15 = h.food.scaleCal.reading('s400-tL15')!.fat_raw_pct!
      const tag = `from formula fat ${raw15.toFixed(1)}%`
      expect(by.muscle_kg).toMatchObject({ basis: 'formula', note: tag })
      expect(by.water_pct).toMatchObject({ basis: 'formula', note: tag })
      expect(by.protein_pct).toMatchObject({ basis: 'formula', note: `guessed formula, ${tag}` })
      expect(by.bone_kg.note).toBeNull() // bone never used fat
      // weighins: fat raw is the formula value, never the calibrated one
      const row = h.food.weighins(7).find((r) => r.measured_at === iso(local(2026, 11, 15, 6)))!
      const fv = row.metrics!.find((x) => x.key === 'fat_pct')!
      expect(fv.raw).toBeCloseTo(raw15, 3)
      expect(Math.abs(fv.value - fv.raw!)).toBeGreaterThan(2)
    } finally {
      h.cleanup()
    }
  })
})

describe('weighin_pair guards and weighin_unpair', () => {
  test('metric names: case and whitespace tolerated, unknown and lean_kg refused', () => {
    const t = local(2026, 11, 16, 6)
    const h = harness(t + 60_000)
    try {
      h.s400('s400-tG1', t, 80, 500)
      const r = h.food.weighinPair({ measured_at: iso(t), metric: ' MUSCLE_KG ', value: 59 }) as Record<string, any>
      expect(r.metric).toBe('muscle_kg')
      expect(() => h.food.weighinPair({ measured_at: iso(t), metric: 'musclekg', value: 59 })).toThrow(/metric must be one of/)
      expect(() => h.food.weighinPair({ measured_at: iso(t), metric: 'lean_kg', value: 61 })).toThrow(/lean_kg is not paired/)
      // visceral range is what the formula can produce
      expect(() => h.food.weighinPair({ measured_at: iso(t), metric: 'visceral', value: 55 })).toThrow(/must be a number in 1-50/)
    } finally {
      h.cleanup()
    }
  })

  test('an out-of-family value (lb for kg) is refused until forced', () => {
    const t = local(2026, 11, 16, 6)
    const h = harness(t + 60_000)
    try {
      h.s400('s400-tG2', t, 80, 500)
      // formula muscle 58.2 kg; 128.4 is the same mass in lb
      expect(() => h.food.weighinPair({ measured_at: iso(t), metric: 'muscle_kg', value: 128.4 })).toThrow(/implausible: muscle_kg 128.4/)
      expect(() => h.food.weighinPair({ measured_at: iso(t), metric: 'bone_kg', value: 4.5 })).toThrow(/implausible/)
      expect(h.store.db.query('SELECT COUNT(*) AS n FROM scale_ref_values').get()).toEqual({ n: 0 })
      expect(h.food.metricModels().muscle_kg).toBeUndefined()
      const r = h.food.weighinPair({ measured_at: iso(t), metric: 'muscle_kg', value: 128.4, force: true }) as Record<string, any>
      expect(r.reading.forced).toBe(true)
      expect(r.status).toBe('provisional')
    } finally {
      h.cleanup()
    }
  })

  test('an excluded reading (someone else) is refused until forced; the reply shows the verdict', () => {
    const t = local(2026, 11, 16, 6)
    const h = harness(t + 60_000)
    try {
      h.s400('s400-tG3', t, 80, 500)
      h.store.db.run("UPDATE body_samples SET excluded = 'possible other person' WHERE uuid = 's400-tG3-m'")
      expect(() => h.food.weighinPair({ measured_at: iso(t), metric: 'muscle_kg', value: 59 })).toThrow(/excluded \("possible other person"\)/)
      const r = h.food.weighinPair({ measured_at: iso(t), metric: 'muscle_kg', value: 59, force: true }) as Record<string, any>
      expect(r.reading.excluded).toBe('possible other person')
      // a reading excluded only as not-a-morning one is still his: no force needed
      const t2 = local(2026, 11, 16, 14)
      h.setNow(t2 + 60_000)
      h.s400('s400-tG4', t2, 80.2, 505)
      h.store.db.run("UPDATE body_samples SET excluded = 'not a morning reading' WHERE uuid = 's400-tG4-m'")
      const ok = h.food.weighinPair({ measured_at: iso(t2), metric: 'muscle_kg', value: 59 }) as Record<string, any>
      expect(ok.reading.excluded).toBe('not a morning reading')
    } finally {
      h.cleanup()
    }
  })

  test('unpair removes the value and refits back to formula; fat unpair refits the fat model', () => {
    const t = local(2026, 11, 16, 6)
    const h = harness(t + 60_000)
    try {
      h.s400('s400-tU1', t, 80, 500)
      h.food.weighinPair({ measured_at: iso(t), metric: 'muscle_kg', value: 59.5 })
      expect(basisOf(h.food.metricModels().muscle_kg!)).toBe('provisional')
      const r = h.food.weighinUnpair({ measured_at: iso(t + 20_000), metric: 'muscle_kg' }) as Record<string, any>
      expect(r.removed).toEqual({ value: 59.5, source: 'xiaomi report' })
      expect(r.status).toBe('formula')
      expect(h.food.metricModels().muscle_kg).toBeUndefined()
      expect(h.food.day().body!.metrics.find((x) => x.key === 'muscle_kg')!.basis).toBe('formula')
      expect((h.food.weighinUnpair({ measured_at: iso(t), metric: 'muscle_kg' }) as Record<string, any>).removed).toBe(false)
      // fat
      const raw = h.food.scaleCal.reading('s400-tU1')!.fat_raw_pct!
      h.food.weighinPair({ measured_at: iso(t), metric: 'fat_pct', value: Math.round((raw + 2) * 10) / 10 })
      expect(h.food.scaleModel()!.n).toBe(1)
      h.food.weighinUnpair({ measured_at: iso(t), metric: 'fat_pct' })
      expect(h.food.scaleModel()!.n).toBe(0)
      expect(h.food.day().body!.metrics.find((x) => x.key === 'fat_pct')!.basis).toBe('formula')
      expect(h.store.db.query('SELECT COUNT(*) AS n FROM scale_ref_values').get()).toEqual({ n: 0 })
      expect(() => h.food.weighinUnpair({ measured_at: iso(t + 200_000), metric: 'fat_pct' })).toThrow(/no S400 weigh-in/)
    } finally {
      h.cleanup()
    }
  })
})
