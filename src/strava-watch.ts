// The Strava watcher: turns a webhook pointer (or reconcile discovery) into
// ONE ride.landed or lift.landed event, guards the rename PUT, runs the
// deterministic fallback when no session answers, and swallows our own
// webhook echo.
//
// Ownership rules, in priority order (the polite-tenant contract):
//   1. A title the OWNER typed is never touched, and once he renames anything
//      by hand that activity is hands-off forever (owner_named).
//   2. Only Strava's generic auto-names are ever replaced, and only on two
//      shapes: the cyclo's rides (never WHOOP-pushed) and WHOOP-pushed lift
//      cards. Any other WHOOP-pushed activity is never renamed OR announced.
//   3. The description is only ever written into an empty field, over one we
//      wrote ourselves, or (lifts) over WHOOP's machine-written strain line,
//      which the daemon strips at discovery because it is a privacy leak.
//   4. The in-session composition (Claude) is the product; the fallback title
//      exists so nothing stays "Morning Ride" overnight when no session is up.

import type { Store } from './store.js'
import type { StravaActivity, StravaWebhookEvent } from './types.js'
import {
  assertPublicText,
  fallbackTitle,
  fmtRideDuration,
  isGenericLiftName,
  isGenericRideName,
  isLiftType,
  isRideType,
  isWhoopAutoDescription,
  isWhoopSourced,
  liftDayTitle,
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
  emit: (
    cls: 'ride.landed' | 'lift.landed',
    dedupeKey: string,
    payload: { content: string; meta: Record<string, string> },
  ) => void
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

    if (isLiftType(a) && isWhoopSourced(a)) {
      await this.discoverLift(a)
      return
    }
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

  /**
   * A WHOOP-pushed lift card. Two-stage by design: WHOOP's auto-description
   * publishes his strain, so the daemon strips it SECONDS after upload with
   * no session in the loop, while the real title/description wait, because
   * the card itself carries no sets or loads. The session that coached the
   * lift composes AFTER his debrief; that conversation is the data source.
   */
  private async discoverLift(a: StravaActivity): Promise<void> {
    const { store, api } = this.deps
    let stripped: 'stripped' | 'failed' | 'clean' = 'clean'
    if (isWhoopAutoDescription(a.description)) {
      try {
        await api.updateActivity(a.id, { description: '' })
        stripped = 'stripped'
        this.log(`stripped WHOOP auto-description from lift ${a.id}`)
      } catch (err) {
        stripped = 'failed'
        this.log(`strip for lift ${a.id} failed (fallback re-strips): ${err}`)
      }
    }
    const ownerNamed = !isGenericLiftName(a.name)
    if (ownerNamed && stripped !== 'failed') {
      // He named it in-app already: title is his, forever. On a FAILED strip
      // the row deliberately stays pending instead (setting owner_named here
      // would drop it from stravaPendingFallback and the leak would never be
      // retried); liftFallback re-strips first and applies this policy after.
      store.setStravaOwnerNamed(a.id)
    }
    this.emitLiftLanded(a, stripped, ownerNamed)
  }

  /** Overlapping scored WHOOP workouts for an activity window, as event
   *  prose inputs (shared by the ride and lift emitters). */
  private whoopOverlap(
    a: StravaActivity,
    query: (startIso: string, endIso: string) => Array<Record<string, unknown>>,
  ): { count: number; strains: string } {
    const startMs = Date.parse(a.start_date)
    if (!Number.isFinite(startMs)) return { count: 0, strains: '' }
    const endMs = startMs + a.elapsed_time * 1000
    const matches = query(
      new Date(startMs - 10 * 60_000).toISOString(),
      new Date(endMs + 10 * 60_000).toISOString(),
    )
    return {
      count: matches.length,
      strains: matches
        .map((m) => (typeof m.strain === 'number' ? (m.strain as number).toFixed(1) : '?'))
        .join(', '),
    }
  }

  private emitLiftLanded(
    a: StravaActivity,
    stripped: 'stripped' | 'failed' | 'clean',
    ownerNamed: boolean,
  ): void {
    const { store, emit } = this.deps
    const overlap = this.whoopOverlap(a, (s, e) => store.whoopLiftingOverlapping(s, e))
    const dur = fmtRideDuration(a.elapsed_time)
    const day = liftDayTitle(a.start_date_local)
    const whoopLine = overlap.count
      ? ` Matches ${overlap.count} scored WHOOP strength record${overlap.count > 1 ? 's' : ''} (strain ${overlap.strains}).`
      : ''
    const stripLine =
      stripped === 'stripped'
        ? " The daemon already stripped WHOOP's public strain line."
        : stripped === 'failed'
          ? " WARNING: stripping WHOOP's public strain line FAILED, so it is still live on the public page; the daemon retries within ~35 min, and any health__strava description write also replaces it."
          : ' The card arrived with no WHOOP auto-description.'
    const action = ownerNamed
      ? ' He titled this card himself, so both fields are hands-off: acknowledge only, do not compose or write anything.'
      : ` Do NOT compose from this card alone: it carries no sets or loads. Acknowledge it, wait for his debrief, then compose the title and description per the lift contract and write them with health__strava activity_id=${a.id}.`
    emit('lift.landed', `lift.landed:${a.id}`, {
      content:
        `Lift card landed on Strava as "${a.name}": ${dur}, started ${a.start_date}.` +
        (day ? ` By weekday this is ${day}.` : '') +
        whoopLine +
        stripLine +
        action,
      meta: {
        class: 'lift.landed',
        activity_id: String(a.id),
        sport_type: a.sport_type,
        name: a.name,
        duration_min: String(Math.round(a.elapsed_time / 60)),
        whoop_matched: overlap.count ? 'true' : 'false',
        stripped,
        owner_named: ownerNamed ? 'true' : 'false',
        ...(day ? { day_type: day } : {}),
      },
    })
  }

  private emitRideLanded(a: StravaActivity): void {
    const { store, emit, getPlanRide } = this.deps
    const overlap = this.whoopOverlap(a, (s, e) => store.whoopCyclingOverlapping(s, e))

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
    const whoopLine = overlap.count
      ? ` Overlaps ${overlap.count} scored WHOOP cycling record${overlap.count > 1 ? 's' : ''} (strain ${overlap.strains}): the session has now landed from BOTH sources.`
      : ' No scored WHOOP cycling record overlaps yet (its card may still be pending).'

    emit('ride.landed', `ride.landed:${a.id}`, {
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
        whoop_matched: overlap.count ? 'true' : 'false',
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
          const lift = isLiftType(a) && isWhoopSourced(a)
          if (lift) {
            await this.liftFallback(a)
            continue
          }
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

  /** The lift fallback never invents content: it re-strips a WHOOP
   *  auto-description that survived discovery (rate limit, daemon restart)
   *  and names a still-generic card by its locked weekday day-type. The
   *  strip comes FIRST, before any ownership verdict: an owner-renamed card
   *  still gets its leak killed, then goes hands-off; a lift on a day with
   *  no day-type name just closes, still stripped. The session's later
   *  composition may revise anything we wrote. */
  private async liftFallback(a: StravaActivity): Promise<void> {
    const { store, api } = this.deps
    const put: { name?: string; description?: string } = {}
    if (isWhoopAutoDescription(a.description)) put.description = ''
    if (!isGenericLiftName(a.name)) {
      // Renamed by him (mid-window, or at a discovery whose strip failed):
      // kill any surviving leak, then hands-off forever.
      if (put.description !== undefined) await api.updateActivity(a.id, put)
      store.setStravaOwnerNamed(a.id)
      this.log(
        `lift fallback for ${a.id}: owner-named` +
          (put.description !== undefined ? ', re-stripped description' : ''),
      )
      return
    }
    const title = liftDayTitle(a.start_date_local)
    if (title) put.name = title
    if (put.name !== undefined || put.description !== undefined) {
      await api.updateActivity(a.id, put)
    }
    store.setStravaAnnotation(a.id, { our_title: put.name, annotated_by: 'fallback' })
    this.log(
      `lift fallback for ${a.id}: ${put.name ? `named "${put.name}"` : 'no day-type name'}` +
        (put.description !== undefined ? ', re-stripped description' : ''),
    )
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
    // The announce guards, re-checked at write time. Exactly two writable
    // shapes exist: the cyclo's rides (never WHOOP-pushed) and WHOOP-pushed
    // lift cards. Everything else reconcile ever seeded stays read-only.
    const lift = isLiftType(a) && isWhoopSourced(a)
    if (!lift && (!isRideType(a) || isWhoopSourced(a))) {
      throw new Error(
        `activity ${id} is not an annotatable ride or lift card (type/source guard); nothing written`,
      )
    }
    const generic = lift ? isGenericLiftName(a.name) : isGenericRideName(a.name)
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
      if (generic || (row.our_title != null && a.name === row.our_title)) {
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
      } else if (
        (a.description ?? '').trim() === '' ||
        row.desc_written ||
        (lift && isWhoopAutoDescription(a.description))
      ) {
        // prepareDescription throws on never-public terms and appends the
        // configured watermark, so neither depends on any session's memory.
        put.description = prepareDescription(description, this.deps.getWatermark())
      } else {
        notes.push('description NOT written: the activity already has one we did not write')
      }
    }

    if (lift && put.description === undefined && isWhoopAutoDescription(a.description)) {
      // Never leave the leak behind on our own write: a title-only session
      // write sets annotated_by and drops the row from the fallback list, so
      // the strip must ride along here or nothing would ever retry it.
      put.description = ''
      notes.push("stripped WHOOP's leftover auto-description")
    }

    if (put.name === undefined && put.description === undefined) {
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
