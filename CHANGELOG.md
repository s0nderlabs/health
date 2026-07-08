# Changelog

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
