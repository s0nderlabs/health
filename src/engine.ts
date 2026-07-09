// The decision engine: deterministic rules that turn stored facts into queued
// events. Quiet by design; the #1 failure mode this must avoid is alert
// fatigue. Gates fire on multi-day patterns, never single-day dips.

import type { Store } from './store.js'
import type { Fact } from './poller.js'
import type { EventClass, EventPriority, HealthConfig, WhoopCycle, WhoopRecovery, WhoopSleep, WhoopWorkout } from './types.js'
import * as fmt from './format.js'

/** A logged workout intent, claimed once by the workout it best fits. */
interface IntentRow {
  ts: string
  activity: string
  label: string
  pr: boolean
  claimed: boolean
  workout_id?: string
}

export class Engine {
  constructor(
    private store: Store,
    private getConfig: () => HealthConfig,
    private onQueued?: () => void,
  ) {}

  private log(msg: string): void {
    process.stderr.write(`healthd engine: ${msg}\n`)
  }

  /**
   * The filter chain shared by every event: class toggle -> cooldown ->
   * daily budget. (Quiet hours gate DELIVERY, not creation; see daemon.)
   */
  private emit(
    cls: EventClass,
    priority: EventPriority,
    dedupeKey: string,
    payload: { content: string; meta: Record<string, string> },
  ): boolean {
    const config = this.getConfig()

    if (!config.events[cls]) return false
    // Already delivered this exact thing: never re-send it.
    if (this.store.hasDeliveredEvent(dedupeKey)) return false

    // A queued-but-undelivered event with the same key is a SUPERSEDE (e.g. a
    // re-scored recovery refreshing a stale brief). insertEvent expires the old
    // row and enqueues the fresh one; cooldown and budget must not block it,
    // since it replaces a queued item rather than adding a new one.
    const isSupersede = this.store.hasUndeliveredEvent(dedupeKey)

    if (!isSupersede) {
      const cooldownMin = config.cooldown_minutes[cls] ?? 0
      const last = this.store.lastEventOfClass(cls)
      if (last && cooldownMin > 0 && Date.now() - Date.parse(last.created_at) < cooldownMin * 60_000) {
        return false
      }

      // Alerts and user-initiated intents always go through; live.* events
      // are throttled by the live state machine itself (per-session, not
      // per-day). Only automated info/notable events are subject to the daily
      // budget. Count events CREATED today (queued or delivered), so a night
      // of offline/quiet-hours queueing cannot flush past the budget in one burst.
      const budgetExempt = priority === 'alert' || cls === 'workout.intent' || cls.startsWith('live.')
      if (!budgetExempt && this.store.createdToday() >= config.daily_budget) {
        this.log(`budget reached, dropping ${cls} (${dedupeKey})`)
        return false
      }
    }

    this.store.insertEvent({
      class: cls,
      priority,
      dedupe_key: dedupeKey,
      content: payload.content,
      meta: { ...payload.meta, priority },
      created_at: new Date().toISOString(),
    })
    this.log(`queued ${cls} (${dedupeKey})`)
    this.onQueued?.()
    return true
  }

  /** Entry point for every data change, from poller and webhook alike. */
  onFact(fact: Fact): void {
    switch (fact.kind) {
      case 'recovery':
        this.onRecovery(fact.record as WhoopRecovery)
        break
      case 'workout':
        this.onWorkout(fact.record as WhoopWorkout)
        break
      case 'cycle':
        this.onCycle(fact.record as WhoopCycle)
        break
      case 'sleep':
        // Sleep is folded into the recovery brief; no standalone event (quiet).
        break
    }
  }

  private onRecovery(r: WhoopRecovery): void {
    if (r.score_state !== 'SCORED' || !r.score) return

    // One brief per sleep. Supersede handles re-scores that land pre-delivery.
    this.emit('recovery.brief', r.score.recovery_score <= 33 ? 'notable' : 'info',
      `recovery.brief:${r.sleep_id}`, fmt.recoveryBrief(this.store, r))

    if (!r.score.user_calibrating) {
      this.checkVitals(r)
      this.checkTrend()
    } else {
      this.checkCalibrationNote()
    }
  }

  private onWorkout(w: WhoopWorkout): void {
    if (w.score_state !== 'SCORED' || !w.score) return
    const card = fmt.workoutCard(w)
    // Staple the declared intent onto WHOOP's anonymous sport label so the
    // archive entry is self-describing ("Deadlift 1RM Test", pr). Claimed
    // once per intent, closest-to-start, so a cooldown walk or two-a-day can
    // never wear another session's label. A score REVISION re-fires here;
    // the intent is already claimed, so the superseding card keeps the label
    // via meta idempotently rather than re-claiming or dropping it.
    const intent = this.claimIntentFor(w) ?? this.claimedIntentFor(w)
    if (intent) {
      card.content += ` Session: ${intent.label}${intent.pr ? ' (PR attempt)' : ''}.`
      card.meta.intent_label = intent.label
      if (intent.pr) card.meta.intent_pr = 'true'
    }
    this.emit('workout.card', 'info', `workout.card:${w.id}`, card)
  }


