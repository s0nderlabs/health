// SQLite store: the permanent local archive of everything WHOOP has produced,
// plus the daemon's event queue. Single writer (the daemon); the MCP server
// may open read-only as a fallback when the daemon is unreachable.

import { Database } from 'bun:sqlite'
import { DB_PATH, ensureRuntimeDir } from './config.js'
import type {
  EventClass,
  HealthEvent,
  WhoopBodyMeasurement,
  WhoopCycle,
  WhoopProfile,
  WhoopRecovery,
  WhoopSleep,
  WhoopWorkout,
} from './types.js'

export type FactKind = 'cycle' | 'sleep' | 'recovery' | 'workout'

export interface UpsertResult {
  changed: boolean
  isNew: boolean
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS profile (
  user_id INTEGER PRIMARY KEY,
  email TEXT, first_name TEXT, last_name TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS body (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  height_meter REAL, weight_kilogram REAL, max_heart_rate INTEGER,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS cycles (
  id INTEGER PRIMARY KEY,
  start TEXT, end TEXT, timezone_offset TEXT, score_state TEXT,
  strain REAL, kilojoule REAL, average_heart_rate INTEGER, max_heart_rate INTEGER,
  raw TEXT, created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS sleeps (
  id TEXT PRIMARY KEY,
  start TEXT, end TEXT, timezone_offset TEXT, nap INTEGER, score_state TEXT,
  performance_pct REAL, consistency_pct REAL, efficiency_pct REAL,
  in_bed_milli INTEGER, awake_milli INTEGER, light_milli INTEGER,
  sws_milli INTEGER, rem_milli INTEGER, no_data_milli INTEGER,
  sleep_cycle_count INTEGER, disturbance_count INTEGER,
  need_baseline_milli INTEGER, need_debt_milli INTEGER,
  need_strain_milli INTEGER, need_nap_milli INTEGER,
  respiratory_rate REAL,
  raw TEXT, created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS recoveries (
  sleep_id TEXT PRIMARY KEY,
  cycle_id INTEGER, score_state TEXT, user_calibrating INTEGER,
  recovery_score REAL, resting_heart_rate REAL, hrv_rmssd_milli REAL,
  spo2_percentage REAL, skin_temp_celsius REAL,
  raw TEXT, created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS workouts (
  id TEXT PRIMARY KEY,
  sport_name TEXT, sport_id INTEGER, start TEXT, end TEXT,
  timezone_offset TEXT, score_state TEXT,
  strain REAL, average_heart_rate INTEGER, max_heart_rate INTEGER,
  kilojoule REAL, percent_recorded REAL, distance_meter REAL,
  zone_durations TEXT,
  raw TEXT, created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class TEXT NOT NULL,
  priority TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  content TEXT NOT NULL,
  meta TEXT NOT NULL,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  expired_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_undelivered ON events (created_at) WHERE delivered_at IS NULL AND expired_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_cycles_start ON cycles (start);
CREATE INDEX IF NOT EXISTS idx_sleeps_end ON sleeps (end);
CREATE INDEX IF NOT EXISTS idx_workouts_start ON workouts (start);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
`

export class Store {
  readonly db: Database

  constructor(path = DB_PATH, readonly_ = false) {
    if (!readonly_) ensureRuntimeDir()
    this.db = new Database(path, readonly_ ? { readonly: true } : { create: true })
    if (!readonly_) {
      this.db.run('PRAGMA journal_mode = WAL')
      this.db.run(SCHEMA)
      if (!this.getMeta('schema_version')) this.setMeta('schema_version', '1')
    }
  }

  close(): void {
    this.db.close()
  }

  // ── meta ──────────────────────────────────────────────────────

  getMeta(key: string): string | null {
    const row = this.db.query('SELECT value FROM meta WHERE key = ?').get(key) as
      | { value: string }
      | null
    return row?.value ?? null
  }

  setMeta(key: string, value: string): void {
    this.db.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value])
  }

  // ── upserts (dedupe by id + updated_at) ───────────────────────

  private shouldWrite(table: string, pk: string, id: string | number, updatedAt: string): UpsertResult {
    const row = this.db.query(`SELECT updated_at FROM ${table} WHERE ${pk} = ?`).get(id) as
      | { updated_at: string }
      | null
    if (!row) return { changed: true, isNew: true }
    return { changed: updatedAt > row.updated_at, isNew: false }
  }

  upsertProfile(p: WhoopProfile): void {
    this.db.run(
      `INSERT INTO profile (user_id, email, first_name, last_name, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET email=excluded.email, first_name=excluded.first_name,
         last_name=excluded.last_name, updated_at=excluded.updated_at`,
      [p.user_id, p.email, p.first_name, p.last_name, new Date().toISOString()],
    )
  }

  upsertBody(b: WhoopBodyMeasurement): boolean {
    const prev = this.db.query('SELECT height_meter, weight_kilogram, max_heart_rate FROM body WHERE id = 1').get() as
      | { height_meter: number; weight_kilogram: number; max_heart_rate: number }
      | null
    const changed =
      !prev ||
      prev.height_meter !== b.height_meter ||
      prev.weight_kilogram !== b.weight_kilogram ||
      prev.max_heart_rate !== b.max_heart_rate
    this.db.run(
      `INSERT INTO body (id, height_meter, weight_kilogram, max_heart_rate, updated_at)
       VALUES (1, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET height_meter=excluded.height_meter,
         weight_kilogram=excluded.weight_kilogram, max_heart_rate=excluded.max_heart_rate,
         updated_at=excluded.updated_at`,
      [b.height_meter, b.weight_kilogram, b.max_heart_rate, new Date().toISOString()],
    )
    return changed
  }

  upsertCycle(c: WhoopCycle): UpsertResult {
    const result = this.shouldWrite('cycles', 'id', c.id, c.updated_at)
    if (!result.changed) return result
    this.db.run(
      `INSERT INTO cycles (id, start, end, timezone_offset, score_state, strain, kilojoule,
         average_heart_rate, max_heart_rate, raw, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET start=excluded.start, end=excluded.end,
         timezone_offset=excluded.timezone_offset, score_state=excluded.score_state,
         strain=excluded.strain, kilojoule=excluded.kilojoule,
         average_heart_rate=excluded.average_heart_rate, max_heart_rate=excluded.max_heart_rate,
         raw=excluded.raw, updated_at=excluded.updated_at`,
      [
        c.id, c.start, c.end, c.timezone_offset, c.score_state,
        c.score?.strain ?? null, c.score?.kilojoule ?? null,
        c.score?.average_heart_rate ?? null, c.score?.max_heart_rate ?? null,
        JSON.stringify(c), c.created_at, c.updated_at,
      ],
    )
    return result
  }

  upsertSleep(s: WhoopSleep): UpsertResult {
    const result = this.shouldWrite('sleeps', 'id', s.id, s.updated_at)
    if (!result.changed) return result
    const sc = s.score
    this.db.run(
      `INSERT INTO sleeps (id, start, end, timezone_offset, nap, score_state,
         performance_pct, consistency_pct, efficiency_pct,
         in_bed_milli, awake_milli, light_milli, sws_milli, rem_milli, no_data_milli,
         sleep_cycle_count, disturbance_count,
         need_baseline_milli, need_debt_milli, need_strain_milli, need_nap_milli,
         respiratory_rate, raw, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET start=excluded.start, end=excluded.end,
         timezone_offset=excluded.timezone_offset, nap=excluded.nap,
         score_state=excluded.score_state, performance_pct=excluded.performance_pct,
         consistency_pct=excluded.consistency_pct, efficiency_pct=excluded.efficiency_pct,
         in_bed_milli=excluded.in_bed_milli, awake_milli=excluded.awake_milli,
         light_milli=excluded.light_milli, sws_milli=excluded.sws_milli,
         rem_milli=excluded.rem_milli, no_data_milli=excluded.no_data_milli,
         sleep_cycle_count=excluded.sleep_cycle_count, disturbance_count=excluded.disturbance_count,
         need_baseline_milli=excluded.need_baseline_milli, need_debt_milli=excluded.need_debt_milli,
         need_strain_milli=excluded.need_strain_milli, need_nap_milli=excluded.need_nap_milli,
         respiratory_rate=excluded.respiratory_rate, raw=excluded.raw, updated_at=excluded.updated_at`,
      [
        s.id, s.start, s.end, s.timezone_offset, s.nap ? 1 : 0, s.score_state,
        sc?.sleep_performance_percentage ?? null, sc?.sleep_consistency_percentage ?? null,
        sc?.sleep_efficiency_percentage ?? null,
        sc?.stage_summary.total_in_bed_time_milli ?? null, sc?.stage_summary.total_awake_time_milli ?? null,
        sc?.stage_summary.total_light_sleep_time_milli ?? null, sc?.stage_summary.total_slow_wave_sleep_time_milli ?? null,
        sc?.stage_summary.total_rem_sleep_time_milli ?? null, sc?.stage_summary.total_no_data_time_milli ?? null,
        sc?.stage_summary.sleep_cycle_count ?? null, sc?.stage_summary.disturbance_count ?? null,
        sc?.sleep_needed.baseline_milli ?? null, sc?.sleep_needed.need_from_sleep_debt_milli ?? null,
        sc?.sleep_needed.need_from_recent_strain_milli ?? null, sc?.sleep_needed.need_from_recent_nap_milli ?? null,
        sc?.respiratory_rate ?? null, JSON.stringify(s), s.created_at, s.updated_at,
      ],
    )
    return result
  }

  upsertRecovery(r: WhoopRecovery): UpsertResult {
    const result = this.shouldWrite('recoveries', 'sleep_id', r.sleep_id, r.updated_at)
    if (!result.changed) return result
    this.db.run(
      `INSERT INTO recoveries (sleep_id, cycle_id, score_state, user_calibrating,
         recovery_score, resting_heart_rate, hrv_rmssd_milli, spo2_percentage, skin_temp_celsius,
         raw, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(sleep_id) DO UPDATE SET cycle_id=excluded.cycle_id,
         score_state=excluded.score_state, user_calibrating=excluded.user_calibrating,
         recovery_score=excluded.recovery_score, resting_heart_rate=excluded.resting_heart_rate,
         hrv_rmssd_milli=excluded.hrv_rmssd_milli, spo2_percentage=excluded.spo2_percentage,
         skin_temp_celsius=excluded.skin_temp_celsius, raw=excluded.raw, updated_at=excluded.updated_at`,
      [
        r.sleep_id, r.cycle_id, r.score_state, r.score?.user_calibrating ? 1 : 0,
        r.score?.recovery_score ?? null, r.score?.resting_heart_rate ?? null,
        r.score?.hrv_rmssd_milli ?? null, r.score?.spo2_percentage ?? null,
        r.score?.skin_temp_celsius ?? null, JSON.stringify(r), r.created_at, r.updated_at,
      ],
    )
    return result
  }

  upsertWorkout(w: WhoopWorkout): UpsertResult {
    const result = this.shouldWrite('workouts', 'id', w.id, w.updated_at)
    if (!result.changed) return result
    this.db.run(
      `INSERT INTO workouts (id, sport_name, sport_id, start, end, timezone_offset, score_state,
         strain, average_heart_rate, max_heart_rate, kilojoule, percent_recorded, distance_meter,
         zone_durations, raw, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET sport_name=excluded.sport_name, sport_id=excluded.sport_id,
         start=excluded.start, end=excluded.end, timezone_offset=excluded.timezone_offset,
         score_state=excluded.score_state, strain=excluded.strain,
         average_heart_rate=excluded.average_heart_rate, max_heart_rate=excluded.max_heart_rate,
         kilojoule=excluded.kilojoule, percent_recorded=excluded.percent_recorded,
         distance_meter=excluded.distance_meter, zone_durations=excluded.zone_durations,
         raw=excluded.raw, updated_at=excluded.updated_at`,
      [
        w.id, w.sport_name, w.sport_id, w.start, w.end, w.timezone_offset, w.score_state,
        w.score?.strain ?? null, w.score?.average_heart_rate ?? null, w.score?.max_heart_rate ?? null,
        w.score?.kilojoule ?? null, w.score?.percent_recorded ?? null, w.score?.distance_meter ?? null,
        JSON.stringify(w.score?.zone_durations ?? null), JSON.stringify(w), w.created_at, w.updated_at,
      ],
    )
    return result
  }

  deleteRecord(kind: FactKind, id: string | number): boolean {
    const table = kind === 'recovery' ? 'recoveries' : `${kind}s`
    const pk = kind === 'recovery' ? 'sleep_id' : 'id'
    const before = this.db.query(`SELECT 1 FROM ${table} WHERE ${pk} = ?`).get(id)
    if (!before) return false
    this.db.run(`DELETE FROM ${table} WHERE ${pk} = ?`, [id])
    return true
  }

  // ── read queries (the /health surface) ────────────────────────

  latestRecovery(): Record<string, unknown> | null {
    return this.db.query('SELECT * FROM recoveries ORDER BY created_at DESC LIMIT 1').get() as Record<string, unknown> | null
  }

  latestSleep(napOk = false): Record<string, unknown> | null {
    return this.db
      .query(`SELECT * FROM sleeps ${napOk ? '' : 'WHERE nap = 0'} ORDER BY end DESC LIMIT 1`)
      .get() as Record<string, unknown> | null
  }

  latestCycle(): Record<string, unknown> | null {
    return this.db.query('SELECT * FROM cycles ORDER BY start DESC LIMIT 1').get() as Record<string, unknown> | null
  }

  recentRecoveries(days: number): Record<string, unknown>[] {
    const since = new Date(Date.now() - days * 86_400_000).toISOString()
    return this.db
      .query('SELECT * FROM recoveries WHERE created_at >= ? ORDER BY created_at ASC')
      .all(since) as Record<string, unknown>[]
  }

  recentSleeps(days: number): Record<string, unknown>[] {
    const since = new Date(Date.now() - days * 86_400_000).toISOString()
    return this.db
      .query('SELECT * FROM sleeps WHERE end >= ? AND nap = 0 ORDER BY end ASC')
      .all(since) as Record<string, unknown>[]
  }

  recentWorkouts(days: number): Record<string, unknown>[] {
    const since = new Date(Date.now() - days * 86_400_000).toISOString()
    return this.db
      .query('SELECT * FROM workouts WHERE start >= ? ORDER BY start ASC')
      .all(since) as Record<string, unknown>[]
  }

  recentCycles(days: number): Record<string, unknown>[] {
    const since = new Date(Date.now() - days * 86_400_000).toISOString()
    return this.db
      .query('SELECT * FROM cycles WHERE start >= ? ORDER BY start ASC')
      .all(since) as Record<string, unknown>[]
  }

  getSleepById(id: string): Record<string, unknown> | null {
    return this.db.query('SELECT * FROM sleeps WHERE id = ?').get(id) as Record<string, unknown> | null
  }

  counts(): Record<string, number> {
    const one = (table: string) =>
      (this.db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
    return {
      cycles: one('cycles'),
      sleeps: one('sleeps'),
      recoveries: one('recoveries'),
      workouts: one('workouts'),
      events: one('events'),
    }
  }

  maxUpdatedAt(kind: FactKind): string | null {
    const table = kind === 'recovery' ? 'recoveries' : `${kind}s`
    const row = this.db.query(`SELECT MAX(updated_at) AS m FROM ${table}`).get() as { m: string | null }
    return row.m
  }

  // ── event queue ───────────────────────────────────────────────

  /** Insert an event; an undelivered event with the same dedupe_key is superseded (expired). */
  insertEvent(e: HealthEvent): number {
    this.db.run(
      `UPDATE events SET expired_at = ? WHERE dedupe_key = ? AND delivered_at IS NULL AND expired_at IS NULL`,
      [new Date().toISOString(), e.dedupe_key],
    )
    this.db.run(
      `INSERT INTO events (class, priority, dedupe_key, content, meta, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [e.class, e.priority, e.dedupe_key, e.content, JSON.stringify(e.meta), e.created_at],
    )
    return Number(
      (this.db.query('SELECT last_insert_rowid() AS id').get() as { id: number | bigint }).id,
    )
  }

  /** Has an event with this dedupe_key already been DELIVERED? Blocks re-sending the same thing. */
  hasDeliveredEvent(dedupeKey: string): boolean {
    return !!this.db
      .query('SELECT 1 FROM events WHERE dedupe_key = ? AND delivered_at IS NOT NULL LIMIT 1')
      .get(dedupeKey)
  }

  /** Is there an UNDELIVERED, non-expired event with this dedupe_key? (A supersede candidate.) */
  hasUndeliveredEvent(dedupeKey: string): boolean {
    return !!this.db
      .query('SELECT 1 FROM events WHERE dedupe_key = ? AND delivered_at IS NULL AND expired_at IS NULL LIMIT 1')
      .get(dedupeKey)
  }

  lastEventOfClass(cls: EventClass): { created_at: string } | null {
    return this.db
      .query('SELECT created_at FROM events WHERE class = ? AND expired_at IS NULL ORDER BY created_at DESC LIMIT 1')
      .get(cls) as { created_at: string } | null
  }

  deliveredToday(): number {
    const dayStart = new Date()
    dayStart.setHours(0, 0, 0, 0)
    return (
      this.db
        .query('SELECT COUNT(*) AS n FROM events WHERE delivered_at >= ?')
        .get(dayStart.toISOString()) as { n: number }
    ).n
  }

  /**
   * Non-expired events CREATED today (delivered or still queued). The daily
   * budget gates on this, not on deliveries, so events queued while the session
   * is offline or during quiet hours still count. Otherwise a night's worth of
   * queued events would all flush at once, blowing past the budget.
   */
  createdToday(): number {
    const dayStart = new Date()
    dayStart.setHours(0, 0, 0, 0)
    return (
      this.db
        .query('SELECT COUNT(*) AS n FROM events WHERE created_at >= ? AND expired_at IS NULL')
        .get(dayStart.toISOString()) as { n: number }
    ).n
  }

  undeliveredEvents(): (HealthEvent & { id: number })[] {
    const rows = this.db
      .query('SELECT * FROM events WHERE delivered_at IS NULL AND expired_at IS NULL ORDER BY id ASC')
      .all() as Array<Record<string, unknown>>
    return rows.map((r) => ({
      id: r.id as number,
      class: r.class as HealthEvent['class'],
      priority: r.priority as HealthEvent['priority'],
      dedupe_key: r.dedupe_key as string,
      content: r.content as string,
      meta: JSON.parse(r.meta as string),
      created_at: r.created_at as string,
    }))
  }

  markDelivered(id: number): void {
    this.db.run('UPDATE events SET delivered_at = ? WHERE id = ?', [new Date().toISOString(), id])
  }

  /** Expire undelivered events past their per-class max age (hours). */
  expireStale(maxAgeHours: Partial<Record<EventClass, number>>, defaultHours = 24): number {
    let expired = 0
    const now = Date.now()
    for (const e of this.undeliveredEvents()) {
      const limit = (maxAgeHours[e.class] ?? defaultHours) * 3_600_000
      if (now - Date.parse(e.created_at) > limit) {
        this.db.run('UPDATE events SET expired_at = ? WHERE id = ?', [new Date().toISOString(), e.id])
        expired++
      }
    }
    return expired
  }
}
