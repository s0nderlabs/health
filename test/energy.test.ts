// Energy balance + confounders + goal + weigh-in upgrade. Synthetic data only.
import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Store } from '../src/store.js'
import { FoodService } from '../src/food.js'
import { MealBook, addDays, foodDay, type BaselineDay } from '../src/meals.js'
import {
  balanceOf,
  balanceText,
  burnByDay,
  calibrate,
  computeCalibration,
  dayEnergy,
  exclusionStats,
  type CycleRec,
  type DayBurn,
} from '../src/energy.js'
import { computeBracket, offsetKg, viewOf, type ConfounderSeed, type ConfounderView } from '../src/confounders.js'
import { DEFAULT_CONFIG } from '../src/types.js'

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'health-energy-'))
})
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Local wall-clock ms (the daemon runs in local time; tests may run in UTC). */
const local = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime()
const iso = (ms: number) => new Date(ms).toISOString()
const cyc = (id: number, s: number, e: number | null, kcal: number | null = 3000, state = 'SCORED'): CycleRec => ({
  id,
  start: iso(s),
  end: e == null ? null : iso(e),
  score_state: state,
  kcal,
})

function harness(nowMs: number, cycles: CycleRec[] = []) {
  const store = new Store(':memory:')
  const events: Array<{ cls: string; key: string; content: string; meta: Record<string, string> }> = []
  const meta = new Map<string, string>()
  let now = nowMs
  let cfg = { ...DEFAULT_CONFIG.food }
  const food = new FoodService({
    db: store.db,
    photosDir: join(dir, `meals-${Math.random().toString(36).slice(2)}`),
    getConfig: () => cfg,
    getMeta: (k) => meta.get(k) ?? null,
    setMeta: (k, v) => void meta.set(k, v),
    emit: (cls, key, p) => {
      events.push({ cls, key, ...p })
      return true
    },
    broadcast: () => {},
    whoopCyclesSince: (since) => cycles.filter((c) => c.end == null || c.end >= since),
    now: () => now,
  })
  return {
    store,
    food,
    events,
    meta,
    cycles,
    setNow: (ms: number) => (now = ms),
    setCfg: (patch: Partial<typeof cfg>) => (cfg = { ...cfg, ...patch }),
    cfg: () => cfg,
  }
}

const R = 4

/** Synthetic confounder records (dates and details made up): the real ones
 *  are added at runtime and never live in source. Kind defaults fill in the
 *  window (creatine 28 d -> Dec 8, step-down 14 d -> Nov 28), label and bracket. */
const SYN_SEED: ConfounderSeed[] = [
  { kind: 'creatine_start', date: '2026-11-10', details: { summary: 'synthetic dose' } },
  { kind: 'intake_step_down', date: '2026-11-14', details: { summary: 'synthetic change' } },
]

describe('burn mapping (cycle -> food day)', () => {
  const today = '2026-11-13'
  const now = local(2026, 11, 13, 12)

  test('a full-coverage day: one cycle, >= 80% of its span inside, burn = its kJ / 4.184', () => {
    const cycles = [
      cyc(1, local(2026, 11, 9, 2), local(2026, 11, 10, 1, 30), 2900),
      cyc(2, local(2026, 11, 10, 1, 30), local(2026, 11, 11, 2), 3100),
      cyc(3, local(2026, 11, 11, 2), local(2026, 11, 12, 1, 45), 3000),
    ]
    const m = burnByDay(cycles, ['2026-11-10'], { nowMs: now, rolloverHour: R, today })
    expect(m.get('2026-11-10')).toEqual({ date: '2026-11-10', burn_kcal: 3100, coverage: 'full', reason: null, cycle_ids: [2] })
  })

  test('a late-night split cycle is excluded (split_cycle), and its neighbour is partial', () => {
    // Up all night: sleep at 08:30, then again at 23:30 the same day.
    const cycles = [
      cyc(1, local(2026, 11, 11, 2), local(2026, 11, 12, 8, 30), 3600),
      cyc(2, local(2026, 11, 12, 8, 30), local(2026, 11, 12, 23, 30), 1800),
      cyc(3, local(2026, 11, 12, 23, 30), local(2026, 11, 13, 23, 30), 2900),
    ]
    const m = burnByDay(cycles, ['2026-11-11', '2026-11-12'], { nowMs: now, rolloverHour: R, today })
    expect(m.get('2026-11-12')).toMatchObject({ burn_kcal: 1800, coverage: 'partial', reason: 'split_cycle' })
    // 24 of 30.5 h inside Nov 11 is under 80% of the cycle's span.
    expect(m.get('2026-11-11')).toMatchObject({ burn_kcal: 3600, coverage: 'partial', reason: 'partial_day' })
  })

  test('two cycles claiming one day = split_cycle, burn = both whole cycles (never pro-rata)', () => {
    const cycles = [cyc(1, local(2026, 11, 5, 3), local(2026, 11, 5, 12), 900), cyc(2, local(2026, 11, 5, 12), local(2026, 11, 6, 3), 2100)]
    const m = burnByDay(cycles, ['2026-11-05'], { nowMs: now, rolloverHour: R, today })
    expect(m.get('2026-11-05')).toMatchObject({ burn_kcal: 3000, reason: 'split_cycle', cycle_ids: [1, 2] })
  })

  test('sleep after 04:00, unscored, no data', () => {
    const cycles = [
      cyc(1, local(2026, 11, 7, 6), local(2026, 11, 8, 6, 15), 3000), // fell asleep at 06:00, then 06:15
      cyc(2, local(2026, 11, 9, 2), local(2026, 11, 10, 2), null, 'PENDING_SCORE'),
    ]
    const m = burnByDay(cycles, ['2026-11-07', '2026-11-09', '2026-11-02'], { nowMs: now, rolloverHour: R, today })
    expect(m.get('2026-11-07')).toMatchObject({ burn_kcal: 3000, coverage: 'partial', reason: 'sleep_after_0400' })
    expect(m.get('2026-11-09')).toMatchObject({ burn_kcal: null, coverage: 'none', reason: 'unscored' })
    expect(m.get('2026-11-02')).toMatchObject({ burn_kcal: null, coverage: 'none', reason: 'unscored' })
  })

  test('the in-progress cycle: today so far, placed on the waking day even before 04:00', () => {
    const open = [cyc(1, local(2026, 11, 12, 1, 30), local(2026, 11, 13, 1, 30), 3000), cyc(2, local(2026, 11, 13, 1, 30), null, 1100)]
    const m = burnByDay(open, ['2026-11-13'], { nowMs: now, rolloverHour: R, today })
    expect(m.get('2026-11-13')).toMatchObject({ burn_kcal: 1100, coverage: 'partial', reason: 'in_progress', cycle_ids: [2] })
    // 03:00, food day still Nov 12: the fresh cycle belongs to Nov 13, Nov 12 keeps its own.
    const early = local(2026, 11, 13, 3)
    const m2 = burnByDay(open, ['2026-11-12', '2026-11-13'], { nowMs: early, rolloverHour: R, today: foodDay(early, R) })
    expect(m2.get('2026-11-12')).toMatchObject({ burn_kcal: 3000, reason: 'in_progress', cycle_ids: [1] })
    expect(m2.get('2026-11-13')!.cycle_ids).toEqual([2])
  })

  test('review: early sleepers (partial_day) get their own waking-day flag', () => {
    const burns = new Map<string, DayBurn>()
    const days = Array.from({ length: 10 }, (_, i) => addDays('2026-11-01', i))
    days.forEach((d, i) =>
      burns.set(d, { date: d, burn_kcal: 3000, coverage: i < 5 ? 'partial' : 'full', reason: i < 5 ? 'partial_day' : null, cycle_ids: [i] }),
    )
    expect(exclusionStats(days, burns).flag).toContain('before ~23:15')
  })

  test('exclusion rate by reason + the waking-day flag above 30%', () => {
    const burns = new Map<string, DayBurn>()
    const days = Array.from({ length: 10 }, (_, i) => addDays('2026-11-01', i))
    days.forEach((d, i) =>
      burns.set(d, { date: d, burn_kcal: 3000, coverage: i < 4 ? 'partial' : 'full', reason: i < 4 ? 'sleep_after_0400' : null, cycle_ids: [i] }),
    )
    const s = exclusionStats(days, burns)
    expect(s.excluded.sleep_after_0400).toBe(4)
    expect(s.full).toBe(6)
    expect(s.rate.sleep_after_0400).toBe(0.4)
    expect(s.flag).toContain('waking day')
    burns.set(days[0], { ...burns.get(days[0])!, coverage: 'full', reason: null })
    burns.set(days[1], { ...burns.get(days[1])!, coverage: 'full', reason: null })
    expect(exclusionStats(days, burns).flag).toBeNull() // 2 of 10
  })
})

