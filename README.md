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
- **A data-freshness watchdog**: if no poll has succeeded for 90 minutes
  (whatever the cause: burned token, network, WHOOP outage), the daemon raises
  one loud alert per broken day instead of failing silently.
- **Live heart rate** (optional): turn on the band's Broadcast Heart Rate and
  the bundled BLE relayer streams it into the daemon in real time. You get
  `/health live` (current BPM, zone, live resting HRV when still), automatic
  session detection (WHOOP cannot signal workout starts; a sustained-hot heart
  rate can), zone milestones during the session, and an end-of-session summary
  with the HR-recovery read. Zones are Karvonen (% of heart-rate reserve over
  a rolling 7-day median resting HR), matching WHOOP's own bands. Detection is confidence-tiered: HR level alone
  cannot separate a warmup from a hot shower, so a session only earns coach
  attention once it shows an exercise signature (set/interval structure,
  sustained depth, or your declared intent); an unconfirmed elevation is
  demoted at the end instead of counting as training load, then upgraded
  automatically if WHOOP later scores an overlapping workout.
- **Band yield** (Strava handoff): the relayers hold the band's broadcast
  exclusively, and a held band never advertises, so other apps can never pair
  it as a sensor. One tap in the phone app (or `/health yield`) disarms every
  relayer so Strava can take the broadcast for a recording; reclaim with a
  tap, a command, or window expiry. Indefinite yields never auto-reclaim
  (a daily reminder nags instead), yields survive daemon and relayer
  restarts, and a relayer that misses its disarm is re-pushed and surfaced
  loudly. Live coaching is dark while yielded, by contract; WHOOP's own
  recording and scoring are unaffected.
