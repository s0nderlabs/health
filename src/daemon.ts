#!/usr/bin/env bun
// healthd: the always-on daemon. Owns the token rotator, the SQLite archive,
// the poller, the webhook receiver, the decision engine, and event delivery
// to the target CC session. Exactly one instance runs (launchd + pidfile).

import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'fs'
import { AuthBrokenError } from './auth.js'
import { ensureRuntimeDir, loadConfig, inQuietHours, PID_PATH, SOCKET_PATH } from './config.js'
import { Store } from './store.js'
import { Engine } from './engine.js'
import { IpcServer } from './ipc.js'
import { backfill, pollOnce, type Fact } from './poller.js'
import { startWebhookReceiver } from './webhook.js'

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

// Events only flow once the initial backfill has completed. Until then the
// archive is still filling: if a partial backfill left tables sparse, a poll
// would otherwise replay years of history through the engine as "fresh" facts.
// The archive keeps filling (upserts happen before onFact); only engine
// emission is gated.
let ready = !!store.getMeta('backfill_done')

const onFact = (fact: Fact): void => {
  if (!ready) return
  try {
    engine.onFact(fact)
  } catch (err) {
    log(`engine error on ${fact.kind}: ${err}`)
  }
}

// Events pushed but not yet acked. Without this, the 250ms-coalesced delivery
// and the 5-minute tick would re-push an event whose ack is still in flight,
// injecting a duplicate channel message. Cleared on ack (delivered) or when the
// subscriber drops (so the event redelivers cleanly on reconnect).
const inFlight = new Set<number>()

const ipc = new IpcServer(SOCKET_PATH, {
  eventTarget: () => config().event_target,
  onAck: (eventId) => {
    store.markDelivered(eventId)
    inFlight.delete(eventId)
  },
  onSubscriberConnected: () => {
    log('event target session connected, draining queue')
    inFlight.clear() // fresh connection: anything previously in flight was never acked
    scheduleDelivery()
  },
  onSubscriberDisconnected: () => {
    inFlight.clear() // un-acked events must redeliver on the next connect
  },
  onRpc: async (method, params) => rpc(method, params),
})

function deliverPending(): void {
  if (!ipc.hasSubscriber()) return
  const quiet = inQuietHours(config())
  for (const e of store.undeliveredEvents()) {
    if (quiet && e.priority !== 'alert') continue // holds until quiet hours end
    if (inFlight.has(e.id)) continue // already pushed, awaiting ack
    if (ipc.pushEvent(e)) inFlight.add(e.id) // delivered_at is stamped on ack
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
      }
    }
    case 'read': {
      return {
        recovery: store.latestRecovery(),
        sleep: store.latestSleep(),
        cycle: store.latestCycle(),
        workouts_today: store.recentWorkouts(1),
        body: store.db.query('SELECT * FROM body WHERE id = 1').get(),
      }
    }
    case 'trend': {
      const days = Math.min(Number(params.days ?? 30), 365)
      return {
        recoveries: store.recentRecoveries(days),
        sleeps: store.recentSleeps(days),
        cycles: store.recentCycles(days),
        workouts: store.recentWorkouts(days),
      }
    }
    case 'intent': {
      const activity = String(params.activity ?? 'workout')
      const surfaced = engine.workoutIntent(activity)
      return { activity, surfaced }
    }
    case 'poll_now': {
      const changes = await pollOnce(store, onFact)
      return { changes }
    }
    case 'config_get':
      return config()
    case 'config_set': {
      const current = config()
      const patch = params as Partial<ReturnType<typeof loadConfig>>
      const merged = {
        ...current,
        ...patch,
        whoop: { ...current.whoop, ...patch.whoop },
        events: { ...current.events, ...patch.events },
        thresholds: { ...current.thresholds, ...patch.thresholds },
        cooldown_minutes: { ...current.cooldown_minutes, ...patch.cooldown_minutes },
        webhook: { ...current.webhook, ...patch.webhook },
      }
      const { saveConfig } = await import('./config.js')
      saveConfig(merged)
      // The poll interval is picked up live by the self-rescheduling poll timer.
      // The webhook listener binds once at startup and cannot rebind live, so a
      // port/path change needs a daemon restart to take effect.
      const webhookChanged =
        patch.webhook != null &&
        (merged.webhook.port !== current.webhook.port || merged.webhook.path !== current.webhook.path)
      return {
        config: merged,
        ...(webhookChanged
          ? { note: 'Webhook port/path change requires a daemon restart: launchctl kickstart -k gui/$UID/com.s0nderlabs.health' }
          : {}),
      }
    }
    default:
      throw new Error(`unknown rpc method: ${method}`)
  }
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

log(`up: poll every ${config().poll_interval_minutes}min, webhook :${config().webhook.port}${config().webhook.path}, target session "${config().event_target}"`)

// ── Shutdown ──────────────────────────────────────────────────────

let shuttingDown = false
function shutdown(reason: string): void {
  if (shuttingDown) return
  shuttingDown = true
  log(`shutting down (${reason})`)
  try { webhookServer.stop(true) } catch {}
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