describe('calibration + balance math', () => {
  const window = { from: '2026-11-01', to: '2026-11-20' }
  const days = Array.from({ length: 20 }, (_, i) => ({ date: addDays('2026-11-01', i), kcal: 2500, complete: true }))
  const burns = new Map<string, DayBurn>(days.map((d) => [d.date, { date: d.date, burn_kcal: 3000, coverage: 'full', reason: null, cycle_ids: [] }]))

  test('factor = maintenance / mean burn over the SAME complete, fully covered days', () => {
    // Losing 0.05 kg/day: maintenance = 2500 + 385 = 2885.
    const c = computeCalibration({ days, burns, window, slope: { central: -0.05, lo: -0.06, hi: -0.04 }, kcalPerKg: 7700, provisional: false, nowIso: '2026-11-21T05:00:00.000Z' })!
    expect(c.n).toBe(20)
    expect(c.maintenance).toBe(2885)
    expect(c.factor).toBeCloseTo(2885 / 3000, 3)
    expect(c.factor_lo).toBeCloseTo((2500 + 0.04 * 7700) / 3000, 3)
    expect(c.factor_hi).toBeCloseTo((2500 + 0.06 * 7700) / 3000, 3)
    expect(c.window).toEqual(window)
    // A partial day never enters the factor; an incomplete food day neither.
    const b2 = new Map(burns)
    b2.set('2026-11-05', { ...b2.get('2026-11-05')!, burn_kcal: 9000, coverage: 'partial', reason: 'split_cycle' })
    const d2 = days.map((d) => (d.date === '2026-11-06' ? { ...d, kcal: 500, complete: false } : d))
    expect(computeCalibration({ days: d2, burns: b2, window, slope: { central: 0, lo: 0, hi: 0 }, kcalPerKg: 7700, provisional: false, nowIso: 'x' })!.n).toBe(18)
  })

  test('fewer than 7 fully covered days = no factor', () => {
    const few = new Map([...burns].map(([k, v], i) => [k, i < 6 ? v : { ...v, coverage: 'partial' as const, reason: 'split_cycle' as const }]))
    expect(computeCalibration({ days, burns: few, window, slope: { central: 0, lo: 0, hi: 0 }, kcalPerKg: 7700, provisional: false, nowIso: 'x' })).toBeNull()
  })

  test('balance = intake - burn x factor, band = logging range x factor band', () => {
    const b = balanceOf({ kcal: 2000, kcal_lo: 1800, kcal_hi: 2200 }, 3000, { factor: 0.8, factor_lo: 0.75, factor_hi: 0.85 })
    expect(b).toEqual({ balance: -400, lo: 1800 - 2550, hi: 2200 - 2250 })
    expect(balanceText({ balance_kcal: -400, balance_lo: -750, balance_hi: -50 })).toBe('-400 kcal deficit (-750 to -50)')
    expect(balanceText({ balance_kcal: 200, balance_lo: -100, balance_hi: 500 })).toBe('+200 kcal surplus (-100 to +500)')
  })

  test('day contract: uncalibrated = burn only, no balance, exact keys', () => {
    const e = dayEnergy({
      date: '2026-11-12',
      today: '2026-11-13',
      intake: { kcal: 2000, kcal_lo: 1800, kcal_hi: 2200, estimated: 3 },
      burn: { date: '2026-11-12', burn_kcal: 3000, coverage: 'full', reason: null, cycle_ids: [1] },
      cal: null,
    })
    expect(Object.keys(e).sort()).toEqual(['balance_hi', 'balance_kcal', 'balance_lo', 'burn_kcal', 'calibrated', 'coverage', 'factor', 'note', 'provisional', 'so_far'])
    expect(e).toMatchObject({ burn_kcal: 3000, calibrated: false, factor: null, balance_kcal: null, balance_lo: null, balance_hi: null, so_far: false, coverage: 'full', provisional: false })
    // Phone-sized: no header restatement, no deficit / surplus word.
    expect(e.note).toBe('No balance until the baseline calibrates WHOOP.')
    expect(e.note).not.toMatch(/deficit|surplus/)
  })

  test('day contract: calibrated balance + band; today is "so far", never projected', () => {
    const cal = { factor: 0.8, factor_lo: 0.75, factor_hi: 0.85, n: 18, provisional: false } as never
    const past = dayEnergy({
      date: '2026-11-12',
      today: '2026-11-13',
      intake: { kcal: 2000, kcal_lo: 1800, kcal_hi: 2200, estimated: 3 },
      burn: { date: '2026-11-12', burn_kcal: 3000, coverage: 'full', reason: null, cycle_ids: [1] },
      cal,
    })
    expect(past).toMatchObject({ calibrated: true, factor: 0.8, balance_kcal: -400, balance_lo: -750, balance_hi: -50, so_far: false, provisional: false })
    // A plain full-coverage past day has nothing to add: no note, no factor restated.
    expect(past.note).toBeNull()
    const now = dayEnergy({
      date: '2026-11-13',
      today: '2026-11-13',
      intake: { kcal: 600, kcal_lo: 500, kcal_hi: 700, estimated: 1 },
      burn: { date: '2026-11-13', burn_kcal: 1100, coverage: 'partial', reason: 'in_progress', cycle_ids: [2] },
      cal,
    })
    // Exactly intake so far vs burn so far: 600 - 1100 x 0.8 = -280.
    expect(now).toMatchObject({ so_far: true, balance_kcal: -280, coverage: 'partial' })
    expect(now.note).toContain('So far today, not a projection')
    const empty = dayEnergy({ date: '2026-11-13', today: '2026-11-13', intake: { kcal: 0, kcal_lo: 0, kcal_hi: 0, estimated: 0 }, burn: null, cal })
    expect(empty).toMatchObject({ burn_kcal: null, balance_kcal: null, coverage: 'none', calibrated: true })
  })
})

