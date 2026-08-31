// The Strava ride watcher: turns a webhook pointer (or reconcile discovery)
// into ONE ride.landed event, guards the rename PUT, runs the deterministic
// fallback when no session answers, and swallows our own webhook echo.
//
// Ownership rules, in priority order (the polite-tenant contract):
//   1. A title the OWNER typed is never touched, and once he renames anything
//      by hand that activity is hands-off forever (owner_named).
//   2. Only Strava's generic auto-names are ever replaced, only on rides, and
//      a WHOOP-pushed activity is never renamed OR announced.
//   3. The description is only ever written into an empty field (or over one
//      we wrote ourselves).
//   4. The in-session composition (Claude) is the product; the fallback title
//      exists so nothing stays "Morning Ride" overnight when no session is up.

import type { Store } from './store.js'
import type { StravaActivity, StravaWebhookEvent } from './types.js'
import {
  assertPublicText,
  fallbackTitle,
  fmtRideDuration,
  isGenericRideName,
  isRideType,
  isWhoopSourced,
  prepareDescription,
  StravaNotFoundError,
  type PlanRide,
  type StravaApi,
} from './strava.js'

/** How long a ride may sit unannotated before the deterministic fallback
 *  names it. Long enough for a live session to compose, short enough that a
 *  ride never spends the evening as "Morning Ride". */
export const FALLBACK_AFTER_MS = 30 * 60_000

export interface StravaWatchDeps {
  api: StravaApi
  store: Store
  emit: (dedupeKey: string, payload: { content: string; meta: Record<string, string> }) => void
  /** Today's planned ride when the given ride start falls on the plan's date. */
  getPlanRide: (rideStartIso: string) => PlanRide | null
  /** The description sign-off ('' = none). Config, not code: an installer's
   *  activities must never be signed with someone else's handle. */
  getWatermark: () => string
  log?: (msg: string) => void
}

export class StravaWatch {
  constructor(private deps: StravaWatchDeps) {}

  // One flight per background loop. Both can be parked seconds-to-minutes on
  // a rate-limited request, which is exactly when their setIntervals fire
  // again; without the guard, stacked ticks fetch and PUT the same rows.
  private fallbackRunning = false
  private reconcileRunning = false

  private log(msg: string): void {
    this.deps.log?.(`strava-watch: ${msg}`)
  }

  /** Webhook entry point. Never throws (callers fire-and-forget post-ack). */
  async onWebhookEvent(e: StravaWebhookEvent): Promise<void> {
    try {
      if (e.object_type !== 'activity') {
        if (e.updates?.authorized === 'false') this.log('app deauthorized by the athlete')
        return
      }
      if (e.aspect_type === 'create') {
        await this.discover(e.object_id)
        return
      }
      if (e.aspect_type === 'delete') {
        // Deleted on Strava: close our row so the fallback loop stops
        // fetching a 404 every tick for the rest of time.
        if (this.deps.store.getStravaActivity(e.object_id)) {
          this.deps.store.setStravaOwnerNamed(e.object_id)
          this.log(`activity ${e.object_id} deleted on Strava; closed`)
        }
        return
      }
      if (e.aspect_type === 'update' && e.updates && 'title' in e.updates) {
        const row = this.deps.store.getStravaActivity(e.object_id)
        if (!row) return // an activity we never tracked
        if (e.updates.title === row.our_title) return // our own PUT echoing back
        // A title change that is not ours = the owner renamed it by hand.
        this.deps.store.setStravaOwnerNamed(e.object_id)
        this.log(`activity ${e.object_id} renamed by owner; hands off from now on`)
      }
    } catch (err) {
      this.log(`webhook event for ${e.object_id} failed: ${err}`)
    }
  }

  /**
   * First contact with an activity id: fetch, apply the announce guards, and
   * emit the ride.landed event. Idempotent by store row (webhook + reconcile
   * can race; the second caller sees stravaSeen and stops).
   */
  async discover(id: number): Promise<void> {
    const { store, api } = this.deps
    if (store.stravaSeen(id)) return
    const a = await api.getActivity(id)
    store.insertStravaActivity({
      id: a.id,
      start: a.start_date ?? null,
      sport_type: a.sport_type,
      name_at_discovery: a.name,
    })

    if (!isRideType(a) || isWhoopSourced(a)) {
      // Seen (so reconcile stops refetching) but permanently hands-off.
      store.setStravaOwnerNamed(a.id)
      return
    }
    if (!isGenericRideName(a.name)) {
      // He named it on his own already: still announce (the loop-closing
      // signal is the point), but never let the fallback near the title.
      store.setStravaOwnerNamed(a.id)
    }

    this.emitRideLanded(a)
  }

