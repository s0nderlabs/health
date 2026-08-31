import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Store } from '../src/store.js'
import {
  fallbackTitle,
  isGenericRideName,
  isRideType,
  isWhoopSourced,
  prepareDescription,
  StravaNotFoundError,
  type StravaApi,
} from '../src/strava.js'

const WM = '- eltrain00r'
import { StravaWatch, FALLBACK_AFTER_MS } from '../src/strava-watch.js'
import type { StravaActivity } from '../src/types.js'

// ── Pure naming rules ─────────────────────────────────────────────

describe('generic-name detection (the only titles we may replace)', () => {
  test('matches exactly the five Strava auto-names for rides', () => {
    for (const n of ['Morning Ride', 'Lunch Ride', 'Afternoon Ride', 'Evening Ride', 'Night Ride']) {
      expect(isGenericRideName(n)).toBe(true)
    }
  })
  test('anything the owner could plausibly have typed is NOT generic', () => {
    for (const n of [
      '4x8 Sudirman',
      'Morning Ride with Dad', // extended = his
      'morning ride', // case changed = his
      'Easy spin',
      'Morning Run', // not a ride title
      '',
    ]) {
      expect(isGenericRideName(n)).toBe(false)
    }
  })
})

describe('announce guards', () => {
  test('ride types', () => {
    expect(isRideType({ sport_type: 'Ride' })).toBe(true)
    expect(isRideType({ sport_type: 'VirtualRide' })).toBe(true)
    expect(isRideType({ sport_type: 'WeightTraining' })).toBe(false)
  })
  test('WHOOP-pushed activities are recognized from device or external id', () => {
    expect(isWhoopSourced({ device_name: 'WHOOP 4.0', external_id: null })).toBe(true)
    expect(isWhoopSourced({ device_name: null, external_id: 'whoop-workout-123' })).toBe(true)
    expect(isWhoopSourced({ device_name: 'iGPSPORT BiNavi', external_id: 'binavi.fit' })).toBe(false)
  })
})

describe('public-text rules (mechanically enforced)', () => {
  test('appends the configured watermark, idempotently; empty watermark appends nothing', () => {
    expect(prepareDescription('Lid on throughout.', WM)).toBe(`Lid on throughout.\n\n${WM}`)
    expect(prepareDescription(`Lid on throughout.\n\n${WM}`, WM)).toBe(`Lid on throughout.\n\n${WM}`)
    expect(prepareDescription('Lid on throughout.', '')).toBe('Lid on throughout.')
  })
  test('rejects never-public physiology terms', () => {
    for (const bad of [
      'WHOOP said 14.7',
      'Strain was high',
      'HRV down this week',
      'recovery score 54%',
      'short sleep last night',
    ]) {
      expect(() => prepareDescription(bad, WM)).toThrow('never-public')
    }
  })
  test('normal cycling prose passes ("recovery pace" is not physiology)', () => {
    expect(() => prepareDescription('Recovery-pace spin, HR peak 154 on the flyover.', WM)).not.toThrow()
  })
})

function ride(overrides: Partial<StravaActivity> = {}): StravaActivity {
  return {
    id: 100,
    name: 'Morning Ride',
    description: null,
    sport_type: 'Ride',
    start_date: '2026-08-31T22:31:00Z',
    elapsed_time: 8400,
    moving_time: 5252, // 1h27m
    distance: 33010,
    total_elevation_gain: 142,
    average_speed: 6.29,
    average_heartrate: 128,
    max_heartrate: 154,
    device_name: 'iGPSPORT',
    external_id: 'binavi-123.fit',
    ...overrides,
  }
}

describe('fallback title (plan-anchored, data-verified)', () => {
  test('claims the plan title only when the ride backs it (>= 80% duration)', () => {
    expect(fallbackTitle(ride(), { title: 'Easy 2h', duration_min: 105 })).toBe('Easy 2h')
  })
  test('a bailed session gets an honest name, never the plan title bare', () => {
    expect(fallbackTitle(ride({ moving_time: 2280 }), { title: '4x8 Sudirman', duration_min: 95 })).toBe(
      '4x8 Sudirman, cut short at 38m',
    )
  })
  test('no plan: plain factual name', () => {
    expect(fallbackTitle(ride(), null)).toBe('Ride: 33.0km in 1h28m')
  })
})

