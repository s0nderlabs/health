import { describe, expect, test } from 'bun:test'
import { Store } from '../src/store.js'

// Deterministic local-day anchors: relative-to-now offsets would cross the
// local midnight boundary depending on when the suite runs.
function localToday(hours: number): string {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return new Date(d.getTime() + hours * 3_600_000).toISOString()
}

function sample(uuid: string, startIso: string, count: number, minutes = 60) {
  return {
    uuid,
    start: startIso,
    end: new Date(Date.parse(startIso) + minutes * 60_000).toISOString(),
    count,
  }
}

describe('steps store', () => {
  test('stepsToday is null before any sample exists', () => {
    const store = new Store(':memory:')
    expect(store.stepsToday()).toBeNull()
  })

  test('upsert is idempotent by uuid', () => {
    const store = new Store(':memory:')
    const s1 = sample('uuid-aaaa-0001', localToday(8), 450)
    const s2 = sample('uuid-aaaa-0002', localToday(9), 1200)
    expect(store.upsertStepsSamples([s1, s2]).added).toBe(2)
    // A HealthKit anchored query can re-deliver overlap after an anchor reset.
    expect(store.upsertStepsSamples([s1, s2]).added).toBe(0)
    expect(store.stepsToday()?.total).toBe(1650)
  })

  test('a re-received sample with a new count replaces, never double-counts', () => {
    const store = new Store(':memory:')
    store.upsertStepsSamples([sample('uuid-bbbb-0001', localToday(8), 450)])
    const res = store.upsertStepsSamples([sample('uuid-bbbb-0001', localToday(8), 500)])
    expect(res.added).toBe(0)
    expect(store.stepsToday()?.total).toBe(500)
  })

  test('stepsToday sums only the local calendar day', () => {
    const store = new Store(':memory:')
    store.upsertStepsSamples([
      sample('uuid-cccc-0001', localToday(8), 1000),
      sample('uuid-cccc-0002', localToday(10), 2000),
      sample('uuid-cccc-yday', localToday(-20), 9999), // yesterday
    ])
    const today = store.stepsToday()
    expect(today?.total).toBe(3000)
    expect(today?.latest_sample_end).toBe(sample('x-unused-x', localToday(10), 0).end)
  })

  test('stepsByDay groups by local day for the trend surface', () => {
    const store = new Store(':memory:')
    store.upsertStepsSamples([
      sample('uuid-dddd-0001', localToday(8), 1000),
      sample('uuid-dddd-0002', localToday(-20), 4000),
      sample('uuid-dddd-0003', localToday(-22), 500),
    ])
    const days = store.stepsByDay(3)
    expect(days.length).toBe(2)
    expect(days[0].total).toBe(4500) // yesterday
    expect(days[1].total).toBe(1000) // today
  })

  test('steps_samples shows up in counts', () => {
    const store = new Store(':memory:')
    store.upsertStepsSamples([sample('uuid-eeee-0001', localToday(8), 100)])
    expect(store.counts().steps_samples).toBe(1)
  })

  test('deleteStepsSamples removes rows so a re-synced hour cannot double-count', () => {
    const store = new Store(':memory:')
    // WHOOP wrote 450 steps for the 14:00 hour, then revised it: HealthKit
    // deletes the old UUID and inserts a new one for the same window.
    store.upsertStepsSamples([sample('uuid-old-0450', localToday(14), 450)])
    expect(store.stepsToday()?.total).toBe(450)
    const res = store.upsertStepsSamples([sample('uuid-new-0300', localToday(14), 300)])
    expect(res.added).toBe(1)
    // Without the delete this would report 750; the courier forwards the
    // deleted UUID so the stale 450 is removed.
    expect(store.deleteStepsSamples(['uuid-old-0450']).deleted).toBe(1)
    expect(store.stepsToday()?.total).toBe(300)
  })

  test('deleteStepsSamples is a no-op for unknown or empty uuids', () => {
    const store = new Store(':memory:')
    store.upsertStepsSamples([sample('uuid-keep-0001', localToday(8), 100)])
    expect(store.deleteStepsSamples([]).deleted).toBe(0)
    expect(store.deleteStepsSamples(['never-existed']).deleted).toBe(0)
    expect(store.stepsToday()?.total).toBe(100)
  })
})