  private emitRideLanded(a: StravaActivity): void {
    const { store, emit, getPlanRide } = this.deps
    const startMs = Date.parse(a.start_date)
    const endMs = startMs + a.elapsed_time * 1000
    let matches: Array<Record<string, unknown>> = []
    if (Number.isFinite(startMs)) {
      matches = store.whoopCyclingOverlapping(
        new Date(startMs - 10 * 60_000).toISOString(),
        new Date(endMs + 10 * 60_000).toISOString(),
      )
    }

    const km = (a.distance / 1000).toFixed(1)
    const dur = fmtRideDuration(a.moving_time)
    const speed = a.average_speed ? ` avg ${(a.average_speed * 3.6).toFixed(1)}km/h,` : ''
    const hr =
      a.average_heartrate != null
        ? ` HR avg ${Math.round(a.average_heartrate)}${a.max_heartrate != null ? ` max ${Math.round(a.max_heartrate)}` : ''},`
        : ''
    const climb = a.total_elevation_gain ? ` +${Math.round(a.total_elevation_gain)}m,` : ''
    const plan = getPlanRide(a.start_date)
    const planLine = plan?.title ? ` Today's planned ride: "${plan.title}".` : ''
    const whoopLine = matches.length
      ? ` Overlaps ${matches.length} scored WHOOP cycling record${matches.length > 1 ? 's' : ''} (strain ${matches
          .map((m) => (typeof m.strain === 'number' ? (m.strain as number).toFixed(1) : '?'))
          .join(', ')}): the session has now landed from BOTH sources.`
      : ' No scored WHOOP cycling record overlaps yet (its card may still be pending).'

    emit(`ride.landed:${a.id}`, {
      content:
        `Ride landed on Strava as "${a.name}": ${km}km in ${dur},${speed}${hr}${climb} started ${a.start_date}.` +
        planLine +
        whoopLine +
        ` Compose the real title and description now (plan vocabulary, honest about what was actually ridden, no raw WHOOP physiology in the public description) and write them with health__strava activity_id=${a.id}. Only Strava's generic auto-name gets replaced and only an empty description gets filled; the daemon enforces both.`,
      meta: {
        class: 'ride.landed',
        activity_id: String(a.id),
        sport_type: a.sport_type,
        name: a.name,
        distance_km: km,
        moving_min: String(Math.round(a.moving_time / 60)),
        whoop_matched: matches.length ? 'true' : 'false',
        ...(plan?.title ? { plan_title: plan.title } : {}),
      },
    })
  }

  /**
   * Sweep recent activities for anything the webhook missed. The FIRST sweep
   * ever (no armed-at watermark yet) only SEEDS: pre-existing history is
   * recorded as seen and hands-off, never announced or renamed. The same
   * "never replay history as fresh events" invariant the WHOOP side enforces
   * with its backfill gate.
   */
  async reconcile(windowDays = 3): Promise<number> {
    if (this.reconcileRunning) return 0
    this.reconcileRunning = true
    try {
      const { api, store } = this.deps
      const after = Math.floor((Date.now() - windowDays * 86_400_000) / 1000)
      const list = await api.listActivitiesAfter(after)
      if (!store.getMeta('strava_armed_at')) {
        for (const a of list) {
          if (store.stravaSeen(a.id)) continue
          store.insertStravaActivity({
            id: a.id,
            start: a.start_date ?? null,
            sport_type: a.sport_type,
            name_at_discovery: a.name,
          })
          store.setStravaOwnerNamed(a.id)
        }
        store.setMeta('strava_armed_at', new Date().toISOString())
        this.log(`armed: seeded ${list.length} pre-existing activities as hands-off`)
        return 0
      }
      let discovered = 0
      for (const a of list) {
        if (store.stravaSeen(a.id)) continue
        try {
          await this.discover(a.id)
          discovered++
        } catch (err) {
          this.log(`reconcile discover ${a.id} failed: ${err}`)
        }
      }
      return discovered
    } finally {
      this.reconcileRunning = false
    }
  }

