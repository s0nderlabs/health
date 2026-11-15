import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Store } from '../src/store.js'
import { FoodService, kcalText } from '../src/food.js'
import {
  addDays,
  computeBaseline,
  foodDay,
  normalizeItems,
  olsSlope,
  totalsOf,
  BASELINE_DEFAULTS,
  type BaselineDay,
} from '../src/meals.js'
import { DEFAULT_CONFIG } from '../src/types.js'
import { hasPersonalMetadata } from '../src/photos.js'
import { makeJpeg } from './fixtures/images.js'

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'health-food-'))
})
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Local wall-clock ms for a fixed date (the daemon runs in local time). */
function local(y: number, mo: number, d: number, h: number, mi = 0): number {
  return new Date(y, mo - 1, d, h, mi).getTime()
}

function harness(nowMs = local(2026, 11, 16, 12)) {
  const store = new Store(':memory:')
  const events: Array<{ cls: string; key: string; content: string; meta: Record<string, string> }> = []
  const pushes: Array<Record<string, unknown>> = []
  const meta = new Map<string, string>()
  let now = nowMs
  const food = new FoodService({
    db: store.db,
    photosDir: join(dir, `meals-${Math.random().toString(36).slice(2)}`),
    getConfig: () => DEFAULT_CONFIG.food,
    getMeta: (k) => meta.get(k) ?? null,
    setMeta: (k, v) => void meta.set(k, v),
    emit: (cls, key, p) => {
      events.push({ cls, key, ...p })
      return true
    },
    broadcast: (m) => void pushes.push(m),
    now: () => now,
  })
  return { store, food, events, pushes, setNow: (ms: number) => (now = ms) }
}

const soto = [
  { name: 'Soto betawi with sengkel + egg', grams: 450, kcal: 620, kcal_lo: 520, kcal_hi: 720, protein_g: 42 },
  { name: 'Rice, 1 centong', grams: 150, kcal: 195, kcal_lo: 170, kcal_hi: 220, protein_g: 4 },
]

describe('pure helpers', () => {
  test('food day rolls over at 04:00 local', () => {
    expect(foodDay(local(2026, 11, 16, 0, 30), 4)).toBe('2026-11-15')
    expect(foodDay(local(2026, 11, 16, 3, 59), 4)).toBe('2026-11-15')
    expect(foodDay(local(2026, 11, 16, 4, 0), 4)).toBe('2026-11-16')
    expect(foodDay(local(2026, 11, 16, 23, 30), 4)).toBe('2026-11-16')
    expect(foodDay(local(2026, 11, 16, 0, 30), 0)).toBe('2026-11-16')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
  })

  test('items: ranges default to the point, lo/hi are clamped around kcal', () => {
    const items = normalizeItems(
      [{ name: 'americano', kcal: 10, protein_g: 0 }, { name: 'x', kcal: 100, kcal_lo: 150, kcal_hi: 50, protein_g: 1 }],
      () => null,
    )
    expect(items[0]).toMatchObject({ kcal: 10, kcal_lo: 10, kcal_hi: 10 })
    expect(items[1]).toMatchObject({ kcal_lo: 100, kcal_hi: 100 })
    expect(() => normalizeItems([], () => null)).toThrow()
    expect(() => normalizeItems([{ name: 'x', kcal: -5, protein_g: 0 }], () => null)).toThrow()
    expect(() => normalizeItems([{ kcal: 5 }], () => null)).toThrow(/name/)
  })

  test('totals: carbs/fat only when every item has them', () => {
    const t = totalsOf(normalizeItems([...soto, { name: 'kecap', kcal: 20, protein_g: 0, carbs_g: 5 }], () => null))
    expect(t).toMatchObject({ kcal: 835, kcal_lo: 710, kcal_hi: 960, protein_g: 46, carbs_g: null })
    expect(kcalText(835, 710, 960)).toBe('835 kcal (710-960)')
    expect(kcalText(10, 10, 10)).toBe('10 kcal')
  })

  test('OLS slope recovers a clean trend', () => {
    const fit = olsSlope([0, 1, 2, 3, 4], [84, 83.9, 83.8, 83.7, 83.6])!
    expect(fit.slope).toBeCloseTo(-0.1, 6)
    expect(fit.se).toBeCloseTo(0, 6)
  })
})