describe('confounder bracket', () => {
  const rec = (kind: string, sign: 1 | -1, kg: [number, number, number], tau: number): ConfounderView =>
    viewOf({ id: 1, kind, date: '2026-11-10', details: { bracket: { sign, kg, tau_days: tau } }, window_end: '2026-12-08', closed_at: null, created_at: 'x' }, '2026-11-20')

  test('the fixed curve: +C(1 - e^(-t/9)) - S(1 - e^(-t/4))', () => {
    const c = rec('creatine_start', 1, [0, 1, 2], 9)
    const s = rec('intake_step_down', -1, [0.5, 1, 2], 4)
    const parts = [
      { anchor: '2026-11-10', spec: c.bracket!, kg: 1 },
      { anchor: '2026-11-10', spec: s.bracket!, kg: 1 },
    ]
    expect(offsetKg('2026-11-10', parts)).toBe(0)
    expect(offsetKg('2026-11-19', parts)).toBeCloseTo(1 - Math.exp(-1) - (1 - Math.exp(-9 / 4)), 6)
  })

  test('3 x 3 grid: range + central (C=1, S=1), central recovers the truth', () => {
    const c = rec('creatine_start', 1, [0, 1, 2], 9)
    const s = rec('intake_step_down', -1, [0.5, 1, 2], 4)
    const window = { from: '2026-11-10', to: '2026-12-07' }
    const days: BaselineDay[] = Array.from({ length: 28 }, (_, i) => ({ date: addDays('2026-11-10', i), kcal: 2400, kcal_lo: 2200, kcal_hi: 2600, complete: true }))
    // Truth: flat 80 kg tissue + exactly the central curves.
    const parts = [
      { anchor: '2026-11-10', spec: c.bracket!, kg: 1 },
      { anchor: '2026-11-10', spec: s.bracket!, kg: 1 },
    ]
    const weights = days.map((d) => ({ date: d.date, kg: 80 + offsetKg(d.date, parts) }))
    const b = computeBracket(days, weights, [c, s], window, 7700)!
    expect(b.grid).toHaveLength(9)
    expect(b.central).toBe(2400)
    expect(b.range.lo).toBeLessThan(b.central)
    expect(b.range.hi).toBeGreaterThan(b.central)
    // More creatine water assumed -> lower true slope -> higher maintenance.
    const at = (C: number, S: number) => b.grid.find((g) => g.kg[0] === C && g.kg[1] === S)!.maintenance
    expect(b.range.hi).toBe(at(2, 0.5))
    expect(b.range.lo).toBe(at(0, 2))
  })
})

