// Event payload composer. Content is FACTUAL: numbers, state, drivers, and a
// terse suggested action. The receiving Claude session translates this into
// the coach voice per the plugin instructions; it never invents numbers.

import type { Store } from './store.js'
import type { WhoopRecovery, WhoopSleep, WhoopWorkout, WhoopCycle } from './types.js'

export type Band = 'green' | 'amber' | 'red'

export function recoveryBand(score: number): Band {
  if (score >= 67) return 'green'
  if (score >= 34) return 'amber'
  return 'red'
}

export function fmtDuration(milli: number): string {
  const totalMin = Math.round(milli / 60_000)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m`
}

const kcal = (kilojoule: number): number => Math.round(kilojoule * 0.239006)

export interface Baselines {
  hrv7: number | null
  rhr7: number | null
  resp7: number | null
  days: number
}

/** 7-day baselines from recoveries/sleeps strictly BEFORE the given sleep id. */
export function baselines(store: Store, excludeSleepId?: string): Baselines {
  const recs = store
    .recentRecoveries(8)
    .filter((r) => r.sleep_id !== excludeSleepId && r.score_state === 'SCORED')
  const sleeps = store.recentSleeps(8).filter((s) => s.id !== excludeSleepId)
  const mean = (xs: number[]): number | null =>
    xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null
  return {
    hrv7: mean(recs.map((r) => r.hrv_rmssd_milli as number).filter((x) => x != null)),
    rhr7: mean(recs.map((r) => r.resting_heart_rate as number).filter((x) => x != null)),
    resp7: mean(sleeps.map((s) => s.respiratory_rate as number).filter((x) => x != null)),
    days: recs.length,
  }
}

function delta(current: number, baseline: number | null): string {
  if (baseline == null || baseline === 0) return ''
  const pct = ((current - baseline) / baseline) * 100
  const sign = pct >= 0 ? '+' : ''
  return ` (${sign}${pct.toFixed(0)}% vs 7d)`
}

export function recoveryBrief(store: Store, r: WhoopRecovery): { content: string; meta: Record<string, string> } {
  const s = r.score
  const band = s ? recoveryBand(s.recovery_score) : 'amber'
  const base = baselines(store, r.sleep_id)
  const sleep = store.getSleepById(r.sleep_id)

  const parts: string[] = []
  if (s) {
    parts.push(`Recovery ${Math.round(s.recovery_score)}% (${band}).`)
    parts.push(`HRV ${s.hrv_rmssd_milli.toFixed(0)}ms${delta(s.hrv_rmssd_milli, base.hrv7)}, RHR ${Math.round(s.resting_heart_rate)}${delta(s.resting_heart_rate, base.rhr7)}.`)
    if (s.spo2_percentage != null) parts.push(`SpO2 ${s.spo2_percentage.toFixed(1)}%, skin temp ${s.skin_temp_celsius?.toFixed(1)}C.`)
  } else {
    parts.push(`Recovery arrived unscored (${r.score_state}).`)
  }
  if (sleep && sleep.in_bed_milli != null) {
    const perf = sleep.performance_pct != null ? `, ${Math.round(sleep.performance_pct as number)}% of need` : ''
    parts.push(`Sleep ${fmtDuration(sleep.in_bed_milli as number)} in bed${perf}, ${sleep.disturbance_count ?? 0} disturbances.`)
  }
  if (s?.user_calibrating) {
    parts.push('Still calibrating: treat the score as ballpark, not gospel.')
  }

  return {
    content: parts.join(' '),
    meta: {
      class: 'recovery.brief',
      score: s ? String(Math.round(s.recovery_score)) : 'n/a',
      band,
      calibrating: String(!!s?.user_calibrating),
      sleep_id: r.sleep_id,
    },
  }
}

export function workoutCard(w: WhoopWorkout): { content: string; meta: Record<string, string> } {
  const s = w.score
  const dur = fmtDuration(Date.parse(w.end) - Date.parse(w.start))
  const name = w.sport_name ?? 'workout'

  const parts: string[] = [`${name}, ${dur}.`]
  if (s) {
    parts.push(`Strain ${s.strain.toFixed(1)}, avg HR ${s.average_heart_rate}, max ${s.max_heart_rate}, ${kcal(s.kilojoule)} kcal.`)
    const z = s.zone_durations
    const zones: string[] = []
    if (z.zone_two_milli > 60_000) zones.push(`Z2 ${fmtDuration(z.zone_two_milli)}`)
    if (z.zone_three_milli > 60_000) zones.push(`Z3 ${fmtDuration(z.zone_three_milli)}`)
    if (z.zone_four_milli > 60_000) zones.push(`Z4 ${fmtDuration(z.zone_four_milli)}`)
    if (z.zone_five_milli > 0) zones.push(`Z5 ${fmtDuration(z.zone_five_milli)}`)
    if (zones.length) parts.push(`Zones: ${zones.join(', ')}.`)
    if (s.distance_meter) parts.push(`${(s.distance_meter / 1000).toFixed(2)}km.`)
  } else {
    parts.push(`Not scored yet (${w.score_state}).`)
  }

  return {
    content: parts.join(' '),
    meta: {
      class: 'workout.card',
      sport: name,
      strain: s ? s.strain.toFixed(1) : 'n/a',
      workout_id: w.id,
    },
  }
}

export function strainThreshold(c: WhoopCycle, threshold: number, recoveryScore: number | null): { content: string; meta: Record<string, string> } {
  const strain = c.score?.strain ?? 0
  const rec = recoveryScore != null ? ` Recovery today was ${Math.round(recoveryScore)}%.` : ''
  return {
    content: `Day strain crossed ${threshold.toFixed(1)} (now ${strain.toFixed(1)}).${rec}`,
    meta: {
      class: 'strain.threshold',
      strain: strain.toFixed(1),
      cycle_id: String(c.id),
    },
  }
}

export function vitalsAlert(drivers: string[], dedupeDate: string): { content: string; meta: Record<string, string> } {
  return {
    content: `Early-warning drift: ${drivers.join('; ')}. Multi-day pattern, not a single-day dip. Worth easing load and watching today.`,
    meta: { class: 'vitals.alert', drivers: String(drivers.length), date: dedupeDate },
  }
}

export function trendAlert(drivers: string[], dedupeDate: string): { content: string; meta: Record<string, string> } {
  return {
    content: `7-day trend moving the wrong way: ${drivers.join('; ')}.`,
    meta: { class: 'trend.alert', date: dedupeDate },
  }
}

export function bedtimeNudge(debtMilli: number, perfPct: number | null): { content: string; meta: Record<string, string> } {
  const perf = perfPct != null ? ` Last night was ${Math.round(perfPct)}% of need.` : ''
  return {
    content: `Sleep debt is ${fmtDuration(debtMilli)}.${perf} Earlier bedtime tonight buys tomorrow's recovery.`,
    meta: { class: 'bedtime.nudge', debt_milli: String(debtMilli) },
  }
}

export function calibrationNote(daysWorn: number): { content: string; meta: Record<string, string> } {
  return {
    content: `WHOOP is still calibrating (day ${daysWorn}). Scores firm up around day 4, baselines around day 30. Read direction, not absolutes.`,
    meta: { class: 'calibration.note', day: String(daysWorn) },
  }
}

export function systemHealth(problem: string): { content: string; meta: Record<string, string> } {
  return {
    content: `health daemon: ${problem}`,
    meta: { class: 'system.health' },
  }
}