// ── The watcher ───────────────────────────────────────────────────

interface MockApi extends StravaApi {
  activities: Map<number, StravaActivity>
  puts: Array<{ id: number; patch: { name?: string; description?: string } }>
}

function mockApi(...activities: StravaActivity[]): MockApi {
  const map = new Map(activities.map((a) => [a.id, a]))
  const puts: MockApi['puts'] = []
  return {
    activities: map,
    puts,
    async getActivity(id) {
      const a = map.get(id)
      if (!a) throw new StravaNotFoundError(`/activities/${id}`)
      return a
    },
    async updateActivity(id, patch) {
      const a = map.get(id)
      if (!a) throw new StravaNotFoundError(`/activities/${id}`)
      puts.push({ id, patch })
      const next = { ...a, ...(patch.name ? { name: patch.name } : {}), ...(patch.description !== undefined ? { description: patch.description } : {}) }
      map.set(id, next)
      return next
    },
    async listActivitiesAfter() {
      return [...map.values()]
    },
  }
}

function makeWatch(api: StravaApi, planTitle?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'health-strava-'))
  const store = new Store(join(dir, 'health.db'))
  const emitted: Array<{ key: string; content: string; meta: Record<string, string> }> = []
  const watch = new StravaWatch({
    api,
    store,
    emit: (key, payload) => emitted.push({ key, ...payload }),
    getPlanRide: () => (planTitle ? { title: planTitle, duration_min: 95 } : null),
    getWatermark: () => WM,
  })
  return { watch, store, emitted }
}

describe('discovery', () => {
  test('a generic-named ride is announced once, with plan context', async () => {
    const api = mockApi(ride())
    const { watch, store, emitted } = makeWatch(api, '4x8 Sudirman')
    await watch.discover(100)
    await watch.discover(100) // idempotent
    expect(emitted.length).toBe(1)
    expect(emitted[0].key).toBe('ride.landed:100')
    expect(emitted[0].meta.activity_id).toBe('100')
    expect(emitted[0].meta.whoop_matched).toBe('false')
    expect(emitted[0].meta.plan_title).toBe('4x8 Sudirman')
    expect(emitted[0].content).toContain('33.0km')
    expect(store.stravaSeen(100)).toBe(true)
  })

  test('an overlapping scored WHOOP cycling record flips whoop_matched', async () => {
    const api = mockApi(ride())
    const { watch, store, emitted } = makeWatch(api)
    store.upsertWorkout({
      id: 'w1', user_id: 1, created_at: '2026-08-31T23:00:00Z', updated_at: '2026-08-31T23:00:00Z',
      start: '2026-08-31T22:35:00Z', end: '2026-08-31T23:55:00Z', timezone_offset: '+07:00',
      sport_name: 'cycling', sport_id: 1, score_state: 'SCORED',
      score: {
        strain: 10.2, average_heart_rate: 128, max_heart_rate: 154, kilojoule: 2400,
        percent_recorded: 100, distance_meter: null, altitude_gain_meter: null, altitude_change_meter: null,
        zone_durations: { zone_zero_milli: 0, zone_one_milli: 0, zone_two_milli: 0, zone_three_milli: 0, zone_four_milli: 0, zone_five_milli: 0 },
      },
    })
    await watch.discover(100)
    expect(emitted[0].meta.whoop_matched).toBe('true')
    expect(emitted[0].content).toContain('BOTH sources')
  })

  test('non-rides and WHOOP-pushed activities are recorded but never announced', async () => {
    const api = mockApi(
      ride({ id: 1, sport_type: 'WeightTraining' }),
      ride({ id: 2, device_name: 'WHOOP 4.0' }),
    )
    const { watch, store, emitted } = makeWatch(api)
    await watch.discover(1)
    await watch.discover(2)
    expect(emitted.length).toBe(0)
    expect(store.stravaSeen(1)).toBe(true)
    expect(store.getStravaActivity(2)?.owner_named).toBe(1)
  })

  test('a ride the owner already named is announced but marked hands-off', async () => {
    const api = mockApi(ride({ name: 'Sunset century attempt' }))
    const { watch, store, emitted } = makeWatch(api)
    await watch.discover(100)
    expect(emitted.length).toBe(1)
    expect(store.getStravaActivity(100)?.owner_named).toBe(1)
  })

  test('first reconcile SEEDS history as hands-off; later sweeps announce new rides', async () => {
    const api = mockApi(ride({ id: 1 }))
    const { watch, store, emitted } = makeWatch(api)
    expect(await watch.reconcile()).toBe(0) // arming sweep: record, never announce
    expect(emitted.length).toBe(0)
    expect(store.getStravaActivity(1)?.owner_named).toBe(1)
    api.activities.set(2, ride({ id: 2 }))
    expect(await watch.reconcile()).toBe(1) // armed: a new ride announces
    expect(emitted.length).toBe(1)
    expect(emitted[0].key).toBe('ride.landed:2')
  })

  test('a delete webhook closes the row so the fallback loop drops it', async () => {
    const api = mockApi(ride())
    const { watch, store } = makeWatch(api)
    await watch.discover(100)
    await watch.onWebhookEvent({
      object_type: 'activity', object_id: 100, aspect_type: 'delete',
      owner_id: 1, subscription_id: 9, event_time: 1,
    })
    expect(store.getStravaActivity(100)?.owner_named).toBe(1)
  })
})

