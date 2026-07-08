#!/usr/bin/env bun
// Live smoke test: pulls one page of every WHOOP resource through the typed
// client and exercises the token rotator. Requires setup to have run (config
// + Keychain). Never run from CI; it hits the real API.

import * as whoop from '../src/whoop.js'
import { forceRefresh, loadTokens } from '../src/auth.js'

const args = new Set(process.argv.slice(2))

function line(label: string, value: unknown) {
  console.log(`${label.padEnd(14)} ${value}`)
}

if (args.has('--rotate')) {
  const before = loadTokens()
  console.log('forcing a refresh cycle (proves rotation + persist)...')
  const after = await forceRefresh()
  line('rotated', before?.refresh_token.slice(0, 10) + '... -> ' + after.refresh_token.slice(0, 10) + '...')
  if (before?.refresh_token === after.refresh_token) {
    console.error('FAIL: refresh token did not rotate')
    process.exit(1)
  }
}

if (args.has('--single-flight')) {
  // Two concurrent forced refreshes must share ONE token request, or the
  // second one burns a single-use refresh token.
  const [a, b] = await Promise.all([forceRefresh(), forceRefresh()])
  if (a.refresh_token !== b.refresh_token) {
    console.error('FAIL: concurrent refreshes returned different tokens (single-flight broken)')
    process.exit(1)
  }
  console.log('single-flight OK: both callers got the same rotated token')
}

const profile = await whoop.getProfile()
line('profile', `${profile.first_name} ${profile.last_name} <${profile.email}>`)

const body = await whoop.getBodyMeasurement()
line('body', `${body.height_meter}m ${body.weight_kilogram}kg maxHR ${body.max_heart_rate}`)

const cycles = await whoop.getCycles({ limit: 3 })
line('cycles', `${cycles.records.length} records, latest strain ${cycles.records[0]?.score?.strain ?? 'n/a'} (state ${cycles.records[0]?.score_state})`)

const recoveries = await whoop.getRecoveries({ limit: 3 })
const r = recoveries.records[0]
line('recovery', r ? `${r.score?.recovery_score}% hrv ${r.score?.hrv_rmssd_milli}ms rhr ${r.score?.resting_heart_rate} calibrating=${r.score?.user_calibrating}` : 'none')

const sleeps = await whoop.getSleeps({ limit: 3 })
const s = sleeps.records[0]
line('sleep', s ? `perf ${s.score?.sleep_performance_percentage}% in-bed ${Math.round((s.score?.stage_summary.total_in_bed_time_milli ?? 0) / 60000)}min` : 'none')

const workouts = await whoop.getWorkouts({ limit: 3 })
const w = workouts.records[0]
line('workout', w ? `${w.sport_name} strain ${w.score?.strain} avgHR ${w.score?.average_heart_rate}` : 'none')

console.log('\nSMOKE PULL OK')
