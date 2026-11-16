// GET /body (the phone's Body tab): one payload built only from FoodService's
// existing reads. Pins the shape, that every part equals the method it comes
// from (latest = latestWeight's row, avg7/trend = avg7, metrics = dayBody,
// goal = baseline().goal), the 30-day newest-first history with excluded
// rows and their reasons, and the pair_key shared by the S400 and Xiaomi
// copies of one weigh-in. Every profile, weight and value here is synthetic.
import { describe, expect, test, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Store } from '../src/store.js'
import { FoodService } from '../src/food.js'
import { bodyPage } from '../src/bodyview.js'
import { DEFAULT_CONFIG } from '../src/types.js'
import { fatPercent, SCALE_SOURCE } from '../src/scale.js'
import { pctToFraction, type ScaleRaw } from '../src/scalecal.js'

const XIAOMI = 'Xiaomi Home'
const PROFILE = { height_cm: 172, birth_date: '1991-03-09', sex: 'male' as const } // made up
const local = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime()
const iso = (ms: number) => new Date(ms).toISOString()

function harness(nowMs = local(2026, 11, 16, 12)) {
  const dir = mkdtempSync(join(tmpdir(), 'health-bodyview-'))
  const store = new Store(':memory:')
  const meta = new Map<string, string>()
  let now = nowMs
  const food = new FoodService({
    db: store.db,
    photosDir: join(dir, 'meals'),
    getConfig: () => DEFAULT_CONFIG.food,
    getMeta: (k) => meta.get(k) ?? null,
    setMeta: (k, v) => void meta.set(k, v),
    emit: () => true,
    broadcast: () => {},
    getScaleProfile: () => PROFILE,
    now: () => now,
  })
  const s400 = (stem: string, at: number, kg: number, imp: number) => {
    const ts = iso(at)
    const fat = fatPercent(kg, PROFILE.height_cm, 35, 'male', imp)!
    const raw: ScaleRaw = { uuid: stem, measured_at: ts, kg, impedance_low: imp, impedance_high: imp - 40, hr: 61, scale_ts: Math.floor(at / 1000), fat_raw_pct: fat }
    return food.ingestBodySamples(
      [
        { uuid: `${stem}-m`, ts, kind: 'mass', value: kg, source: SCALE_SOURCE },
        { uuid: `${stem}-f`, ts, kind: 'fat', value: pctToFraction(fat), source: SCALE_SOURCE },
      ],
      [],
      raw,
    )
  }
  const xiaomi = (id: string, at: number, kg: number, fatPct: number | null) =>
    food.ingestBodySamples(
      [
        { uuid: `xiaomi-${id}-m`, ts: iso(at), kind: 'mass', value: kg, source: XIAOMI },
        ...(fatPct != null ? [{ uuid: `xiaomi-${id}-f`, ts: iso(at), kind: 'fat' as const, value: fatPct / 100, source: XIAOMI }] : []),
      ],
      [],
    )
  return {
    food,
    s400,
    xiaomi,
    setNow: (ms: number) => (now = ms),
    cleanup: () => {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})
function h0(nowMs?: number) {
  const h = harness(nowMs)
  cleanups.push(h.cleanup)
  return h
}

/** Two weeks of mornings: Xiaomi Nov 3-8 (the previous week), S400 Nov 10-16
 *  (this week), the Nov 16 weigh-in delivered by BOTH sources at the same
 *  instant, plus an evening reading and a second morning reading. */
function richWeek(h: ReturnType<typeof harness>) {
  const prevKg = [72.4, 72.2, 72.5, 72.1, 72.3, 72.0]
  prevKg.forEach((kg, i) => h.xiaomi(`p${i}`, local(2026, 11, 3 + i, 6, 10), kg, 22.0 + i / 10))
  const curKg = [71.9, 71.7, 71.8, 71.5, 71.6, 71.4]
  curKg.forEach((kg, i) => h.s400(`s400-c${i}`, local(2026, 11, 10 + i, 6, 5), kg, 480 + i))
  const t = local(2026, 11, 16, 6, 5)
  h.s400('s400-today', t, 71.3, 490)
  h.xiaomi('today', t, 71.3, 21.4) // the same weigh-in via Xiaomi Home
  h.xiaomi('evening', local(2026, 11, 15, 19, 30), 72.6, 21.9) // not a morning reading
  h.s400('s400-again', local(2026, 11, 16, 6, 40), 71.2, 492) // repeat
  return t
}

describe('GET /body', () => {
  test('empty: nothing weighed yet, every part null or empty', () => {
    const h = h0()
    const p = bodyPage(h.food)
    expect(Object.keys(p)).toEqual([
      'latest', 'avg7', 'trend', 'metrics', 'compartments', 'unassigned', 'goal', 'goal_ghost', 'confounders', 'baseline_status', 'history',
    ])
    expect(p).toEqual({
      latest: null, avg7: null, trend: null, metrics: null, compartments: [], unassigned: null, goal: null, goal_ghost: null,
      confounders: [], baseline_status: 'collecting', history: [],
    })
  })

  test('rich: each part equals the method it is built from', () => {
    const h = h0()
    const t = richWeek(h)
    h.food.setGoal({ target_bf_pct: 15, milestone_kg: 70, lean_mass_ref_kg: 58, lean_mass_ref_source: 'synthetic scan' })
    h.food.addConfounder({ kind: 'creatine_start', date: '2026-11-12', details: { summary: 'synthetic' } })
    const p = bodyPage(h.food)

    // latest: the counted S400 copy of this morning's weigh-in, as latestWeight sees it.
    const lw = h.food.latestWeight()!
    expect(p.latest).toEqual({ measured_at: iso(t), kg: 71.3, fat_pct: p.latest!.fat_pct, fat_basis: p.latest!.fat_basis, source: SCALE_SOURCE })
    expect(p.latest!.measured_at).toBe(lw.at)
    expect(p.latest!.kg).toBe(lw.kg)
    expect(p.latest!.fat_pct).toBe(lw.fat_pct)
    expect(p.latest!.fat_basis).toBe(lw.fat_basis ?? null)

    // avg7 + trend: avg7 at latest, and the previous week = avg7 seven days back.
    const a = h.food.avg7(iso(t))!
    expect(p.avg7).toEqual({ kg: a.kg, n: a.n, anchored_at: iso(t) })
    expect(p.avg7!.n).toBe(7) // Nov 10-16 S400 mornings, the Xiaomi copy + repeat not counted
    const prevMean = Math.round(((72.4 + 72.2 + 72.5 + 72.1 + 72.3 + 72.0) / 6) * 10) / 10
    // The delta is the two rounded means sent, so the phone's line adds up.
    expect(p.trend).toEqual({ delta_kg: Math.round((a.kg - prevMean) * 10) / 10, prev_avg_kg: prevMean })
    expect(p.trend!.delta_kg).toBeCloseTo(p.avg7!.kg - p.trend!.prev_avg_kg, 9)
    expect(p.trend!.delta_kg).toBeLessThan(0)

    // metrics: exactly day.body; goal: exactly the baseline's goal view.
    expect(p.metrics).toEqual(h.food.dayBody())
    expect(p.metrics).toEqual(h.food.day().body)
    expect(p.metrics!.measured_at).toBe(iso(local(2026, 11, 16, 6, 40))) // the latest S400 that is his
    expect(p.goal).toEqual(h.food.baseline().goal)
    expect(p.goal!.derived.weight_at_target_kg).toBe(68.2) // 58 / 0.85
    expect(p.goal!.derived.weight_at_target_on_creatine_kg).not.toBeNull()
    expect(p.goal!.derived.to_milestone_kg).toBe(1.3)

    // confounders + baseline status
    expect(p.baseline_status).toBe('provisional')
    expect(p.confounders).toHaveLength(1)
    expect(p.confounders[0]).toMatchObject({ kind: 'creatine_start', status: 'active', window_to: '2026-12-10' })
    expect(Object.keys(p.confounders[0])).toEqual(['kind', 'label', 'sentence', 'window_to', 'status'])
    expect(p.confounders[0].sentence).toContain('through ~Dec 10')

    // history: newest first, excluded rows with their reason, one pair key.
    const hist = p.history
    expect(hist.map((r) => r.measured_at)).toEqual([...hist.map((r) => r.measured_at)].sort().reverse())
    expect(hist).toHaveLength(6 + 6 + 2 + 1 + 1)
    for (const r of hist) expect(Object.keys(r)).toEqual(['measured_at', 'kg', 'fat_pct', 'fat_basis', 'source', 'excluded', 'pair_key'])
    const pair = hist.filter((r) => r.measured_at === iso(t))
    // A pair renders in one stable order: the counted S400 copy first.
    expect(pair.map((r) => r.source)).toEqual([SCALE_SOURCE, XIAOMI])
    expect(pair.map((r) => r.fat_basis)).toEqual([pair[0].fat_basis, 'device'])
    expect(pair.every((r) => r.pair_key === iso(t))).toBe(true)
    expect(pair.find((r) => r.source === SCALE_SOURCE)!.excluded).toBeNull()
    expect(pair.find((r) => r.source === XIAOMI)!.excluded).toBe('same weigh-in, other source')
    expect(hist.filter((r) => r.pair_key != null)).toHaveLength(2)
    expect(hist.find((r) => r.measured_at === iso(local(2026, 11, 15, 19, 30)))!.excluded).toBe('not a morning reading')
    expect(hist.find((r) => r.measured_at === iso(local(2026, 11, 16, 6, 40)))!.excluded).toMatch(/^repeat/)
    expect(hist[0].measured_at).toBe(iso(local(2026, 11, 16, 6, 40)))
  })

  test('compartments: the figure splits day.body\'s reading, the rest is unassigned, never stretched', () => {
    const h = h0()
    richWeek(h)
    h.food.setGoal({ target_bf_pct: 15, milestone_kg: 70, lean_mass_ref_kg: 58, lean_mass_ref_source: 'synthetic scan' })
    const p = bodyPage(h.food)
    const m = p.metrics!
    const view = (k: string) => m.metrics.find((x) => x.key === k)!
    expect(p.compartments.map((c) => c.key)).toEqual(['mineral', 'protein', 'water', 'fat'])
    for (const c of p.compartments) expect(Object.keys(c)).toEqual(['key', 'label', 'kg', 'pct', 'basis', 'note', 'series'])
    const by = (k: string) => p.compartments.find((c) => c.key === k)!
    // Each one is its metric as shown on the card: % x kg (bone as kg).
    const r1 = (n: number) => Math.round(n * 10) / 10
    expect(by('water').kg).toBe(r1((view('water_pct').value / 100) * m.kg))
    expect(by('fat').kg).toBe(r1((view('fat_pct').value / 100) * m.kg))
    expect(by('protein').kg).toBe(r1((view('protein_pct').value / 100) * m.kg))
    expect(by('mineral').kg).toBe(view('bone_kg').value)
    expect(by('water').pct).toBe(view('water_pct').value)
    expect(by('fat').basis).toBe(view('fat_pct').basis)
    expect(by('protein').note).toBe(view('protein_pct').note)
    // Unassigned = weight minus the four (unrounded), or the overshoot.
    const sum = (view('water_pct').value + view('fat_pct').value + view('protein_pct').value) / 100 * m.kg + view('bone_kg').value
    const rest = m.kg - sum
    expect(p.unassigned).toEqual({
      kg: Math.round(Math.max(0, rest) * 100) / 100,
      pct: r1((Math.max(0, rest) / m.kg) * 100),
      over_kg: Math.round(Math.max(0, -rest) * 100) / 100,
    })
    expect(p.unassigned!.kg === 0 || p.unassigned!.over_kg === 0).toBe(true)
    // Series: his counted S400 mornings of the 7 days up to the figure's
    // reading, plus that reading (the 06:40 repeat), oldest first.
    const fat = by('fat').series
    expect(fat.at(-1)).toEqual({ measured_at: m.measured_at, kg: by('fat').kg })
    expect(fat.map((x) => x.measured_at)).toEqual([...fat.map((x) => x.measured_at)].sort())
    expect(fat).toHaveLength(7 + 1) // the 7 counted S400 mornings Nov 10-16, plus the 06:40 repeat
    expect(fat.at(-2)!.measured_at).toBe(iso(local(2026, 11, 16, 6, 5)))
    for (const c of p.compartments) expect(c.series).toHaveLength(fat.length)
    // Goal ghost: the target fat % at TODAY's lean mass (the figure's own
    // reading's lean_kg as shown), not the scan's; the scan-based weight
    // stays in goal.derived as the reference.
    const lean = view('lean_kg')
    expect(lean.value).toBe(r1(m.kg * (1 - view('fat_pct').value / 100)))
    expect(p.goal_ghost).toEqual({ kg: r1(lean.value / 0.85), lean_kg: lean.value, lean_basis: 'scale', lean_source: `S400, ${lean.basis}` })
    expect(p.goal_ghost!.lean_kg).not.toBe(58)
    expect(p.goal!.derived.weight_at_target_kg).toBe(68.2) // 58 / 0.85, the scan reference, unchanged
  })

  test('a missing metric leaves its mass unassigned; four over the weight report over_kg', () => {
    const h = h0()
    richWeek(h)
    const real = h.food.dayBody()!
    const food = Object.create(h.food) as FoodService
    // Protein dropped (a clamped sentinel): no band, its mass unassigned.
    food.dayBody = () => ({ ...real, metrics: real.metrics.filter((x) => x.key !== 'protein_pct') })
    const p = bodyPage(food)
    expect(p.compartments.map((c) => c.key)).toEqual(['mineral', 'water', 'fat'])
    expect(p.unassigned!.pct).toBeGreaterThan(10)
    // Calibrated fat above the formula fat the water was built on: over.
    food.dayBody = () => ({
      ...real,
      metrics: real.metrics.map((x) => (x.key === 'fat_pct' ? { ...x, value: x.value + 2, basis: 'calibrated' as const } : x)),
    })
    const q = bodyPage(food)
    expect(q.unassigned!.kg).toBe(0)
    expect(q.unassigned!.over_kg).toBeGreaterThan(1)
    // No goal record: no ghost.
    expect(q.goal_ghost).toBeNull()
    // A goal, but the figure's reading has no lean_kg: no ghost either (never
    // the scan number standing in for today's lean).
    h.food.setGoal({ target_bf_pct: 15, milestone_kg: 70, lean_mass_ref_kg: 58, lean_mass_ref_source: 'synthetic scan' })
    expect(bodyPage(h.food).goal_ghost).not.toBeNull()
    food.dayBody = () => ({ ...real, metrics: real.metrics.filter((x) => x.key !== 'lean_kg') })
    const r = bodyPage(food)
    expect(r.goal).not.toBeNull()
    expect(r.goal_ghost).toBeNull()
  })

  test('a not-his row keeps its date and reason, never its kg or fat', () => {
    const h = h0()
    richWeek(h)
    h.xiaomi('guest', local(2026, 11, 9, 6, 10), 58.0, 17.0) // synthetic guest, far off his weight
    const p = bodyPage(h.food)
    const g = p.history.find((r) => r.measured_at === iso(local(2026, 11, 9, 6, 10)))!
    expect(g.excluded).toBe('not his (weight outlier)')
    expect(g).toMatchObject({ kg: null, fat_pct: null, fat_basis: null, source: XIAOMI })
    expect(JSON.stringify(p.history)).not.toContain('58')
  })

  test('a pair renders counted copy first whichever source landed first', () => {
    const h = h0()
    const t = local(2026, 11, 16, 6, 5)
    h.xiaomi('first', t, 71.3, 21.4) // the Xiaomi copy is stored BEFORE the S400 one
    h.s400('s400-second', t, 71.3, 490)
    const pair = bodyPage(h.food).history.filter((r) => r.measured_at === iso(t))
    expect(pair).toHaveLength(2)
    expect(pair[0].excluded).toBeNull()
    expect(pair[1].excluded).not.toBeNull()
    expect(pair[0].pair_key).toBe(pair[1].pair_key)
  })

  test('avg7 is anchored on the latest counted reading, stale or not', () => {
    const h = h0(local(2026, 11, 28, 12))
    for (let d = 0; d < 4; d++) h.xiaomi(`c${d}`, local(2026, 11, 10 + d, 6), 71.8 - d / 10, 21.8)
    const p = bodyPage(h.food)
    expect(p.avg7).toEqual({ kg: 71.7, n: 4, anchored_at: iso(local(2026, 11, 13, 6)) })
    expect(p.avg7!.anchored_at).toBe(p.latest!.measured_at)
  })

  test('trend only when BOTH weeks have >= 3 counted readings', () => {
    const h = h0()
    h.xiaomi('p0', local(2026, 11, 5, 6), 72.0, 22.0)
    h.xiaomi('p1', local(2026, 11, 6, 6), 72.2, 22.1)
    for (let d = 0; d < 4; d++) h.xiaomi(`c${d}`, local(2026, 11, 13 + d, 6), 71.8 - d / 10, 21.8)
    const p = bodyPage(h.food)
    expect(p.avg7).toMatchObject({ kg: 71.7, n: 4 })
    expect(p.trend).toBeNull()
    // and no avg7 at all under 3 counted readings this week
    const h2 = h0()
    h2.xiaomi('a', local(2026, 11, 15, 6), 71.0, 21.0)
    h2.xiaomi('b', local(2026, 11, 16, 6), 70.9, 21.0)
    const p2 = bodyPage(h2.food)
    expect(p2.latest).toMatchObject({ kg: 70.9, source: XIAOMI, fat_pct: 21 })
    expect(p2.avg7).toBeNull()
    expect(p2.trend).toBeNull()
  })

  test('history spans 30 days; a closed confounder older than that drops out', () => {
    const h = h0(local(2026, 12, 20, 12))
    h.xiaomi('old', local(2026, 11, 10, 6), 72.0, 22.0) // 40 days back
    h.xiaomi('new', local(2026, 12, 19, 6), 71.0, 21.5)
    h.food.addConfounder({ kind: 'travel', date: '2026-11-01', window_days: 7 })
    h.food.addConfounder({ kind: 'creatine_start', date: '2026-12-01' })
    const p = bodyPage(h.food)
    expect(p.history.map((r) => r.measured_at)).toEqual([iso(local(2026, 12, 19, 6))])
    expect(p.confounders.map((c) => c.kind)).toEqual(['creatine_start'])
  })

  test('served by the food handler: GET /body, JSON', async () => {
    const h = h0()
    richWeek(h)
    const res = (await h.food.handleHttp(new Request('http://x/body'), new URL('http://x/body')))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as ReturnType<typeof bodyPage>
    expect(body).toEqual(JSON.parse(JSON.stringify(bodyPage(h.food))))
    expect(await h.food.handleHttp(new Request('http://x/body', { method: 'POST' }), new URL('http://x/body'))).toBeNull()
  })
})

describe('GET /body: friend rule', () => {
  test('a housemate on the S400 never pairs, never calibrates, and is masked in history', () => {
    const h = h0()
    const t = richWeek(h)
    const before = h.food.scaleCalibration().pairs.length
    const pal = local(2026, 11, 16, 7, 30)
    h.s400('s400-pal', pal, 58.0, 520) // synthetic housemate
    h.xiaomi('pal', pal, 58.0, 17.0) // the same weigh-in via Xiaomi Home
    const cal = h.food.scaleCalibration()
    expect(cal.pairs.map((p) => p.measured_at)).not.toContain(iso(pal))
    expect(cal.pairs).toHaveLength(before)
    // Even a forced manual pair on it never feeds a fit.
    h.food.weighinPair({ measured_at: iso(pal), metric: 'fat_pct', value: 17.0, force: true })
    expect(h.food.scaleCalibration().pairs.map((p) => p.measured_at)).not.toContain(iso(pal))
    const p = bodyPage(h.food)
    const rows = p.history.filter((r) => r.measured_at === iso(pal))
    expect(rows).toHaveLength(2)
    for (const r of rows) expect(r).toMatchObject({ kg: null, fat_pct: null, fat_basis: null, excluded: 'not his (weight outlier)' })
    expect(p.metrics!.measured_at).not.toBe(iso(pal))
    expect(p.latest!.measured_at).toBe(iso(t))
    // A manual include reclaims the weigh-in: the S400 copy counts, the
    // Xiaomi copy is no longer filed as not his (the older rules still keep
    // it from counting twice), and the two pair again.
    h.food.setWeighin({ uuid: 's400-pal-m', include: true })
    const back = bodyPage(h.food).history.filter((r) => r.measured_at === iso(pal))
    expect(back.find((r) => r.source === SCALE_SOURCE)!.excluded).toBeNull()
    expect(back.find((r) => r.source === XIAOMI)!.excluded).not.toBeNull()
    expect(back.find((r) => r.source === XIAOMI)!.excluded).not.toBe('not his (weight outlier)')
    expect(h.food.scaleCalibration().pairs.map((p) => p.measured_at)).toContain(iso(pal))
    // The other copy is that weigh-in delivered twice, never "maybe someone
    // else": no masked row left in the pair, and its values show.
    expect(back.find((r) => r.source === XIAOMI)!.excluded).toBe('same weigh-in, other source')
    for (const r of back) expect(r.kg).toBe(58.0)
  })

  test('reclaiming the Xiaomi copy leaves the S400 copy his body (composition shown)', () => {
    const h = h0()
    richWeek(h)
    const pal = local(2026, 11, 16, 7, 30)
    h.s400('s400-pal', pal, 58.0, 520)
    h.xiaomi('pal', pal, 58.0, 17.0)
    h.food.setWeighin({ uuid: 'xiaomi-pal-m', include: true })
    const rows = bodyPage(h.food).history.filter((r) => r.measured_at === iso(pal))
    expect(rows.find((r) => r.source === XIAOMI)!.excluded).toBeNull()
    expect(rows.find((r) => r.source === SCALE_SOURCE)!.excluded).toBe('same weigh-in, other source')
    expect(rows.every((r) => r.kg != null)).toBe(true)
    expect(h.food.dayBody()!.measured_at).toBe(iso(pal))
  })

  test('a "possible other person" reading never pairs either', () => {
    const h = h0()
    richWeek(h)
    // 3 kg over his latest: past the outlier limit (2.5 kg), inside the
    // friend rule's 4 kg, delivered by both sources.
    const odd = local(2026, 11, 16, 8, 0)
    h.s400('s400-odd', odd, 74.4, 470)
    h.xiaomi('odd', odd, 74.4, 23.0)
    const rows = bodyPage(h.food).history.filter((r) => r.measured_at === iso(odd))
    expect(rows.some((r) => r.excluded === 'possible other person')).toBe(true)
    expect(h.food.scaleCalibration().pairs.map((p) => p.measured_at)).not.toContain(iso(odd))
  })
})
