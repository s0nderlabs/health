#!/usr/bin/env bun
// healthd: the always-on daemon. Owns the token rotator, the SQLite archive,
// the poller, the webhook receiver, the decision engine, and event delivery
// to every connected CC session. Exactly one instance runs (launchd + pidfile).

import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'fs'
import { join } from 'path'
import { randomBytes } from 'node:crypto'
import { AuthBrokenError } from './auth.js'
import { ensureRuntimeDir, loadConfig, saveConfig, configFileWritable, inQuietHours, resolvePlanPath, PID_PATH, SOCKET_PATH, RUNTIME_DIR } from './config.js'
import { Store } from './store.js'
import { Engine } from './engine.js'
import { IpcServer } from './ipc.js'
import { InFlightTracker } from './delivery.js'
import { backfill, pollOnce, type Fact } from './poller.js'
import { startWebhookReceiver } from './webhook.js'
import { isWakeSignal, wakeReleaseActive } from './wake.js'
import { LiveState } from './livestate.js'
import { LiveListener } from './live.js'

function log(msg: string): void {
  process.stderr.write(`healthd: ${new Date().toISOString()} ${msg}\n`)
}

// ── Singleton guard ───────────────────────────────────────────────

ensureRuntimeDir()

// Is `pid` alive AND actually a healthd process? kill(pid,0) alone is not enough:
// after an unclean shutdown the pidfile persists, and across a reboot that PID
// number is often reused by an unrelated process, which would make every start
// falsely see "another daemon" and exit into a KeepAlive loop with nothing
// running. So confirm the process command references this daemon entrypoint.
function isHealthdRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch {
    return false // no such process
  }
  const ps = Bun.spawnSync(['ps', '-p', String(pid), '-o', 'command='])
  if (ps.exitCode !== 0) return false
  return ps.stdout.toString().includes('daemon.ts')
}

if (existsSync(PID_PATH)) {
  const oldPid = Number(readFileSync(PID_PATH, 'utf8').trim())
  if (oldPid > 0 && oldPid !== process.pid) {
    if (isHealthdRunning(oldPid)) {
      log(`another healthd is already running (pid ${oldPid}), exiting`)
      process.exit(0)
    }
    log(`stale pidfile (pid ${oldPid} not a live healthd), taking over`)
  }
}
writeFileSync(PID_PATH, String(process.pid))

// ── Wiring ────────────────────────────────────────────────────────

const store = new Store()
const config = () => loadConfig()

let deliverScheduled = false
const scheduleDelivery = (): void => {
  if (deliverScheduled) return
  deliverScheduled = true
  setTimeout(() => {
    deliverScheduled = false
    deliverPending()
  }, 250)
}

const engine = new Engine(store, config, scheduleDelivery)

// ── Live HR feed (BLE relayers stream raw frames in over WS) ──────

// Relayers on this machine authenticate with a token from the config file;
// generate it once so the file is ready before the first relayer starts.
// NEVER write when the on-disk file is malformed: loadConfig() would be
// serving defaults and the write would destroy the user's repairable config.
if (!config().live.token) {
  if (configFileWritable()) {
    const current = loadConfig()
    saveConfig({ ...current, live: { ...current.live, token: randomBytes(24).toString('hex') } })
    log('generated live-ingest token')
  } else {
    log('config.json is malformed: refusing to write a live token over it (live ingest stays locked until the file is repaired)')
  }
}

// These deps are consulted for EVERY 1Hz sample (and 600-frame buffer
// flushes); a config-file read + SQLite query per sample is waste. 30s TTL
// keeps config edits near-live without the per-sample cost.
function cached<T>(fn: () => T, ttlMs = 30_000): () => T {
  let value: T
  let at = 0
  return () => {
    if (Date.now() - at > ttlMs) {
      value = fn()
      at = Date.now()
    }
    return value
  }
}

