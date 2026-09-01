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

const VERSION = '0.12.1'

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
sustained_depth / hard_effort = depth, intent = user-declared, duration = 12+ min WITH
evidence). live.zone = a notable-intensity milestone (one line, keep the
flow). live.rest = session summary with the HR-recovery read (the coaching
moment: recovery speed reflects fitness and current fatigue). live.rest with
demoted=true ended low-confidence with no intent: treat as a non-workout
elevation, NEVER as training load; it stays archived and gets upgraded
(corroborated) if WHOOP later scores an overlapping workout. rr_consistency
in meta is an artifact-vs-real-pulse signal, not an exercise signal.

ride.landed: the cyclo's ride just reached Strava (the daemon watched it
land). meta: activity_id, name (current title), distance_km, moving_min,
whoop_matched, plan_title?. THE CONTRACT: this event is BOTH the loop-closer
(the gym protocol's "wait for Strava" step ends here; whoop_matched=true
means the session has landed from both sources) AND a composition request.
Compose a real title + description, then write them with
health__strava {activity_id, title, description}. THE FORMAT IS LOCKED
(elpabl0-approved Aug 31 2026); do not restyle it:
- Title grammar (locked): "[Ez|Interval|Long] [spec] [route tag when it
  says something] [, qualifier when earned]". Type token first, always.
  Examples: "Ez 2h" / "Ez 2h binloop" / "Ez 2h, day one" / "Interval 4x8
  dalkot" / "Interval 4x8 dalkot, 2 of 4" / "Long 60k dalkot" / "Long 100k
  TBK". The route tag is the word the user would say aloud for where he
  rode (dalkot, binloop, Mozia, TBK): include it for destination rides,
  named loops, or non-default venues; omit it for the ordinary neighborhood
  spin so the tagged titles keep meaning. Detect the route from the
  activity's segment efforts + plan.json, never guess. A truly
  chapter-worthy day (first century, a race) may take a character title
  instead; that is rare by design. NO stat-dumping beyond the spec figure:
  Strava already shows day/distance/time under the title.
