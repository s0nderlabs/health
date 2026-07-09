// Wake release: WHOOP scores a sleep ~2 minutes after the band detects the
// user woke, so the arrival of a freshly-ended, scored, non-nap sleep (or the
// recovery keyed to it) IS wake detection. Quiet hours should not hold the
// morning brief past that moment; the hold lifts for the rest of the current
// window and re-arms when the next window starts.

import type { Fact } from './poller.js'
import type { HealthConfig, WhoopRecovery, WhoopSleep } from './types.js'

// A sleep that ended longer ago than this is history (an app edit, a poller
// re-fetch), not a wake. Generous enough to survive a missed webhook + one
// poll cycle after waking.
export const WAKE_FRESH_MS = 45 * 60_000

// A wake only lifts the hold near the END of the quiet window (the MORNING
// wake). A fragmented night can close and score a 2:30am sleep segment; that
// must not flush every queued event while the user is getting back to bed.
export const WAKE_RELEASE_TAIL_MS = 3 * 3_600_000

/** Does this fact prove the user just woke up? */
export function isWakeSignal(
  fact: Fact,
  getSleepById: (id: string) => Record<string, unknown> | null,
  now = Date.now(),
): boolean {
  let end: string | null
  let nap: boolean
  if (fact.kind === 'sleep') {
    const s = fact.record as WhoopSleep
    if (s.score_state !== 'SCORED') return false
    end = s.end
    nap = s.nap
  } else if (fact.kind === 'recovery') {
    const r = fact.record as WhoopRecovery
    if (r.score_state !== 'SCORED') return false
    const s = getSleepById(r.sleep_id)
    if (!s) return false
    end = (s.end as string | null) ?? null
    nap = !!s.nap
  } else {
    return false
  }
  if (nap || !end) return false
  const age = now - Date.parse(end)
  return age >= 0 && age < WAKE_FRESH_MS
}

/**
 * Should a recorded wake lift the quiet-hours hold right now? True only when
 * the wake falls inside the CURRENT window (so this morning's wake never
 * unlocks tonight's) AND within the final stretch before the window ends (so
 * a scored mid-night sleep fragment never flushes events at 2:30am).
 */
export function wakeReleaseActive(
  config: HealthConfig,
  wakeAtIso: string | null,
  now = new Date(),
): boolean {
  const qh = config.quiet_hours
  if (!qh?.start || !qh.end || qh.wake_release === false || !wakeAtIso) return false
  const wakeAt = Date.parse(wakeAtIso)
  if (Number.isNaN(wakeAt) || wakeAt > now.getTime()) return false
  const [startH, startM] = qh.start.split(':').map(Number)
  const windowStart = new Date(now)
  windowStart.setHours(startH, startM, 0, 0)
  // Inside an overnight window, after midnight the start was yesterday.
  if (windowStart.getTime() > now.getTime()) windowStart.setDate(windowStart.getDate() - 1)
  if (wakeAt < windowStart.getTime()) return false
  const [endH, endM] = qh.end.split(':').map(Number)
  const windowEnd = new Date(windowStart)
  windowEnd.setHours(endH, endM, 0, 0)
  if (windowEnd.getTime() <= windowStart.getTime()) windowEnd.setDate(windowEnd.getDate() + 1)
  return wakeAt >= windowEnd.getTime() - WAKE_RELEASE_TAIL_MS
}
