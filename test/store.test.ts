import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Store } from '../src/store.js'

describe('live_sessions schema migration', () => {
  test('a v1 archive gains the confidence columns on open, data intact', () => {
    // Build a pre-v0.7.0 db by hand: live_sessions without the new columns.
    const dir = mkdtempSync(join(tmpdir(), 'health-store-'))
    const path = join(dir, 'health.db')
    const raw = new Database(path, { create: true })
    raw.run(`CREATE TABLE live_sessions (
      started_at TEXT PRIMARY KEY, ended_at TEXT NOT NULL, reason TEXT NOT NULL,
      duration_s INTEGER NOT NULL, avg_bpm INTEGER NOT NULL, max_bpm INTEGER NOT NULL,
      zone_seconds TEXT NOT NULL, recovery_60s_drop INTEGER)`)
    raw.run(`INSERT INTO live_sessions VALUES ('2026-01-05T09:00:00.000Z',
      '2026-01-05T09:09:00.000Z', 'feed_drop', 540, 117, 149, '[0,100,300,140,0,0]', NULL)`)
    raw.close()

    const store = new Store(path)
    const row = store.db.query('SELECT * FROM live_sessions').get() as Record<string, unknown>
    expect(row.avg_bpm).toBe(117) // legacy data survives
    expect(row.confidence).toBeNull() // new columns exist, unstamped
    expect(row.demoted).toBeNull()
    expect(row.corroborated).toBeNull()
    expect(store.getMeta('schema_version')).toBe('2')
    // Re-open: migration is idempotent.
    store.close()
    const again = new Store(path)
    expect((again.db.query('SELECT * FROM live_sessions').get() as Record<string, unknown>).avg_bpm).toBe(117)
    again.close()
  })
})

describe('live_sessions persistence semantics', () => {
  const base = {
    started_at: '2026-01-05T09:00:00.000Z',
    ended_at: '2026-01-05T09:09:00.000Z',
    reason: 'feed_drop',
    duration_s: 540,
    avg_bpm: 117,
    max_bpm: 149,
    zone_seconds: [0, 100, 300, 140, 0, 0],
    recovery_60s_drop: null,
  }

  test('booleans round-trip as 0/1 and the confidence fields persist', () => {
    const store = new Store(':memory:')
    store.insertLiveSession({
      ...base,
      confidence: 'low',
      demoted: true,
      intent_matched: false,
      rr_presence: 0.82,
      rr_consistency: 0.97,
    })
    const row = store.db.query('SELECT * FROM live_sessions').get() as Record<string, unknown>
    expect(row.confidence).toBe('low')
    expect(row.demoted).toBe(1)
    expect(row.intent_matched).toBe(0)
    expect(row.rr_presence).toBe(0.82)
    expect(row.rr_consistency).toBe(0.97)
  })

  test('a corroborated stamp survives a re-insert of the same session', () => {
    const store = new Store(':memory:')
    store.insertLiveSession({ ...base, confidence: 'low', demoted: true })
    store.corroborateLiveSessions('2026-01-05T08:55:00.000Z', '2026-01-05T09:30:00.000Z')
    // Re-insert (an upsert of the same started_at) must not wipe the stamp.
    store.insertLiveSession({ ...base, confidence: 'low', demoted: true })
    const row = store.db.query('SELECT corroborated FROM live_sessions').get() as { corroborated: number }
    expect(row.corroborated).toBe(1)
  })

  test('corroborated can be set at insert time (reverse lookup path)', () => {
    const store = new Store(':memory:')
    store.insertLiveSession({ ...base, corroborated: true })
    const row = store.db.query('SELECT corroborated FROM live_sessions').get() as { corroborated: number }
    expect(row.corroborated).toBe(1)
  })

  test('corroborateLiveSessions only touches overlapping windows', () => {
    const store = new Store(':memory:')
    store.insertLiveSession(base)
    const n = store.corroborateLiveSessions('2026-01-05T12:00:00.000Z', '2026-01-05T13:00:00.000Z')
    expect(n).toBe(0)
    const row = store.db.query('SELECT corroborated FROM live_sessions').get() as { corroborated: number | null }
    expect(row.corroborated).toBeNull()
  })

  test('hasScoredWorkoutOverlapping matches scored overlaps only', () => {
    const store = new Store(':memory:')
    store.db.run(
      `INSERT INTO workouts (id, start, end, score_state, updated_at, created_at)
       VALUES ('w1', '2026-01-05T08:55:00.000Z', '2026-01-05T09:30:00.000Z', 'SCORED', 't', 't'),
              ('w2', '2026-01-05T06:00:00.000Z', '2026-01-05T06:30:00.000Z', 'SCORED', 't', 't'),
              ('w3', '2026-01-05T08:55:00.000Z', '2026-01-05T09:30:00.000Z', 'PENDING_SCORE', 't', 't')`,
    )
    expect(store.hasScoredWorkoutOverlapping('2026-01-05T09:00:00.000Z', '2026-01-05T09:09:00.000Z')).toBe(true)
    expect(store.hasScoredWorkoutOverlapping('2026-01-05T07:00:00.000Z', '2026-01-05T07:30:00.000Z')).toBe(false)
    store.db.run(`DELETE FROM workouts WHERE id = 'w1'`)
    // Only the PENDING_SCORE overlap remains: not corroborating evidence.
    expect(store.hasScoredWorkoutOverlapping('2026-01-05T09:00:00.000Z', '2026-01-05T09:09:00.000Z')).toBe(false)
  })
})
