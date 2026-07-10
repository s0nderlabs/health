# Changelog

## 0.5.1 - 2026-07-10

### Fixed

- **Dual-up no longer attacks the live feed away from home.** The
  release-and-race orchestrator gated "am I home" on the phone reporting
  wifi, and gym wifi passes that test: the daemon repeatedly released the
  SOLE holder of the band mid-warmup to race a Mac that was kilometers away.
  A new long-memory reachability gate (when did each leg last deliver a band
  frame, surviving disconnects) now blocks any release unless the other leg
  demonstrably had the band within the last 10 minutes. Home blips still
  re-dual; away, the holder is never touched. `health__status` exposes the
  signal per relayer as `band_seen_ago_s`.
- **Dead lock-screen cards are reaped instead of adopted.** iOS hard-ends
  every Live Activity at its ~8h cap and the corpse lingers, silently
  swallowing updates: the pulse card froze, the session face never appeared,
  and the corpse's stale state force-disarmed a genuinely armed session on
  every app foreground (the plan kept reverting to a document mid-PR-day).
  The controller now only treats a live activity as current, ends corpses on
  foreground and session start, re-arms a fresh card (wearing the session
  face if a session is armed), and the card can no longer arm or disarm the
  session machine in either direction; the End button keeps its explicit path.
- **Start-button retries no longer double-notify.** A same-activity intent
  within 3 minutes is absorbed as a retry (one log entry, one event, normal
  ack), and the intent dedupe key now includes the activity so same-instant
  intents for different activities can never supersede each other.

## 0.5.0 - 2026-07-09

### Added

- **Coach schedule + calibration awareness.** `health__read` now returns
  `plan_today` (the /gym-authored session with an `is_today` freshness flag)
  and `calibration` (days of data + whether WHOOP still flags calibration),
  so the in-chat coach reads a rest day, a PR day, and an early-days score
  correctly instead of guessing.
- **Workout-intent labels stapled onto scored cards.** A tapped/spoken intent
  is logged with a plan-derived label and a PR flag (detected from the plan
  title), then claimed by the workout it best fits (in-window, closest to
  start, once only) so the scored card reads "Session: Deadlift 1RM Test (PR
  attempt)" and the archive is self-describing. Consume-once keying means a
  cooldown walk or a two-a-day can never wear another session's label, and a
  score revision keeps the label it already earned.
- **Daemon-maintained daily log** at `~/.claude/channels/health/daily-log.md`:
  one line per day (recovery, HRV, RHR, sleep, strain, steps), newest first,
  90 days, regenerated on every scored fact. The durable memory anchor that
  journal and gym tooling read instead of querying the archive.
- **Body-stat canon** documented for the coach: the gym log is canonical for
  body weight (the WHOOP profile value goes stale); max HR = the WHOOP
  profile value auto-raised by any higher observed workout max, and every
  zone derives from it. Zone max synced to 187 on both the daemon and phone.
- **tmux BPM status segment** wired into the status line at a 5s refresh.

## 0.4.0 - 2026-07-09

### Added

- **Dual connections (hot standby).** The band accepts a second BLE central
  when two connects land inside its post-drop advertising window; the daemon
  now maintains that state deliberately. Single-writer ingest: only the
  primary source (mac at home) feeds the live math while the standby's frames
  are shadowed, so a doubled stream can never pollute HR/HRV; a disconnect
  admission from the primary hands the pen to the standby with the very next
  frame (zero-gap failover). Dual-up orchestration: at rest, on wifi, with the
  phone power-eligible (charging or >=40%), the daemon releases the current
  holder so both standing anchors race back in; retries with cooldown, a
  per-epoch attempt cap, and a sticky strikeout backoff that reconnect or
  wifi-edge churn cannot re-arm. Losing a dual leg starts a grace period so a
  walk-out's surviving holder is never released mid-exit. Standbys draining
  below 35% unplugged are released (a spare connection is a wall-power
  luxury). The phone reports its role: the app and lock screen show
  "standby · Mac is live" instead of claiming the band.
- **`release` arbitration message + capability negotiation.** Relayers
  advertise caps in hello (mac: release; phone: release + battery); the
  daemon only orchestrates against clients that opted in. The mac relayer now
  parses inbound commands. Legacy pause-probes remain for cap-less clients.
- **`plan_today` in `health__read`**: the /gym-authored session (title, rest
  flag, lifts) with an `is_today` freshness flag, so the in-chat coach is
  never schedule-blind on rest days or PR days.
- **Documented wire format.** The server instructions now spell out the
  literal channel envelope, per-event-class meta attributes, the plan_today
  contract, and the dual/active_source semantics (active_source = the
  WRITER). No skill load is required for any of it.
- **tmux status segment** (`scripts/tmux-bpm.ts`): zone-colored live BPM off
  the daemon's IPC socket; prints nothing when there is no live feed.

### Fixed

- iOS pending-connect re-arm inside didDisconnect is now deferred ~50ms
  (CoreBluetooth can otherwise wedge in a phantom connecting state with no
  real pending connection).