const liveState = new LiveState({
  // Canon (his ruling, Jul 9 2026): config override first, else the WHOOP
  // profile max HR (187) auto-raised by any higher observed workout max.
  // Observed alone is useless early (lifting never approaches true max).
  getMaxHr: cached(() => {
    const override = config().live.max_hr
    if (override) return override
    const profile =
      ((store.db.query('SELECT max_heart_rate FROM body WHERE id = 1').get() as
        | { max_heart_rate?: number }
        | null)?.max_heart_rate) || 187
    return Math.max(store.maxWorkoutHr() ?? 0, profile, 187)
  }),
  getRestHr: cached(() => {
    const rhr = store.latestRecovery()?.resting_heart_rate
    return typeof rhr === 'number' && rhr > 25 ? rhr : 60
  }),
  getHotBpm: cached(() => config().live.hot_bpm),
  emit: (cls, dedupeKey, payload) => {
    engine.liveEvent(cls, dedupeKey, payload)
  },
  onSessionEnd: (summary) => {
    try {
      store.insertLiveSession(summary)
    } catch (err) {
      log(`live session persist failed: ${err}`)
    }
  },
})
const liveListener = new LiveListener(liveState, () => config().live.token, {
  // Phone-side surfaces: intent taps ride the same event path as the MCP tool,
  // steps land in the archive, plan reads come from the /gym-authored file,
  // and phone liveness persists for the cert-expiry watchdog.
  onIntent: (activity) => engine.workoutIntent(activity, intentEnrichment(activity)),
  onSteps: (samples, deletedUuids) => {
    const { added } = store.upsertStepsSamples(samples)
    const { deleted } = store.deleteStepsSamples(deletedUuids)
    return { added, deleted }
  },
  getPlanPath: () => resolvePlanPath(config()),
  onPhoneSeen: (atIso) => store.setMeta('phone_relayer_last_seen', atIso),
})

// Events only flow once the initial backfill has completed. Until then the
// archive is still filling: if a partial backfill left tables sparse, a poll
// would otherwise replay years of history through the engine as "fresh" facts.
// The archive keeps filling (upserts happen before onFact); only engine
// emission is gated.
let ready = !!store.getMeta('backfill_done')

const onFact = (fact: Fact): void => {
  if (!ready) return
  try {
    // A freshly-ended scored sleep (or its recovery) arriving inside quiet
    // hours means the user just woke: lift the hold for this window so the
    // morning brief lands with the wake, not at the clock boundary.
    const cfg = config()
    if (
      cfg.quiet_hours?.wake_release !== false &&
      inQuietHours(cfg) &&
      !wakeReleaseActive(cfg, store.getMeta('wake_detected_at')) &&
      isWakeSignal(fact, (id) => store.getSleepById(id))
    ) {
      store.setMeta('wake_detected_at', new Date().toISOString())
      log('wake detected: quiet-hours hold lifted for this window')
      scheduleDelivery()
    }
    engine.onFact(fact)
    // The durable memory anchor: any archive-changing fact refreshes the
    // one-line-per-day log that the /gym skill and journal tooling read.
    if (fact.kind === 'recovery' || fact.kind === 'sleep' || fact.kind === 'cycle' || fact.kind === 'workout') {
      scheduleDailyLog()
    }
  } catch (err) {
    log(`engine error on ${fact.kind}: ${err}`)
  }
}

// ── Daily log (health -> memory-system bridge) ────────────────────
// Regenerated wholesale from the archive (idempotent, no append bookkeeping):
// one terse line per day, newest first, 90 days. Local file only: the same
// privacy domain as the SQLite archive it summarizes.
let dailyLogScheduled = false
function scheduleDailyLog(): void {
  if (dailyLogScheduled) return
  dailyLogScheduled = true
  setTimeout(() => {
    dailyLogScheduled = false
    try {
      writeDailyLog(store)
    } catch (err) {
      log(`daily-log write failed: ${err}`)
    }
  }, 5_000)
}
// Boot refresh so the daily log exists/reflects the archive even before the
// next fact arrives. Lives BELOW the let-binding: module-scope `let` has a
// temporal dead zone, and calling above it crashes the daemon at startup.
if (ready) scheduleDailyLog()