- **Food log** (calorie + protein tracker, baseline first): snap a meal or
  type it ("americano") on the phone, or log it in chat with text or photo
  paths. Your Claude session estimates each meal per item (grams, kcal with
  a range, protein) and the number lands back on the phone and in chat.
  Corrections are a full re-estimate with the history kept; repeat meals
  become presets. Weigh-ins flow in from Apple Health (any scale app that
  writes there), and each one becomes a `body.weighin` event: weight, body
  fat and the change from your last counted reading. Readings that should
  not drive the trend (a test before your start date, outside the morning
  window, a second reading that morning, or far enough off to be someone
  else) are still shown, labelled and excluded; you can flip any of them.
  There is no calorie
  target until your own logs and weigh-in trend have measured maintenance
  (14 complete days + 8 weigh-ins); protein has a target from day one.
  WHOOP's daily burn sits next to intake, labelled uncalibrated until that
  baseline exists; then a calibration factor (measured maintenance over
  WHOOP's own number) turns it into a daily balance with an error band,
  "so far" for today and never projected. Record anything that moves the
  scale without moving fat (a creatine start, a diet change, travel) as a
  confounder and the baseline stays provisional, reported as a range,
  until its window closes. An optional goal record (body-fat %, milestone,
  lean-mass reference) shows the weight that goal implies.
- **Zero-tap scale** (optional, Xiaomi S400): a tiny passive Bluetooth
  listener on the Mac picks up the scale's encrypted broadcasts and files
  each weigh-in with its exact time, no phone tap. A one-time
  `bun scripts/scale-bindkey.ts` fetches the scale's key through a QR-code
  login to your Xiaomi account (no password; only the key is kept, in the
  macOS Keychain). Build the listener with `scripts/build-scale.sh`, copy it
  to `~/.local/bin`, and load `relayer/com.s0nderlabs.health.scale.plist.template`
  as a LaunchAgent (it asks for Bluetooth permission once). Its body-fat
  value is calibrated against the scale's own app whenever both record the
  same weigh-in, and it adds formula estimates of visceral fat, muscle,
  water, protein, bone and BMR, each labelled with how far to trust it.
  The phone app's Body tab shows it all: the latest weigh-in and trend, a
  body-composition figure, goal progress and the weigh-in history. Readings
  far from your recent weight (a housemate on the same scale) are filed as
  someone else's and can be reclaimed.
  Photos are converted to plain JPEGs with GPS and all other metadata
  stripped; your originals are never touched.
- **Money notifications** (optional): an iOS Shortcuts automation forwards
  notifications from every app that touches your money (banks, e-wallets,
  marketplaces, crypto wallets) to the daemon the moment they land. Amount,
  currency, merchant and balance are parsed, the raw text is kept, and a
  `money.notif` event lets your session run its budget flow. One-time codes
  are dropped before anything is stored; marketplace and super-app
  marketing is dropped too (only real payments, refunds, top-ups, transfers,
  declines and bills survive), and so are loan, contest and amountless ad
  pushes from banks, never a text saying money actually moved. Moves
  between your own pockets or accounts (`money.own_names` in the config)
  are internal, and card authorization requests are pending, neither
  counted as spending; a zero or dust-sized crypto deposit is
  flagged as possible address poisoning, never counted as income. Setup: [guides/money-notifications.md](guides/money-notifications.md).
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
your full history, and installing the always-on launchd daemon. Re-running it
is always safe and is also the recovery path: it validates the stored tokens
and only asks for a fresh consent if WHOOP has actually rejected them.

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

### Ride watcher (optional)

If your rides are recorded by a bike computer and uploaded to a training
platform, the daemon can watch for each upload, announce it into your
sessions the moment it lands (closing the "did my ride sync yet" loop), and
give the activity a real title and description in place of the generic
auto-name. Claude composes the text in-session from your training plan and
the ride data; a deterministic plan-derived fallback covers the case where
no session is live. Strict guards: only generic auto-names are ever
replaced, only an empty description is filled, and anything you rename by
hand is left alone forever. Bring your own API app and run
`bun run setup:strava` (consent + webhook subscription) to enable it.

The same watcher also covers the lift cards WHOOP itself pushes to the
platform. WHOOP's auto-description publishes your strain score on every
one; the daemon strips that line seconds after upload, no session needed,
and announces the card so Claude can title it and write a real training
note after you debrief the session (the card alone carries no sets or
loads, so composition deliberately waits for your report). A weekday
fallback names anything no session gets to.

### Live heart rate (optional)

Enable **Broadcast Heart Rate** in the WHOOP app, then build and install the
BLE relayer (macOS, near your body):

```bash
scripts/build-relayer.sh
bin/health-relay   # or install it under launchd for always-on
```

If you run it under launchd, copy the binary somewhere OUTSIDE `~/Documents`
(e.g. `~/.local/bin`) and point the LaunchAgent there: Documents is
TCC-protected, and a launchd spawn of a rebuilt binary from a protected
folder wedges silently in dyld with no way to prompt.

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
plan your main session's coach writes to `plan.json` (tap-to-expand ladders
where every working, back-off, and bodyweight set is its own checkmark;
checking a set starts its prescribed rest, with an audible chime when rest
ends: in-app it beats the mute switch and ducks your music, locked it rides
the rest-over notification). Double days split into a Ride / Lift toggle;
the ride face is a read-only viewer (steps, cues, an HR readout in words,
an optional route preview from a GPX the daemon serves out of its `routes/`
dir, an optional fuelling clock) that never touches the band, so a head
unit can hold it on the road. A sideload clock reads the embedded
provisioning profile and counts down to the free-team signature expiry
(in-app, a notification the day before, and up to the daemon so
`/health status` reports the real date),
a one-tap workout intent that lands in your live Claude session (while a
session runs, the start button becomes a live session bar with an elapsed
timer and an in-app End, mirrored in the Plan header), a
lock-screen Live Activity (live BPM pulse card; during sessions a timer +
next-set card with a rest countdown and end button), a HealthKit courier
that streams WHOOP-sourced step counts into the daily read, a Food tab (the
day's kcal and protein ring, meals with thumbnails, one-tap photo or text
capture through an offline-safe outbox, a fix line per meal), weigh-ins
(body mass and body fat from Apple Health, for the food log's baseline), and
a "Log Money Notification" Shortcuts action for forwarding bank and wallet
alerts (see the money notifications guide). Build and
sideload with a free Apple ID (7-day re-sign; one-time Xcode signing setup):

```bash
scripts/build-phone.sh install   # phone paired + on the same Wi-Fi
```

#### Auto re-sign (optional)

A free team signature lasts 7 days. Auto re-sign keeps it alive without a
cable: a separate LaunchAgent (`com.s0nderlabs.health.resign`, every 15
min) mints a fresh profile with Xcode inside the last 72h, stages the
signed build, and installs it over Wi-Fi when the phone is unlocked at home
and nothing live is running (no open session, no fresh workout intent, no
yield, the phone not the band writer). It never alerts on its own: it
writes facts to `~/.claude/channels/health/resign/` and the daemon turns
them into `system.health` events (one per failure episode, clock tiers at
48/24/8h). Under 24h with no renewal it also pushes a notification to the
phone (through the app, with sound) and one to the Mac, so you hear about it
even with no Claude session open. The legacy 48h nag stays on as the
backstop whenever the automation is off, dry, or has gone quiet.

The build input is a snapshot of the code that is actually on the phone,
kept outside protected folders (`~/Library/Application Support/health-resign`);
`scripts/build-phone.sh install` refreshes it after every verified install.
It also refuses a build whose app or widget profile was not freshly minted
(a reused cached profile installs a build that dies on the old date);
`HEALTH_ALLOW_STALE_PROFILE=1 scripts/build-phone.sh install` installs anyway
when no fresh mint is possible.

```bash
bun run resign seed --ref <commit of the installed build>   # first time only
bun run resign install-agent        # harmless while disabled
bun run resign plan                 # read-only: every gate and probe
bun run resign kick --dry-run       # the same, in the launchd context
bun run resign kick --force         # a supervised real run
# then health__config {resign: {device_udid: "<UDID>", enabled: true}}
bun run resign status
```

Enabling needs `system.health` events on. `device_udid` is the phone's
hardware UDID (`xcrun devicectl list devices`) and stays in your local
config. A changed signing certificate is never installed unattended (the
phone needs a Trust tap), and an Apple ID that needs a password or 2FA can
only be reported, never fixed headless.

The loud subset (the 24h and 8h tiers, expiry, and a hard failure with 24h
or less left) also goes out as notifications: a local notification on the
phone over the relayer socket (resent until acked, and at every phone
hello) and a native Mac banner via `osascript`. macOS attributes those
banners to Script Editor and drops them silently until it is allowed once:
run `osascript -e 'display notification "test" with title "health"'` from
a terminal and allow Script Editor in System Settings > Notifications.

The app never depends on DNS to find the daemon. iCloud Private Relay (and
any encrypted-DNS app) resolves names outside Tailscale's MagicDNS, and a
`ts.net` name with Funnel enabled also has public records, so a plain lookup
can land on the wrong address. Instead, every daemon request goes through a
small HTTP CONNECT tunnel on the phone's loopback interface that splices
raw TCP to the Mac's tailnet IP, while URLSession keeps speaking TLS end to
end to the `ts.net` name (normal SNI and certificate checks). The app
learns the tailnet IP by asking Tailscale's own resolver (100.100.100.100)
directly and keeps it only after a `/healthz` check through the tunnel
passes; it re-learns on foreground and after repeated socket failures.
Settings has a Find button and accepts a typed IP (`tailscale ip -4` on
the Mac). Clearing the field by hand switches back to the plain hostname
path.

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
interval, webhook port/path, live-ingest port/max-HR/session threshold, and
the food log (`food.protein_target_g`, `food.rollover_hour` for when the
food day ends, `food.deficit_kcal` subtracted from measured maintenance).

## Data + security posture

- Tokens and client secret: macOS Keychain only. WHOOP rotates refresh tokens
  on every use; the daemon persists the new one before anything can touch it.
- Archive: `~/.claude/channels/health/health.db` (SQLite). Back it up; it is
  your health history. A human-readable `daily-log.md` (one line per day) sits
  beside it, regenerated from the archive as a durable memory anchor.
- Webhook receiver binds 127.0.0.1 only; public exposure is your tunnel's job,
  and every request is HMAC-verified.
- Meal photos live beside the archive (`meals/`), re-encoded with every
  metadata segment except color data removed. The phone talks to the daemon
  only over your tailnet, with the same token as the live feed.
- The plugin's read scope is exactly WHOOP's six read scopes. It can write
  nothing to your WHOOP account.

## License

Apache-2.0. (c) s0nderlabs.