  private onCycle(c: WhoopCycle): void {
    const config = this.getConfig()
    const strain = c.score?.strain
    if (strain == null || strain < config.thresholds.strain_notable) return
    const recovery = this.store
      .recentRecoveries(2)
      .filter((r) => r.cycle_id === c.id)
      .map((r) => r.recovery_score as number)[0] ?? null
    this.emit('strain.threshold', 'notable', `strain.threshold:${c.id}`,
      fmt.strainThreshold(c, config.thresholds.strain_notable, recovery))
  }

  /**
   * Early-warning vitals: fires only on a MULTI-DAY pattern:
   * recovery below the floor for N consecutive days AND at least one
   * physiological driver elevated vs the 7-day baseline.
   */
  private checkVitals(current: WhoopRecovery): void {
    const config = this.getConfig()
    const t = config.thresholds
    const recs = this.store
      .recentRecoveries(t.recovery_low_days + 1)
      .filter((r) => r.score_state === 'SCORED')
    if (recs.length < t.recovery_low_days) return

    const lastN = recs.slice(-t.recovery_low_days)
    const allLow = lastN.every((r) => (r.recovery_score as number) <= t.recovery_low)
    if (!allLow) return

    const base = fmt.baselines(this.store, current.sleep_id)
    const drivers: string[] = []
    const s = current.score!

    if (base.rhr7 != null && s.resting_heart_rate > base.rhr7 * (1 + t.rhr_elevated_pct / 100)) {
      drivers.push(`RHR ${Math.round(s.resting_heart_rate)} vs ${base.rhr7.toFixed(0)} baseline`)
    }
    if (base.hrv7 != null && s.hrv_rmssd_milli < base.hrv7 * (1 - t.hrv_drop_pct / 100)) {
      drivers.push(`HRV ${s.hrv_rmssd_milli.toFixed(0)}ms vs ${base.hrv7.toFixed(0)}ms baseline`)
    }
    const sleep = this.store.getSleepById(current.sleep_id)
    if (sleep?.respiratory_rate != null && base.resp7 != null &&
        (sleep.respiratory_rate as number) > base.resp7 + t.resp_rate_elevated) {
      drivers.push(`respiratory rate ${(sleep.respiratory_rate as number).toFixed(1)} vs ${base.resp7.toFixed(1)} baseline`)
    }
    if (drivers.length === 0) return

    drivers.unshift(`recovery <= ${t.recovery_low}% for ${t.recovery_low_days} days`)
    const date = new Date().toISOString().slice(0, 10)
    this.emit('vitals.alert', 'alert', `vitals.alert:${date}`, fmt.vitalsAlert(drivers, date))
  }

  /** 7-day HRV/RHR direction check; needs a real week of scored data. */
  private checkTrend(): void {
    const config = this.getConfig()
    const recs = this.store
      .recentRecoveries(7)
      .filter((r) => r.score_state === 'SCORED' && !(r.user_calibrating as unknown as number))
    if (recs.length < 7) return

    const firstHalf = recs.slice(0, 3)
    const lastHalf = recs.slice(-3)
    const mean = (xs: Record<string, unknown>[], k: string): number =>
      xs.reduce((a, r) => a + (r[k] as number), 0) / xs.length

    const drivers: string[] = []
    const hrvBefore = mean(firstHalf, 'hrv_rmssd_milli')
    const hrvAfter = mean(lastHalf, 'hrv_rmssd_milli')
    if (hrvAfter < hrvBefore * (1 - config.thresholds.hrv_drop_pct / 100)) {
      drivers.push(`HRV sliding ${hrvBefore.toFixed(0)}ms -> ${hrvAfter.toFixed(0)}ms over the week`)
    }
    const rhrBefore = mean(firstHalf, 'resting_heart_rate')
    const rhrAfter = mean(lastHalf, 'resting_heart_rate')
    if (rhrAfter > rhrBefore * (1 + config.thresholds.rhr_elevated_pct / 100)) {
      drivers.push(`RHR climbing ${rhrBefore.toFixed(0)} -> ${rhrAfter.toFixed(0)} over the week`)
    }
    if (drivers.length === 0) return

    const week = new Date().toISOString().slice(0, 10)
    this.emit('trend.alert', 'notable', `trend.alert:${week}`, fmt.trendAlert(drivers, week))
  }

  private checkCalibrationNote(): void {
    const recs = this.store.recentRecoveries(365)
    const daysWorn = recs.length
    // Weekly cadence comes from the class cooldown (10080 min); dedupe per ISO week.
    const week = `${new Date().getFullYear()}-w${Math.ceil((Date.now() - new Date(new Date().getFullYear(), 0, 1).getTime()) / 604_800_000)}`
    this.emit('calibration.note', 'info', `calibration.note:${week}`, fmt.calibrationNote(daysWorn))
  }

