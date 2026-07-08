import { describe, expect, test } from 'bun:test'
import { InFlightTracker } from '../src/delivery.js'

describe('InFlightTracker redelivery policy', () => {
  test('a pushed event excludes its recipients until acked', () => {
    const t = new InFlightTracker()
    t.pushed(1, [10, 11])
    expect([...t.exclusions(1)].sort()).toEqual([10, 11])
    t.acked(1)
    expect(t.exclusions(1).size).toBe(0)
  })

  test('latecomer sessions are not excluded (targeted push)', () => {
    const t = new InFlightTracker()
    t.pushed(1, [10])
    const ex = t.exclusions(1)
    expect(ex.has(10)).toBe(true)
    expect(ex.has(20)).toBe(false) // session 20 connected later: still eligible
    t.pushed(1, [20])
    expect(t.exclusions(1).has(20)).toBe(true) // now it has its copy
  })

  test('event frees for redelivery when its ONLY recipient drops, even with survivors', () => {
    const t = new InFlightTracker()
    t.pushed(1, [10]) // pushed to session 10 only
    t.pushed(2, [10, 30]) // pushed to both
    t.sessionDropped(10)
    // event 1 lost its only recipient: fully redeliverable
    expect(t.exclusions(1).size).toBe(0)
    // event 2 still has a live recipient (30) that may ack
    expect(t.exclusions(2).has(30)).toBe(true)
    expect(t.exclusions(2).has(10)).toBe(false)
  })

  test('TTL expiry frees a stuck event (handler failed / session suspended)', () => {
    const t = new InFlightTracker(1000)
    const t0 = 1_000_000
    t.pushed(1, [10], t0)
    expect(t.exclusions(1, t0 + 500).has(10)).toBe(true) // within TTL: excluded
    expect(t.exclusions(1, t0 + 1500).size).toBe(0) // past TTL: eligible everywhere again
  })

  test('re-push after TTL restarts the clock', () => {
    const t = new InFlightTracker(1000)
    const t0 = 1_000_000
    t.pushed(1, [10], t0)
    t.exclusions(1, t0 + 1500) // expires
    t.pushed(1, [10, 20], t0 + 1500)
    expect(t.exclusions(1, t0 + 2000).size).toBe(2) // fresh entry, both excluded
  })

  test('acked events stay gone regardless of later drops', () => {
    const t = new InFlightTracker()
    t.pushed(1, [10, 20])
    t.acked(1)
    t.sessionDropped(10)
    expect(t.size).toBe(0)
    expect(t.exclusions(1).size).toBe(0)
  })
})