/** n days of complete logging + flat-ish morning weigh-ins ending yesterday. */
async function seedHistory(h: ReturnType<typeof harness>, endDay: [number, number, number], n: number, kcal: number, kg: (i: number) => number) {
  const [y, mo, d] = endDay
  for (let i = n; i >= 1; i--) {
    const day = new Date(y, mo - 1, d - i)
    const at = (hh: number) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), hh).getTime()
    h.setNow(at(20))
    await h.food.logFromChat({ items: [{ name: 'day', kcal, kcal_lo: kcal - 200, kcal_hi: kcal + 200, protein_g: 150 }] })
    h.food.ingestBodySamples([{ uuid: `hk-syn-${y}${mo}${d}-${i}`, ts: iso(at(5)), kind: 'mass', value: kg(i), source: 'Synthetic Scale' }], [])
  }
}

/** One 24 h cycle per day, 02:00 to 02:00 local: every day full coverage. */
function dailyCycles(from: [number, number, number], n: number, kcal: number): CycleRec[] {
  return Array.from({ length: n }, (_, i) => cyc(i + 1, local(from[0], from[1], from[2] + i, 2), local(from[0], from[1], from[2] + i + 1, 2), kcal))
}

describe('food service: energy end to end', () => {
  test('uncalibrated: day() shows burn only; no deficit claim anywhere', async () => {
    const cycles = dailyCycles([2026, 11, 14], 3, 2900)
    cycles.push(cyc(99, local(2026, 11, 17, 2), null, 800))
    const h = harness(local(2026, 11, 17, 12), cycles)
    await h.food.logFromChat({ items: [{ name: 'lunch', kcal: 700, protein_g: 40 }] })
    const today = h.food.day()
    expect(today.energy).toMatchObject({ burn_kcal: 800, calibrated: false, factor: null, balance_kcal: null, so_far: true })
    const y = h.food.day('2026-11-16')
    expect(y.energy).toMatchObject({ burn_kcal: 2900, coverage: 'full', so_far: false, balance_kcal: null })
    const line = h.food.summaryOf(null, today)
    expect(line).toContain('Burned (WHOOP, uncalibrated): 800 kcal so far.')
    expect(line).not.toMatch(/deficit|surplus/)
  })

  test('calibrated: factor stored with computed_at/n/window, balance + band, weekly refresh', async () => {
    const h = harness(local(2026, 11, 21, 12), dailyCycles([2026, 10, 30], 23, 3000))
    await seedHistory(h, [2026, 11, 21], 20, 2500, () => 80) // flat weight: maintenance 2500
    h.setNow(local(2026, 11, 21, 12))
    const b = h.food.baseline({ refreshCalibration: true })
    expect(b.ready).toBe(true)
    expect(b.status).toBe('ready')
    expect(b.maintenance).toBe(2500)
    expect(b.energy.calibrated).toBe(true)
    expect(b.energy.factor).toBeCloseTo(0.833, 3)
    expect(b.energy.calibration).toMatchObject({ n: 20, maintenance: 2500, mean_burn_kcal: 3000, window: { from: '2026-10-24', to: '2026-11-20' }, provisional: false })
    expect(JSON.parse(h.meta.get('food_energy_calibration')!).computed_at).toBe(iso(local(2026, 11, 21, 12)))
    expect(b.energy.coverage).toMatchObject({ days: 20, full: 20, flag: null })
    // A past day: 2500 - 3000 x 0.833.
    const past = h.food.day('2026-11-20').energy
    expect(past.balance_kcal).toBe(Math.round(2500 - 3000 * b.energy.factor!))
    expect(past.balance_lo! < past.balance_kcal! && past.balance_kcal! < past.balance_hi!).toBe(true)

    // Intake shifts: day() keeps the stored factor (at most weekly)...
    await h.food.logFromChat({ items: [{ name: 'extra', kcal: 900, protein_g: 0 }], at: iso(local(2026, 11, 20, 21)) })
    expect(h.food.day().energy.factor).toBe(b.energy.factor)
    // ...an explicit baseline read recomputes it...
    const b2 = h.food.baseline({ refreshCalibration: true })
    expect(b2.energy.factor).not.toBe(b.energy.factor)
    // ...and so does a day() read once the stored one is 7 days old.
    h.meta.set('food_energy_calibration', JSON.stringify({ ...b.energy.calibration, computed_at: iso(local(2026, 11, 13, 12)) }))
    h.food.day()
    expect(JSON.parse(h.meta.get('food_energy_calibration')!).factor).toBe(b2.energy.factor)
  })
})

