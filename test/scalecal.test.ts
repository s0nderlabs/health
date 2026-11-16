// S400 fat calibration against Xiaomi Home (v0.19.1): raw storage, pairing,
// the offset / linear model, recalibration of stored samples, the pre-table
// backfill, event wording, the scale_calibration report, the bindkey at
// startup, and the listener's accept-only dedupe contract.
// Every body value, key, and MAC here is synthetic.
import { describe, expect, test, afterEach } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Store } from '../src/store.js'
import { FoodService } from '../src/food.js'
import { MealBook } from '../src/meals.js'
import { DEFAULT_CONFIG } from '../src/types.js'
import {
  applyModel,
  fitCalibration,
  pairReadings,
  pctToFraction,
  readingStemOf,
  calibrationNote,
  SLOPE_PRIOR_SXX,
  FIT_MAX_PAIRS,
  type CalPair,
  type ScaleRaw,
} from '../src/scalecal.js'
import {
  ScaleService,
  encodeMiBeaconV5,
  encodeObj6e16,
  encodeIdleFrame,
  listenerRemembers,
  LISTENER_RETRY_REASON,
  parseMac,
  readingFatPercent,
  OBJ_S400,
  SCALE_SOURCE,
  type S400Obj,
} from '../src/scale.js'
import { LiveListener } from '../src/live.js'
import { LiveState } from '../src/livestate.js'

const KEY = Buffer.from('a1b2c3d4e5f60718293a4b5c6d7e8f90', 'hex') // made up
const MAC = 'C4:7C:8D:00:33:44' // made up
const PID = 0x30d9
const PROFILE = { height_cm: 165, birth_date: '1985-07-04', sex: 'male' as const } // made up
const XIAOMI = 'Xiaomi Home'

