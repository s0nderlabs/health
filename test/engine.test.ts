import { describe, expect, test, beforeEach } from 'bun:test'
import { Store } from '../src/store.js'
import { Engine } from '../src/engine.js'
import { DEFAULT_CONFIG } from '../src/types.js'
import type { HealthConfig, WhoopCycle, WhoopRecovery, WhoopWorkout } from '../src/types.js'
import type { Fact } from '../src/poller.js'

function freshStore(): Store {
  return new Store(':memory:')
}

function testConfig(patch: Partial<HealthConfig> = {}): HealthConfig {
  const base = structuredClone(DEFAULT_CONFIG)
  return { ...base, ...patch, quiet_hours: null }
}

function recovery(
  sleepId: string,
  daysAgo: number,
  score: { recovery_score: number; resting_heart_rate: number; hrv_rmssd_milli: number },
  calibrating = false,
): WhoopRecovery {
  const ts = new Date(Date.now() - daysAgo * 86_400_000).toISOString()
  return {
    cycle_id: 1000 + daysAgo,
    sleep_id: sleepId,
    user_id: 1,
    created_at: ts,
    updated_at: ts,
    score_state: 'SCORED',
    score: {
      user_calibrating: calibrating,
      recovery_score: score.recovery_score,
      resting_heart_rate: score.resting_heart_rate,
      hrv_rmssd_milli: score.hrv_rmssd_milli,
      spo2_percentage: 97,
      skin_temp_celsius: 33,
    },
  }
}

function workout(id: string, scored = true): WhoopWorkout {
  const now = new Date().toISOString()
  return {
    id,
    user_id: 1,
    created_at: now,
    updated_at: now,
    start: new Date(Date.now() - 3_600_000).toISOString(),
    end: now,
    timezone_offset: '+07:00',
    sport_name: 'powerlifting',
    sport_id: 59,
    score_state: scored ? 'SCORED' : 'PENDING_SCORE',
    score: scored
      ? {
          strain: 12.4,
          average_heart_rate: 117,
          max_heart_rate: 165,
          kilojoule: 3700,
          percent_recorded: 100,
          distance_meter: null,
          altitude_gain_meter: null,
          altitude_change_meter: null,
          zone_durations: {
            zone_zero_milli: 0, zone_one_milli: 600_000, zone_two_milli: 1_200_000,
            zone_three_milli: 900_000, zone_four_milli: 300_000, zone_five_milli: 0,
          },
        }
      : null,
  }
}

function cycle(id: number, strain: number): WhoopCycle {
  const now = new Date().toISOString()
  return {
    id, user_id: 1, created_at: now, updated_at: now,
    start: new Date(Date.now() - 8 * 3_600_000).toISOString(), end: null,
    timezone_offset: '+07:00', score_state: 'SCORED',
    score: { strain, kilojoule: 8000, average_heart_rate: 80, max_heart_rate: 160 },
  }
}

const fact = (kind: Fact['kind'], record: Fact['record']): Fact => ({ kind, isNew: true, record })