// Per-event, per-recipient in-flight tracking: prevents duplicate injection
// while an ack is pending, gives latecomer sessions a targeted push, frees an
// event when all its recipients drop, and TTL-frees it when no ack arrives
// (failed handler, suspended session) so nothing strands. See delivery.ts.
const inFlight = new InFlightTracker()

const ipc = new IpcServer(SOCKET_PATH, {
  onAck: (eventId) => {
    store.markDelivered(eventId)
    inFlight.acked(eventId)
  },
  onSubscriberConnected: (sessionId) => {
    log(`session ${sessionId} subscribed (${ipc.subscriberCount()} live), draining queue`)
    scheduleDelivery()
  },
  onSubscriberDisconnected: (sessionId) => {
    inFlight.sessionDropped(sessionId) // fully-dropped events become redeliverable
    scheduleDelivery()
  },
  onRpc: async (method, params) => rpc(method, params),
})

function deliverPending(): void {
  if (!ipc.hasSubscriber()) return
  const cfg = config()
  const quiet = inQuietHours(cfg) && !wakeReleaseActive(cfg, store.getMeta('wake_detected_at'))
  for (const e of store.undeliveredEvents()) {
    // live.* events prove the user is awake and active RIGHT NOW; holding
    // them would deliver a stale burst at the quiet-hours boundary instead.
    if (quiet && e.priority !== 'alert' && !e.class.startsWith('live.')) continue // holds until quiet hours end
    const pushedTo = ipc.pushEvent(e, inFlight.exclusions(e.id))
    inFlight.pushed(e.id, pushedTo) // delivered_at is stamped on ack
  }
}

// ── RPC surface (the MCP server's tool backend) ───────────────────