- A relayer's `status connected:false` clears its feed freshness immediately
  instead of coasting on the staleness window, which also keeps the dual flag
  and the phone's role display truthful after a release.
- `/health` skill allowed-tools now include the installed plugin-scoped tool
  IDs (previously only the dev-channel form, which could permission-prompt).
- Plugin manifest no longer depends on CLAUDE_PLUGIN_ROOT as an environment
  variable (Claude Code stopped exporting it to plugin MCP spawns, which
  killed the server at launch with -32000); the path is now substituted as a
  whole argument, matching attn/inb0x.

## 0.3.1 - 2026-07-09

### Fixed

- **Locked-phone feed loss from reacquire probes.** The daemon's blind
  mac-reacquire probe told the phone to go radio-silent for 25 s; with the
  screen locked, iOS suspended the radio-silent app in seconds and the
  `resume` verdict landed on a socket nobody was reading, killing the live
  feed until the next foreground. Three-part fix: the phone now runs the
  whole pause window inside a UIKit background task and self-resumes before
  suspension if no verdict arrives; every reconnect path uses a no-timeout
  pending `connect()` to the remembered band (survives suspension and wakes
  the app the moment the band advertises) instead of a timer-driven rescan;
  and the daemon only probes phones that affirmatively report being on
  wifi (the phone reports its network path in `hello` and on every change),
  since a phone on cellular is away from home and the mac cannot win the
  probe anyway.
- **Silent walk-out handover.** Standdown now parks with the pending
  connect armed instead of turning the radio fully off, so leaving the
  mac's range hands the band to the phone in the background; previously the
  phone had to be foregrounded once after walking out.

## 0.3.0 - 2026-07-09

### Added

- **iPhone relayer + gym companion** (`relayer-ios/`, SwiftUI, sideloaded via
  `scripts/build-phone.sh install`). The phone is the band's receiver whenever
  the Mac is out of range: same raw-frame WebSocket protocol over a
  tailnet-only `tailscale serve` HTTPS endpoint, mac-priority arbitration
  refereed by the daemon (`standdown` / `resume` / rest-only blind `pause`
  probes; freshness = frame arrival time), capture-first client so a dead link
  never costs frames.
- **HealthKit steps courier**: WHOOP-sourced step samples stream to the daemon
  with an ack-gated anchored query (batch paging, deletion forwarding so a
  revised hour can never double-count) into a new `steps_samples` table;
  `steps_today` joins the `health__read` surface and daily totals join
  `health__trend`.
- **Plan pipeline**: the `/gym` skill writes `plan.json` (atomic rename); the
  daemon watches it (mtime-checked), pushes `plan_updated` to connected
  relayers, and serves token-authed `GET /plan`. The phone renders every plan
  shape through ONE session component: ordered lift rows, tap-to-expand
  ladders (ramp / working / AMRAP / back-off tones, PR rungs in accent,
  conditional rungs outlined), structured `amrap` + `backoff` fields.
- **Workout intent**: one tap on the phone (plan-first sheet: today's session
  title is a single coral button) lands a `workout.intent` event in the live
  Claude session.
- **Lock-screen Live Activity**, two faces: a pulse card (live BPM + zone any
  time the phone holds the band) and a session card (plan title, native
  elapsed timer, BPM, next-set pointer, End button). Updates are serialized
  full-state snapshots from the BLE runloop; the pulse card survives Mac
  handback so BPM can return without a foreground re-arm.
- **Exercise completion + rest timers**: starting today's session arms the
  plan; checking a set off starts its prescribed rest (parsed from the plan's
  own rest strings, ranges resolve to the generous end), mirrored as an in-app
  countdown pill, a lock-screen countdown, and a "rest over" notification that
  also presents in-foreground. Hold a lift to bulk-complete it. Completion is
  keyed to the plan's date + generation so a regenerated plan starts clean.
- **Liquid-glass UI pass**: app icon (coral pulse mark), glass surfaces +
  capsule geometry throughout, ambient warm radials, hidden scroll indicators,
  SF Rounded display voice, true multiplication glyphs in schemes.

### Fixed

- devicectl device-ID extraction in `build-phone.sh` (model names contain
  spaces; extract the UDID by shape).
- Adversarial-review fixes shipped in the same pass: Live Activity
  read-modify-write races (serial snapshot pipeline), same-day plan
  regeneration remapping positional checkmarks, stale auto-expansion leaking
  across plans, and the streaming heart animation freezing at its first
  cadence.

## 0.2.0 - 2026-07-09

### Added

- **Live heart rate.** A bundled macOS BLE relayer (`relayer/health-relay.swift`,
  built via `scripts/build-relayer.sh`) subscribes to the band's Broadcast
  Heart Rate and streams every notification raw into the daemon over a
  token-authenticated loopback WebSocket. The daemon parses the standard
  Heart Rate Measurement format once (`src/hrparse.ts`), runs a live state
  machine (`src/livestate.ts`), and emits three new event classes:
  `live.session` (a sustained-hot heart rate auto-detects the workout start
  WHOOP itself cannot signal), `live.zone` (first sustained entry into Z3-Z5,
  once per zone per session), and `live.rest` (end-of-session summary with
  the 60-second HR-recovery read). Session summaries persist to a new
  `live_sessions` table; summaries describe the work, not the cooldown tail.