describe('engine event gating', () => {
  let store: Store
  let config: HealthConfig
  let engine: Engine

  beforeEach(() => {
    store = freshStore()
    config = testConfig()
    engine = new Engine(store, () => config)
  })

  test('scored recovery queues exactly one brief per sleep', () => {
    const r = recovery('sleep-1', 0, { recovery_score: 55, resting_heart_rate: 58, hrv_rmssd_milli: 60 })
    store.upsertRecovery(r)
    engine.onFact(fact('recovery', r))
    engine.onFact(fact('recovery', r)) // duplicate fact (webhook + poll race)
    const events = store.undeliveredEvents()
    expect(events.filter((e) => e.class === 'recovery.brief').length).toBe(1)
    expect(events[0].content).toContain('Recovery 55%')
    expect(events[0].content).toContain('amber')
  })

  test('red recovery is notable priority', () => {
    const r = recovery('sleep-red', 0, { recovery_score: 20, resting_heart_rate: 62, hrv_rmssd_milli: 30 })
    store.upsertRecovery(r)
    engine.onFact(fact('recovery', r))
    const [e] = store.undeliveredEvents()
    expect(e.priority).toBe('notable')
    expect(e.content).toContain('red')
  })

  test('unscored records queue nothing', () => {
    const r = { ...recovery('sleep-p', 0, { recovery_score: 0, resting_heart_rate: 0, hrv_rmssd_milli: 0 }), score_state: 'PENDING_SCORE' as const, score: null }
    engine.onFact(fact('recovery', r))
    engine.onFact(fact('workout', workout('w-pending', false)))
    expect(store.undeliveredEvents().length).toBe(0)
  })

  test('scored workout queues a card with the numbers', () => {
    engine.onFact(fact('workout', workout('w-1')))
    const [e] = store.undeliveredEvents()
    expect(e.class).toBe('workout.card')
    expect(e.content).toContain('powerlifting')
    expect(e.content).toContain('Strain 12.4')
    expect(e.content).toContain('884 kcal')
  })

  test('class toggle off suppresses the event', () => {
    config.events['workout.card'] = false
    engine.onFact(fact('workout', workout('w-2')))
    expect(store.undeliveredEvents().length).toBe(0)
  })

  test('strain threshold fires once per cycle, only above the line', () => {
    engine.onFact(fact('cycle', cycle(1, 14.9)))
    expect(store.undeliveredEvents().length).toBe(0)
    engine.onFact(fact('cycle', cycle(2, 15.3)))
    engine.onFact(fact('cycle', cycle(2, 16.1))) // same cycle, later update
    const events = store.undeliveredEvents().filter((e) => e.class === 'strain.threshold')
    expect(events.length).toBe(1)
  })

  test('daily budget blocks info events but never alerts', () => {
    config.daily_budget = 0
    // deliveredToday >= 0 means budget exhausted immediately
    engine.onFact(fact('workout', workout('w-3'))) // info: blocked? budget check compares deliveredToday >= budget: 0 >= 0
    expect(store.undeliveredEvents().length).toBe(0)

    // Alerts bypass the budget: build the two-low-days + elevated-RHR pattern.
    for (let d = 8; d >= 2; d--) {
      const r = recovery(`s-${d}`, d, { recovery_score: 70, resting_heart_rate: 55, hrv_rmssd_milli: 80 })
      store.upsertRecovery(r)
    }
    const low1 = recovery('s-low1', 1, { recovery_score: 25, resting_heart_rate: 64, hrv_rmssd_milli: 45 })
    store.upsertRecovery(low1)
    const low2 = recovery('s-low2', 0, { recovery_score: 22, resting_heart_rate: 66, hrv_rmssd_milli: 42 })
    store.upsertRecovery(low2)
    engine.onFact(fact('recovery', low2))
    const alerts = store.undeliveredEvents().filter((e) => e.class === 'vitals.alert')
    expect(alerts.length).toBe(1)
    expect(alerts[0].priority).toBe('alert')
  })

  test('daily budget counts events CREATED today, not just delivered', () => {
    config.daily_budget = 3
    config.cooldown_minutes = { ...config.cooldown_minutes, 'workout.card': 0 } // isolate budget from cooldown
    // Queue 3 workout cards while "offline" (nothing delivered/acked).
    for (let i = 0; i < 3; i++) engine.onFact(fact('workout', workout(`w-b${i}`)))
    expect(store.undeliveredEvents().filter((e) => e.class === 'workout.card').length).toBe(3)
    // The 4th is blocked by the budget even though deliveredToday() is still 0.
    engine.onFact(fact('workout', workout('w-b4')))
    expect(store.undeliveredEvents().filter((e) => e.class === 'workout.card').length).toBe(3)
    expect(store.deliveredToday()).toBe(0)
    expect(store.createdToday()).toBe(3)
  })

  test('vitals alert does NOT fire on a single bad day', () => {
    for (let d = 8; d >= 1; d--) {
      const r = recovery(`n-${d}`, d, { recovery_score: 70, resting_heart_rate: 55, hrv_rmssd_milli: 80 })
      store.upsertRecovery(r)
    }
    const oneBad = recovery('n-bad', 0, { recovery_score: 15, resting_heart_rate: 70, hrv_rmssd_milli: 35 })
    store.upsertRecovery(oneBad)
    engine.onFact(fact('recovery', oneBad))
    expect(store.undeliveredEvents().filter((e) => e.class === 'vitals.alert').length).toBe(0)
  })

  test('calibrating recovery hedges and never raises vitals alerts', () => {
    const r1 = recovery('c-1', 1, { recovery_score: 9, resting_heart_rate: 62, hrv_rmssd_milli: 25 }, true)
    const r2 = recovery('c-2', 0, { recovery_score: 12, resting_heart_rate: 63, hrv_rmssd_milli: 24 }, true)
    store.upsertRecovery(r1)
    store.upsertRecovery(r2)
    engine.onFact(fact('recovery', r2))
    const events = store.undeliveredEvents()
    expect(events.filter((e) => e.class === 'vitals.alert').length).toBe(0)
    const brief = events.find((e) => e.class === 'recovery.brief')
    expect(brief?.content).toContain('calibrating')
  })

  test('workout intent queues immediately', () => {
    engine.workoutIntent('cycling')
    const [e] = store.undeliveredEvents()
    expect(e.class).toBe('workout.intent')
    expect(e.content).toContain('cycling')
  })

  test('workout intent bypasses the daily budget (user-initiated)', () => {
    config.daily_budget = 0
    const surfaced = engine.workoutIntent('deadlifts')
    expect(surfaced).toBe(true)
    expect(store.undeliveredEvents().filter((e) => e.class === 'workout.intent').length).toBe(1)
  })

  test('a re-scored recovery SUPERSEDES a queued (undelivered) brief', () => {
    const first = recovery('sleep-x', 0, { recovery_score: 30, resting_heart_rate: 60, hrv_rmssd_milli: 40 })
    store.upsertRecovery(first)
    engine.onFact(fact('recovery', first))
    expect(store.undeliveredEvents()[0].content).toContain('Recovery 30%')

    // WHOOP re-scores the same sleep; updated_at advances so the upsert takes.
    const rescored: WhoopRecovery = {
      ...first,
      updated_at: new Date(Date.now() + 60_000).toISOString(),
      score: { ...first.score!, recovery_score: 62 },
    }
    store.upsertRecovery(rescored)
    engine.onFact(fact('recovery', rescored))

    const events = store.undeliveredEvents()
    expect(events.length).toBe(1) // superseded, not duplicated
    expect(events[0].content).toContain('Recovery 62%')
    expect(events[0].content).not.toContain('Recovery 30%')
  })

  test('a DELIVERED brief is never re-sent for the same sleep', () => {
    const r = recovery('sleep-d', 0, { recovery_score: 40, resting_heart_rate: 58, hrv_rmssd_milli: 55 })
    store.upsertRecovery(r)
    engine.onFact(fact('recovery', r))
    const [queued] = store.undeliveredEvents()
    store.markDelivered(queued.id)

    // Same sleep re-scored after delivery: no new brief (already told the user).
    const rescored: WhoopRecovery = {
      ...r,
      updated_at: new Date(Date.now() + 60_000).toISOString(),
      score: { ...r.score!, recovery_score: 44 },
    }
    store.upsertRecovery(rescored)
    engine.onFact(fact('recovery', rescored))
    expect(store.undeliveredEvents().length).toBe(0)
  })
})

