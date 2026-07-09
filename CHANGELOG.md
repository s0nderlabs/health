# Changelog

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