describe('confounders + provisional baseline', () => {
  test('seeding is idempotent; provisional through the creatine window (it binds), not after', () => {
    const h = harness(local(2026, 12, 8, 12))
    expect(h.food.seedConfounders(SYN_SEED)).toBe(2)
    expect(h.food.seedConfounders(SYN_SEED)).toBe(0)
    const b = h.food.baseline()
    expect(b.status).toBe('provisional')
    expect(b.status_reason).toBe('creatine saturation through ~Dec 8, weight trend inflated')
    expect(b.confounders.map((c) => [c.kind, c.status, c.window.to])).toEqual([
      ['creatine_start', 'active', '2026-12-08'],
      ['intake_step_down', 'closed', '2026-11-28'],
    ])
    for (const c of b.confounders) {
      expect(c.sentence.split('. ').length).toBe(1) // one plain sentence
      expect(c.sentence).not.toContain('\u2014')
    }
    h.setNow(local(2026, 12, 9, 12))
    const after = h.food.baseline()
    expect(after.status).toBe('collecting')
    expect(after.clean_from).toBe('2026-12-09')
    expect(after.confounders.every((c) => c.status === 'closed')).toBe(true)
  })

  test('provisional + ready: raw slope + bracket shown, no suggested target unless accept:true', async () => {
    const h = harness(local(2026, 12, 5, 12))
    h.food.seedConfounders(SYN_SEED)
    await seedHistory(h, [2026, 12, 5], 20, 2500, (i) => 80 + 0.02 * (20 - i))
    h.setNow(local(2026, 12, 5, 12))
    const b = h.food.baseline()
    expect(b.ready).toBe(true)
    expect(b.status).toBe('provisional')
    expect(b.suggested_target).toBeNull()
    expect(b.weight_trend_kg_per_week).toBeCloseTo(0.14, 2) // the raw slope stays visible
    expect(b.bracket!.grid).toHaveLength(9)
    expect(b.provisional_suggested_target).toBe(b.bracket!.central - 400)
    expect(b.early_slope?.note).toContain('LEAST trustworthy')
    const r = h.food.acceptTarget({ accept: true })
    expect(r.provisional).toBe(true)
    expect(r.target_kcal).toBe(b.provisional_suggested_target!)
    // The maintenance stored beside it is the one the target came from.
    expect(r.maintenance).toBe(b.bracket!.central)
    expect(h.meta.get('food_target_maintenance')).toBe(String(b.bracket!.central))
    expect(r.target_kcal).toBe(r.maintenance! - 400)
    expect(h.food.day().targets.kcal_provisional).toBe(true)
  })

  test('add / close a confounder through the service', () => {
    const h = harness(local(2026, 11, 20, 12))
    const a = h.food.addConfounder({ kind: 'Travel', details: 'a week of hotel food', window_days: 7 })
    expect(a.confounder).toMatchObject({ kind: 'travel', date: '2026-11-20', status: 'active', window: { from: '2026-11-20', to: '2026-11-27' } })
    expect(h.food.baseline().status).toBe('provisional')
    const c = h.food.closeConfounder({ kind: 'travel' })
    expect(c.confounder.status).toBe('closed')
    expect(h.food.baseline().status).toBe('collecting')
    expect(() => h.food.closeConfounder({ kind: 'nope' })).toThrow()
  })

  test('review: a future start is refused; close accepts the human spelling', () => {
    const h = harness(local(2026, 11, 20, 12))
    expect(() => h.food.addConfounder({ kind: 'travel', date: '2026-11-25' })).toThrow(/future/)
    h.food.addConfounder({ kind: 'Creatine start', date: '2026-11-18' })
    expect(h.food.closeConfounder({ kind: 'Creatine start' }).confounder.status).toBe('closed')
  })

  test('goal record: derived weight at target, creatine-adjusted, settable + clearable', () => {
    const h = harness(local(2026, 11, 20, 12))
    expect(h.food.baseline().goal).toBeNull()
    h.food.seedConfounders(SYN_SEED)
    const g = h.food.setGoal({ target_bf_pct: 15, milestone_kg: 70, lean_mass_ref_kg: 60, lean_mass_ref_source: 'synthetic scan' }).goal!
    expect(g.derived.weight_at_target_kg).toBe(70.6) // 60 / 0.85
    expect(g.derived.weight_at_target_on_creatine_kg).toBe(71.6)
    expect(g.derived.note).toContain('TREND only')
    expect(h.food.baseline().goal?.milestone_kg).toBe(70)
    expect(h.food.clearGoal().cleared).toBe(true)
    expect(h.food.baseline().goal).toBeNull()
    expect(() => h.food.setGoal({ target_bf_pct: 90, lean_mass_ref_kg: 60 })).toThrow()
  })
})