describe('event queue semantics', () => {
  test('same dedupe_key supersedes the undelivered event', () => {
    const store = freshStore()
    const base = { class: 'recovery.brief' as const, priority: 'info' as const, meta: {}, created_at: new Date().toISOString() }
    store.insertEvent({ ...base, dedupe_key: 'k1', content: 'old' })
    store.insertEvent({ ...base, dedupe_key: 'k1', content: 'new' })
    const events = store.undeliveredEvents()
    expect(events.length).toBe(1)
    expect(events[0].content).toBe('new')
  })

  test('delivered events are not redelivered', () => {
    const store = freshStore()
    const id = store.insertEvent({
      class: 'workout.card', priority: 'info', dedupe_key: 'w1', content: 'x', meta: {},
      created_at: new Date().toISOString(),
    })
    store.markDelivered(id)
    expect(store.undeliveredEvents().length).toBe(0)
    expect(store.deliveredToday()).toBe(1)
  })

  test('stale undelivered events expire by class age', () => {
    const store = freshStore()
    store.insertEvent({
      class: 'bedtime.nudge', priority: 'info', dedupe_key: 'b1', content: 'x', meta: {},
      created_at: new Date(Date.now() - 5 * 3_600_000).toISOString(), // 5h old
    })
    const expired = store.expireStale({ 'bedtime.nudge': 3 })
    expect(expired).toBe(1)
    expect(store.undeliveredEvents().length).toBe(0)
  })
})

