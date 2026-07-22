// The per-session MCP server: thin client over the daemon. Tools for reads,
// config, and the manual workout trigger; channel notifications for events.

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { toolResult, toolError } from './types.js'
import type { IpcClient } from './ipc.js'
import { Store } from './store.js'
import { DB_PATH } from './config.js'
import { existsSync } from 'fs'

const VERSION = '0.9.0'

const INSTRUCTIONS = `
health: WHOOP recovery, sleep, and strain as a live channel. The daemon on this
machine archives every WHOOP record locally and pushes events here.

No skill load is required: these instructions and the tools are active from
connect, and events inject on their own. The /health skill is a convenience
wrapper for on-demand reads, nothing more.

WIRE FORMAT. Events inject as channel messages shaped like:
  <channel source="plugin:health:health" class="recovery.brief"
           priority="info|notable|alert" ts="<ISO>" ...>coach-readable prose
  with every number inline</channel>
(source is "health" when loaded as a dev channel). The content IS the payload:
read the numbers out of the prose. meta attributes are for routing; every
event carries class + priority + ts, plus per class:
- recovery.brief: score, band (green/amber/red), calibrating, sleep_id.
  Content: recovery %, HRV/RHR vs 7-day baseline, SpO2/skin temp, sleep line.
- workout.card: sport, strain, workout_id. Content: sport, duration, strain,
  avg/max HR, kcal, zone minutes.
- strain.threshold: strain, cycle_id. vitals.alert: drivers, date (the ONE
  priority=alert class). trend.alert: date. bedtime.nudge: date.
  calibration.note: week. system.health: daemon problems.
- workout.intent: activity, label?, pr? (the user tapped/said "starting X
  now": act on it; label = the plan title when it IS today's session, and
  pr=true means treat it as a PR attempt).
- workout.card also carries intent_label / intent_pr when a declared intent
  matched the scored workout: "powerlifting" with intent_label "Deadlift 1RM
  Test" IS the PR session, coach it as such.
- live.session / live.confirm / live.zone / live.rest: BLE-feed milestones,
  see below.

How to act on events (the behavioral contract):
- Voice: professional coach. Number first, then state, then 2-3 drivers, then
  one actionable read with the why. Direct, no coddling, no praise inflation,
  no alarmism. Continue the user's training-coach tone if one exists.
- Scores are STRONG INPUT, not law. Recommend decisively but phrase overridably
  ("I'd cap volume today, but if you feel good the top single is still there").
  Never treat a recovery score as gospel; the user autoregulates.
- Severity keys decisiveness, not emotion. Red recovery = sharper on the action,
  same calm tone. Green = brief, one line, move on.
- Interrupt policy: routine events (recovery brief, workout card) should NOT
  derail active work; acknowledge briefly or fold into your next natural reply.
  vitals.alert (priority alert) is the exception: surface it promptly, once,
  calmly. Never re-ping about the same alert.
- If meta says calibrating=true, hedge: the score is a ballpark during the
  first ~4 days, baselines firm up around day 30.
- Sleep advice: state the cost, let the user decide. No nagging.
- PRIVACY: this is the user's private medical data. Never send it to any
  external channel, message, email, or document unless the user explicitly
  directs that specific disclosure.

live.* events come from the live BLE feed, and every live.session/live.rest
carries meta confidence=low|medium|high. THE CONTRACT: confidence=low is
SITUATIONAL AWARENESS ONLY: do not address the user about it and do not
invite an intent (at a ~116bpm/90s threshold a low start may be a shower,
stress, heat, or a walk). Engage on medium/high, or on live.confirm (once
per session: fires when the elevation develops an exercise signature;
confidence_reasons lists which: effort_cycles = set/interval structure,
sustained_z3 / z4 = depth, intent = user-declared, duration = 12+ min WITH
evidence). live.zone = a notable-intensity milestone (one line, keep the
flow). live.rest = session summary with the HR-recovery read (the coaching
moment: recovery speed reflects fitness and current fatigue). live.rest with
demoted=true ended low-confidence with no intent: treat as a non-workout
elevation, NEVER as training load; it stays archived and gets upgraded
(corroborated) if WHOOP later scores an overlapping workout. rr_consistency
in meta is an artifact-vs-real-pulse signal, not an exercise signal.

steps_today in health__read is WHOOP-counted daily movement (relayed from the
phone; the WHOOP cloud API has no steps). It is CONTEXT, not an interrupt:
fold it into reads (training strain says nothing about NEAT; a 2k-step desk
day and a 12k-step day are different recovery pictures). Arrives in batches,
roughly hourly; treat the number as "as of latest_sample_end", never live.

plan_today in health__read is the /gym-authored programmed session (title,
rest flag, lifts with weights/ladders). Check is_today: false means the file
is stale, treat as "no plan written yet". USE IT: never coach "if you train
today" blind; a rest:true day means protect the rest, and a PR day changes
how every recovery number should be read. null = the plan bridge is unused.

calibration in health__read: days_of_data + calibrating. Hedge with the
number ("day 3: scores are ballpark") instead of guessing.

BODY-STAT CANON (the user's ruling): body.weight_kilogram is a typed WHOOP
profile value and goes stale: the user's gym log is canonical for body
weight; never use the WHOOP number for coaching math. Max HR canon = the
WHOOP profile value auto-raised by any higher observed workout max (the
zones everywhere derive from it); observed max alone is meaningless early.

A daemon-maintained daily log (one line per day: recovery/HRV/RHR/sleep/
strain/steps, 90 days) lives at ~/.claude/channels/health/daily-log.md as
the durable memory anchor: journal/gym tooling reads it instead of the db.

Live feed semantics (health__live and status.live): active_source is the
WRITER of the live record (mac has priority at home), not merely the freshest
device. dual:true means both the mac and the phone hold the band: the mac
writes, the phone is a hot standby that takes over with zero gap; this is
normal and healthy at home, not a conflict.

YIELD (health__live action:yield): the relayers hold the band's broadcast
exclusively, so external apps (Strava sensor pairing) can never see it. When
the user says they want to record in Strava / pair the band elsewhere / "give
Strava the sensor", call health__live {action:'yield', minutes:N} with N
comfortably LONGER than the planned activity (default 240), or minutes:0 for
an INDEFINITE yield (no expiry; only an explicit reclaim ends it; the daemon
nags daily while it stays active). Use 0 when the user wants certainty that
nothing can interrupt the external app. Relay the response's warnings
verbatim: they are load-bearing (an unreachable phone relayer can silently
defeat the yield). While yielded: live.* events are dark
by design (not a fault); WHOOP's own recording and scoring are unaffected.
The yield ends by expiry or health__live {action:'reclaim'}; reclaim is
always safe (a held band cannot be stolen; the relayers just re-arm and wait
for the band to free). status.live.yield shows the window; yield.breach_source
non-null means a relayer missed its disarm and is still holding the band: the
user must open or force-quit the phone app (or restart the mac relay).

Tools: health__read (today + plan_today), health__trend (multi-day),
health__workout_intent (user says they are starting a workout NOW; WHOOP
cannot detect starts), health__live (live BPM/zone/HRV while the band
broadcasts), health__config (event toggles, thresholds, quiet hours),
health__status (daemon).
`.trim()