describe('baseline', () => {
  const today = '2026-12-15'
  const opts = { ...BASELINE_DEFAULTS, today, deficitKcal: 400 }
  const days = (n: number, kcal: number): BaselineDay[] =>
    Array.from({ length: n }, (_, i) => ({
      date: addDays(today, -1 - i),
      kcal,
      kcal_lo: kcal - 200,
      kcal_hi: kcal + 200,
      complete: true,
    }))

  test('gated: no target before 14 complete days and 8 weigh-ins over 14+ days', () => {
    const b = computeBaseline(days(10, 2500), [{ date: addDays(today, -2), kg: 84 }], [], opts)
    expect(b.ready).toBe(false)
    expect(b.suggested_target).toBeNull()
    expect(b.needs.join(' ')).toContain('4 more complete')
    expect(b.needs.join(' ')).toContain('7 more weigh-in')
  })

  test('flat weight: maintenance = intake; losing 0.5 kg/wk adds ~550 kcal/day', () => {
    const weights = (perDay: number) =>
      Array.from({ length: 20 }, (_, i) => ({ date: addDays(today, -1 - i), kg: 84 - perDay * (19 - i) }))
    const flat = computeBaseline(days(20, 2500), weights(0), [], opts)
    expect(flat.ready).toBe(true)
    expect(flat.maintenance).toBe(2500)
    expect(flat.suggested_target).toBe(2100)
    const losing = computeBaseline(days(20, 2500), weights(0.5 / 7), [], opts)
    expect(losing.weight_trend_kg_per_week).toBeCloseTo(-0.5, 2)
    expect(losing.maintenance).toBe(3050)
  })

  test('a 2 kg one-morning water swing barely moves the fit', () => {
    const w = Array.from({ length: 20 }, (_, i) => ({ date: addDays(today, -1 - i), kg: 84 }))
    w[10].kg = 86
    const b = computeBaseline(days(20, 2500), w, [], opts)
    expect(Math.abs(b.maintenance! - 2500)).toBeLessThan(150)
  })

  test('incomplete days and today are excluded from intake', () => {
    const d = days(16, 2500)
    d[0].complete = false
    d[0].kcal = 900 // a half-logged day must not drag the mean down
    d.push({ date: today, kcal: 300, kcal_lo: 300, kcal_hi: 300, complete: true })
    const b = computeBaseline(d, [], [], opts)
    expect(b.complete_days).toBe(15)
    expect(b.mean_intake).toBe(2500)
  })
})