describe('body.weighin upgrade', () => {
  const src = 'Synthetic Scale'
  const mass = (uuid: string, ms: number, value: number) => ({ uuid, ts: iso(ms), kind: 'mass', value, source: src })
  const fat = (uuid: string, ms: number, value: number) => ({ uuid, ts: iso(ms), kind: 'fat', value, source: src })

  test('7-day average + delta once n >= 3, and the active confounders line', () => {
    const h = harness(local(2026, 11, 16, 6))
    h.food.seedConfounders(SYN_SEED)
    const vals = [81.0, 80.8, 80.9, 80.7, 80.6, 80.6, 80.5, 80.4, 80.3, 80.4, 80.2]
    vals.forEach((v, i) => {
      h.setNow(local(2026, 11, 16 + i, 6))
      h.food.ingestBodySamples([mass(`hk-avg-${String(i).padStart(3, '0')}`, local(2026, 11, 16 + i, 5), v)], [])
    })
    const ev = h.events.filter((e) => e.cls === 'body.weighin')
    expect(ev[1].content).not.toContain('7-day average') // n = 2
    expect(ev[2].meta.avg7_n).toBe('3')
    const last = ev.at(-1)!
    // Last 7 days (Nov 20-26): 80.6 80.6 80.5 80.4 80.3 80.4 80.2 -> 80.43; the 7 before (Nov 16-19): 80.85.
    expect(last.meta.avg7_kg).toBe('80.4')
    expect(last.meta.avg7_delta_kg).toBe('-0.4')
    expect(last.content).toContain('7-day average 80.4 kg over 7 readings (-0.4 kg vs the 7 days before).')
    expect(last.content).toContain('Confounders: creatine saturation through ~Dec 8, weight trend inflated; intake step-down through ~Nov 28, early water loss in the trend.')
    expect(last.content).not.toContain('\u2014')
  })

  test('after-a-meal: a reading after a meal of the same food day is excluded, also when the meal is logged later', async () => {
    const h = harness(local(2026, 11, 17, 6, 30))
    const book = new MealBook(h.store.db)
    await h.food.logFromChat({ items: [{ name: 'breakfast', kcal: 400, protein_g: 20 }], at: iso(local(2026, 11, 17, 5)) })
    h.food.ingestBodySamples([mass('hk-meal-0001', local(2026, 11, 17, 6), 80.4)], [])
    expect(book.bodyExcluded('hk-meal-0001')).toBe('after a meal')
    expect(h.events.at(-1)!.content).toContain('Taken after a meal logged this food day, excluded from the trend (not fasted).')
    // A late-night meal belongs to the previous food day: the next morning stays fasted.
    h.setNow(local(2026, 11, 18, 6, 30))
    await h.food.logFromChat({ items: [{ name: 'late snack', kcal: 300, protein_g: 5 }], at: iso(local(2026, 11, 18, 1)) })
    h.food.ingestBodySamples([mass('hk-meal-0002', local(2026, 11, 18, 6), 80.3)], [])
    expect(book.bodyExcluded('hk-meal-0002')).toBeNull()
    // Breakfast logged AFTER the reading synced, back-dated before it: re-classified.
    h.setNow(local(2026, 11, 19, 7))
    h.food.ingestBodySamples([mass('hk-meal-0003', local(2026, 11, 19, 6), 80.2)], [])
    expect(book.bodyExcluded('hk-meal-0003')).toBeNull()
    await h.food.logFromChat({ items: [{ name: 'breakfast', kcal: 400, protein_g: 20 }], at: '05:30' })
    expect(book.bodyExcluded('hk-meal-0003')).toBe('after a meal')
  })

  test('replay guard: identical mass AND fat to the previous reading is excluded but still announced', () => {
    const h = harness(local(2026, 11, 17, 6))
    const book = new MealBook(h.store.db)
    h.food.ingestBodySamples([mass('hk-rep-m17', local(2026, 11, 17, 5), 80.4), fat('hk-rep-f17', local(2026, 11, 17, 5), 0.2)], [])
    h.setNow(local(2026, 11, 18, 6))
    h.food.ingestBodySamples([mass('hk-rep-m18', local(2026, 11, 18, 5), 80.4), fat('hk-rep-f18', local(2026, 11, 18, 5), 0.2)], [])
    expect(book.bodyExcluded('hk-rep-m18')).toBe('possible replay')
    expect(book.bodyExcluded('hk-rep-f18')).toBe('possible replay')
    const ev = h.events.filter((e) => e.cls === 'body.weighin')
    expect(ev).toHaveLength(2)
    expect(ev[1].content).toContain('Identical to the previous reading in both weight and fat')
    // Same mass, different fat: a real reading.
    h.setNow(local(2026, 11, 19, 6))
    h.food.ingestBodySamples([mass('hk-rep-m19', local(2026, 11, 19, 5), 80.4), fat('hk-rep-f19', local(2026, 11, 19, 5), 0.201)], [])
    expect(book.bodyExcluded('hk-rep-m19')).toBeNull()
  })

  test('re-classification on a weighins_from config change (both directions)', () => {
    const h = harness(local(2026, 11, 18, 6))
    const book = new MealBook(h.store.db)
    h.food.ingestBodySamples([mass('hk-cfg-m17', local(2026, 11, 17, 5), 80.4)], [])
    expect(book.bodyExcluded('hk-cfg-m17')).toBeNull()
    const before = h.cfg()
    h.setCfg({ weighins_from: '2026-11-18' })
    h.food.onConfigChanged(before, h.cfg())
    expect(book.bodyExcluded('hk-cfg-m17')).toContain('before the first fasted weigh-in')
    const mid = h.cfg()
    h.setCfg({ weighins_from: '2026-11-16' })
    h.food.onConfigChanged(mid, h.cfg())
    expect(book.bodyExcluded('hk-cfg-m17')).toBeNull()
    // Unrelated config changes leave verdicts alone.
    h.food.onConfigChanged(h.cfg(), { ...h.cfg(), deficit_kcal: 300 })
    expect(book.bodyExcluded('hk-cfg-m17')).toBeNull()
  })
})