async function rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case 'status': {
      return {
        pid: process.pid,
        backfill_done: store.getMeta('backfill_done'),
        last_poll_at: store.getMeta('last_poll_at'),
        webhook_last_rx: store.getMeta('webhook_last_rx'),
        counts: store.counts(),
        subscriber: ipc.hasSubscriber(),
        quiet_hours_now: inQuietHours(config()),
        // Only meaningful INSIDE quiet hours; gate it so status never claims
        // an active release while no hold exists.
        wake_release_active:
          inQuietHours(config()) && wakeReleaseActive(config(), store.getMeta('wake_detected_at')),
        live: liveListener.status(),
        // Free-tier sideload certs die silently after 7 days; surface staleness
        // so an expired phone relayer can never cost a workout unnoticed.
        phone_relayer_last_seen: store.getMeta('phone_relayer_last_seen'),
      }
    }
    case 'read': {
      return {
        recovery: store.latestRecovery(),
        sleep: store.latestSleep(),
        cycle: store.latestCycle(),
        workouts_today: store.recentWorkouts(1),
        body: store.db.query('SELECT * FROM body WHERE id = 1').get(),
        steps_today: store.stepsToday(),
        // Today's programmed session from the /gym-authored plan file, so the
        // in-chat coach is never schedule-blind (it used to coach "if you
        // lift today" on programmed rest days). Training data only; is_today
        // false means the file is stale and should be read as "no plan yet".
        plan_today: readPlanToday(resolvePlanPath(config())),
        // How far into WHOOP's calibration we are: scores are ballpark the
        // first ~4 days, baselines firm up around day 30.
        calibration: calibrationStatus(store),
      }
    }
    case 'trend': {
      const days = Math.min(Number(params.days ?? 30), 365)
      return {
        recoveries: store.recentRecoveries(days),
        sleeps: store.recentSleeps(days),
        cycles: store.recentCycles(days),
        workouts: store.recentWorkouts(days),
        steps_daily: store.stepsByDay(days),
      }
    }
    case 'intent': {
      const activity = String(params.activity ?? 'workout')
      const surfaced = engine.workoutIntent(activity, intentEnrichment(activity))
      return { activity, surfaced }
    }
    case 'poll_now': {
      const changes = await pollOnce(store, onFact)
      return { changes }
    }
    case 'live': {
      return {
        ...liveState.snapshot(Date.now()),
        ...liveListener.status(),
        sessions_24h: store.recentLiveSessions(1), // rolling window, not calendar-today
      }
    }
    case 'config_get':
      return redactConfig(config())
    case 'config_set': {
      const current = config()
      const patch = params as Partial<ReturnType<typeof loadConfig>>
      // The token is redacted in config_get output; a patch echoing that
      // placeholder back must not overwrite the real secret.
      if (patch.live && (patch.live as Record<string, unknown>).token === REDACTED) {
        delete (patch.live as Record<string, unknown>).token
      }
      const merged = {
        ...current,
        ...patch,
        whoop: { ...current.whoop, ...patch.whoop },
        events: { ...current.events, ...patch.events },
        thresholds: { ...current.thresholds, ...patch.thresholds },
        cooldown_minutes: { ...current.cooldown_minutes, ...patch.cooldown_minutes },
        webhook: { ...current.webhook, ...patch.webhook },
        // Deep-merge or a partial patch (e.g. {live:{max_hr:190}}) would wipe
        // the generated live.token and lock every relayer out.
        live: { ...current.live, ...patch.live },
        // Same for quiet_hours: a partial patch ({quiet_hours:{start:'22:30'}})
        // must not drop end or the wake_release flag. null still disables.
        quiet_hours:
          patch.quiet_hours === undefined
            ? current.quiet_hours
            : patch.quiet_hours === null
              ? null
              : { ...current.quiet_hours, ...patch.quiet_hours },
      }
      if (merged.quiet_hours && (!merged.quiet_hours.start || !merged.quiet_hours.end)) {
        throw new Error('quiet_hours needs both start and end (or null to disable)')
      }
      const { saveConfig } = await import('./config.js')
      saveConfig(merged)
      // The poll interval is picked up live by the self-rescheduling poll timer.
      // The webhook listener binds once at startup and cannot rebind live, so a
      // port/path change needs a daemon restart to take effect.
      const webhookChanged =
        patch.webhook != null &&
        (merged.webhook.port !== current.webhook.port || merged.webhook.path !== current.webhook.path)
      // The plan file watcher captures its directory once at startup, so a
      // plan_path change keeps GET /plan working (it re-reads the path) but
      // stops live plan_updated pushes until the daemon is restarted.
      const planPathChanged = patch.plan_path != null && merged.plan_path !== current.plan_path
      const restartHint = 'requires a daemon restart: launchctl kickstart -k gui/$UID/com.s0nderlabs.health'
      const notes = [
        webhookChanged ? `Webhook port/path change ${restartHint}` : null,
        planPathChanged ? `plan_path change: live plan push ${restartHint}` : null,
      ].filter(Boolean)
      return {
        config: redactConfig(merged),
        ...(notes.length ? { note: notes.join(' ') } : {}),
      }
    }
    default:
      throw new Error(`unknown rpc method: ${method}`)
  }
}

// The live-ingest token is a secret; RPC responses land in session transcripts
// that leave this machine. Relayers read it from the config FILE, never RPC.
const REDACTED = '<redacted>'
function redactConfig(cfg: ReturnType<typeof loadConfig>): ReturnType<typeof loadConfig> {
  return { ...cfg, live: { ...cfg.live, token: cfg.live.token ? REDACTED : '' } }
}

// ── Startup ───────────────────────────────────────────────────────

ipc.start()
log(`ipc listening on ${SOCKET_PATH}`)

const webhookServer = startWebhookReceiver(
  store,
  config().webhook.port,
  config().webhook.path,
  onFact,
)

// Live ingest is OPTIONAL: a bind failure (port taken) must degrade to
// no-live-feed, never take the poller/webhooks/delivery down with it.
try {
  liveListener.start(config().live.port, config().live.bind)
} catch (err) {
  log(`live listener failed to start (live HR disabled): ${err}`)
  engine.systemProblem(
    `Live HR ingest could not bind ${config().live.bind}:${config().live.port}: ${err}`,
    `live-bind:${new Date().toISOString().slice(0, 10)}`,
  )
}

// Live transitions that need wall-clock time (a dead feed ends a session).
setInterval(() => {
  try {
    liveState.tick(Date.now())
  } catch (err) {
    log(`live tick failed: ${err}`)
  }
}, 30_000)

