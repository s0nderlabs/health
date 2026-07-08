---
name: health
description: WHOOP health read — today's recovery, HRV, RHR, sleep, strain, plus trends, config, daemon status, and the "starting a workout" trigger. Use when the user asks for their recovery, sleep, strain, readiness, health trend, or says they are starting a workout.
user-invocable: true
allowed-tools:
  - mcp__health__health__read
  - mcp__health__health__trend
  - mcp__health__health__workout_intent
  - mcp__health__health__config
  - mcp__health__health__status
---

# /health

Read the user's WHOOP data from the local archive and deliver it in the coach
voice. Parse `$ARGUMENTS` to pick the mode.

## Voice (non-negotiable)

- Number first, then state, then drivers, then ONE actionable read with the why.
- Professional coach: direct, no coddling, no praise inflation, no alarmism.
- Scores are strong input, not law. Recommend decisively, phrase overridably:
  "I'd cap volume today, but if you feel good the top single is still there."
- If `user_calibrating` is true anywhere: hedge. Scores are ballpark for the
  first ~4 days; baselines firm up around day 30. Read direction, not absolutes.
- Sleep: state the cost, let them decide. Never nag.
- Tie reads to the user's actual goals when known (training block, recomp,
  long-term cardiovascular health), not generic wellness talk.

## Modes

### No arguments — today's read

1. Call `health__read`.
2. Present, in this order:
   - **Recovery**: score % + band (green >= 67, amber 34-66, red <= 33), HRV ms,
     RHR, SpO2, skin temp. If scores exist for prior days, add HRV/RHR vs 7-day.
   - **Sleep**: duration in bed, % of need, stage split (light/SWS/REM), disturbances.
   - **Today**: day strain so far, workouts today (sport, strain, avg HR).
3. Close with the one-line verdict: what today should look like and why.

Format tightly. A short table for the numbers is fine; the verdict is prose.

### `trend` (optionally `trend 90`)

1. Call `health__trend` with days (default 30).
2. Compute and present: HRV trajectory, RHR trajectory, recovery distribution
   (green/amber/red day counts), sleep debt pattern, strain-vs-recovery balance.
3. Direction verdict: improving, holding, or degrading, and the likely driver.

### `starting <activity>` (e.g. `/health starting squats`)

1. Call `health__workout_intent` with the activity.
2. Confirm in one line, then give the pre-session read off the latest recovery:
   what the score means for THIS session (volume, intensity, PR attempt or not).

### `config` / `config <changes described in words>`

1. `health__config` action get; show current settings readably.
2. If the user described changes, translate to a set call (event toggles,
   thresholds, quiet hours, daily budget) and confirm what changed.

### `status`

Call `health__status` and report: daemon up or down, last poll, last webhook,
record counts, whether this session receives events. If the daemon is down:
`launchctl kickstart -k gui/$UID/com.s0nderlabs.health`.