describe('live events through the engine', () => {
  test('zone escalations seconds apart are not cooldown-blocked', () => {
    const store = freshStore()
    const engine = new Engine(store, () => testConfig())
    expect(engine.liveEvent('live.zone', 'live.zone:s1:z4', { content: 'z4', meta: {} })).toBe(true)
    expect(engine.liveEvent('live.zone', 'live.zone:s1:z5', { content: 'z5', meta: {} })).toBe(true)
  })

  test('live events are exempt from the daily budget', () => {
    const store = freshStore()
    const engine = new Engine(store, () => testConfig({ daily_budget: 0 }))
    expect(engine.liveEvent('live.rest', 'live.rest:s1', { content: 'r', meta: {} })).toBe(true)
  })

  test('time-critical systemProblem bypasses the 6h class cooldown AND the daily budget', () => {
    const store = freshStore()
    // daily_budget 0: any budget-subject event is dropped; bypass must not be.
    const engine = new Engine(store, () => testConfig({ daily_budget: 0 }))
    engine.systemProblem('yield breach: mac still holds the band', 'yield-breach:mac:t1', { bypassCooldown: true })
    // Minutes later (inside the 360-min system.health cooldown) the window
    // expires; without the bypass this advisory is silently dropped.
    engine.systemProblem('yield window ended; relayers re-armed', 'yield-expired:t2', { bypassCooldown: true })
    const classes = store.undeliveredEvents().filter((e) => e.class === 'system.health')
    expect(classes.length).toBe(2)
    // The default path keeps the cooldown: a third, non-bypass problem stays muted.
    engine.systemProblem('chronic: auth broken', 'auth-broken:t3')
    expect(store.undeliveredEvents().filter((e) => e.class === 'system.health').length).toBe(2)
  })

  test('the confirm passes inside the live.session cooldown; a plain second start does not', () => {
    const store = freshStore()
    const engine = new Engine(store, () => testConfig()) // live.session cooldown: 10 min
    expect(engine.liveEvent('live.session', 'live.session:s1', { content: 'start', meta: {} })).toBe(true)
    // A different-key start inside the cooldown is blocked (anti-flap)...
    expect(engine.liveEvent('live.session', 'live.session:s2', { content: 'flap', meta: {} })).toBe(false)
    // ...unless it is a declared/evidenced start, which livestate emits with
    // the bypass so a phantom's earlier start can never anchor it away.
    expect(
      engine.liveEvent('live.session', 'live.session:s3', { content: 'declared', meta: {} }, { bypassCooldown: true }),
    ).toBe(true)
    // ...but the once-per-session confirm (own class, self-throttled, bypass) passes.
    expect(
      engine.liveEvent(
        'live.confirm',
        'live.confirm:s1',
        { content: 'confirmed', meta: { kind: 'confirm' } },
        { bypassCooldown: true },
      ),
    ).toBe(true)
  })

  test('a confirm never re-anchors the live.session cooldown against the next session', () => {
    const store = freshStore()
    const engine = new Engine(store, () => testConfig())
    engine.liveEvent('live.session', 'live.session:sA', { content: 'a', meta: {} })
    // Age session A's start past the 10-min cooldown, then land A's confirm NOW.
    store.db.run(`UPDATE events SET created_at = ? WHERE dedupe_key = 'live.session:sA'`, [
      new Date(Date.now() - 11 * 60_000).toISOString(),
    ])
    expect(
      engine.liveEvent('live.confirm', 'live.confirm:sA', { content: 'c', meta: { kind: 'confirm' } }, { bypassCooldown: true }),
    ).toBe(true)
    // Session B's start must anchor on A's START (11 min ago), not A's confirm
    // (just now): a fresh confirm must never swallow the next real session.
    expect(engine.liveEvent('live.session', 'live.session:sB', { content: 'b', meta: {} })).toBe(true)
  })
})