describe('webhook update events (echo vs owner rename)', () => {
  test('our own rename echoing back does NOT mark owner_named', async () => {
    const api = mockApi(ride())
    const { watch, store } = makeWatch(api)
    await watch.discover(100)
    await watch.annotate(100, { title: 'Easy 2h' })
    await watch.onWebhookEvent({
      object_type: 'activity', object_id: 100, aspect_type: 'update',
      owner_id: 1, subscription_id: 9, event_time: 1, updates: { title: 'Easy 2h' },
    })
    expect(store.getStravaActivity(100)?.owner_named).toBe(0)
  })

  test('a title we did not write marks the activity hands-off forever', async () => {
    const api = mockApi(ride())
    const { watch, store } = makeWatch(api)
    await watch.discover(100)
    await watch.onWebhookEvent({
      object_type: 'activity', object_id: 100, aspect_type: 'update',
      owner_id: 1, subscription_id: 9, event_time: 1, updates: { title: 'My own name' },
    })
    expect(store.getStravaActivity(100)?.owner_named).toBe(1)
  })
})

describe('fallback naming', () => {
  function backdate(store: Store, id: number): void {
    store.db.run('UPDATE strava_activities SET discovered_at = ? WHERE id = ?', [
      new Date(Date.now() - FALLBACK_AFTER_MS - 60_000).toISOString(),
      id,
    ])
  }

  test('names an unannotated ride after the window, from the plan', async () => {
    const api = mockApi(ride())
    const { watch, store } = makeWatch(api, 'Easy 2h')
    await watch.discover(100)
    await watch.fallbackTick() // window not reached: no PUT
    expect(api.puts.length).toBe(0)
    backdate(store, 100)
    await watch.fallbackTick()
    expect(api.puts).toEqual([{ id: 100, patch: { name: 'Easy 2h' } }])
    expect(store.getStravaActivity(100)?.annotated_by).toBe('fallback')
    await watch.fallbackTick() // done: never twice
    expect(api.puts.length).toBe(1)
  })

  test('backs off when the live title stopped being generic', async () => {
    const api = mockApi(ride())
    const { watch, store } = makeWatch(api)
    await watch.discover(100)
    backdate(store, 100)
    api.activities.set(100, ride({ name: 'Renamed by hand mid-window' }))
    await watch.fallbackTick()
    expect(api.puts.length).toBe(0)
    expect(store.getStravaActivity(100)?.owner_named).toBe(1)
  })
})