- **`health__live` tool + `/health live`**: current BPM, zone, feed health,
  session progress, and a rolling 5-minute resting rMSSD computed from RR
  intervals with artifact rejection (adjacent-beat pairing only, physiological
  range + max-jump filters); reports only when the wearer is still enough to
  trust.
- **Wake release**: WHOOP scores your sleep ~2 minutes after you get up, and
  that event now lifts the quiet-hours hold, so the morning recovery brief
  arrives when you wake instead of at the window boundary. Guarded to the
  final 3 hours of the window (a scored mid-night sleep fragment never flushes
  events at 2:30am) and re-arms every night. Togglable via
  `quiet_hours.wake_release`.
- Live-ingest config block (`live`: port, bind, token, max_hr, hot_bpm); the
  session threshold auto-derives from your resting HR via heart-rate reserve
  when not set.

### Fixed

- Channel detection now walks the ancestor process chain to the NEAREST
  claude process (v0.1.1's single-hop check never subscribed in real sessions
  because the manifest's runner sits between; and an unbounded walk would let
  nested claude sessions ack events into a void).
- `config_set` deep-merges the `live` and `quiet_hours` blocks: a partial
  patch can no longer wipe the relayer token or drop quiet-hours fields (which
  could crash-loop the daemon).
- The daemon never rewrites a malformed config file (repairable by hand)
  and config saves are atomic; the live-ingest token is redacted from
  `config_get`/`config_set` responses so it cannot land in transcripts.
- Live events bypass the quiet-hours hold (a workout proves you are awake)
  and are excluded from the daily budget count so training days cannot starve
  the recovery brief; moment-bound live events expire quickly if undelivered.
- The relayer only ever binds devices matching a name filter (default WHOOP,
  `HEALTH_RELAY_DEVICE` to override), never an arbitrary nearby HR strap; it
  recovers from Bluetooth power cycles, discovery/subscription failures, and
  silent streams, and its reconnect path no longer leaks sessions or ping
  chains.
- A live-listener bind failure or a bad frame degrades to live-HR-off instead
  of taking the whole daemon down; relayer clock skew cannot starve the feed.
- Session detection uses real elapsed time (a lossy sub-1Hz feed no longer
  slows milestone detection 4.5x), and a feed gap longer than the relayer's
  offline buffer is required before a session is declared over.

## 0.1.1

### Changed

- Events now broadcast to every channel-enabled session instead of routing to
  a single configured target (`event_target` removed from config and tools).
  Loading the plugin with the channel IS the subscription; first ack marks an
  event delivered for all.
- Channel-less sessions (a plugin's MCP server auto-loads in every CC session)
  now identify themselves and get tools only: they can no longer receive and
  silently swallow events Claude Code would never render.
- Delivery hardening: per-recipient in-flight tracking (no duplicate injection,
  latecomer sessions get targeted pushes of still-undelivered events, an event
  whose recipients all drop redelivers) plus a 60-second ack TTL so a failed
  handler or suspended session cannot strand an event.
- The plugin manifest is dual-mode: `${CLAUDE_PLUGIN_ROOT:-.}` resolves to the
  plugin cache when installed and to the repo when loaded as a dev channel
  (`claude --dangerously-load-development-channels=server:health` from the repo
  root now works for local development).

## 0.1.0

Initial release. The full loop, local-only:

- `healthd` daemon (launchd, always-on): Keychain-backed token rotator with
  single-flight refresh and persist-before-use rotation handling; typed WHOOP
  v2 client (pagination, 429 via X-RateLimit-Reset); SQLite archive with full
  first-run backfill and idempotent upserts; reconciliation poller; HMAC-verified
  webhook receiver (localhost-only, tunnel-friendly).
- Decision engine, quiet by default: recovery briefs, workout cards, strain
  crossings, multi-day-gated vitals alerts, trend alerts, bedtime nudges,
  calibration notes, daemon health. Class toggles, cooldowns, daily budget,
  quiet hours.
- Channel injection into Claude Code sessions (single target session, offline
  queue with supersede + expiry, ack-based delivery).
- MCP tools: `health__read`, `health__trend`, `health__workout_intent`,
  `health__config`, `health__status`; `/health` skill.
- Guided onboarding: dev-app registration, Keychain, OAuth consent, backfill,
  launchd install.

Hardening in this release (from an adversarial code review): re-scored recoveries
supersede a stale queued brief instead of being suppressed; the poller reconciles
by a fixed occurrence-time window so late edits to older records are caught;
the daemon singleton guard verifies the PID is actually healthd (survives reboot
PID reuse); a partial first backfill no longer replays history as fresh events;
socket writes handle backpressure so large trend frames never truncate; un-acked
events are not re-injected as duplicates; the daily budget counts events queued,
not just delivered; setup stops a running daemon before touching the single-use
refresh token; and a failed OAuth exchange fails setup cleanly instead of hanging.