describe('live session corroboration', () => {
  test('a scored workout stamps corroborated on overlapping live sessions, demoted included', () => {
    const store = freshStore()
    const engine = new Engine(store, () => testConfig())
    const w = workout('w-corr') // window: [now-1h, now]
    const inWindow = new Date(Date.now() - 30 * 60_000).toISOString()
    const before = new Date(Date.now() - 3 * 3_600_000).toISOString()
    store.insertLiveSession({
      started_at: inWindow,
      ended_at: new Date(Date.now() - 20 * 60_000).toISOString(),
      reason: 'cooldown', duration_s: 600, avg_bpm: 120, max_bpm: 140,
      zone_seconds: [0, 0, 600, 0, 0, 0], recovery_60s_drop: null,
      confidence: 'low', demoted: true,
    })
    store.insertLiveSession({
      started_at: before,
      ended_at: new Date(Date.now() - 2.9 * 3_600_000).toISOString(),
      reason: 'cooldown', duration_s: 600, avg_bpm: 120, max_bpm: 140,
      zone_seconds: [0, 0, 600, 0, 0, 0], recovery_60s_drop: null,
    })
    engine.onFact(fact('workout', w))
    const rows = store.recentLiveSessions(2) as Array<Record<string, unknown>>
    expect(rows.find((r) => r.started_at === inWindow)?.corroborated).toBe(1)
    expect(rows.find((r) => r.started_at === before)?.corroborated).toBeNull()
  })

  test('corroboration runs even when the card emit is suppressed (score revision)', () => {
    const store = freshStore()
    const engine = new Engine(store, () => testConfig())
    engine.onFact(fact('workout', workout('w-rev'))) // first card queued
    // Insert the live session AFTER the first pass, then re-fire the same
    // workout (a revision): the card is deduped away, the stamp must not be.
    const inWindow = new Date(Date.now() - 30 * 60_000).toISOString()
    store.insertLiveSession({
      started_at: inWindow,
      ended_at: new Date(Date.now() - 20 * 60_000).toISOString(),
      reason: 'feed_drop', duration_s: 600, avg_bpm: 121, max_bpm: 142,
      zone_seconds: [0, 120, 360, 120, 0, 0], recovery_60s_drop: null,
      confidence: 'low', demoted: true,
    })
    engine.onFact(fact('workout', workout('w-rev')))
    const rows = store.recentLiveSessions(1) as Array<Record<string, unknown>>
    expect(rows.find((r) => r.started_at === inWindow)?.corroborated).toBe(1)
  })
})

describe('workout intent stapling', () => {
  let store: Store
  let engine: Engine

  beforeEach(() => {
    store = freshStore()
    engine = new Engine(store, () => testConfig())
  })

  test('enriched intent carries label and pr, and staples onto the scored card', () => {
    engine.workoutIntent('Deadlift 1RM Test', { label: 'Deadlift 1RM Test', pr: true })
    const [intentEvent] = store.undeliveredEvents().filter((e) => e.class === 'workout.intent')
    expect(intentEvent.content).toContain('PR attempt')
    expect((intentEvent.meta as Record<string, string>).pr).toBe('true')

    // WHOOP scores the workout afterwards (started 1h ago, intent inside it).
    const w = workout('w-pr-day')
    engine.onFact(fact('workout', w))
    const [card] = store.undeliveredEvents().filter((e) => e.class === 'workout.card')
    expect(card.content).toContain('Session: Deadlift 1RM Test (PR attempt)')
    const meta = card.meta as Record<string, string>
    expect(meta.intent_label).toBe('Deadlift 1RM Test')
    expect(meta.intent_pr).toBe('true')
  })

  test('a stale intent (outside the workout window) is not stapled', () => {
    // An intent 26h old, well before this workout's window.
    store.setMeta('intent_log', JSON.stringify([
      { ts: new Date(Date.now() - 26 * 3_600_000).toISOString(), activity: 'Run', label: 'Run', pr: false, claimed: false },
    ]))
    const w = workout('w-no-intent')
    engine.onFact(fact('workout', w))
    const [card] = store.undeliveredEvents().filter((e) => e.class === 'workout.card')
    expect(card.content).not.toContain('Session:')
    expect((card.meta as Record<string, string>).intent_label).toBeUndefined()
  })

  test('a later cooldown intent does not clobber the earlier lift label', () => {
    // The workout ran the last hour (workout() start = now-1h, end = now).
    // Deadlift intent lands inside it; a Walk intent lands AFTER it ends.
    const now = Date.now()
    store.setMeta('intent_log', JSON.stringify([
      { ts: new Date(now - 55 * 60_000).toISOString(), activity: 'Deadlift 1RM Test', label: 'Deadlift 1RM Test', pr: true, claimed: false },
      { ts: new Date(now + 60_000).toISOString(), activity: 'Walk', label: 'Walk', pr: false, claimed: false },
    ]))
    engine.onFact(fact('workout', workout('w-lift')))
    const [card] = store.undeliveredEvents().filter((e) => e.class === 'workout.card')
    expect(card.content).toContain('Session: Deadlift 1RM Test (PR attempt)')
  })

  test('a claimed intent never staples onto a second overlapping workout', () => {
    // Zero the workout.card cooldown so both cards actually emit in-test.
    const eng = new Engine(store, () => testConfig({ cooldown_minutes: { ...DEFAULT_CONFIG.cooldown_minutes, 'workout.card': 0 } }))
    eng.workoutIntent('Deadlift 1RM Test', { label: 'Deadlift 1RM Test', pr: true })
    eng.onFact(fact('workout', workout('w-lift'))) // claims it
    // An auto-detected cooldown walk overlapping the same window scores next.
    eng.onFact(fact('workout', workout('w-walk')))
    const cards = store.undeliveredEvents().filter((e) => e.class === 'workout.card')
    const walkCard = cards.find((c) => (c.meta as Record<string, string>).workout_id === 'w-walk')!
    expect(walkCard.content).not.toContain('Session:')
  })

  test('a score revision keeps the label instead of coming back bare', () => {
    engine.workoutIntent('Deadlift 1RM Test', { label: 'Deadlift 1RM Test', pr: true })
    engine.onFact(fact('workout', workout('w-lift'))) // claims + staples
    // WHOOP revises the score; the same workout id re-fires onWorkout.
    engine.onFact(fact('workout', workout('w-lift')))
    const cards = store.undeliveredEvents().filter(
      (e) => e.class === 'workout.card' && (e.meta as Record<string, string>).intent_label === 'Deadlift 1RM Test',
    )
    expect(cards.length).toBeGreaterThan(0)
  })
})