describe('annotate guards (the session write path)', () => {
  test('writes title + description onto a fresh generic ride', async () => {
    const api = mockApi(ride())
    const { watch, store } = makeWatch(api)
    await watch.discover(100)
    const res = await watch.annotate(100, { title: '4x8 Sudirman', description: 'All 8 reps done.' })
    expect(res).toEqual({ renamed: true, described: true, notes: [] })
    expect(api.puts[0].patch).toEqual({
      name: '4x8 Sudirman',
      description: `All 8 reps done.\n\n${WM}`,
    })
    const row = store.getStravaActivity(100)
    expect(row?.our_title).toBe('4x8 Sudirman')
    expect(row?.annotated_by).toBe('session')
  })

  test('may revise our own fallback title, and its own description', async () => {
    const api = mockApi(ride())
    const { watch, store } = makeWatch(api, 'Easy 2h')
    await watch.discover(100)
    store.db.run('UPDATE strava_activities SET discovered_at = ? WHERE id = ?', [
      new Date(Date.now() - FALLBACK_AFTER_MS - 60_000).toISOString(), 100,
    ])
    await watch.fallbackTick() // now titled "Easy 2h" by us
    const res = await watch.annotate(100, { title: 'Easy 2h, negative split', description: 'Steady.' })
    expect(res.renamed).toBe(true)
    expect(res.described).toBe(true)
  })

  test('refuses a title the owner set and a description we did not write', async () => {
    const api = mockApi(ride({ name: 'His own title', description: 'his words' }))
    const { watch } = makeWatch(api)
    await watch.discover(100)
    const res = await watch.annotate(100, { title: 'Nope', description: 'also nope' })
    expect(res.renamed).toBe(false)
    expect(res.described).toBe(false)
    expect(res.notes.length).toBe(2)
    expect(api.puts.length).toBe(0)
  })

  test('an untracked activity is refused outright', async () => {
    const api = mockApi(ride())
    const { watch } = makeWatch(api)
    await expect(watch.annotate(999, { title: 'x' })).rejects.toThrow('not tracked')
  })

  test('the title runs the same never-public filter as the description', async () => {
    const api = mockApi(ride())
    const { watch } = makeWatch(api)
    await watch.discover(100)
    await expect(watch.annotate(100, { title: 'Ez 2h, strain 10.2' })).rejects.toThrow('never-public')
    expect(api.puts.length).toBe(0)
  })

  test('a second session write is a refused no-op unless overwrite is passed', async () => {
    const api = mockApi(ride())
    const { watch } = makeWatch(api)
    await watch.discover(100)
    await watch.annotate(100, { title: 'Ez 2h' })
    const race = await watch.annotate(100, { title: 'Easy two hours' })
    expect(race.renamed).toBe(false)
    expect(race.notes[0]).toContain('already composed')
    expect(api.puts.length).toBe(1)
    const revised = await watch.annotate(100, { title: 'Ez 2h, day one', overwrite: true })
    expect(revised.renamed).toBe(true)
  })

  test('a WHOOP-pushed or non-ride row can never be annotated, description included', async () => {
    const api = mockApi(ride({ id: 1, device_name: 'WHOOP 4.0' }))
    const { watch } = makeWatch(api)
    await watch.discover(1)
    await expect(watch.annotate(1, { description: 'nope' })).rejects.toThrow('not an annotatable ride')
    expect(api.puts.length).toBe(0)
  })

  test('an owner-claimed activity gets no description either', async () => {
    const api = mockApi(ride({ name: 'His own title' })) // empty description
    const { watch } = makeWatch(api)
    await watch.discover(100) // non-generic name -> owner_named at discovery
    const res = await watch.annotate(100, { description: 'ours' })
    expect(res.described).toBe(false)
    expect(res.notes[0]).toContain('owner-claimed')
    expect(api.puts.length).toBe(0)
  })

  test('fallback gives up on an activity deleted from Strava', async () => {
    const api = mockApi(ride())
    const { watch, store } = makeWatch(api, 'Ez 2h')
    await watch.discover(100)
    store.db.run('UPDATE strava_activities SET discovered_at = ? WHERE id = ?', [
      new Date(Date.now() - FALLBACK_AFTER_MS - 60_000).toISOString(), 100,
    ])
    api.activities.delete(100) // deleted on Strava mid-window
    await watch.fallbackTick()
    expect(store.getStravaActivity(100)?.owner_named).toBe(1) // closed, not retried forever
    expect(api.puts.length).toBe(0)
  })
})