export function createServer(ipc: IpcClient) {
  const mcp = new Server(
    { name: 'health', version: VERSION },
    {
      capabilities: {
        tools: {},
        experimental: { 'claude/channel': {} },
      },
      instructions: INSTRUCTIONS,
    },
  )

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'health__read',
        description:
          "Today's snapshot: recovery (score, HRV, RHR, SpO2, skin temp), last sleep, day strain, workouts today, WHOOP-counted steps (daily movement), body measurements. Reads the local archive, no WHOOP call.",
        inputSchema: { type: 'object' as const, properties: {}, required: [] },
      },
      {
        name: 'health__trend',
        description:
          'Multi-day history for trend analysis: recoveries, sleeps, cycles (day strain), workouts. Returns raw daily rows; compute trends from them.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            days: { type: 'number', description: 'How many days back (default 30, max 365)' },
          },
          required: [],
        },
      },
      {
        name: 'health__workout_intent',
        description:
          'Log that the user is STARTING a workout right now (WHOOP has no start detection; scored data arrives after completion). Records the intent so coaching can react immediately.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            activity: { type: 'string', description: 'What they are starting, e.g. "powerlifting", "cycling", "tennis"' },
          },
          required: ['activity'],
        },
      },
      {
        name: 'health__config',
        description:
          'View or update health settings: event class toggles, thresholds, quiet hours, daily event budget, poll interval.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            action: { type: 'string', enum: ['get', 'set'], description: 'get current config or set values' },
            events: { type: 'object', description: 'Event class toggles, e.g. {"bedtime.nudge": false}' },
            thresholds: { type: 'object', description: 'Threshold overrides, e.g. {"strain_notable": 16}' },
            quiet_hours: {
              type: ['object', 'null'],
              description: 'e.g. {"start": "23:00", "end": "06:00"}, or null to disable',
            },
            daily_budget: { type: 'number', description: 'Max non-alert events delivered per day' },
            poll_interval_minutes: { type: 'number' },
          },
          required: ['action'],
        },
      },
      {
        name: 'health__status',
        description: 'Daemon health: pid, last poll, last webhook, record counts, subscriber state.',
        inputSchema: { type: 'object' as const, properties: {}, required: [] },
      },
      {
        name: 'health__live',
        description:
          'Live heart-rate feed: snapshot (default) returns current BPM, zone, 5-min HRV (rMSSD), session state, feed health. action "yield" surrenders the band so an external app (Strava sensor pairing) can take the broadcast; action "reclaim" ends a yield early and re-arms the relayers.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            action: {
              type: 'string',
              enum: ['snapshot', 'yield', 'reclaim'],
              description: 'Default snapshot. yield = disarm the relayers so Strava can pair the band (live coaching goes dark). reclaim = end the yield now.',
            },
            minutes: {
              type: 'number',
              description: 'Yield window in minutes (default 240, clamp 5-720). Pick LONGER than the planned activity: expiry mid-ride re-arms the relayers. 0 = INDEFINITE: no expiry, only an explicit reclaim ends it (the ironclad mode; a daily reminder fires while active).',
            },
          },
          required: [],
        },
      },
    ],
  }))

  mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = (req.params.arguments ?? {}) as Record<string, unknown>
    try {
      switch (req.params.name) {
        case 'health__read':
          return toolResult(await viaDaemonOrStore('read', {}))
        case 'health__trend':
          return toolResult(await viaDaemonOrStore('trend', { days: args.days ?? 30 }))
        case 'health__workout_intent': {
          const data = (await ipc.rpc('intent', { activity: args.activity })) as {
            activity: string
            surfaced: boolean
          }
          if (data.surfaced) {
            return toolResult(`Intent logged: ${data.activity}. Coaching can react now; WHOOP scores it after completion.`)
          }
          return toolResult(`Recorded ${data.activity}, but it was not surfaced as an event (the workout.intent class is toggled off in config). Coaching still has it via this call.`)
        }
        case 'health__config': {
          if (args.action === 'get') {
            return toolResult(JSON.stringify(await ipc.rpc('config_get'), null, 2))
          }
          const { action: _a, ...patch } = args
          return toolResult(JSON.stringify(await ipc.rpc('config_set', patch), null, 2))
        }
        case 'health__status': {
          const status = (await ipc.rpc('status')) as Record<string, unknown>
          return toolResult(
            JSON.stringify({ ...status, this_session_receives_events: ipc.eventsEnabled }, null, 2),
          )
        }
        case 'health__live': {
          if (args.action === 'yield') {
            return toolResult(JSON.stringify(await ipc.rpc('live_yield', { minutes: args.minutes }), null, 2))
          }
          if (args.action === 'reclaim') {
            return toolResult(JSON.stringify(await ipc.rpc('live_reclaim', {}), null, 2))
          }
          return toolResult(JSON.stringify(await ipc.rpc('live'), null, 2))
        }
        default:
          return toolError(`Unknown tool: ${req.params.name}`)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return toolError(`${req.params.name} failed: ${msg}`)
    }
  })

  // Read tools stay usable when the daemon is down: fall back to a read-only
  // open of the archive itself.
  async function viaDaemonOrStore(method: 'read' | 'trend', params: Record<string, unknown>): Promise<string> {
    if (ipc.connected) {
      return JSON.stringify(await ipc.rpc(method, params), null, 2)
    }
    if (!existsSync(DB_PATH)) {
      throw new Error('daemon is not running and no local archive exists yet; run setup / start healthd')
    }
    const store = new Store(DB_PATH, true)
    try {
      if (method === 'read') {
        return JSON.stringify(
          {
            daemon: 'DOWN (read served from archive directly; restart: launchctl kickstart -k gui/$UID/com.s0nderlabs.health)',
            recovery: store.latestRecovery(),
            sleep: store.latestSleep(),
            cycle: store.latestCycle(),
            workouts_today: store.recentWorkouts(1),
            steps_today: store.stepsToday(),
          },
          null,
          2,
        )
      }
      const days = Math.min(Number(params.days ?? 30), 365)
      return JSON.stringify(
        {
          daemon: 'DOWN (read served from archive directly)',
          recoveries: store.recentRecoveries(days),
          sleeps: store.recentSleeps(days),
          cycles: store.recentCycles(days),
          workouts: store.recentWorkouts(days),
        },
        null,
        2,
      )
    } finally {
      store.close()
    }
  }

  return mcp
}

export async function connectMcp(ipc: IpcClient): Promise<Server> {
  const transport = new StdioServerTransport()
  const mcp = createServer(ipc)
  await mcp.connect(transport)
  return mcp
}

export function notifyChannel(mcp: Server, content: string, meta: Record<string, string>): Promise<void> {
  return mcp
    .notification({
      method: 'notifications/claude/channel',
      params: {
        content,
        meta: { ...meta, ts: meta.ts ?? new Date().toISOString() },
      },
    })
    .catch((err) => {
      process.stderr.write(`health: failed to deliver notification: ${err}\n`)
      throw err
    })
}