describe('workout intent retry dedupe', () => {
  let store: Store
  let engine: Engine

  beforeEach(() => {
    store = freshStore()
    engine = new Engine(store, () => testConfig())
  })

  test('a same-activity re-press within the window is absorbed: one event, one log entry', () => {
    // Jul 10: the app UI failed to arm, he pressed start twice 14s apart,
    // and both intents were delivered as a double notif.
    expect(engine.workoutIntent('Deadlift 1RM Test', { label: 'Deadlift 1RM Test', pr: true })).toBe(true)
    expect(engine.workoutIntent('Deadlift 1RM Test', { label: 'Deadlift 1RM Test', pr: true })).toBe(true)
    expect(store.undeliveredEvents().filter((e) => e.class === 'workout.intent').length).toBe(1)
    const log = JSON.parse(store.getMeta('intent_log') ?? '[]') as unknown[]
    expect(log.length).toBe(1)
  })

  test('a different activity inside the window is a real second intent', () => {
    engine.workoutIntent('Deadlift 1RM Test')
    engine.workoutIntent('Walk')
    expect(store.undeliveredEvents().filter((e) => e.class === 'workout.intent').length).toBe(2)
  })

  test('the same activity past the window is a real new intent', () => {
    store.setMeta('intent_log', JSON.stringify([
      { ts: new Date(Date.now() - 4 * 60_000).toISOString(), activity: 'Lifting', label: 'Lifting', pr: false, claimed: false },
    ]))
    engine.workoutIntent('Lifting')
    expect(store.undeliveredEvents().filter((e) => e.class === 'workout.intent').length).toBe(1)
    const log = JSON.parse(store.getMeta('intent_log') ?? '[]') as unknown[]
    expect(log.length).toBe(2)
  })

  test('a claimed same-activity entry does not absorb a new press (back-to-back sessions)', () => {
    store.setMeta('intent_log', JSON.stringify([
      { ts: new Date(Date.now() - 60_000).toISOString(), activity: 'Lifting', label: 'Lifting', pr: false, claimed: true, workout_id: 'w-1' },
    ]))
    engine.workoutIntent('Lifting')
    expect(store.undeliveredEvents().filter((e) => e.class === 'workout.intent').length).toBe(1)
  })
})
