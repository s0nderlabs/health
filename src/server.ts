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

const VERSION = '0.1.1'

const INSTRUCTIONS = `
health: WHOOP recovery, sleep, and strain as a live channel. The daemon on this
machine archives every WHOOP record locally and pushes events here.

Events arrive as <channel> messages (recovery briefs, workout cards, strain
crossings, early-warning vitals alerts, bedtime nudges). Payloads carry the
numbers, drivers, and band; you translate them for the user as their coach.

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

Tools: health__read (today), health__trend (multi-day), health__workout_intent
(user says they are starting a workout NOW; WHOOP cannot detect starts),
health__config (event toggles, thresholds, quiet hours), health__status (daemon).
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
          "Today's snapshot: recovery (score, HRV, RHR, SpO2, skin temp), last sleep, day strain, workouts today, body measurements. Reads the local archive, no WHOOP call.",
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
