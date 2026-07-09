import { describe, expect, test } from 'bun:test'
import { isWakeSignal, wakeReleaseActive, WAKE_FRESH_MS } from '../src/wake.js'
import { DEFAULT_CONFIG } from '../src/types.js'
import type { HealthConfig, WhoopRecovery, WhoopSleep } from '../src/types.js'
import type { Fact } from '../src/poller.js'

const NOW = Date.parse('2026-07-09T05:01:00.000Z')

function sleepFact(endAgoMs: number, opts: { nap?: boolean; scored?: boolean } = {}): Fact {
  const end = new Date(NOW - endAgoMs).toISOString()
  const record = {
    id: 'sleep-1',
    cycle_id: 1,
    user_id: 1,
    created_at: end,
    updated_at: end,
    start: new Date(NOW - endAgoMs - 8 * 3_600_000).toISOString(),
    end,
    timezone_offset: '+07:00',
    nap: opts.nap ?? false,
    score_state: opts.scored === false ? 'PENDING_SCORE' : 'SCORED',
    score: null,
  } as unknown as WhoopSleep
  return { kind: 'sleep', isNew: true, record }
}

function recoveryFact(sleepId = 'sleep-1'): Fact {
  const record = {
    cycle_id: 1,
    sleep_id: sleepId,
    user_id: 1,
    created_at: new Date(NOW).toISOString(),
    updated_at: new Date(NOW).toISOString(),
    score_state: 'SCORED',
    score: {
      user_calibrating: false,
      recovery_score: 50,
      resting_heart_rate: 55,
      hrv_rmssd_milli: 45,
      spo2_percentage: 97,
      skin_temp_celsius: 33,
    },
  } as WhoopRecovery
  return { kind: 'recovery', isNew: true, record }
}

const noSleep = (): null => null

describe('isWakeSignal', () => {
  test('scored non-nap sleep that just ended is a wake', () => {
    expect(isWakeSignal(sleepFact(3 * 60_000), noSleep, NOW)).toBe(true)
  })

  test('sleep that ended long ago (app edit, poller re-fetch) is not', () => {
    expect(isWakeSignal(sleepFact(WAKE_FRESH_MS + 60_000), noSleep, NOW)).toBe(false)
  })

  test('sleep ending exactly at the freshness bound is not', () => {
    expect(isWakeSignal(sleepFact(WAKE_FRESH_MS), noSleep, NOW)).toBe(false)
  })

  test('nap is not a wake', () => {
    expect(isWakeSignal(sleepFact(3 * 60_000, { nap: true }), noSleep, NOW)).toBe(false)
  })

  test('unscored sleep is not a wake', () => {
    expect(isWakeSignal(sleepFact(3 * 60_000, { scored: false }), noSleep, NOW)).toBe(false)
  })

  test('sleep with a future end (clock skew) is not', () => {
    expect(isWakeSignal(sleepFact(-5 * 60_000), noSleep, NOW)).toBe(false)
  })

  test('recovery resolves its sleep and counts as a wake', () => {
    const lookup = () => ({ end: new Date(NOW - 3 * 60_000).toISOString(), nap: 0 })
    expect(isWakeSignal(recoveryFact(), lookup, NOW)).toBe(true)
  })

  test('recovery whose sleep is a nap is not', () => {
    const lookup = () => ({ end: new Date(NOW - 3 * 60_000).toISOString(), nap: 1 })
    expect(isWakeSignal(recoveryFact(), lookup, NOW)).toBe(false)
  })

  test('recovery whose sleep is not in the store yet is not', () => {
    expect(isWakeSignal(recoveryFact(), noSleep, NOW)).toBe(false)
  })

  test('cycle and workout facts are never wakes', () => {
    const fact = { kind: 'cycle', isNew: true, record: {} } as unknown as Fact
    expect(isWakeSignal(fact, noSleep, NOW)).toBe(false)
  })
})

function cfg(quiet: HealthConfig['quiet_hours']): HealthConfig {
  return { ...structuredClone(DEFAULT_CONFIG), quiet_hours: quiet }
}

// Local wall-clock times (wakeReleaseActive computes the window in local time).
function localTime(hours: number, minutes: number, dayOffset = 0): Date {
  const d = new Date(2026, 6, 9 + dayOffset) // Jul 9 2026 local midnight
  d.setHours(hours, minutes, 0, 0)
  return d
}

describe('wakeReleaseActive', () => {
  const overnight = { start: '23:00', end: '06:00' }

  test('wake inside the current overnight window lifts the hold', () => {
    const wake = localTime(5, 1).toISOString()
    expect(wakeReleaseActive(cfg(overnight), wake, localTime(5, 30))).toBe(true)
  })

  test('a mid-night wake does NOT lift the hold (outside the morning tail)', () => {
    // Fragmented night: WHOOP closes and scores a sleep segment at 00:30.
    // Flushing every queued event then is exactly what quiet hours prevent.
    const wake = localTime(0, 30).toISOString()
    expect(wakeReleaseActive(cfg(overnight), wake, localTime(1, 0))).toBe(false)
  })

  test('a wake inside the 3h morning tail lifts the hold', () => {
    const wake = localTime(3, 30).toISOString() // window ends 06:00, tail starts 03:00
    expect(wakeReleaseActive(cfg(overnight), wake, localTime(4, 0))).toBe(true)
  })

  test("this morning's wake does not unlock tonight's window", () => {
    const wake = localTime(5, 1).toISOString()
    expect(wakeReleaseActive(cfg(overnight), wake, localTime(23, 30))).toBe(false)
  })

  test('wake from before the window started does not lift it', () => {
    const wake = localTime(22, 0).toISOString()
    expect(wakeReleaseActive(cfg(overnight), wake, localTime(23, 30))).toBe(false)
  })

  test('no recorded wake means no release', () => {
    expect(wakeReleaseActive(cfg(overnight), null, localTime(5, 30))).toBe(false)
  })

  test('wake_release: false disables the feature', () => {
    const wake = localTime(5, 1).toISOString()
    expect(wakeReleaseActive(cfg({ ...overnight, wake_release: false }), wake, localTime(5, 30))).toBe(false)
  })

  test('quiet_hours: null means no release logic', () => {
    const wake = localTime(5, 1).toISOString()
    expect(wakeReleaseActive(cfg(null), wake, localTime(5, 30))).toBe(false)
  })

  test('a future wake timestamp is ignored', () => {
    const wake = localTime(6, 0).toISOString()
    expect(wakeReleaseActive(cfg(overnight), wake, localTime(5, 30))).toBe(false)
  })

  test('garbage wake timestamp is ignored', () => {
    expect(wakeReleaseActive(cfg(overnight), 'not-a-date', localTime(5, 30))).toBe(false)
  })

  test('same-day window (start < end) uses today\'s start', () => {
    const daytime = { start: '13:00', end: '15:00' }
    const wake = localTime(13, 30).toISOString()
    expect(wakeReleaseActive(cfg(daytime), wake, localTime(14, 0))).toBe(true)
    const staleWake = localTime(14, 0, -1).toISOString() // yesterday 14:00
    expect(wakeReleaseActive(cfg(daytime), staleWake, localTime(14, 0))).toBe(false)
  })
})
