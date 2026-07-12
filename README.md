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
WHOOP band ──(BLE Broadcast HR)──> health-relay ──(WS, raw frames)──^
```

## What you get

- **Morning recovery brief**: score, band, HRV and RHR vs your 7-day baseline,
  sleep folded in, one actionable read. Delivered the moment you wake: WHOOP
  scores your sleep ~2 minutes after you get up, and that event ends quiet
  hours early (wake release; togglable).
- **Workout cards** when activities score (strain, HR, zones, calories).
- **Early-warning vitals alerts**, gated on multi-day patterns (never
  single-day dips; alert fatigue is treated as the #1 failure mode).
- **Strain crossings, bedtime nudges, trend alerts**: each togglable, all quiet
  by default.
- **Live heart rate** (optional): turn on the band's Broadcast Heart Rate and
  the bundled BLE relayer streams it into the daemon in real time. You get
  `/health live` (current BPM, zone, live resting HRV when still), automatic
  session detection (WHOOP cannot signal workout starts; a sustained-hot heart
  rate can), zone milestones during the session, and an end-of-session summary
  with the HR-recovery read.
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

### Live heart rate (optional)

Enable **Broadcast Heart Rate** in the WHOOP app, then build and install the
BLE relayer (macOS, near your body):

```bash
scripts/build-relayer.sh
bin/health-relay   # or install it under launchd for always-on
```

The relayer is a dumb pipe: it subscribes to the band's standard Bluetooth
Heart Rate service (matching device names against `WHOOP` by default; set
`HEALTH_RELAY_DEVICE` to override) and forwards every notification raw to the
daemon's loopback WebSocket (`live.port`, token-authenticated; the token is
generated into your config on first daemon start and never leaves the
machine). All parsing, session detection, zone logic, and HRV math happen in
the daemon, behind physiological artifact gates: optical wrist HR under
vibration can broadcast an impossible value (a double-count reads as ~2x your
true rate), and those frames are rejected before they can touch session
stats, counted in the live status, and logged with their raw bytes. Notes: the band normally streams to one receiver (a second can
only join by racing the brief post-drop advertising window; the daemon
orchestrates that at home), and broadcasting costs band battery, so many
people run it only during training.
If the packets carry RR intervals (WHOOP 5.0 does), `/health live` includes a
rolling resting rMSSD when you are still enough. macOS quirk: each rebuild of
the unsigned relayer binary re-triggers the Bluetooth permission check when
it runs under launchd; re-grant it in System Settings > Privacy & Security >
Bluetooth if the log stalls before "scanning".

### iPhone relayer + gym companion (optional)

`relayer-ios/` is a SwiftUI app that takes over as the band's receiver
whenever you are away from the Mac (gym, outside), speaking the same
raw-frame protocol over a tailnet-only `tailscale serve` HTTPS endpoint. At
home the daemon deliberately holds the band on BOTH receivers when it can
(the band accepts a second central when two connects race its advertising
window): the Mac writes the live record, the phone rides along as a hot
standby and takes over with zero gap if the Mac drops. Away, the phone is
the sole holder and is never interrupted: the daemon only orchestrates the
dual hold when both receivers have recently proven they can reach the band
(wifi alone is not trusted as a home signal), and never on cellular or low
battery.
Handover is silent in both directions: a parked phone keeps a pending BLE
connect armed, so walking out of the Mac's range hands it the band without
opening the app. The app adds: a Plan tab rendering the training
plan your main session's coach writes to `plan.json` (tap-to-expand ladders,
set-by-set completion, rest timers parsed from the plan's own prescriptions),
a one-tap workout intent that lands in your live Claude session (while a
session runs, the start button becomes a live session bar with an elapsed
timer and an in-app End, mirrored in the Plan header), a
lock-screen Live Activity (live BPM pulse card; during sessions a timer +
next-set card with a rest countdown and end button), and a HealthKit courier
that streams WHOOP-sourced step counts into the daily read. Build and
sideload with a free Apple ID (7-day re-sign; one-time Xcode signing setup):

```bash
scripts/build-phone.sh install   # phone paired + on the same Wi-Fi
```

## Sessions and routing

Sessions started with the health channel receive the event stream; every
session with the plugin loaded gets the tools (`/health`, config, status).
The channel is the opt-in:

```bash
claude --channels=plugin:health@s0nderlabs
```

Events queue durably and redeliver until some channel session acknowledges
one (an ack marks it done for all). Un-acked events retry across session
drops and reconnects; per-class expiry eventually retires anything nobody
was around to see (a three-day-old bedtime nudge helps no one).

## Configuration

Talk to it (`/health config`) or edit `~/.config/health/config.json`:
event class toggles, thresholds, quiet hours, daily event budget, poll
interval, webhook port/path, live-ingest port/max-HR/session threshold.

## Data + security posture

- Tokens and client secret: macOS Keychain only. WHOOP rotates refresh tokens
  on every use; the daemon persists the new one before anything can touch it.
- Archive: `~/.claude/channels/health/health.db` (SQLite). Back it up; it is
  your health history. A human-readable `daily-log.md` (one line per day) sits
  beside it, regenerated from the archive as a durable memory anchor.
- Webhook receiver binds 127.0.0.1 only; public exposure is your tunnel's job,
  and every request is HMAC-verified.
- The plugin's read scope is exactly WHOOP's six read scopes. It can write
  nothing to your WHOOP account.

## License

Apache-2.0. (c) s0nderlabs.
