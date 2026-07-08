# health

Your body, talking to Claude, unprompted.

`health` is a Claude Code **channel plugin** that streams your WHOOP recovery,
sleep, and strain into Claude the moment your body produces them. A local
daemon archives every record your WHOOP account has ever generated, decides
what is worth saying, and pushes events into your live Claude Code session as
`<channel>` messages. Claude reads them as your coach: number first, drivers,
one actionable call.

```
WHOOP cloud ──(poll + webhooks)──> healthd (your Mac)
                                     ├─ SQLite archive (yours, forever)
                                     ├─ decision engine (quiet by design)
                                     └─> <channel> events ──> your Claude Code session
```

## What you get

- **Morning recovery brief**: score, band, HRV and RHR vs your 7-day baseline,
  sleep folded in, one actionable read.
- **Workout cards** when activities score (strain, HR, zones, calories).
- **Early-warning vitals alerts**, gated on multi-day patterns (never
  single-day dips; alert fatigue is treated as the #1 failure mode).
- **Strain crossings, bedtime nudges, trend alerts**: each togglable, all quiet
  by default.
- **`/health`**: today's read on demand. `/health trend` for the long view.
- **A permanent local archive** of your WHOOP data in one SQLite file.

## What this is not

- Not affiliated with, endorsed by, or supported by WHOOP. Unofficial.
- Not a medical device and not medical advice.
- Not a cloud service. There is no server, no telemetry, no analytics. Your
  health data never leaves your machine.

## Requirements

- macOS (Keychain and launchd are load-bearing), [bun](https://bun.sh)
- An **active WHOOP membership** (any paid tier) and a WHOOP 4.0/5.0/MG
- Your **own free WHOOP developer app** (single-tenant by design: your
  credentials, your data, your machine)
- Claude Code with channel support

## Install

```bash
/plugin install health@s0nderlabs
```

Then run setup from the plugin directory:

```bash
bun run setup
```

Setup walks you through: registering your WHOOP dev app, storing credentials
in the macOS Keychain (never on disk), the one-time OAuth consent, backfilling
your full history, and installing the always-on launchd daemon.

### Real-time webhooks (optional but worth it)

Polling alone gives a few minutes of lag. For push latency (~30 s from the
WHOOP cloud), expose the local receiver over HTTPS, for example with Tailscale
Funnel:

```bash
tailscale funnel --bg 8789
```

Register `https://<your-funnel-host>/whoop` as a webhook URL (Model Version
v2) in your WHOOP dashboard. The receiver verifies every request's HMAC
signature against your client secret; everything else is rejected.

## Sessions and routing

Events push to ONE session (default name `main`, set via `event_target`);
every session with the plugin loaded gets the tools (`/health`, config,
status). If you launch Claude Code through a wrapper script, load the channel
only where you want it:

```bash
claude --channels=plugin:health@s0nderlabs
```

## Configuration

Talk to it (`/health config`) or edit `~/.config/health/config.json`:
event class toggles, thresholds, quiet hours, daily event budget, poll
interval, webhook port/path, target session.

## Data + security posture

- Tokens and client secret: macOS Keychain only. WHOOP rotates refresh tokens
  on every use; the daemon persists the new one before anything can touch it.
- Archive: `~/.claude/channels/health/health.db` (SQLite). Back it up; it is
  your health history.
- Webhook receiver binds 127.0.0.1 only; public exposure is your tunnel's job,
  and every request is HMAC-verified.
- The plugin's read scope is exactly WHOOP's six read scopes. It can write
  nothing to your WHOOP account.

## License

Apache-2.0. (c) s0nderlabs.