  /** Name anything a session never got to. Re-fetches before writing: the
   *  guard must hold against the LIVE title, not a half-hour-old snapshot. */
  async fallbackTick(now = Date.now()): Promise<void> {
    if (this.fallbackRunning) return
    this.fallbackRunning = true
    try {
      const { store, api, getPlanRide } = this.deps
      const cutoff = new Date(now - FALLBACK_AFTER_MS).toISOString()
      for (const { id } of store.stravaPendingFallback(cutoff)) {
        try {
          const a = await api.getActivity(id)
          if (!isRideType(a) || isWhoopSourced(a)) {
            store.setStravaOwnerNamed(id)
            continue
          }
          if (!isGenericRideName(a.name)) {
            store.setStravaOwnerNamed(id) // renamed out from under us: his
            continue
          }
          let title = fallbackTitle(a, getPlanRide(a.start_date))
          try {
            assertPublicText(title, 'fallback title')
          } catch {
            // A plan title tripping the public filter falls back to plain
            // facts rather than blocking the rename forever.
            title = fallbackTitle(a, null)
          }
          await api.updateActivity(id, { name: title })
          store.setStravaAnnotation(id, { our_title: title, annotated_by: 'fallback' })
          this.log(`fallback-renamed ${id} to "${title}"`)
        } catch (err) {
          if (err instanceof StravaNotFoundError) {
            // Deleted (or made invisible) on Strava: close the row instead of
            // burning a rate-limited fetch on it every tick forever.
            store.setStravaOwnerNamed(id)
            this.log(`fallback for ${id}: gone on Strava, closed`)
            continue
          }
          this.log(`fallback for ${id} failed (will retry next tick): ${err}`)
        }
      }
    } finally {
      this.fallbackRunning = false
    }
  }

  /**
   * The session's write path (health__strava). Applies the same guards
   * against the LIVE activity and reports exactly what happened. Every
   * connected session receives the same ride.landed, so the first session
   * to write wins: a later session's write is a no-op unless it passes
   * `overwrite` (deliberate revision, not a race).
   */
  async annotate(
    id: number,
    patch: { title?: string; description?: string; overwrite?: boolean },
  ): Promise<{ renamed: boolean; described: boolean; notes: string[] }> {
    const { store, api } = this.deps
    const row = store.getStravaActivity(id)
    if (!row) {
      throw new Error(
        `activity ${id} is not tracked (no ride.landed was emitted for it); refusing to write blind`,
      )
    }
    if (row.annotated_by === 'session' && !patch.overwrite) {
      return {
        renamed: false,
        described: false,
        notes: [
          'already composed by a session; pass overwrite=true only for a deliberate revision (another connected session likely answered the same ride.landed first)',
        ],
      }
    }
    const a = await api.getActivity(id)
    // The announce guards, re-checked at write time: reconcile also seeds
    // rows for lifts and WHOOP-pushed activities, and none of those may ever
    // be written to, description included.
    if (!isRideType(a) || isWhoopSourced(a)) {
      throw new Error(`activity ${id} is not an annotatable ride (type/source guard); nothing written`)
    }
    const notes: string[] = []
    const put: { name?: string; description?: string } = {}

    const title = patch.title?.trim()
    if (title) {
      // Same never-public filter as descriptions: the ride.landed event
      // itself hands the composer WHOOP numbers, and a title is just as
      // public as a description.
      assertPublicText(title, 'title')
      // Writable when the live title is still Strava's generic one, or is a
      // title WE wrote earlier (session revision over the fallback is fine).
      if (isGenericRideName(a.name) || (row.our_title != null && a.name === row.our_title)) {
        if (row.owner_named && !(row.our_title != null && a.name === row.our_title)) {
          notes.push(`title NOT written: the owner named this activity himself ("${a.name}")`)
        } else {
          put.name = title
        }
      } else {
        notes.push(`title NOT written: current title "${a.name}" is not a generic auto-name`)
      }
    }

    const description = patch.description?.trim()
    if (description) {
      // Hands-off is hands-off for BOTH fields: an owner-claimed activity
      // never gets our description either (unless revising one we wrote).
      if (row.owner_named && !row.desc_written) {
        notes.push('description NOT written: this activity is owner-claimed (hands-off)')
      } else if ((a.description ?? '').trim() === '' || row.desc_written) {
        // prepareDescription throws on never-public terms and appends the
        // configured watermark, so neither depends on any session's memory.
        put.description = prepareDescription(description, this.deps.getWatermark())
      } else {
        notes.push('description NOT written: the activity already has one we did not write')
      }
    }

    if (!put.name && !put.description) {
      return { renamed: false, described: false, notes: notes.length ? notes : ['nothing to write'] }
    }

    await api.updateActivity(id, put)
    store.setStravaAnnotation(id, {
      our_title: put.name,
      desc_written: !!put.description,
      annotated_by: 'session',
    })
    return { renamed: !!put.name, described: !!put.description, notes }
  }
}
