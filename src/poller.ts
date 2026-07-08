// Reconciliation poller: the pull half of the daemon. First run backfills the
// entire account history; every cycle after that sweeps a trailing window to
// catch missed webhooks and cover cycle/body, which have no webhooks at all.

import * as whoop from './whoop.js'
import type { Store, FactKind } from './store.js'
import type { WhoopCycle, WhoopRecovery, WhoopSleep, WhoopWorkout } from './types.js'

export interface Fact {
  kind: FactKind
  isNew: boolean
  record: WhoopCycle | WhoopSleep | WhoopRecovery | WhoopWorkout
}

export type FactHandler = (fact: Fact) => void

// WHOOP collection endpoints filter by the record's OCCURRENCE time (start/end),
// NOT by updated_at, so a sweep window anchored on updated_at would miss late
// edits/re-scores to older records (their start is old even though updated_at is
// fresh). Instead we re-pull a fixed trailing window by occurrence time every
// sweep; upsert-dedupe makes the unchanged records no-ops. 14 days covers WHOOP's
// re-score/edit horizon with wide margin. Edits to records OLDER than this are
// caught by webhooks (v2); a poll-only (v1) install will not see them, which is
// an accepted limitation of poll-only mode.
const RECONCILE_WINDOW_MS = 14 * 24 * 3_600_000

// Full-history floor for backfill; WHOOP has no earlier consumer data.
const EPOCH = '2015-01-01T00:00:00.000Z'

function log(msg: string): void {
  process.stderr.write(`healthd poller: ${msg}\n`)
}

export async function backfill(store: Store, onFact?: FactHandler): Promise<Record<string, number>> {
  const counts: Record<string, number> = { cycles: 0, sleeps: 0, recoveries: 0, workouts: 0 }
  const params = { start: EPOCH, limit: 25 }

  for await (const c of whoop.paginate(whoop.getCycles, params)) {
    const r = store.upsertCycle(c)
    if (r.changed) { counts.cycles++; onFact?.({ kind: 'cycle', isNew: r.isNew, record: c }) }
  }
  for await (const s of whoop.paginate(whoop.getSleeps, params)) {
    const r = store.upsertSleep(s)
    if (r.changed) { counts.sleeps++; onFact?.({ kind: 'sleep', isNew: r.isNew, record: s }) }
  }
  for await (const rec of whoop.paginate(whoop.getRecoveries, params)) {
    const r = store.upsertRecovery(rec)
    if (r.changed) { counts.recoveries++; onFact?.({ kind: 'recovery', isNew: r.isNew, record: rec }) }
  }
  for await (const w of whoop.paginate(whoop.getWorkouts, params)) {
    const r = store.upsertWorkout(w)
    if (r.changed) { counts.workouts++; onFact?.({ kind: 'workout', isNew: r.isNew, record: w }) }
  }

  store.upsertProfile(await whoop.getProfile())
  store.upsertBody(await whoop.getBodyMeasurement())
  store.setMeta('backfill_done', new Date().toISOString())
  log(`backfill done: ${JSON.stringify(counts)}`)
  return counts
}

/**
 * One reconciliation sweep. Emits every changed record as a fact so the
 * decision engine sees exactly one fact per data change, regardless of
 * whether poll or webhook noticed it first (upsert dedupe guarantees it).
 */
export async function pollOnce(store: Store, onFact: FactHandler): Promise<number> {
  const windowStart = new Date(Date.now() - RECONCILE_WINDOW_MS).toISOString()

  let changes = 0

  for await (const c of whoop.paginate(whoop.getCycles, { start: windowStart, limit: 25 })) {
    const r = store.upsertCycle(c)
    if (r.changed) { changes++; onFact({ kind: 'cycle', isNew: r.isNew, record: c }) }
  }
  for await (const s of whoop.paginate(whoop.getSleeps, { start: windowStart, limit: 25 })) {
    const r = store.upsertSleep(s)
    if (r.changed) { changes++; onFact({ kind: 'sleep', isNew: r.isNew, record: s }) }
  }
  for await (const rec of whoop.paginate(whoop.getRecoveries, { start: windowStart, limit: 25 })) {
    const r = store.upsertRecovery(rec)
    if (r.changed) { changes++; onFact({ kind: 'recovery', isNew: r.isNew, record: rec }) }
  }
  for await (const w of whoop.paginate(whoop.getWorkouts, { start: windowStart, limit: 25 })) {
    const r = store.upsertWorkout(w)
    if (r.changed) { changes++; onFact({ kind: 'workout', isNew: r.isNew, record: w }) }
  }

  // Daily, not every sweep: profile + body have no timestamps worth chasing.
  const lastDaily = store.getMeta('last_daily_pull')
  if (!lastDaily || Date.now() - Date.parse(lastDaily) > 24 * 3_600_000) {
    store.upsertProfile(await whoop.getProfile())
    if (store.upsertBody(await whoop.getBodyMeasurement())) changes++
    store.setMeta('last_daily_pull', new Date().toISOString())
  }

  store.setMeta('last_poll_at', new Date().toISOString())
  return changes
}