const local = (y: number, mo: number, d: number, h: number, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime()
const iso = (ms: number) => new Date(ms).toISOString()

function harness(startAt = local(2026, 11, 16, 12), opts: { refSources?: string[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'health-scalecal-'))
  const store = new Store(':memory:')
  const meta = new Map<string, string>()
  const events: Array<{ cls: string; key: string; content: string; meta: Record<string, string> }> = []
  const broadcasts: Array<{ type?: string; date?: string }> = []
  let now = startAt
  const food = new FoodService({
    db: store.db,
    photosDir: join(dir, 'meals'),
    getConfig: () => DEFAULT_CONFIG.food,
    getMeta: (k) => meta.get(k) ?? null,
    setMeta: (k, v) => void meta.set(k, v),
    emit: (cls, key, p) => {
      events.push({ cls, key, ...p })
      return true
    },
    broadcast: (m) => void broadcasts.push(m as { type?: string; date?: string }),
    getScaleReferenceSources: () => opts.refSources,
    now: () => now,
  })
  /** One S400 reading (mass + raw-formula fat) the way the scale leg sends it. */
  const s400 = (stem: string, at: number, kg: number, rawPct: number | null) => {
    const ts = iso(at)
    const samples: Array<{ uuid: string; ts: string; kind: 'mass' | 'fat'; value: number; source: string }> = [
      { uuid: `${stem}-m`, ts, kind: 'mass', value: kg, source: SCALE_SOURCE },
    ]
    if (rawPct != null) samples.push({ uuid: `${stem}-f`, ts, kind: 'fat' as const, value: pctToFraction(rawPct), source: SCALE_SOURCE })
    const raw: ScaleRaw = {
      uuid: stem,
      measured_at: ts,
      kg,
      impedance_low: 512.3,
      impedance_high: 461.7,
      hr: 64,
      scale_ts: Math.floor(at / 1000),
      fat_raw_pct: rawPct,
    }
    return food.ingestBodySamples(samples, [], raw)
  }
  /** One Xiaomi Home weigh-in (mass + fat, via Apple Health). */
  const xiaomi = (id: string, at: number, kg: number, fatPct: number) =>
    food.ingestBodySamples(
      [
        { uuid: `xiaomi-${id}-m`, ts: iso(at), kind: 'mass', value: kg, source: XIAOMI },
        { uuid: `xiaomi-${id}-f`, ts: iso(at), kind: 'fat', value: fatPct / 100, source: XIAOMI },
      ],
      [],
    )
  const s400Fat = (stem: string) =>
    (store.db.query('SELECT value FROM body_samples WHERE uuid = ?').get(`${stem}-f`) as { value: number } | null)?.value ?? null
  const reading = (stem: string) => food.scaleCal.reading(stem)
  return {
    store,
    food,
    meta,
    events,
    broadcasts,
    s400,
    xiaomi,
    s400Fat,
    reading,
    setNow: (ms: number) => (now = ms),
    cleanup: () => {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

const pair = (i: number, raw: number, ref: number): CalPair => ({
  reading_uuid: `r${i}`,
  measured_at: iso(local(2026, 10, 1 + i, 6)),
  kg: 70,
  raw_pct: raw,
  ref_uuid: `x${i}`,
  ref_fat_pct: ref,
})

describe('pairing (pure)', () => {
  const t0 = local(2026, 11, 10, 6, 0)
  const r = (uuid: string, at: number, kg: number) => ({ uuid, measured_at: iso(at), kg, fat_raw_pct: 20 })
  const f = (uuid: string, at: number, kg: number) => ({ uuid, ts: iso(at), kg, fat_pct: 21 })

  test('window edges: 180 s and 0.2 kg are in, a second or 0.01 kg more is out', () => {
    expect(pairReadings([r('a', t0, 70)], [f('x', t0 + 180_000, 70)])).toHaveLength(1)
    expect(pairReadings([r('a', t0, 70)], [f('x', t0 - 180_000, 70)])).toHaveLength(1)
    expect(pairReadings([r('a', t0, 70)], [f('x', t0 + 181_000, 70)])).toHaveLength(0)
    expect(pairReadings([r('a', t0, 70)], [f('x', t0, 70.2)])).toHaveLength(1)
    expect(pairReadings([r('a', t0, 70.3)], [f('x', t0, 70.1)])).toHaveLength(1) // float 0.2 still in
    expect(pairReadings([r('a', t0, 70)], [f('x', t0, 70.21)])).toHaveLength(0)
    expect(pairReadings([r('a', t0, 70)], [f('x', t0, 69.79)])).toHaveLength(0)
  })

  test('one-to-one, closest in time wins', () => {
    // two S400 readings, one Xiaomi record: the nearer reading takes it
    const p1 = pairReadings([r('far', t0, 70), r('near', t0 + 100_000, 70)], [f('x', t0 + 120_000, 70)])
    expect(p1.map((p) => [p.reading_uuid, p.ref_uuid])).toEqual([['near', 'x']])
    // one reading, two Xiaomi records: the nearer record wins, the other stays unpaired
    const p2 = pairReadings([r('a', t0, 70)], [f('x1', t0 + 150_000, 70), f('x2', t0 - 30_000, 70.1)])
    expect(p2.map((p) => p.ref_uuid)).toEqual(['x2'])
    // two of each, crossed: each gets its own closest partner, no reuse
    const p3 = pairReadings(
      [r('a', t0, 70), r('b', t0 + 160_000, 70)],
      [f('x1', t0 + 10_000, 70), f('x2', t0 + 150_000, 70)],
    )
    expect(p3.map((p) => [p.reading_uuid, p.ref_uuid])).toEqual([
      ['a', 'x1'],
      ['b', 'x2'],
    ])
  })
})

describe('calibration model (pure)', () => {
  const now = iso(local(2026, 11, 16, 12))

  test('n = 0: none, the raw value passes through', () => {
    const m = fitCalibration([], now)
    expect(m).toMatchObject({ kind: 'none', n: 0, residual_rms_pct: null })
    expect(applyModel(m, 19.27)).toBe(19.27)
    expect(applyModel(null, 19.27)).toBe(19.27)
  })

  test('1 <= n < 3: offset only (mean difference)', () => {
    const m1 = fitCalibration([pair(1, 18.4, 19.9)], now)
    expect(m1.kind).toBe('offset')
    expect(m1.b).toBe(1)
    expect(m1.a).toBeCloseTo(1.5, 9)
    expect(m1.residual_rms_pct).toBe(0)
    expect(applyModel(m1, 18.4)).toBe(19.9)
    const m2 = fitCalibration([pair(1, 18, 19), pair(2, 20, 22)], now)
    expect(m2).toMatchObject({ kind: 'offset', n: 2, b: 1 })
    expect(m2.a).toBeCloseTo(1.5, 9)
    expect(m2.residual_rms_pct).toBeCloseTo(0.5, 6)
  })

  test('n >= 3: Theil-Sen slope shrunk toward 1 by the raw spread, through the means', () => {
    // exact line y = 2 + 0.9 x; sxx = 45, so b' = 1 - 0.1 * 45 / 49
    const ps = [15, 18, 21, 24].map((x, i) => pair(i, x, 2 + 0.9 * x))
    const m = fitCalibration(ps, now)
    expect(m.kind).toBe('linear')
    expect(m.n).toBe(4)
    const b = 1 - 0.1 * (45 / (45 + SLOPE_PRIOR_SXX))
    expect(m.b).toBeCloseTo(b, 9)
    expect(m.a + m.b * 19.5).toBeCloseTo(2 + 0.9 * 19.5, 9) // passes through the means
    expect(m).toMatchObject({ raw_min: 15, raw_max: 24, span_from: ps[0].measured_at })
    expect(m.loo_rms_pct).not.toBeNull()
    expect(applyModel(m, 20)).toBe(Math.round((m.a + m.b * 20) * 100) / 100)
  })

  test('a slope outside [0, 1.4] is clamped (continuous), raw SD under 1 point is offset only', () => {
    const steep = [15, 18, 21].map((x, i) => pair(i, x, 1.8 * x - 10)) // b = 1.8, shrunk 1.65
    const m = fitCalibration(steep, now)
    expect(m.kind).toBe('linear')
    expect(m.b).toBe(1.4)
    expect(m.note).toMatch(/slope 1\.65 clamped to 1\.4/)
    // A reference that barely follows the raw (Xiaomi may lean on weight, not
    // impedance) keeps its shrunk slope: no 0.6 floor.
    const flat = [15, 18, 21].map((x, i) => pair(i, x, 0.3 * x + 14)) // b = 0.3, shrunk 0.43
    expect(fitCalibration(flat, now).b).toBeCloseTo(0.427, 3)
    const negative = [15, 18, 21].map((x, i) => pair(i, x, -2 * x + 60)) // b = -2, shrunk -1.2
    expect(fitCalibration(negative, now).b).toBe(0)
    const same = [20, 20, 20].map((x, i) => pair(i, x, 21 + i * 0.1)) // no spread in raw
    expect(fitCalibration(same, now).kind).toBe('offset')
    const tight = [19.5, 20, 20.5].map((x, i) => pair(i, x, x + 1.5 + i * 0.2)) // SD 0.41 < 1
    const t = fitCalibration(tight, now)
    expect(t.kind).toBe('offset')
    expect(t.note).toMatch(/under 1 point/)
  })

  test('a 0.1-point move of one reference value cannot swing the model (clustered raws)', () => {
    // morning raws sit in a few tenths: the old least-squares slope fitted the
    // noise and flipped between offset and linear on a 0.1 move
    const base = [
      [30.0, 27.0],
      [30.2, 27.2],
      [29.9, 26.9],
      [30.1, 27.1],
    ].map(([x, y], i) => pair(i, x, y))
    const at24 = [27.3, 27.4, 27.8, 27.9].map((y) => applyModel(fitCalibration([...base, pair(9, 30.6, y)], now), 24))
    for (const v of at24) expect(Math.abs(v - at24[0])).toBeLessThan(0.15)
    expect(fitCalibration([...base, pair(9, 30.6, 27.4)], now).kind).toBe('offset')
  })

  test('one bad pair cannot set the slope (Theil-Sen)', () => {
    const good = [14, 17, 20, 23, 26].map((x, i) => pair(i, x, 3 + 0.9 * x))
    const bad = pair(9, 21, 3 + 0.9 * 21 + 6) // a 6-point miss
    const clean = fitCalibration(good, now)
    const dirty = fitCalibration([...good, bad], now)
    expect(Math.abs(dirty.b - clean.b)).toBeLessThan(0.05)
  })

  test('a linear model continues with slope 1 outside its fitted raw range', () => {
    const ps = [18, 20, 22].map((x, i) => pair(i, x, 1 + 0.8 * x))
    const m = fitCalibration(ps, now)
    expect(m.kind).toBe('linear')
    const atMax = m.a + m.b * 22
    expect(applyModel(m, 30)).toBeCloseTo(Math.round((atMax + 8) * 100) / 100, 9)
    const atMin = m.a + m.b * 18
    expect(applyModel(m, 12)).toBeCloseTo(Math.round((atMin - 6) * 100) / 100, 9)
  })

  test('leave-one-out RMS is reported (null at n = 1)', () => {
    expect(fitCalibration([pair(1, 18, 19)], now).loo_rms_pct).toBeNull()
    // n = 2 offset: each pair predicted from the other's difference
    expect(fitCalibration([pair(1, 18, 19), pair(2, 20, 22)], now).loo_rms_pct).toBeCloseTo(1, 6)
  })

  test('only the 30 most recent pairs feed the fit', () => {
    // 10 old pairs with offset +5, then 30 recent ones with offset +1
    const old = Array.from({ length: 10 }, (_, i) => pair(i, 20, 25))
    const recent = Array.from({ length: 30 }, (_, i) => ({ ...pair(i, 20 + (i % 3), 21 + (i % 3)), measured_at: iso(local(2026, 11, 1, 6) + i * 3_600_000) }))
    const m = fitCalibration([...recent, ...old], now)
    expect(m.n).toBe(30)
    expect(m.a + m.b * 20).toBeCloseTo(21, 6)
  })

  test('the calibrated value is clamped to 5-75 % and rounded to 2 dp', () => {
    expect(applyModel({ kind: 'offset', a: -10, b: 1, n: 1, residual_rms_pct: 0, fitted_at: now }, 8)).toBe(5)
    expect(applyModel({ kind: 'offset', a: 0.123456, b: 1, n: 1, residual_rms_pct: 0, fitted_at: now }, 20)).toBe(20.12)
    expect(readingStemOf('s400-t6a0b1c2d-f')).toBe('s400-t6a0b1c2d')
  })
})

describe('FoodService: raw storage, pairing, recalibration', () => {
  const cleanup: Array<() => void> = []
  afterEach(() => {
    while (cleanup.length) cleanup.pop()!()
  })

  test('raw kept in scale_readings, offset model at n = 1 rewrites the S400 fat sample', () => {
    const h = harness()
    cleanup.push(h.cleanup)
    const t = local(2026, 11, 16, 6, 10)
    h.s400('s400-tA', t, 71.3, 18.37)
    // before any pair: raw stored, sample = raw at 0.1-point resolution, no model
    expect(h.reading('s400-tA')).toMatchObject({ kg: 71.3, impedance_low: 512.3, impedance_high: 461.7, hr: 64, fat_raw_pct: 18.37, fat_cal_pct: null, calibration_n: 0 })
    expect(h.s400Fat('s400-tA')).toBe(0.184)
    expect(h.food.scaleModel()).toMatchObject({ kind: 'none', n: 0 })
    // Xiaomi Home copy of the same weigh-in arrives minutes later, 40 s off in its own clock
    h.xiaomi('a', t + 40_000, 71.25, 20.1)
    const m = h.food.scaleModel()!
    expect(m).toMatchObject({ kind: 'offset', n: 1, b: 1 })
    expect(m.a).toBeCloseTo(1.73, 9)
    expect(h.reading('s400-tA')).toMatchObject({ fat_raw_pct: 18.37, fat_cal_pct: 20.1, calibration_n: 1, pair_uuid: 'xiaomi-a-m', pair_fat_pct: 20.1 })
    expect(h.s400Fat('s400-tA')).toBe(0.201)
    // weighins() (the trend view) now reads the calibrated value
    expect(h.food.weighins(2).find((w) => w.source === SCALE_SOURCE)!.fat_pct).toBe(20.1)
  })

  test('recalibration rewrites unpaired S400 samples too (one consistent series)', () => {
    const h = harness()
    cleanup.push(h.cleanup)
    const d1 = local(2026, 11, 14, 6, 0)
    const d2 = local(2026, 11, 15, 6, 0)
    h.s400('s400-tB1', d1, 70.0, 17.0) // will pair
    h.s400('s400-tB2', d2, 69.8, 19.0) // never pairs (no Xiaomi that day)
    expect(h.s400Fat('s400-tB2')).toBe(0.19)
    h.xiaomi('b1', d1 + 20_000, 70.0, 18.2)
    expect(h.s400Fat('s400-tB1')).toBe(0.182)
    expect(h.s400Fat('s400-tB2')).toBe(0.202) // 19.0 + 1.2
    expect(h.reading('s400-tB2')).toMatchObject({ fat_raw_pct: 19.0, fat_cal_pct: 20.2, calibration_n: 1, pair_uuid: null })
    // a second pair changes the model: both rows follow it, raw untouched
    h.xiaomi('b2', d2 - 90_000, 69.9, 19.8) // offset now mean(1.2, 0.8) = 1.0
    expect(h.food.scaleModel()).toMatchObject({ kind: 'offset', n: 2 })
    expect(h.s400Fat('s400-tB1')).toBe(0.18)
    expect(h.s400Fat('s400-tB2')).toBe(0.2)
    expect(h.reading('s400-tB1')!.fat_raw_pct).toBe(17.0)
  })

  test('linear model at n >= 3 from ingested pairs', () => {
    const h = harness()
    cleanup.push(h.cleanup)
    const raws = [16, 18, 20, 22]
    raws.forEach((raw, i) => {
      const t = local(2026, 11, 10 + i, 6, 0)
      h.s400(`s400-tL${i}`, t, 72 - i * 0.1, raw)
      h.xiaomi(`l${i}`, t + 60_000, 72 - i * 0.1, 3 + 0.85 * raw)
    })
    const m = h.food.scaleModel()!
    expect(m.kind).toBe('linear')
    expect(m.n).toBe(4)
    // the reference values are rounded to 0.01 on the way in: allow for it
    expect(m.b).toBeCloseTo(1 - 0.15 * (20 / (20 + SLOPE_PRIOR_SXX)), 2)
    expect(m.a + m.b * 19).toBeCloseTo(3 + 0.85 * 19, 1)
    expect(h.s400Fat('s400-tL1')).toBe(pctToFraction(m.a + m.b * 18))
    expect(m.sources).toEqual([XIAOMI])
  })

  test('excluded (test, non-morning) readings still pair: they are calibration data', () => {
    const h = harness()
    cleanup.push(h.cleanup)
    const t = local(2026, 11, 16, 11, 30) // outside the morning window: excluded from the trend
    h.s400('s400-tX', t, 66.4, 21.0)
    h.xiaomi('x', t + 5_000, 66.4, 22.6)
    expect(h.food.weighins(2).every((w) => w.excluded === 'not a morning reading')).toBe(true)
    expect(h.food.scaleModel()).toMatchObject({ kind: 'offset', n: 1 })
    expect(h.reading('s400-tX')!.pair_uuid).toBe('xiaomi-x-m')
  })

  test('the Xiaomi copy of a paired weigh-in is a repeat, never a "possible replay"', () => {
    const h = harness()
    cleanup.push(h.cleanup)
    const t = local(2026, 11, 16, 6, 0)
    h.s400('s400-tR', t, 68.2, 17.5)
    h.xiaomi('r', t + 30_000, 68.2, 19.0) // offset n=1: calibrated S400 == Xiaomi exactly
    const rows = h.food.weighins(2)
    expect(rows.find((w) => w.source === SCALE_SOURCE)!.excluded).toBeNull()
    expect(rows.find((w) => w.source === XIAOMI)!.excluded).toMatch(/^repeat/)
  })

  test('the pairing follows the data: a deleted Xiaomi record drops its pair and the model', () => {
    const h = harness()
    cleanup.push(h.cleanup)
    const t = local(2026, 11, 16, 6, 0)
    h.s400('s400-tD', t, 70.5, 18.0)
    h.xiaomi('d', t + 10_000, 70.5, 19.5)
    expect(h.s400Fat('s400-tD')).toBe(0.195)
    h.food.ingestBodySamples([], ['xiaomi-d-m', 'xiaomi-d-f'])
    expect(h.food.scaleModel()).toMatchObject({ kind: 'none', n: 0 })
    expect(h.s400Fat('s400-tD')).toBe(0.18) // back to raw
    expect(h.reading('s400-tD')).toMatchObject({ fat_raw_pct: 18.0, fat_cal_pct: null, pair_uuid: null })
  })
})

describe('backfill of pre-table S400 rows', () => {
  test('an S400 fat sample with no scale_readings row gets one from the sample, impedances null', () => {
    const store = new Store(':memory:')
    try {
      // simulate an archive from before v0.19.1
      store.db.run('DROP TABLE scale_readings')
      const ts = iso(local(2026, 11, 12, 6, 15))
      const ins = store.db.prepare('INSERT INTO body_samples (uuid, ts, kind, value, source, received_at) VALUES (?, ?, ?, ?, ?, ?)')
      ins.run('s400-t0badc0de-m', ts, 'mass', 73.6, SCALE_SOURCE, ts)
      ins.run('s400-t0badc0de-f', ts, 'fat', 0.213, SCALE_SOURCE, ts)
      ins.run('xiaomi-old-m', ts, 'mass', 73.6, XIAOMI, ts) // not S400: no row
      ins.run('xiaomi-old-f', ts, 'fat', 0.228, XIAOMI, ts)
      MealBook.ensureSchema(store.db) // the migration at the next open
      const rows = store.db.query('SELECT * FROM scale_readings').all() as Array<Record<string, unknown>>
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        uuid: 's400-t0badc0de',
        measured_at: ts,
        kg: 73.6,
        fat_raw_pct: 21.3,
        impedance_low: null,
        impedance_high: null,
        hr: null,
        fat_cal_pct: null,
      })
      MealBook.ensureSchema(store.db) // idempotent
      expect((store.db.query('SELECT COUNT(*) AS n FROM scale_readings').get() as { n: number }).n).toBe(1)
    } finally {
      store.close()
    }
  })

  test('a backfilled row calibrates like any other (raw comes from the sample, not a rewrite)', () => {
    const h = harness()
    try {
      const t = local(2026, 11, 16, 6, 0)
      // an S400 sample that arrives WITHOUT its raw reading (pre-table path)
      h.food.ingestBodySamples(
        [
          { uuid: 's400-tOLD-m', ts: iso(t), kind: 'mass', value: 70.2, source: SCALE_SOURCE },
          { uuid: 's400-tOLD-f', ts: iso(t), kind: 'fat', value: 0.175, source: SCALE_SOURCE },
        ],
        [],
      )
      expect(h.reading('s400-tOLD')).toMatchObject({ fat_raw_pct: 17.5, impedance_low: null })
      h.xiaomi('old', t + 15_000, 70.2, 19.0)
      expect(h.s400Fat('s400-tOLD')).toBe(0.19)
      h.xiaomi('noise', t + 3 * 86_400_000, 70, 19) // later unrelated ingest: raw stays 17.5
      expect(h.reading('s400-tOLD')!.fat_raw_pct).toBe(17.5)
    } finally {
      h.cleanup()
    }
  })
})

describe('body.weighin wording for S400 readings', () => {
  test('uncalibrated before the first pair, calibrated from N pairs after', () => {
    const h = harness(local(2026, 11, 16, 6, 30))
    try {
      const t1 = local(2026, 11, 15, 6, 0)
      h.setNow(t1 + 60_000)
      h.s400('s400-tE1', t1, 69.4, 18.6)
      const e1 = h.events.filter((e) => e.cls === 'body.weighin').at(-1)!
      expect(e1.content).toContain('(S400 BLE, uncalibrated: no Xiaomi pair yet)')
      expect(e1.meta).toMatchObject({ source: SCALE_SOURCE, fat_calibration: 'uncalibrated', calibration_pairs: '0', fat_pct: '18.6' })
      h.xiaomi('e1', t1 + 45_000, 69.4, 20.0)
      const t2 = local(2026, 11, 16, 6, 0)
      h.setNow(t2 + 60_000)
      h.s400('s400-tE2', t2, 69.2, 18.8)
      const e2 = h.events.filter((e) => e.cls === 'body.weighin' && e.meta.source === SCALE_SOURCE).at(-1)!
      expect(e2.content).toContain('(S400 BLE, provisional offset to Xiaomi Home from 1 pair)')
      expect(e2.meta).toMatchObject({ fat_calibration: 'provisional', calibration_pairs: '1', fat_pct: '20.2' }) // 18.8 + 1.4
      // Xiaomi events keep their plain source
      const ex = h.events.find((e) => e.meta.source === XIAOMI)!
      expect(ex.content).toContain(`(${XIAOMI})`)
      expect(calibrationNote({ status: 'calibrated', n: 4, rms_pct: 0.34, reference: XIAOMI })).toBe('S400 BLE, calibrated to Xiaomi Home from 4 pairs, +/-0.3 pt')
      expect(calibrationNote({ status: 'calibrated', n: 4, rms_pct: null, reference: null })).toBe('S400 BLE, calibrated to Xiaomi Home from 4 pairs')
    } finally {
      h.cleanup()
    }
  })

  test('an S400 reading with no fat keeps the bare source', () => {
    const h = harness(local(2026, 11, 16, 6, 30))
    try {
      h.s400('s400-tNF', local(2026, 11, 16, 6, 0), 69.0, null)
      const e = h.events.filter((x) => x.cls === 'body.weighin').at(-1)!
      expect(e.content).toContain('(S400 BLE).')
      expect(e.meta.fat_calibration).toBeUndefined()
      expect(h.reading('s400-tNF')).toMatchObject({ fat_raw_pct: null, kg: 69.0 })
    } finally {
      h.cleanup()
    }
  })
})

describe('scale_calibration report', () => {
  test('model plus per-pair xiaomi / raw / calibrated / residual', () => {
    const h = harness()
    try {
      const t1 = local(2026, 11, 13, 6, 0)
      const t2 = local(2026, 11, 14, 6, 0)
      h.s400('s400-tP1', t1, 70.0, 18.0)
      h.xiaomi('p1', t1 + 20_000, 70.0, 19.0)
      h.s400('s400-tP2', t2, 70.1, 19.0)
      h.xiaomi('p2', t2 + 20_000, 70.1, 20.4)
      const rep = h.food.scaleCalibration()
      expect(rep.model).toMatchObject({ kind: 'offset', n: 2 })
      expect(rep.status).toBe('provisional')
      expect(rep.reference).toBe(XIAOMI)
      expect(rep.readings).toEqual({ total: 2, with_impedance: 2, paired: 2 })
      expect(rep.pairs).toHaveLength(2)
      expect(rep.pairs[0]).toEqual({
        measured_at: iso(t2),
        kg: 70.1,
        ref_source: XIAOMI,
        ref_fat_pct: 20.4,
        raw_pct: 19.0,
        raw_quantized: false,
        calibrated_pct: 20.2,
        residual_pct: 0.2,
        in_fit: true,
      })
      expect(rep.pairs[1]).toMatchObject({ raw_pct: 18.0, calibrated_pct: 19.2, residual_pct: -0.2 })
      expect(rep.note).toMatch(/trend only/)
    } finally {
      h.cleanup()
    }
  })
})

// ── scale leg end to end, bindkey at startup, listener contract ─────

function obj(o: Partial<S400Obj>): S400Obj {
  return { profileId: 1, massRaw: 0, hrRaw: 0, impedanceRaw: 0, scaleTs: 0, ...o }
}
function frame(o: S400Obj, counter: number): Buffer {
  return encodeMiBeaconV5({ productId: PID, counter, macBE: parseMac(MAC)!, bindkey: KEY, objects: [{ type: OBJ_S400, data: encodeObj6e16(o) }] })
}
const hex = (b: Buffer) => b.toString('hex')

function scaleHarness(readKey: () => Buffer | null) {
  const h = harness(local(2026, 11, 16, 6, 30))
  let now = local(2026, 11, 16, 6, 30)
  h.setNow(now)
  let reads = 0
  const logs: string[] = []
  const scale = new ScaleService({
    getConfig: () => ({ mac: MAC, profile: PROFILE }),
    ingest: (samples, raw) => h.food.ingestBodySamples(samples, [], raw),
    readBindkey: () => {
      reads++
      return readKey()
    },
    now: () => now,
    log: (m) => void logs.push(m),
  })
  return {
    ...h,
    scale,
    logs,
    reads: () => reads,
    advance: (ms: number) => {
      now += ms
      h.setNow(now)
    },
    now: () => now,
  }
}

describe('scale leg: raw reading lands with its impedances', () => {
  test('frames -> one scale_readings row (50/250 kHz, hr, scale ts, raw fat at full precision)', () => {
    const h = scaleHarness(() => KEY)
    try {
      const ts = Math.floor(h.now() / 1000)
      h.scale.ingestFrame(hex(frame(obj({ massRaw: 713, hrRaw: 18, impedanceRaw: 5123, scaleTs: ts }), 0x200)))
      h.advance(1500)
      expect(h.scale.ingestFrame(hex(frame(obj({ impedanceRaw: 4617, scaleTs: ts }), 0x201))).readings).toBe(1)
      const stem = `s400-t${ts.toString(16).padStart(8, '0')}`
      const row = h.reading(stem)!
      const expectRaw = readingFatPercent({ kg: 71.3, impedanceLow: 512.3, measuredAt: ts * 1000 }, PROFILE)!
      expect(row).toMatchObject({ kg: 71.3, impedance_low: 512.3, impedance_high: 461.7, hr: 68, scale_ts: ts, fat_raw_pct: expectRaw })
      expect(h.logs.join('\n')).not.toMatch(/71\.3|512|461/)
    } finally {
      h.scale.stop()
      h.cleanup()
    }
  })
})

describe('bindkey at startup', () => {
  test('start() loads the key at once, before any frame', () => {
    const h = scaleHarness(() => KEY)
    try {
      h.scale.start(60_000)
      expect(h.reads()).toBe(1)
      expect(h.scale.hasKey()).toBe(true)
    } finally {
      h.scale.stop()
      h.cleanup()
    }
  })

  test('a key missing at boot is retried on the timer every 60 s with no frames arriving', () => {
    let stored: Buffer | null = null
    const h = scaleHarness(() => stored)
    try {
      h.scale.start(60_000) // the real interval is not reached in this test; tick() is driven by hand
      expect(h.reads()).toBe(1)
      h.advance(5_000)
      h.scale.tick()
      expect(h.reads()).toBe(1) // rate-limited
      stored = KEY
      h.advance(56_000)
      h.scale.tick()
      expect(h.reads()).toBe(2)
      expect(h.scale.hasKey()).toBe(true)
      h.advance(120_000)
      h.scale.tick()
      expect(h.reads()).toBe(2) // a loaded key is not re-read by the timer
      // the "no bindkey" line is said once, not every retry
      expect(h.logs.filter((l) => /no bindkey/.test(l))).toHaveLength(1)
    } finally {
      h.scale.stop()
      h.cleanup()
    }
  })
})

describe('listener dedupe contract (accept-only)', () => {
  test('listenerRemembers: forgotten ONLY on a 2xx accepted:false no_key (review finding)', () => {
    expect(listenerRemembers(200, { ok: true, accepted: true, readings: 0 })).toBe(true)
    expect(listenerRemembers(200, { ok: true, accepted: true, reason: 'duplicate', readings: 0 })).toBe(true)
    expect(listenerRemembers(200, { ok: true, accepted: false, reason: LISTENER_RETRY_REASON, readings: 0 })).toBe(false)
    // every other reject is permanent for this frame: re-posting it on each
    // advertisement (several a second) would flood the daemon
    for (const reason of ['mac_mismatch', 'decrypt_failed', 'replay', 'unencrypted', 'malformed', 'unsupported', 'not_s400', 'no_mac'])
      expect(listenerRemembers(200, { ok: true, accepted: false, reason, readings: 0 })).toBe(true)
    expect(listenerRemembers(200, { ok: true, accepted: false, readings: 0 })).toBe(true) // no reason given
    expect(listenerRemembers(400, 'frame_hex must be an even-length hex string')).toBe(true)
    expect(listenerRemembers(405, null)).toBe(true)
    // a token mismatch is not fixed by re-posting: stay deduped (no log storm)
    expect(listenerRemembers(401, null)).toBe(true)
    // daemon down / 5xx: the frame already sits once in the retry buffer
    expect(listenerRemembers(500, { accepted: false, reason: LISTENER_RETRY_REASON })).toBe(true)
    expect(listenerRemembers(503, null)).toBe(true)
    expect(listenerRemembers(0, null)).toBe(true)
  })

  test('the Swift listener keys its forget rule on the same reason string', () => {
    const swift = readFileSync(join(import.meta.dir, '..', 'relayer', 'scale-listen.swift'), 'utf8')
    const body = swift.slice(swift.indexOf('func classify('), swift.indexOf('\n}\n', swift.indexOf('func classify(')))
    expect(body).toContain(`reason == "${LISTENER_RETRY_REASON}"`)
  })

  test('/scale-adv names the reason on every reject (the listener keys on it)', async () => {
    const h = scaleHarness(() => KEY)
    const TOKEN = 'synthetic-token-cal-10'
    const state = new LiveState({ getMaxHr: () => 190, getRestHr: () => 56, getHotBpm: () => null, emit: () => {} })
    const listener = new LiveListener(state, () => TOKEN, { scaleHttp: (req, url) => h.scale.handleHttp(req, url) })
    listener.start(0, '127.0.0.1')
    try {
      // @ts-expect-error reach into the private server for the assigned port
      const url = `http://127.0.0.1:${listener.server.port as number}/scale-adv`
      const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
      // a frame with a broken payload: decrypt fails, a permanent reject
      const buf = frame(obj({ massRaw: 690, impedanceRaw: 5000 }), 0x301)
      buf[buf.length - 1] ^= 0xff // the MIC no longer matches
      const bad = hex(buf)
      const r = await fetch(url, { method: 'POST', body: JSON.stringify({ frame_hex: bad, ts: h.now() }), headers })
      const j = (await r.json()) as { accepted: boolean; reason?: string }
      expect(r.status).toBe(200)
      expect(j.accepted).toBe(false)
      expect(typeof j.reason).toBe('string')
      expect(j.reason).not.toBe(LISTENER_RETRY_REASON)
      expect(listenerRemembers(r.status, j)).toBe(true)
    } finally {
      listener.stop()
      h.scale.stop()
      h.cleanup()
    }
  })

  test('/scale-adv answers a no_key frame with JSON accepted:false, so the listener re-posts it', async () => {
    let stored: Buffer | null = null
    const h = scaleHarness(() => stored)
    const TOKEN = 'synthetic-token-cal-9'
    const state = new LiveState({ getMaxHr: () => 190, getRestHr: () => 56, getHotBpm: () => null, emit: () => {} })
    const listener = new LiveListener(state, () => TOKEN, { scaleHttp: (req, url) => h.scale.handleHttp(req, url) })
    listener.start(0, '127.0.0.1')
    try {
      // @ts-expect-error reach into the private server for the assigned port
      const url = `http://127.0.0.1:${listener.server.port as number}/scale-adv`
      const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
      const body = JSON.stringify({ frame_hex: hex(frame(obj({ massRaw: 690, impedanceRaw: 5000 }), 0x300)), ts: h.now() })
      const r1 = await fetch(url, { method: 'POST', body, headers })
      const j1 = await r1.json()
      expect(r1.status).toBe(200)
      expect(j1).toEqual({ ok: true, accepted: false, reason: 'no_key', readings: 0 })
      expect(listenerRemembers(r1.status, j1)).toBe(false)
      // key lands (timer retry); the SAME frame re-posted is now accepted
      stored = KEY
      h.advance(61_000)
      h.scale.tick()
      const body2 = JSON.stringify({ frame_hex: hex(frame(obj({ massRaw: 690, impedanceRaw: 5000 }), 0x300)), ts: h.now() })
      const r2 = await fetch(url, { method: 'POST', body: body2, headers })
      const j2 = await r2.json()
      expect(j2).toMatchObject({ ok: true, accepted: true })
      expect(listenerRemembers(r2.status, j2)).toBe(true)
      h.scale.ingestFrame(hex(encodeIdleFrame(PID, 0x01)))
      expect(h.food.weighins(2)).toHaveLength(1)
    } finally {
      listener.stop()
      h.scale.stop()
      h.cleanup()
    }
  })
})

// ── review fixes (v0.19.1 hardening) ─────────────────────────────────

describe('same weigh-in, same instant, two sources', () => {
  const cleanup: Array<() => void> = []
  afterEach(() => {
    while (cleanup.length) cleanup.pop()!()
  })

  test('an S400 and a Xiaomi copy at the IDENTICAL timestamp count once (the S400 one)', () => {
    const h = harness()
    cleanup.push(h.cleanup)
    // three earlier mornings so avg7 has n >= 3 either way
    for (let d = 0; d < 3; d++) h.s400(`s400-tW${d}`, local(2026, 11, 12 + d, 6, 0), 70.0, 20.0 + d / 10)
    const t = local(2026, 11, 16, 6, 0)
    h.xiaomi('same', t, 70.0, 21.5) // Xiaomi first, on the scale's own clock
    h.s400('s400-tSAME', t, 70.0, 20.4)
    const rows = h.food.weighins(2).filter((w) => w.measured_at === iso(t))
    expect(rows).toHaveLength(2)
    expect(rows.find((w) => w.source === SCALE_SOURCE)!.excluded).toBeNull()
    expect(rows.find((w) => w.source === XIAOMI)!.excluded).toBe('same weigh-in, other source')
    // one weigh-in in the 7-day mean, not two
    expect(h.food.avg7(iso(t))!.n).toBe(4)
    // a re-pass is stable (order-independent)
    h.food.reclassifyWeighins()
    const again = h.food.weighins(2).filter((w) => w.measured_at === iso(t))
    expect(again.filter((w) => w.excluded == null).map((w) => w.source)).toEqual([SCALE_SOURCE])
  })

  test('weighin_set by uuid touches only that source\'s record at a shared instant', () => {
    const h = harness()
    cleanup.push(h.cleanup)
    const t = local(2026, 11, 16, 6, 0)
    h.s400('s400-tU', t, 70.0, 20.4)
    h.xiaomi('u', t, 70.0, 21.5)
    const res = h.food.setWeighin({ uuid: 'xiaomi-u-m', include: false, reason: 'synthetic check' })
    expect(res.changed).toBe(2)
    const rows = h.food.weighins(2)
    expect(rows.find((w) => w.source === XIAOMI)!.excluded).toBe('synthetic check')
    expect(rows.find((w) => w.source === SCALE_SOURCE)!.excluded).toBeNull()
    // and by the S400 uuid: only the S400 pair
    h.food.setWeighin({ uuid: 's400-tU-f', include: false })
    expect(h.food.weighins(2).find((w) => w.source === XIAOMI)!.excluded).toBe('synthetic check')
    expect(h.food.weighins(2).find((w) => w.source === SCALE_SOURCE)!.excluded).toBe('excluded by hand')
  })
})

describe('same-instant copies: deterministic, and re-decided every pass (review finding)', () => {
  const cleanup: Array<() => void> = []
  afterEach(() => {
    while (cleanup.length) cleanup.pop()!()
  })
  const at = (h: ReturnType<typeof harness>, ms: number, source: string) =>
    h.food.weighins(5).find((w) => w.measured_at === iso(ms) && w.source === source)!

  test('the S400 copy excluded by hand: the Xiaomi copy at the same instant counts again', () => {
    const h = harness()
    cleanup.push(h.cleanup)
    const t = local(2026, 11, 16, 6, 0)
    h.s400('s400-tH', t, 70.0, 20.4)
    h.xiaomi('h', t, 70.0, 21.5)
    expect(at(h, t, XIAOMI).excluded).toBe('same weigh-in, other source')
    h.food.setWeighin({ uuid: 's400-tH-m', include: false })
    expect(at(h, t, SCALE_SOURCE).excluded).toBe('excluded by hand')
    expect(at(h, t, XIAOMI).excluded).toBeNull()
    // stable on a later pass
    h.food.reclassifyWeighins()
    expect(at(h, t, XIAOMI).excluded).toBeNull()
    // and back: including the S400 copy again makes the Xiaomi copy the loser
    h.food.setWeighin({ uuid: 's400-tH-m', include: true })
    expect(at(h, t, SCALE_SOURCE).excluded).toBeNull()
    expect(at(h, t, XIAOMI).excluded).toBe('same weigh-in, other source')
  })

  test('the S400 copy is a replay: the Xiaomi copy counts, whichever arrived first', () => {
    for (const xiaomiFirst of [true, false]) {
      const h = harness()
      cleanup.push(h.cleanup)
      h.s400('s400-tD1', local(2026, 11, 15, 6, 0), 70.0, 20.0)
      const t = local(2026, 11, 16, 6, 0)
      if (xiaomiFirst) h.xiaomi('d2', t, 70.0, 21.5)
      h.s400('s400-tD2', t, 70.0, 20.0) // identical raw: a replay of the 15th
      if (!xiaomiFirst) h.xiaomi('d2', t, 70.0, 21.5)
      expect(at(h, t, SCALE_SOURCE).excluded).toBe('possible replay')
      expect(at(h, t, XIAOMI).excluded).toBeNull()
    }
  })
})

describe('replay compares a reading with the previous one of its OWN source (review finding)', () => {
  const cleanup: Array<() => void> = []
  afterEach(() => {
    while (cleanup.length) cleanup.pop()!()
  })
  const at = (h: ReturnType<typeof harness>, ms: number, source: string) =>
    h.food.weighins(5).find((w) => w.measured_at === iso(ms) && w.source === source)!

  test('a re-synced Xiaomi copy is a replay even when the previous weigh-in has an S400 copy at the same instant', () => {
    for (const s400First of [true, false]) {
      const h = harness()
      cleanup.push(h.cleanup)
      const t1 = local(2026, 11, 15, 6, 0)
      if (s400First) h.s400('s400-tX1', t1, 70.0, 20.0)
      h.xiaomi('x1', t1, 70.0, 21.5)
      if (!s400First) h.s400('s400-tX1', t1, 70.0, 20.0)
      const t2 = local(2026, 11, 16, 6, 0)
      h.xiaomi('x1-resynced', t2, 70.0, 21.5)
      expect(at(h, t2, XIAOMI).excluded).toBe('possible replay')
    }
  })

  test('an S400 replay is caught even when the previous weigh-in has a Xiaomi copy at the same instant', () => {
    for (const s400First of [true, false]) {
      const h = harness()
      cleanup.push(h.cleanup)
      const t1 = local(2026, 11, 15, 6, 0)
      if (s400First) h.s400('s400-tY1', t1, 70.0, 20.0)
      h.xiaomi('y1', t1, 70.0, 21.5)
      if (!s400First) h.s400('s400-tY1', t1, 70.0, 20.0)
      const t2 = local(2026, 11, 16, 6, 0)
      h.s400('s400-tY2', t2, 70.0, 20.0)
      expect(at(h, t2, SCALE_SOURCE).excluded).toBe('possible replay')
    }
  })

  test('the previous reading of the SAME source is the reference, not just the latest of any source', () => {
    const h = harness()
    cleanup.push(h.cleanup)
    h.xiaomi('z1', local(2026, 11, 14, 6, 0), 70.0, 21.5)
    h.s400('s400-tZ2', local(2026, 11, 15, 6, 0), 70.4, 20.8) // a different weigh-in in between
    const t3 = local(2026, 11, 16, 6, 0)
    h.xiaomi('z1-resynced', t3, 70.0, 21.5)
    expect(at(h, t3, XIAOMI).excluded).toBe('possible replay')
  })
})

describe('applyToAll writes only rows the model has not written (review finding)', () => {
  test('a second pass under the same model changes no row', () => {
    const h = harness(local(2026, 11, 16, 6, 30))
    try {
      ;[16, 18, 20, 22].forEach((raw, i) => {
        const t = local(2026, 11, 10 + i, 6, 0)
        h.s400(`s400-tW${i}`, t, 72 - i * 0.1, raw)
        h.xiaomi(`w${i}`, t + 60_000, 72 - i * 0.1, 3 + 0.85 * raw + (i % 2 ? 0.2 : -0.2))
      })
      const model = h.food.scaleModel()!
      expect(model.kind).not.toBe('none')
      const changes = () => (h.store.db.query('SELECT total_changes() AS n').get() as { n: number }).n
      h.food.scaleCal.applyToAll(model)
      const before = changes()
      expect(h.food.scaleCal.applyToAll(model)).toEqual([])
      expect(changes()).toBe(before)
      // every row still carries the model
      expect(h.reading('s400-tW0')!.cal_fitted_at).toBe(model.fitted_at)
      // a new model rewrites them
      const next = { ...model, fitted_at: new Date(Date.parse(model.fitted_at) + 1000).toISOString() }
      h.food.scaleCal.applyToAll(next)
      expect(changes()).toBeGreaterThan(before)
      expect(h.reading('s400-tW0')!.cal_fitted_at).toBe(next.fitted_at)
    } finally {
      h.cleanup()
    }
  })
})

describe('replay rule never reads a calibrated S400 value', () => {
  const cleanup: Array<() => void> = []
  afterEach(() => {
    while (cleanup.length) cleanup.pop()!()
  })

  test('S400 vs S400 compares the raw open-formula value, not the 0.1-point sample', () => {
    const h = harness()
    cleanup.push(h.cleanup)
    h.s400('s400-tP1', local(2026, 11, 14, 6, 0), 70.0, 20.0)
    h.s400('s400-tP2', local(2026, 11, 15, 6, 0), 70.0, 20.03) // same 0.1 bin, different raw
    h.s400('s400-tP3', local(2026, 11, 16, 6, 0), 70.0, 20.03) // identical raw: a replay
    const by = (d: number) => h.food.weighins(5).find((w) => w.measured_at === iso(local(2026, 11, d, 6, 0)))!
    expect(by(15).excluded).toBeNull()
    expect(by(16).excluded).toBe('possible replay')
  })

  test('S400 vs another source is never a replay (independent paths)', () => {
    const h = harness()
    cleanup.push(h.cleanup)
    h.s400('s400-tC1', local(2026, 11, 15, 6, 0), 70.0, 20.0)
    h.xiaomi('c2', local(2026, 11, 16, 6, 0), 70.0, 20.0) // next day, same numbers
    expect(h.food.weighins(3).find((w) => w.source === XIAOMI)!.excluded).toBeNull()
  })
})

describe('the S400 fat sample is never stored raw next to calibrated ones', () => {
  test('a new reading is written calibrated from the stored model even when the refit throws', () => {
    const h = harness(local(2026, 11, 16, 6, 30))
    try {
      const t1 = local(2026, 11, 15, 6, 0)
      h.setNow(t1 + 60_000)
      h.s400('s400-tF1', t1, 70.0, 18.0)
      h.xiaomi('f1', t1 + 30_000, 70.0, 19.5) // offset +1.5
      const t2 = local(2026, 11, 16, 6, 0)
      h.setNow(t2 + 60_000)
      h.food.recalibrateScale = () => {
        throw new Error('synthetic failure')
      }
      h.s400('s400-tF2', t2, 69.9, 18.2)
      expect(h.s400Fat('s400-tF2')).toBe(0.197) // 18.2 + 1.5, never the raw 0.182
      const e = h.events.filter((x) => x.cls === 'body.weighin').at(-1)!
      expect(e.meta).toMatchObject({ fat_calibration: 'provisional', calibration_pairs: '1', fat_pct: '19.7' })
      // a re-ingest of the same reading (scanner retry) never puts the raw back
      h.s400('s400-tF2', t2, 69.9, 18.2)
      expect(h.s400Fat('s400-tF2')).toBe(0.197)
    } finally {
      h.cleanup()
    }
  })

  test('the event label follows the reading\'s own row: calibrated from 3+ pairs carries a +/- band', () => {
    const h = harness(local(2026, 11, 16, 6, 30))
    try {
      ;[16, 18, 20, 22].forEach((raw, i) => {
        const t = local(2026, 11, 10 + i, 6, 0)
        h.s400(`s400-tK${i}`, t, 72 - i * 0.1, raw)
        h.xiaomi(`k${i}`, t + 60_000, 72 - i * 0.1, 3 + 0.85 * raw + (i % 2 ? 0.2 : -0.2))
      })
      const t = local(2026, 11, 16, 6, 0)
      h.setNow(t + 60_000)
      h.s400('s400-tKN', t, 71.5, 19.0)
      const e = h.events.filter((x) => x.cls === 'body.weighin' && x.meta.source === SCALE_SOURCE).at(-1)!
      expect(e.content).toMatch(/\(S400 BLE, calibrated to Xiaomi Home from 4 pairs, \+\/-\d\.\d pt\)/)
      expect(e.meta.fat_calibration).toBe('calibrated')
      expect(Number(e.meta.calibration_rms_pct)).toBeGreaterThan(0)
    } finally {
      h.cleanup()
    }
  })
})

describe('provenance on every surface', () => {
  test('weighins rows and latestWeight say device / raw / provisional and carry the S400 raw', () => {
    const h = harness()
    try {
      const t1 = local(2026, 11, 15, 6, 0)
      h.s400('s400-tV1', t1, 70.0, 18.04)
      let w = h.food.weighins(3).find((r) => r.source === SCALE_SOURCE)!
      expect(w).toMatchObject({ fat_pct: 18.0, fat_basis: 'raw', fat_raw_pct: 18.04 })
      h.xiaomi('v1', t1 + 20_000, 70.0, 19.5)
      w = h.food.weighins(3).find((r) => r.source === SCALE_SOURCE)!
      expect(w).toMatchObject({ fat_pct: 19.5, fat_basis: 'provisional', fat_raw_pct: 18.04 })
      expect(h.food.weighins(3).find((r) => r.source === XIAOMI)!.fat_basis).toBe('device')
      const lw = h.food.latestWeight()!
      // the counted weigh-in is the S400 one (the Xiaomi copy is the repeat)
      expect(lw).toMatchObject({ kg: 70, fat_pct: 19.5, fat_source: SCALE_SOURCE, fat_basis: 'provisional', fat_raw_pct: 18.04, fat_at: iso(t1) })
    } finally {
      h.cleanup()
    }
  })
})

describe('a model change re-sends every food day it rewrote', () => {
  test('changed() fires for the older day whose S400 sample moved, not only today', () => {
    const h = harness()
    try {
      h.s400('s400-tO1', local(2026, 11, 3, 6, 0), 70.0, 18.0) // weeks ago, never paired
      h.broadcasts.length = 0
      h.xiaomi('o2', local(2026, 11, 16, 6, 0) + 10_000, 70.0, 19.0)
      h.s400('s400-tO2', local(2026, 11, 16, 6, 0), 70.0, 18.0)
      const days = h.broadcasts.filter((b) => b.type === 'meals_updated').map((b) => b.date)
      expect(days).toContain('2026-11-03')
    } finally {
      h.cleanup()
    }
  })
})

describe('history freezes once the fit window is full', () => {
  test('readings older than the oldest of the 30 fitted pairs keep their calibration', () => {
    const h = harness(local(2027, 1, 30, 12))
    try {
      const day = (i: number) => local(2026, 11, 1, 6, 0) + i * 86_400_000
      // 5 early pairs at +1, then pairs at +3: raws identical (offset model)
      for (let i = 0; i < 5; i++) {
        h.s400(`s400-tZ${i}`, day(i), 70, 20)
        h.xiaomi(`z${i}`, day(i) + 20_000, 70, 21)
      }
      expect(h.s400Fat('s400-tZ0')).toBe(0.21)
      for (let i = 5; i < FIT_MAX_PAIRS + 1; i++) {
        h.s400(`s400-tZ${i}`, day(i), 70, 20)
        h.xiaomi(`z${i}`, day(i) + 20_000, 70, 23)
      }
      // window now full and z0 has rolled out: s400-tZ0 is frozen
      const frozen = h.s400Fat('s400-tZ0')!
      const inSpan = h.s400Fat('s400-tZ10')!
      for (let i = FIT_MAX_PAIRS + 1; i < FIT_MAX_PAIRS + 6; i++) {
        h.s400(`s400-tZ${i}`, day(i), 70, 20)
        h.xiaomi(`z${i}`, day(i) + 20_000, 70, 23)
      }
      expect(h.s400Fat('s400-tZ0')).toBe(frozen)
      expect(h.s400Fat('s400-tZ10')).toBeGreaterThan(inSpan) // in the fit span: follows the model
      const row = h.reading('s400-tZ0')!
      expect(row.cal_kind).toBe('offset')
      expect(row.cal_fitted_at).not.toBeNull()
    } finally {
      h.cleanup()
    }
  })
})

describe('reference sources', () => {
  test('with scale.reference_sources set, a manual Apple Health entry never becomes a pair', () => {
    const h = harness(undefined, { refSources: [XIAOMI] })
    try {
      const t = local(2026, 11, 16, 6, 0)
      h.s400('s400-tH', t, 70.0, 18.0)
      h.food.ingestBodySamples(
        [
          { uuid: 'manual-h-m', ts: iso(t + 30_000), kind: 'mass', value: 70.0, source: 'Health' },
          { uuid: 'manual-h-f', ts: iso(t + 30_000), kind: 'fat', value: 0.25, source: 'Health' },
        ],
        [],
      )
      expect(h.food.scaleModel()).toMatchObject({ kind: 'none', n: 0 })
      h.xiaomi('h', t + 60_000, 70.0, 19.0)
      expect(h.food.scaleModel()).toMatchObject({ kind: 'offset', n: 1, sources: [XIAOMI] })
    } finally {
      h.cleanup()
    }
  })

  test('unset: any source pairs, and the report names it instead of assuming Xiaomi', () => {
    const h = harness()
    try {
      const t = local(2026, 11, 16, 6, 0)
      h.s400('s400-tG', t, 70.0, 18.0)
      h.food.ingestBodySamples(
        [
          { uuid: 'other-g-m', ts: iso(t + 30_000), kind: 'mass', value: 70.0, source: 'Other Scale' },
          { uuid: 'other-g-f', ts: iso(t + 30_000), kind: 'fat', value: 0.2, source: 'Other Scale' },
        ],
        [],
      )
      const rep = h.food.scaleCalibration()
      expect(rep.reference).toBe('Other Scale')
      expect(rep.pairs[0].ref_source).toBe('Other Scale')
    } finally {
      h.cleanup()
    }
  })
})

describe('the uncalibrated series is the open formula, one rounding step', () => {
  test('dropping back to no model writes exactly what the scale leg wrote', () => {
    const h = harness()
    try {
      const t = local(2026, 11, 16, 6, 0)
      h.s400('s400-tQ', t, 70.0, 22.2496) // 2-dp storage would round this to 22.25 -> 0.223
      expect(h.s400Fat('s400-tQ')).toBe(0.222)
      h.xiaomi('q', t + 10_000, 70.0, 23.0)
      h.food.ingestBodySamples([], ['xiaomi-q-m', 'xiaomi-q-f'])
      expect(h.food.scaleModel()).toMatchObject({ kind: 'none' })
      expect(h.s400Fat('s400-tQ')).toBe(0.222)
      expect(h.reading('s400-tQ')!.fat_raw_pct).toBe(22.2496)
    } finally {
      h.cleanup()
    }
  })

  test('a backfilled row is flagged raw_from_sample, and the report says its raw is quantized', () => {
    const h = harness()
    try {
      const t = local(2026, 11, 16, 6, 0)
      h.food.ingestBodySamples(
        [
          { uuid: 's400-tBK-m', ts: iso(t), kind: 'mass', value: 70.2, source: SCALE_SOURCE },
          { uuid: 's400-tBK-f', ts: iso(t), kind: 'fat', value: 0.175, source: SCALE_SOURCE },
        ],
        [],
      )
      expect(h.reading('s400-tBK')!.raw_from_sample).toBe(1)
      h.xiaomi('bk', t + 15_000, 70.2, 19.0)
      expect(h.food.scaleCalibration().pairs[0].raw_quantized).toBe(true)
      // the real raw arriving later replaces it and clears the flag
      h.food.ingestBodySamples([], [], { uuid: 's400-tBK', measured_at: iso(t), kg: 70.2, impedance_low: 500, impedance_high: 450, hr: null, scale_ts: null, fat_raw_pct: 17.46 })
      expect(h.reading('s400-tBK')).toMatchObject({ raw_from_sample: 0, fat_raw_pct: 17.46 })
    } finally {
      h.cleanup()
    }
  })
})