  /** Periodic checks not driven by facts. Called every few minutes. */
  tick(): void {
    this.checkBedtime()
    this.store.expireStale({
      'recovery.brief': 20,
      'workout.card': 12,
      'strain.threshold': 12,
      'bedtime.nudge': 3,
      'calibration.note': 72,
      'vitals.alert': 48,
      'trend.alert': 48,
      'system.health': 24,
      // Live events are moment-bound: a zone milestone from hours ago is noise.
      'live.session': 1,
      'live.zone': 1,
      'live.rest': 6,
    })
  }

  private checkBedtime(): void {
    const now = new Date()
    const minutes = now.getHours() * 60 + now.getMinutes()
    if (minutes < 21 * 60 + 30 || minutes > 23 * 60) return // 21:30-23:00 window

    const sleep = this.store.latestSleep()
    if (!sleep || sleep.need_debt_milli == null) return
    const debt = sleep.need_debt_milli as number
    if (debt < 45 * 60_000) return // real debt only; quiet otherwise

    const date = new Date().toISOString().slice(0, 10)
    this.emit('bedtime.nudge', 'info', `bedtime.nudge:${date}`,
      fmt.bedtimeNudge(debt, sleep.performance_pct as number | null))
  }

  systemProblem(problem: string, dedupeKey: string): void {
    this.emit('system.health', 'notable', `system.health:${dedupeKey}`, fmt.systemHealth(problem))
  }

  /** Entry point for the live HR state machine (pre-throttled per-session). */
  liveEvent(
    cls: 'live.session' | 'live.zone' | 'live.rest',
    dedupeKey: string,
    payload: { content: string; meta: Record<string, string> },
  ): boolean {
    return this.emit(cls, 'info', dedupeKey, payload)
  }

  /** Manual workout-intent trigger (the only start-detection WHOOP allows). */
  workoutIntent(activity: string, enrich?: { label?: string; pr?: boolean }): boolean {
    const ts = new Date().toISOString()
    const label = enrich?.label?.trim() || activity
    const pr = enrich?.pr === true
    // Append (not overwrite) to a short intent log, so a lift-then-cooldown-
    // walk, a two-a-day, or a slow-scoring workout can never clobber an
    // earlier session's label. Each intent is claimed once by the workout it
    // best matches (see onWorkout), keeping the durable archive honest.
    const log = this.intentLog()
    log.push({ ts, activity, label, pr, claimed: false })
    // Prune to 24h + a hard cap so the meta value stays bounded.
    const cutoff = Date.now() - 24 * 3_600_000
    const pruned = log.filter((i) => Date.parse(i.ts) >= cutoff).slice(-16)
    this.store.setMeta('intent_log', JSON.stringify(pruned))
    return this.emit('workout.intent', 'info', `workout.intent:${ts}`, {
      content: `Starting now: ${label}.${pr ? ' This is a PR attempt.' : ''} Logged as intent at ${ts}; WHOOP will score it after completion.`,
      meta: {
        class: 'workout.intent',
        activity,
        ...(label !== activity ? { label } : {}),
        ...(pr ? { pr: 'true' } : {}),
      },
    })
  }

  private intentLog(): IntentRow[] {
    try {
      const raw = this.store.getMeta('intent_log')
      return raw ? (JSON.parse(raw) as IntentRow[]) : []
    } catch {
      return []
    }
  }

  /** Claim the unclaimed intent that best fits a scored workout (in its
   *  window, closest to its start) and stamp it with this workout's id so it
   *  can never staple onto a second overlapping workout (an auto-detected
   *  cooldown walk, a two-a-day). Returns null if nothing fits. */
  private claimIntentFor(w: WhoopWorkout): { label: string; pr: boolean } | null {
    const start = Date.parse(w.start)
    const end = Date.parse(w.end)
    const log = this.intentLog()
    let bestIdx = -1
    let bestGap = Infinity
    for (let i = 0; i < log.length; i++) {
      const it = log[i]
      if (it.claimed) continue
      const t = Date.parse(it.ts)
      if (t < start - 30 * 60_000 || t > end) continue
      const gap = Math.abs(t - start)
      if (gap < bestGap) {
        bestGap = gap
        bestIdx = i
      }
    }
    if (bestIdx < 0) return null
    const claimed = log[bestIdx]
    log[bestIdx] = { ...claimed, claimed: true, workout_id: w.id }
    this.store.setMeta('intent_log', JSON.stringify(log))
    return { label: claimed.label, pr: claimed.pr }
  }

  /** For a score REVISION of an already-labeled workout: return the intent
   *  THIS workout id previously claimed, so the superseding card keeps its
   *  label instead of coming back bare. Keyed to the id, so a different
   *  overlapping workout never inherits it. */
  private claimedIntentFor(w: WhoopWorkout): { label: string; pr: boolean } | null {
    const it = this.intentLog().find((i) => i.claimed && i.workout_id === w.id)
    return it ? { label: it.label, pr: it.pr } : null
  }
}