let authBroken = false

async function guarded(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn()
    authBroken = false
  } catch (err) {
    if (err instanceof AuthBrokenError) {
      if (!authBroken) {
        authBroken = true
        engine.systemProblem(err.message, `auth-broken:${new Date().toISOString().slice(0, 10)}`)
      }
      log(`${label}: ${err.message}`)
    } else {
      log(`${label} failed: ${err}`)
    }
  }
}

if (!ready) {
  // Retry backfill until it completes; do NOT start emitting events until it
  // does (the `ready` gate). A partial backfill must not replay history.
  let attempt = 0
  while (!store.getMeta('backfill_done')) {
    attempt++
    log(`first run: backfilling full history (attempt ${attempt})`)
    await guarded('backfill', () => backfill(store))
    if (!store.getMeta('backfill_done')) {
      const backoff = Math.min(attempt * 30, 300)
      log(`backfill incomplete, retrying in ${backoff}s`)
      await Bun.sleep(backoff * 1000)
    }
  }
  ready = true
  log('backfill complete: event engine is now live')
  scheduleDailyLog() // fresh install: write the log now, not one poll later
} else {
  await guarded('startup poll', () => pollOnce(store, onFact))
}

// Poll on a self-rescheduling timer that re-reads the interval each cycle, so a
// config_set of poll_interval_minutes takes effect without a daemon restart.
async function scheduleNextPoll(): Promise<void> {
  const delayMs = Math.max(config().poll_interval_minutes, 1) * 60_000
  setTimeout(() => {
    void guarded('poll', () => pollOnce(store, onFact)).finally(scheduleNextPoll)
  }, delayMs)
}
void scheduleNextPoll()

setInterval(() => {
  try {
    engine.tick()
  } catch (err) {
    log(`tick failed: ${err}`)
  }
  scheduleDelivery() // re-check quiet-hours holds
}, 5 * 60_000)

// Delivery heartbeat: picks up TTL-expired in-flight events (failed handler,
// suspended session) within a minute instead of waiting for the 5-min tick.
setInterval(scheduleDelivery, 60_000)

log(`up: poll every ${config().poll_interval_minutes}min, webhook :${config().webhook.port}${config().webhook.path}, events push to every connected session`)

// ── Shutdown ──────────────────────────────────────────────────────