describe('food service: phone front door', () => {
  test('app log is idempotent on client_id and raises one meal.logged', async () => {
    const { food, events, pushes } = harness()
    const a = await food.logFromApp({ client_id: 'c1-aaaa-bbbb', note: 'americano' })
    const b = await food.logFromApp({ client_id: 'c1-aaaa-bbbb', note: 'americano' })
    expect(b).toEqual({ ...a, duplicate: true })
    expect(events.filter((e) => e.cls === 'meal.logged')).toHaveLength(1)
    expect(events[0].meta).toMatchObject({ meal_id: String(a.meal_id), kind: 'text', date: '2026-11-16' })
    expect(events[0].content).toContain('expected_revision=0')
    expect(pushes).toContainEqual({ type: 'meals_updated', date: '2026-11-16' })
  })

  test('concurrent retries of one upload share the first ingest', async () => {
    const { food, events } = harness()
    const jpeg = await makeJpeg(dir, 200, 100)
    const body = { client_id: 'race-1234-5678', photos: [Buffer.from(jpeg).toString('base64')] }
    const [a, b] = await Promise.all([food.logFromApp(body), food.logFromApp(body)])
    expect(a.meal_id).toBe(b.meal_id)
    expect(events).toHaveLength(1)
  })

  test('photo upload is normalised, stripped, and served back', async () => {
    const { food, events } = harness()
    const jpeg = await makeJpeg(dir, 400, 200, 6)
    const r = await food.logFromApp({ client_id: 'photo-0001-x', photo: Buffer.from(jpeg).toString('base64'), note: 'dirty latte' })
    const meal = food.book.getMeal(r.meal_id)!
    expect(meal.photos).toHaveLength(1)
    expect(meal.photos[0].path).toEndWith(`/2026-11-16/${r.meal_id}-0.jpg`)
    expect(hasPersonalMetadata(new Uint8Array(readFileSync(meal.photos[0].path)))).toBe(false)
    expect(events[0].meta.photo).toBe(meal.photos[0].path)
    expect(events[0].meta.kind).toBe('photo')
    const res = await food.handleHttp(
      new Request(`http://x/meal-photo?meal=${r.meal_id}&n=0&thumb=1`),
      new URL(`http://x/meal-photo?meal=${r.meal_id}&n=0&thumb=1`),
    )
    expect(res!.status).toBe(200)
    expect(res!.headers.get('content-type')).toBe('image/jpeg')
  })

  test('a failed photo leaves no meal behind (phone outbox retries)', async () => {
    const { food, events, store } = harness()
    await expect(
      food.logFromApp({ client_id: 'bad-photo-001', photo: Buffer.from('x'.repeat(300)).toString('base64') }),
    ).rejects.toThrow()
    expect(events).toHaveLength(0)
    expect((store.db.query('SELECT COUNT(*) AS n FROM meals').get() as { n: number }).n).toBe(0)
  })

  test('a 00:30 meal lands on the previous food day', async () => {
    const { food } = harness(local(2026, 11, 16, 0, 40))
    const r = await food.logFromApp({ client_id: 'late-dinner-1', note: 'soto', captured_at: new Date(local(2026, 11, 16, 0, 30)).toISOString() })
    expect(r.date).toBe('2026-11-15')
  })

  test('HTTP: bad bodies are 400, unknown paths fall through', async () => {
    const { food } = harness()
    const post = (path: string, body: unknown) =>
      food.handleHttp(
        new Request(`http://x${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
        new URL(`http://x${path}`),
      )
    expect((await post('/meal', { note: 'no client id' }))!.status).toBe(400)
    expect((await post('/meal', { client_id: 'empty-meal-1' }))!.status).toBe(400)
    expect((await post('/meal/fix', { meal_id: 999, text: 'x' }))!.status).toBe(400)
    expect(await food.handleHttp(new Request('http://x/other'), new URL('http://x/other'))).toBeNull()
    const ok = await post('/meal', { client_id: 'http-ok-0001', note: 'teh manis' })
    expect(ok!.status).toBe(200)
    const day = await food.handleHttp(new Request('http://x/meals'), new URL('http://x/meals'))
    const body = (await day!.json()) as { meals: unknown[]; targets: { protein_g: number; kcal: number | null } }
    expect(body.meals).toHaveLength(1)
    expect(body.targets).toEqual({ protein_g: 165, kcal: null, kcal_set_at: null } as never)
  })

  test('phone fix line raises meal.amended once per distinct text', async () => {
    const { food, events } = harness()
    const r = await food.logFromApp({ client_id: 'fix-me-00001', note: 'gulai' })
    food.estimate({ meal_id: r.meal_id, expected_revision: 0, items: soto })
    food.fixFromApp({ meal_id: r.meal_id, text: "it's soto betawi, not gulai" })
    food.fixFromApp({ meal_id: r.meal_id, text: "it's soto betawi, not gulai" })
    const amended = events.filter((e) => e.cls === 'meal.amended')
    expect(amended).toHaveLength(1)
    expect(amended[0].content).toContain('rev 1')
    expect(amended[0].content).toContain('expected_revision=1')
    expect(food.book.getMeal(r.meal_id)!.fix_text).toBe("it's soto betawi, not gulai")
  })
})

describe('food service: estimate, corrections, voids', () => {
  test('estimate is a full replace with history and revision guard', async () => {
    const { food, store } = harness()
    const r = await food.logFromApp({ client_id: 'est-000001', note: 'dinner' })
    const m1 = food.estimate({ meal_id: r.meal_id, expected_revision: 0, items: soto, label: 'Soto dinner', confidence: 'medium' })
    expect(m1).toMatchObject({ status: 'estimated', revision: 1, kcal: 815, kcal_lo: 690, kcal_hi: 940, protein_g: 46 })
    // Stale writer loses.
    expect(() => food.estimate({ meal_id: r.meal_id, expected_revision: 0, items: soto })).toThrow(/revision conflict/)
    const m2 = food.estimate({ meal_id: r.meal_id, expected_revision: 1, items: [soto[0]], reason: 'no rice' })
    expect(m2.items).toHaveLength(1)
    expect(m2.kcal).toBe(620)
    const revs = store.db.query('SELECT revision, reason FROM meal_revisions WHERE meal_id = ? ORDER BY revision').all(r.meal_id)
    expect(revs).toEqual([
      { revision: 1, reason: null },
      { revision: 2, reason: 'no rice' },
    ])
  })

  test('estimate can move a meal to the day it was eaten', async () => {
    const { food, pushes } = harness(local(2026, 11, 16, 9))
    const r = await food.logFromApp({ client_id: 'move-00001', note: 'last night' })
    const m = food.estimate({ meal_id: r.meal_id, items: soto, at: '23:30' })
    expect(m.date).toBe('2026-11-15')
    expect(pushes).toContainEqual({ type: 'meals_updated', date: '2026-11-15' })
  })

  test('void removes from totals; void meals refuse estimates', async () => {
    const { food } = harness()
    const r = await food.logFromApp({ client_id: 'void-00001', note: 'dup' })
    food.estimate({ meal_id: r.meal_id, items: soto })
    food.void({ meal_id: r.meal_id, reason: 'duplicate' })
    expect(food.day().totals.kcal).toBe(0)
    expect(food.day().meals).toHaveLength(0)
    expect(() => food.estimate({ meal_id: r.meal_id, items: soto })).toThrow(/void/)
  })
})

describe('food service: chat front door', () => {
  test('chat log with items counts exactly like an app capture', async () => {
    const { food, events, pushes } = harness()
    const m = await food.logFromChat({ items: [{ name: 'Americano', kcal: 10, protein_g: 0 }], note: 'americano' })
    expect(m).toMatchObject({ source: 'chat', status: 'estimated', revision: 1, kcal: 10 })
    expect(events).toHaveLength(0) // the session that logged it already knows
    expect(pushes).toContainEqual({ type: 'meals_updated', date: '2026-11-16' })
    expect(food.day().totals.kcal).toBe(10)
  })

  test('chat photos (paths) are copied + stripped; the original is untouched', async () => {
    const { food } = harness()
    const src = join(dir, 'IMG_0001.jpg')
    const jpeg = await makeJpeg(dir, 300, 150, 6)
    writeFileSync(src, jpeg)
    const before = readFileSync(src)
    const m = await food.logFromChat({ photos: [src, src], items: soto, at: '12:00' })
    expect(m.photos).toHaveLength(2)
    expect(m.photos[1].path).toEndWith(`${m.id}-1.jpg`)
    for (const p of m.photos) expect(hasPersonalMetadata(new Uint8Array(readFileSync(p.path)))).toBe(false)
    expect(readFileSync(src).equals(before)).toBe(true)
    expect(existsSync(src)).toBe(true)
    const phone = food.day(undefined, { forPhone: true }).meals[0]
    expect(phone.photos[0]).toEqual({ n: 0, url: `/meal-photo?meal=${m.id}&n=0`, thumb_url: `/meal-photo?meal=${m.id}&n=0&thumb=1` })
  })

  test('chat log validates paths and times', async () => {
    const { food } = harness()
    await expect(food.logFromChat({ photos: ['relative.heic'] })).rejects.toThrow(/absolute/)
    await expect(food.logFromChat({ photos: ['/nope/IMG_1.HEIC'] })).rejects.toThrow(/not found/)
    await expect(food.logFromChat({})).rejects.toThrow()
    await expect(food.logFromChat({ note: 'x', at: '2020-01-01T00:00:00Z' })).rejects.toThrow(/14 days/)
  })

  test('HH:MM ahead of now means last night', () => {
    const { food } = harness(local(2026, 11, 16, 1, 0))
    expect(food.parseAt('23:30')!.date).toBe('2026-11-15')
    expect(food.parseAt('00:45')!.date).toBe('2026-11-15') // before 04:00 rollover
  })
})

describe('presets', () => {
  test('save, expand with servings, count uses, match on note', async () => {
    const { food, events } = harness()
    food.presetSave({ name: "Soto betawi (mom's)", slug: 'soto-betawi-mom', aliases: ['soto betawi', 'soto mama'], items: soto })
    const m = await food.logFromChat({ items: [{ preset: 'soto-betawi-mom', servings: 1.5 }] })
    expect(m.items[0]).toMatchObject({ name: "Soto betawi (mom's)", kcal: 1222.5, protein_g: 69, preset_slug: 'soto-betawi-mom', servings: 1.5 })
    expect(food.book.getPreset('soto-betawi-mom')!.uses).toBe(1)
    await food.logFromApp({ client_id: 'preset-hint-1', note: 'soto mama again' })
    expect(events.at(-1)!.content).toContain('soto-betawi-mom')
    expect(() => food.presetSave({ name: 'nested', items: [{ preset: 'soto-betawi-mom' }] })).toThrow(/plain items/)
    await expect(food.logFromChat({ items: [{ preset: 'nope' }] })).rejects.toThrow(/unknown preset/)
  })
})

describe('weigh-ins + targets', () => {
  test('body samples validate, dedupe, delete; latest weight reads back', () => {
    const { food } = harness()
    const ts = new Date(local(2026, 11, 16, 7)).toISOString()
    const r = food.ingestBodySamples(
      [
        { uuid: 'hk-mass-0001', ts, kind: 'mass', value: 83.4, source: 'Mi Home' },
        { uuid: 'hk-fat-00001', ts, kind: 'fat', value: 0.236 },
        { uuid: 'hk-bad-00001', ts, kind: 'mass', value: 5 },
      ],
      [],
    )
    expect(r).toEqual({ received: 2, added: 2, deleted: 0 })
    expect(food.ingestBodySamples([{ uuid: 'hk-mass-0001', ts, kind: 'mass', value: 83.4 }], [])!.added).toBe(0)
    expect(food.latestWeight()).toEqual({ kg: 83.4, at: ts, fat_pct: 23.6 })
    expect(food.ingestBodySamples([], ['hk-fat-00001'])!.deleted).toBe(1)
    expect(food.ingestBodySamples('nope', [])).toBeNull()
  })

  test('accepting a target is refused until the baseline is ready; explicit target allowed', async () => {
    const { food } = harness()
    expect(() => food.acceptTarget({})).toThrow(/not ready/)
    const r = food.acceptTarget({ target_kcal: 2200 })
    expect(r.target_kcal).toBe(2200)
    expect(food.day().targets.kcal).toBe(2200)
  })

  test('end to end: 20 logged days + weigh-ins -> ready baseline', async () => {
    const start = local(2026, 11, 1, 12)
    const { food, setNow } = harness(start)
    for (let i = 0; i < 20; i++) {
      setNow(start + i * 86_400_000)
      await food.logFromChat({ items: [{ name: 'day', kcal: 2600, kcal_lo: 2400, kcal_hi: 2800, protein_g: 150 }] })
      food.ingestBodySamples(
        [{ uuid: `hk-day-${String(i).padStart(4, '0')}`, ts: new Date(start + i * 86_400_000 - 5 * 3_600_000).toISOString(), kind: 'mass', value: 84 - i * 0.05 }],
        [],
      )
    }
    setNow(start + 20 * 86_400_000)
    const b = food.baseline()
    expect(b.ready).toBe(true)
    expect(b.complete_days).toBe(20)
    expect(b.weight_trend_kg_per_week).toBeCloseTo(-0.35, 2)
    expect(b.maintenance).toBe(2985) // 2600 + 0.05 * 7700
    expect(food.acceptTarget({ accept: true }).target_kcal).toBe(2585)
  })
})

describe('review regressions', () => {
  test('meal events never consume the daily event budget', () => {
    const store = new Store(':memory:')
    for (let i = 0; i < 8; i++) {
      store.insertEvent({ class: 'meal.logged', priority: 'notable', dedupe_key: `meal.logged:${i}`, content: 'x', meta: {}, created_at: new Date().toISOString() })
    }
    expect(store.createdToday()).toBe(0)
    store.insertEvent({ class: 'workout.card', priority: 'info', dedupe_key: 'w1', content: 'x', meta: {}, created_at: new Date().toISOString() })
    expect(store.createdToday()).toBe(1)
  })

  test('a past-day read is summarised as that day, not today', async () => {
    const { food } = harness(local(2026, 11, 16, 12))
    await food.logFromChat({ items: soto, at: new Date(local(2026, 11, 15, 19)).toISOString() })
    const past = food.day('2026-11-15')
    const line = food.summaryOf(null, past)
    expect(line.startsWith('2026-11-15: 815 kcal')).toBe(true)
    expect(food.summaryOf(null, food.day()).startsWith('Today: 0 kcal')).toBe(true)
  })
})

describe('quiet hours policy', () => {
  test('meal.* and live.* pierce, routine classes hold', async () => {
    const { piercesQuietHours } = await import('../src/types.js')
    const e = (cls: string, priority = 'notable', key = 'k') => ({ class: cls, priority, dedupe_key: key })
    expect(piercesQuietHours(e('meal.logged'))).toBe(true)
    expect(piercesQuietHours(e('meal.amended'))).toBe(true)
    expect(piercesQuietHours(e('live.zone', 'info'))).toBe(true)
    expect(piercesQuietHours(e('vitals.alert', 'alert'))).toBe(true)
    expect(piercesQuietHours(e('system.health', 'notable', 'system.health:yield-expired:x'))).toBe(true)
    expect(piercesQuietHours(e('recovery.brief', 'info'))).toBe(false)
    expect(piercesQuietHours(e('ride.landed'))).toBe(false)
  })
})