describe('review fixes (Nov 16 2026)', () => {
  const src = 'Synthetic Scale'
  const mass = (uuid: string, ms: number, value: number) => ({ uuid, ts: iso(ms), kind: 'mass', value, source: src })
  const fat = (uuid: string, ms: number, value: number) => ({ uuid, ts: iso(ms), kind: 'fat', value, source: src })

  test('fasted check: a 03:45 reading is not "after a meal" because of last night\'s dinner', async () => {
    const h = harness(local(2026, 11, 17, 20, 30))
    const book = new MealBook(h.store.db)
    await h.food.logFromChat({ items: [{ name: 'dinner', kcal: 700, protein_g: 40 }], at: iso(local(2026, 11, 17, 20)) })
    h.setNow(local(2026, 11, 18, 4))
    h.food.ingestBodySamples([mass('hk-fast-0345', local(2026, 11, 18, 3, 45), 80.4)], [])
    expect(book.bodyExcluded('hk-fast-0345')).toBeNull()
    // A meal on that same morning, before the reading, still counts.
    await h.food.logFromChat({ items: [{ name: 'early bite', kcal: 200, protein_g: 5 }], at: iso(local(2026, 11, 18, 3, 35)) })
    expect(book.bodyExcluded('hk-fast-0345')).toBe('after a meal')
  })

  test('after-a-meal follows the meal log: void or re-time the meal and the reading counts again', async () => {
    const h = harness(local(2026, 11, 17, 6, 30))
    const book = new MealBook(h.store.db)
    const meal = await h.food.logFromChat({ items: [{ name: 'breakfast', kcal: 400, protein_g: 20 }], at: iso(local(2026, 11, 17, 5)) })
    h.food.ingestBodySamples([mass('hk-undo-0001', local(2026, 11, 17, 6), 80.4)], [])
    expect(book.bodyExcluded('hk-undo-0001')).toBe('after a meal')
    h.food.void({ meal_id: meal.id, reason: 'wrong time' })
    expect(book.bodyExcluded('hk-undo-0001')).toBeNull()
    // Re-timed after the reading: still fasted.
    const m2 = await h.food.logFromChat({ items: [{ name: 'breakfast', kcal: 400, protein_g: 20 }], at: iso(local(2026, 11, 17, 5, 30)) })
    expect(book.bodyExcluded('hk-undo-0001')).toBe('after a meal')
    h.food.estimate({ meal_id: m2.id, items: [{ name: 'breakfast', kcal: 400, protein_g: 20 }], at: iso(local(2026, 11, 17, 7)), expected_revision: m2.revision })
    expect(book.bodyExcluded('hk-undo-0001')).toBeNull()
  })

  test('a hand exclusion worded like a derived one is never lifted by the next pass', async () => {
    const h = harness(local(2026, 11, 17, 6, 30))
    const book = new MealBook(h.store.db)
    h.food.ingestBodySamples([mass('hk-hand-0001', local(2026, 11, 17, 6), 80.4)], [])
    h.food.setWeighin({ uuid: 'hk-hand-0001', include: false, reason: 'after a meal' })
    h.food.reclassifyWeighins()
    expect(book.bodyExcluded('hk-hand-0001')).toBe('after a meal (by hand)')
  })

  test('replay verdict is re-decided when its reference reading is deleted', () => {
    const h = harness(local(2026, 11, 18, 6))
    const book = new MealBook(h.store.db)
    h.food.ingestBodySamples([mass('hk-rd-m17', local(2026, 11, 17, 5), 80.4), fat('hk-rd-f17', local(2026, 11, 17, 5), 0.2)], [])
    h.food.ingestBodySamples([mass('hk-rd-m18', local(2026, 11, 18, 5), 80.4), fat('hk-rd-f18', local(2026, 11, 18, 5), 0.2)], [])
    expect(book.bodyExcluded('hk-rd-m18')).toBe('possible replay')
    h.food.ingestBodySamples([], ['hk-rd-m17', 'hk-rd-f17'])
    expect(book.bodyExcluded('hk-rd-m18')).toBeNull()
    expect(book.bodyExcluded('hk-rd-f18')).toBeNull()
  })

  test('confounder_close: a future date is refused; a legacy future close keeps the window open', () => {
    const h = harness(local(2026, 11, 20, 12))
    h.food.seedConfounders(SYN_SEED)
    expect(() => h.food.closeConfounder({ kind: 'creatine_start', date: '2026-11-25' })).toThrow(/future/)
    expect(h.food.baseline().status).toBe('provisional')
    const row = { id: 1, kind: 'creatine_start', date: '2026-11-10', details: {}, window_end: '2026-12-08', closed_at: '2026-11-25', created_at: 'x' }
    expect(viewOf(row, '2026-11-20').status).toBe('active')
    expect(viewOf(row, '2026-11-25').status).toBe('closed')
    expect(viewOf(row, '2026-11-25').window.to).toBe('2026-11-25')
  })

  test('confounder_add: a known kind brings its window, label and bracket; personal fields stay the caller\'s', () => {
    const h = harness(local(2026, 11, 20, 12))
    const a = h.food.addConfounder({ kind: 'creatine_start', date: '2026-11-18', details: { summary: 'synthetic' } })
    expect(a.confounder.window).toEqual({ from: '2026-11-18', to: '2026-12-16' })
    expect(a.confounder.bracket).toEqual({ sign: 1, kg: [0, 1, 2], tau_days: 9 })
    expect(a.confounder.label).toBe('creatine saturation through ~Dec 16, weight trend inflated')
    expect(a.confounder.details.summary).toBe('synthetic')
    const b = h.food.addConfounder({ kind: 'intake_step_down', date: '2026-11-18', window_days: 10 })
    expect(b.confounder.window.to).toBe('2026-11-28')
  })

  test('calibration numerator = intake over ALL complete days (same days as the slope); subset gap is flagged', () => {
    const window = { from: '2026-11-01', to: '2026-11-20' }
    // Late nights (every 4th day) eat 3,300 and never get full coverage.
    const days = Array.from({ length: 20 }, (_, i) => ({ date: addDays('2026-11-01', i), kcal: i % 4 === 0 ? 3300 : 2300, complete: true }))
    const burns = new Map<string, DayBurn>(
      days.map((d, i) => [d.date, { date: d.date, burn_kcal: 3000, coverage: i % 4 === 0 ? 'partial' : 'full', reason: i % 4 === 0 ? 'sleep_after_0400' : null, cycle_ids: [] }]),
    )
    const r = calibrate({ days, burns, window, slope: { central: 0, lo: 0, hi: 0 }, kcalPerKg: 7700, provisional: false, nowIso: 'x' })
    const c = r.cal!
    expect(c.n).toBe(15)
    expect(c.intake_days).toBe(20)
    expect(c.mean_intake_kcal).toBe(2550) // (5 x 3300 + 15 x 2300) / 20
    expect(c.maintenance).toBe(2550)
    expect(c.factor).toBeCloseTo(2550 / 3000, 3)
    expect(c.mean_intake_full_days_kcal).toBe(2300)
    expect(c.intake_gap_kcal).toBe(-250)
    expect(c.flag).toContain('250 kcal less')
  })

  test('an implausible factor is rejected with the reason, never stored', async () => {
    const window = { from: '2026-11-01', to: '2026-11-20' }
    const days = Array.from({ length: 20 }, (_, i) => ({ date: addDays('2026-11-01', i), kcal: 2500, complete: true }))
    const burns = new Map<string, DayBurn>(days.map((d) => [d.date, { date: d.date, burn_kcal: 3000, coverage: 'full', reason: null, cycle_ids: [] }]))
    // A water-driven slope of -0.15 kg/day reads as +1,155 kcal maintenance: factor 1.22.
    const hi = calibrate({ days, burns, window, slope: { central: -0.15, lo: -0.16, hi: -0.14 }, kcalPerKg: 7700, provisional: false, nowIso: 'x' })
    expect(hi.cal).toBeNull()
    expect(hi.issue).toContain('implausible factor 1.22')
    const lo = calibrate({ days, burns, window, slope: { central: 0.12, lo: 0.11, hi: 0.13 }, kcalPerKg: 7700, provisional: false, nowIso: 'x' })
    expect(lo.cal).toBeNull()
    // Service level: a rising-weight baseline yields no factor and says why.
    const h = harness(local(2026, 11, 21, 12), dailyCycles([2026, 10, 30], 23, 3000))
    await seedHistory(h, [2026, 11, 21], 20, 2500, (i) => 80 + 0.15 * (20 - i))
    h.setNow(local(2026, 11, 21, 12))
    const b = h.food.baseline({ refreshCalibration: true })
    expect(b.energy.calibrated).toBe(false)
    expect(b.energy.calibration_issue).toContain('implausible factor')
    expect(h.meta.get('food_energy_calibration')).toBeUndefined()
  })

  test('the factor band also carries the mean burn\'s sampling error', () => {
    const window = { from: '2026-11-01', to: '2026-11-20' }
    const days = Array.from({ length: 20 }, (_, i) => ({ date: addDays('2026-11-01', i), kcal: 2500, complete: true }))
    const burns = new Map<string, DayBurn>(days.map((d, i) => [d.date, { date: d.date, burn_kcal: i % 2 ? 2600 : 3400, coverage: 'full', reason: null, cycle_ids: [] }]))
    const c = computeCalibration({ days, burns, window, slope: { central: 0, lo: 0, hi: 0 }, kcalPerKg: 7700, provisional: false, nowIso: 'x' })!
    expect(c.burn_se_kcal).toBeGreaterThan(0)
    expect(c.factor_lo).toBeLessThan(c.factor)
    expect(c.factor_hi).toBeGreaterThan(c.factor)
  })

  test('coverage is symmetric: a 27 h cycle spilling 5 h outside the day is partial, not full', () => {
    const now = local(2026, 11, 14, 12)
    const cycles = [
      cyc(1, local(2026, 11, 11, 2), local(2026, 11, 11, 23), 2700),
      cyc(2, local(2026, 11, 11, 23), local(2026, 11, 13, 2), 3100),
    ]
    const m = burnByDay(cycles, ['2026-11-12'], { nowMs: now, rolloverHour: R, today: '2026-11-14' })
    expect(m.get('2026-11-12')).toMatchObject({ burn_kcal: 3100, coverage: 'partial', reason: 'partial_day' })
  })

  test('no balance while a meal is pending, or on a past day not fully logged', () => {
    const cal = { factor: 0.8, factor_lo: 0.75, factor_hi: 0.85, n: 18, provisional: false } as never
    const burn: DayBurn = { date: '2026-11-12', burn_kcal: 3000, coverage: 'full', reason: null, cycle_ids: [1] }
    const pendingToday = dayEnergy({ date: '2026-11-13', today: '2026-11-13', intake: { kcal: 600, kcal_lo: 500, kcal_hi: 700, estimated: 1, pending: 1, complete: false }, burn: { ...burn, date: '2026-11-13' }, cal })
    expect(pendingToday).toMatchObject({ balance_kcal: null, balance_lo: null, balance_hi: null, calibrated: true })
    expect(pendingToday.note).toBe('1 meal not estimated yet, so no balance yet.')
    const incomplete = dayEnergy({ date: '2026-11-12', today: '2026-11-13', intake: { kcal: 1200, kcal_lo: 1000, kcal_hi: 1400, estimated: 2, pending: 0, complete: false }, burn, cal })
    expect(incomplete.balance_kcal).toBeNull()
    expect(incomplete.note).toBe('Day not marked fully logged, so no balance.')
  })

  test('service: pending meal today and an incomplete past day get no balance (day + baseline rows)', async () => {
    const h = harness(local(2026, 11, 21, 12), dailyCycles([2026, 10, 30], 23, 3000))
    await seedHistory(h, [2026, 11, 21], 20, 2500, () => 80)
    h.setNow(local(2026, 11, 21, 12))
    expect(h.food.baseline({ refreshCalibration: true }).energy.calibrated).toBe(true)
    h.food.setDayComplete({ date: '2026-11-19', complete: false })
    expect(h.food.day('2026-11-19').energy).toMatchObject({ calibrated: true, balance_kcal: null, note: 'Day not marked fully logged, so no balance.' })
    const row = h.food.baseline().energy.days.find((d) => d.date === '2026-11-19')!
    expect(row.balance_kcal).toBeNull()
    expect(h.food.day('2026-11-20').energy.balance_kcal).not.toBeNull()
  })

  test('a baseline read reuses the stored factor (weekly cadence); recalibrate forces it', async () => {
    const h = harness(local(2026, 11, 21, 12), dailyCycles([2026, 10, 30], 23, 3000))
    await seedHistory(h, [2026, 11, 21], 20, 2500, () => 80)
    h.setNow(local(2026, 11, 21, 12))
    const b = h.food.baseline({ refreshCalibration: true })
    await h.food.logFromChat({ items: [{ name: 'extra', kcal: 900, protein_g: 0 }], at: iso(local(2026, 11, 20, 21)) })
    h.setNow(local(2026, 11, 22, 12))
    const plain = h.food.baseline()
    expect(plain.energy.factor).toBe(b.energy.factor)
    expect(plain.energy.calibration!.computed_at).toBe(b.energy.calibration!.computed_at)
    expect(h.food.baseline({ refreshCalibration: true }).energy.factor).not.toBe(b.energy.factor)
  })

  test('a provisional factor is flagged on the day contract', () => {
    const cal = { factor: 0.86, factor_lo: 0.8, factor_hi: 0.92, n: 12, provisional: true } as never
    const e = dayEnergy({
      date: '2026-11-12',
      today: '2026-11-13',
      intake: { kcal: 2000, kcal_lo: 1800, kcal_hi: 2200, estimated: 3, pending: 0, complete: true },
      burn: { date: '2026-11-12', burn_kcal: 3000, coverage: 'full', reason: null, cycle_ids: [1] },
      cal,
    })
    expect(e.provisional).toBe(true)
    expect(e.note).toBe('Provisional factor (confounder window).')
  })
})