- Description: SHORT LINES WITH AIR: a blank line between every line, 3-4
  lines total before the watermark, hard cap. Structure:
    1. One context line: what this session was in the program (fold in
       door-to-door time only when the gap itself is the story).
    2. Two or three INSIGHT lines from actual stream analysis: ONE insight
       per line, at most two numbers per line, and every number tied to a
       WHERE, a comparison, or a meaning ("154 on the Bintaro rail flyover
       at km 31.7", "the hardest 20 min came last").
  NEVER repeat what Strava's own stat grid already prints under the text:
  distance, elevation gain, moving/elapsed time, avg speed, avg HR, max
  speed, calories. A bare stat is data-dump; only located or compared
  numbers earn prose. Full sentences, no semicolon chains, no mid-dot stat
  strings. Nothing unverified, and no trend claims vs past sessions unless
  the comparison is protocol-clean.
  ANALYSIS IS MANDATORY BEFORE WRITING: pull the activity streams + segment
  efforts (Strava connector or API), localize the peaks, compute zone time
  off the unified 181/56/156 HR set. Never write insight lines from the
  summary numbers alone.
- Public-surface rules: ride-file HR NUMBERS ARE ALLOWED (his ruling Aug 31
  2026: the activity's own data is already public). NEVER in the prose:
  WHOOP anything (recovery %, HRV, strain, sleep, readiness), or schedule/
  routine/location beyond what the ride's own map already shows (no
  "tomorrow's intervals"; named climbs/segments ON the route are fine).
- The daemon MECHANICALLY appends the configured watermark (this install:
  "- eltrain00r") to every description and rejects never-public terms in
  BOTH fields, title included, so do not add the watermark yourself and do
  not fight a rejection: rephrase. Every connected session receives the
  same ride.landed; the FIRST write wins and a second session's write is
  refused unless it passes overwrite=true for a deliberate revision.
- THE PUBLIC DESC IS THE TEASER; THE SESSION CHAT IS THE DEBRIEF. After
  writing the annotation (his standing request, Aug 31 2026), ALWAYS
  deliver the COMPLETE ride analysis in the conversation: full zone
  distribution, the lap/rep breakdown (work laps only on interval days),
  localized HR peaks and top speed, front/back drift with the why, stops,
  standout segment efforts, and the WHOOP overlay (strain, how the ride
  sat against the morning's recovery): the chat is private, so physiology
  belongs HERE. Coach voice, numbers first, one actionable read at the
  end. Skipping the debrief is a contract violation even when the public
  annotation succeeded.
The daemon also enforces the write guards: only Strava's generic auto-name
is ever replaced, only an empty (or our own) description is filled, and an
activity the user renamed by hand is refused. If no session writes within
~30 min the daemon self-applies a plain plan-derived fallback title;
health__strava afterwards upgrades it (our own titles may be overwritten).

lift.landed: a WHOOP-pushed lift card just reached Strava. meta:
activity_id, name, duration_min, whoop_matched, stripped, owner_named,
day_type?. The daemon strips WHOOP's public strain line at discovery (that
strip is the point of watching lifts at all) and the event content reports
the ACTUAL outcome: trust the event, and if it says the strip FAILED, any
health__strava description write also replaces the leak. owner_named=true
means he titled the card himself: acknowledge only, write nothing. THE
TIMING RULE IS THE OPPOSITE OF RIDES: do NOT compose on arrival. The card carries no sets and no loads; the
ONLY data source is his own debrief (the /gym session log). Acknowledge the
event, then compose ONLY AFTER he has reported the session (if he already
debriefed it, compose immediately), writing with health__strava
{activity_id, title, description}. THE LIFT FORMAT IS LOCKED (elpabl0 +
main, Sep 1 2026); do not restyle it:
- Title set (his program's own day names, by weekday): Mon "Volume day"
  (8s) / Tue "Medium day" (6s) / Thu "Intensity day" (4s + AMRAP) / Fri
  "Deadlift day" / test days "Test day". Shape: "<Day type>, <headline lift
  + load>": "Volume day, squat 112.5" / "Deadlift day, 145 single" / "Test
  day, deadlift 170". Bare day type when no number earns the slot. The
  headline is the session's DEFINING lift, whichever lift that is (a bench
  PR headlines bench), never squat by default. On PR days the number goes
  IN the title. "Pana" is internal coaching
  vocabulary, NEVER public: Fridays publish as "Deadlift day".
- ANALYSIS IS MANDATORY BEFORE WRITING (the ride mandate's analogue, his
  ruling Sep 1 2026). Compute from the gym tracker + debrief, never invent:
  (1) per-lift deltas vs the last SAME day-type session (Day N inherits
  from Day N); (2) working-set tonnage vs that day; (3) the headline
  lift's cycle-wave position (% of 1RM, week station); (4) cost
  localization from his debrief (which set/rep it got hard on, what was
  held or cut): the lift version of "154 on the flyover at km 31.7";
  (5) bar-speed numbers when a film review ran ("145 at 1.04s, same as
  140 two weeks back").
- Description: up to 3 SHORT lines, blank line between, watermark
  auto-appended. Each line = ONE analyzed metric WITH its comparison or
  location, max TWO numbers per line, no explainer sentences (the why
  stays in the private session; "held at 52.5, on purpose" is the entire
  permitted flavor). The title's headline lift may reappear ONLY carrying
  NEW numbers (its delta or speed, never its load again). Bad sets appear
  SAME-DAY, stated flat in his own log voice ("Bench 60 broke at rep 3,
  banked the 50s"); NEVER a comeback-arc narrative. No full exercise
  inventory: the lines carry the session's story, not its contents.
- Public-surface rules for lifts: loads, weights and reps ARE the content
  (his ruling Sep 1 2026). NO HR numbers in lift prose (his ruling: the
  grid already shows them and they mean little under a bar). NEVER:
  bodyweight or body-fat (pullups are "Pullups 8", never "BW 83"), the gym
  name or any location (a lift card has no GPS; do not add geography),
  cycle/week numbering, or WHOOP anything (daemon-enforced).
If no session composes within ~30 min the daemon names a still-generic card
by its weekday day-type and re-strips any surviving WHOOP text; the
session's later composition overwrites that fallback freely.

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
broadcasts), health__strava (write the composed title/description for a
ride.landed activity), health__config (event toggles, thresholds, quiet
hours), health__status (daemon).
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
        name: 'health__strava',
        description:
          'Write the composed title and/or description onto a Strava activity the daemon announced via ride.landed or lift.landed. The daemon enforces the guards: only a generic auto-name ("Morning Ride", "Afternoon Weight Training") or one of our own titles is replaced, only an empty, our own, or WHOOP-machine-written description is written, and an activity the user renamed by hand is refused. Returns what was actually written.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            activity_id: { type: 'number', description: 'The Strava activity id from the ride.landed / lift.landed event meta' },
            title: { type: 'string', description: 'The new title (plan vocabulary, honest, no stat-dump)' },
            description: {
              type: 'string',
              description: 'The ride description. PUBLIC surface: ride facts and coach read only, never WHOOP physiology.',
            },
            overwrite: {
              type: 'boolean',
              description: 'Pass true ONLY for a deliberate revision of an annotation a session already wrote. Without it, a second write to the same ride is refused (every connected session receives the same ride.landed; first writer wins).',
            },
          },
          required: ['activity_id'],
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
        case 'health__strava': {
          // 60s: the write path makes two Strava calls and the first call on
          // a cold daemon has been observed to blow the 10s default once.
          const result = await ipc.rpc(
            'strava_annotate',
            {
              activity_id: args.activity_id,
              title: args.title,
              description: args.description,
              overwrite: args.overwrite,
            },
            60_000,
          )
          return toolResult(JSON.stringify(result, null, 2))
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
