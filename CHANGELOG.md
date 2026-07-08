# Changelog

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