let shuttingDown = false
function shutdown(reason: string): void {
  if (shuttingDown) return
  shuttingDown = true
  log(`shutting down (${reason})`)
  try { webhookServer.stop(true) } catch {}
  try { liveListener.stop() } catch {}
  try { ipc.stop() } catch {}
  try { store.close() } catch {}
  try { if (existsSync(PID_PATH)) unlinkSync(PID_PATH) } catch {}
  process.exit(0)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('unhandledRejection', (err) => log(`unhandled rejection: ${err}`))
process.on('uncaughtException', (err) => {
  log(`uncaught exception: ${err}`)
  shutdown('uncaught exception')
})

/** Parse the /gym-authored plan file for health__read's plan_today block.
 *  Adds is_today (local date match) so a stale file reads as "no plan yet"
 *  instead of yesterday's session. Never throws: a missing/garbled file is
 *  simply null (the plan bridge is optional). */
function readPlanToday(planPath: string): Record<string, unknown> | null {
  try {
    const raw = JSON.parse(readFileSync(planPath, 'utf8')) as Record<string, unknown>
    if (raw == null || typeof raw !== 'object') return null
    const today = new Date().toLocaleDateString('sv') // YYYY-MM-DD, local tz
    return { ...raw, is_today: raw.date === today }
  } catch {
    return null
  }
}

/** Days of scored data + whether WHOOP still flags calibration, so the coach
 *  can hedge with a number ("day 3 of ~30") instead of guessing from vibes. */
function calibrationStatus(s: Store): Record<string, unknown> {
  const first = s.db.query('SELECT MIN(created_at) AS at FROM recoveries').get() as {
    at: string | null
  } | null
  const days = first?.at ? Math.floor((Date.now() - Date.parse(first.at)) / 86_400_000) + 1 : 0
  const latest = s.latestRecovery()
  return {
    days_of_data: days,
    calibrating: Boolean(latest?.user_calibrating),
    baselines_solid_after_days: 30,
  }
}

/** Plan-derived enrichment for a workout intent: when the declared activity
 *  IS today's programmed session, carry the plan title as the label and
 *  detect a PR day (title or any rung mentions PR/1RM), so the intent and
 *  the eventual scored card are self-describing. */
function intentEnrichment(activity: string): { label?: string; pr?: boolean } {
  const plan = readPlanToday(resolvePlanPath(config()))
  if (!plan || plan.is_today !== true || plan.rest === true) return {}
  const title = typeof plan.title === 'string' ? plan.title : ''
  if (!title || activity.trim().toLowerCase() !== title.trim().toLowerCase()) return {}
  // PR detection: the TITLE only, never free-text notes. Scanning the whole
  // plan JSON matched negating note text ("not a PR day") and flipped pr on.
  const pr = /\b(1\s*rm|pr)\b/i.test(title)
  return { label: title, pr }
}

/** One line per day, newest first, regenerated from the archive. The bridge
 *  between the live health feed and the durable memory system: /gym and the
 *  journal tooling read this instead of querying SQLite. */
function writeDailyLog(s: Store): void {
  const days = 90
  const byDay = new Map<string, { rec?: string; sleep?: string; strain?: string; steps?: string }>()
  const localDate = (iso: string, shiftMs = 0) =>
    new Date(Date.parse(iso) + shiftMs).toLocaleDateString('sv')
  const row = (d: string) => {
    let r = byDay.get(d)
    if (!r) {
      r = {}
      byDay.set(d, r)
    }
    return r
  }
  for (const rec of s.recentRecoveries(days)) {
    if (rec.score_state !== 'SCORED' || rec.recovery_score == null) continue
    const score = Math.round(rec.recovery_score as number)
    const band = score >= 67 ? 'green' : score >= 34 ? 'amber' : 'red'
    const sleep = rec.sleep_id ? s.getSleepById(rec.sleep_id as string) : null
    const d = localDate(rec.created_at as string)
    row(d).rec =
      `recovery ${score}% ${band} · HRV ${Math.round(rec.hrv_rmssd_milli as number)} · RHR ${Math.round(rec.resting_heart_rate as number)}` +
      (rec.user_calibrating ? ' (calibrating)' : '')
    if (sleep?.in_bed_milli != null) {
      const h = Math.floor((sleep.in_bed_milli as number) / 3_600_000)
      const m = Math.round(((sleep.in_bed_milli as number) % 3_600_000) / 60_000)
      const perf = sleep.performance_pct != null ? ` (${Math.round(sleep.performance_pct as number)}% of need)` : ''
      row(d).sleep = `sleep ${h}h${String(m).padStart(2, '0')}m${perf}`
    }
  }
  for (const c of s.recentCycles(days)) {
    if (c.score_state !== 'SCORED' || c.strain == null) continue
    // Cycles start at the previous evening's sleep onset; +12h lands the
    // label on the day the cycle actually covers.
    const d = localDate(c.start as string, 12 * 3_600_000)
    row(d).strain = `strain ${(c.strain as number).toFixed(1)}`
  }
  for (const st of s.stepsByDay(days) as Array<{ day: string; total: number }>) {
    row(st.day).steps = `steps ${st.total}`
  }
  const dates = [...byDay.keys()].sort().reverse()
  const lines = dates.map((d) => {
    const r = byDay.get(d)
    if (!r) return d
    return [d, r.rec, r.sleep, r.strain, r.steps].filter(Boolean).join(' | ')
  })
  const header =
    '# health daily log (daemon-maintained, regenerated on every scored fact)\n' +
    '# one line per day, newest first, last 90 days. Source of truth: health.db.\n\n'
  writeFileSync(join(RUNTIME_DIR, 'daily-log.md'), header + lines.join('\n') + '\n')
}
