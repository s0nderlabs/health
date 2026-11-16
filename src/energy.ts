// Energy balance: WHOOP burn per food day, the calibration factor, and the
// day balance. Pure functions (unit tested); FoodService wires them to the DB.
//
// The rules (locked spec, Nov 16 2026):
// - burn_kcal = WHOOP cycle kilojoule / 4.184. WHOOP is NEVER an input to the
//   maintenance estimate; it is only scaled against it.
// - Each cycle goes WHOLE to the food day (04:00 local rollover) it overlaps
//   most. No pro-rata kJ split, ever.
// - A food day is FULL coverage only when exactly one scored cycle claims it
//   with >= 80% of that cycle's span inside the day, and no other cycle owns
//   a big share of the day. The bound is symmetric: a cycle that spills more
//   than 20% of a day OUTSIDE it (a 27 h cycle) is as partial as one that
//   covers less than 80% of it. Everything else is still shown, labelled
//   with a reason, and kept out of the calibration factor.
// - factor = measured maintenance / mean WHOOP burn over the complete, fully
//   covered days. The maintenance numerator is computeBaseline's own (intake
//   over ALL complete days of the window, paired with the slope those days
//   produced); the fully covered subset only sets the mean burn. balance =
//   intake - burn x factor, with a band from the logging ranges and the
//   factor's own error. Today is "so far", never projected.

import { addDays, foodDay } from './meals.js'

export const KJ_PER_KCAL = 4.184
/** A claiming cycle must have this share of its span inside the day, and
 *  own this share of the day itself (else another cycle owns a big share). */
export const CLAIM_SHARE = 0.8
/** Sleep onset this far past the rollover shifts the burn window off the food day. */
export const SLEEP_GRACE_MS = 30 * 60_000
/** Fewest complete, fully covered days a factor is fitted on. */
export const MIN_FACTOR_DAYS = 7
/** The stored factor is refreshed at most this often outside a baseline read. */
export const CALIBRATION_MAX_AGE_MS = 7 * 86_400_000
/** sleep_after_0400 on more than this share of baseline days raises a flag. */
export const SLEEP_FLAG_RATE = 0.3
/** A factor outside this range is implausible (wrist kJ overstates, so expect
 *  < 1): it is not stored or used, and the baseline says why. */
export const FACTOR_SANE = { lo: 0.6, hi: 1.1 }
/** Mean intake on the fully covered days vs all complete days: a gap this big
 *  means the excluded days eat differently, worth a flag. */
export const INTAKE_GAP_FLAG_KCAL = 150

export type ExclusionReason = 'sleep_after_0400' | 'split_cycle' | 'unscored' | 'partial_day' | 'in_progress'
export const EXCLUSION_REASONS: ExclusionReason[] = ['sleep_after_0400', 'split_cycle', 'unscored', 'partial_day', 'in_progress']
export type Coverage = 'full' | 'partial' | 'none'

export interface CycleRec {
  id: number | string
  start: string
  end: string | null // null = the in-progress cycle
  score_state: string | null
  kcal: number | null
}

export interface DayBurn {
  date: string
  burn_kcal: number | null
  coverage: Coverage
  reason: ExclusionReason | null
  cycle_ids: Array<number | string>
}

/** The food day's absolute bounds, consistent with foodDay(): [D 00:00 + R h, D+1 00:00 + R h). */
export function dayBounds(day: string, rolloverHour: number): { start: number; end: number } {
  const [y, m, d] = day.split('-').map(Number)
  return {
    start: new Date(y, m - 1, d).getTime() + rolloverHour * 3_600_000,
    end: new Date(y, m - 1, d + 1).getTime() + rolloverHour * 3_600_000,
  }
}

const overlap = (s: number, e: number, b: { start: number; end: number }) => Math.max(0, Math.min(e, b.end) - Math.max(s, b.start))
const scored = (c: CycleRec) => c.score_state === 'SCORED' && c.kcal != null && c.kcal > 0

/** WHOOP burn for each requested food day, with coverage + exclusion reason. */
export function burnByDay(
  cycles: CycleRec[],
  days: string[],
  o: { nowMs: number; rolloverHour: number; today: string },
): Map<string, DayBurn> {
  const R = o.rolloverHour
  const spans = cycles
    .map((c) => {
      const s = Date.parse(c.start)
      const endMs = c.end ? Date.parse(c.end) : null
      return { c, s, e: endMs ?? Math.max(o.nowMs, s), open: endMs == null }
    })
    .filter((x) => Number.isFinite(x.s) && Number.isFinite(x.e) && x.e >= x.s)

  // Claim: the food day each cycle overlaps most. An open cycle is placed by
  // its nominal 24 h (placement only: its kJ is what WHOOP reports so far),
  // so a cycle that began at 01:30 belongs to the waking day, not the night.
  const claims = new Map<string, typeof spans>()
  for (const x of spans) {
    const ae = x.open ? Math.max(x.e, x.s + 86_400_000) : x.e
    if (!(ae > x.s)) continue
    let best: string | null = null
    let bestOv = -1
    let d = foodDay(x.s, R)
    const last = foodDay(ae - 1, R)
    for (let i = 0; i < 10 && d <= last; i++, d = addDays(d, 1)) {
      const ov = overlap(x.s, ae, dayBounds(d, R))
      if (ov > bestOv) {
        bestOv = ov
        best = d
      }
    }
    if (best) claims.set(best, [...(claims.get(best) ?? []), x])
  }

  const out = new Map<string, DayBurn>()
  for (const day of days) {
    const b = dayBounds(day, R)
    const daySpan = b.end - b.start
    const mine = claims.get(day) ?? []
    const touching = spans.filter((x) => overlap(x.s, x.e, b) > 0)
    const scoredMine = mine.filter((x) => scored(x.c))
    const burn = scoredMine.length ? Math.round(scoredMine.reduce((n, x) => n + x.c.kcal!, 0)) : null

    let reason: ExclusionReason | null = null
    if (day >= o.today || mine.some((x) => x.open)) reason = 'in_progress'
    else if (mine.length === 0 && touching.length === 0) reason = 'unscored' // no WHOOP record at all
    else if (mine.some((x) => !scored(x.c))) reason = 'unscored'
    else if (mine.length === 0) reason = 'partial_day' // only neighbours' spill-over touches it
    else if (mine.length >= 2) reason = 'split_cycle'
    else {
      const x = mine[0]
      const ov = overlap(x.s, x.e, b)
      // Symmetric: at most 20% of the cycle's span may sit outside the day
      // (relative to the day), just as at least 80% of the day must be inside it.
      if (ov < CLAIM_SHARE * (x.e - x.s) || x.e - x.s - ov > (1 - CLAIM_SHARE) * daySpan) reason = 'partial_day'
      else if (ov < CLAIM_SHARE * daySpan) {
        const others = touching.filter((y) => y !== x).reduce((n, y) => n + overlap(y.s, y.e, b), 0)
        reason = others >= (1 - CLAIM_SHARE) * daySpan ? 'split_cycle' : 'partial_day'
      } else if (x.s > b.start + SLEEP_GRACE_MS || x.e > b.end + SLEEP_GRACE_MS) reason = 'sleep_after_0400'
    }
    out.set(day, {
      date: day,
      burn_kcal: burn,
      coverage: burn == null ? 'none' : reason == null ? 'full' : 'partial',
      reason,
      cycle_ids: mine.map((x) => x.c.id),
    })
  }
  return out
}

// ── calibration ───────────────────────────────────────────────────

export interface Calibration {
  factor: number
  factor_lo: number
  factor_hi: number
  computed_at: string
  n: number // complete, fully covered days the mean burn is taken over
  window: { from: string; to: string }
  maintenance: number // measured maintenance: intake over ALL complete days - slope x 7,700
  mean_burn_kcal: number
  burn_se_kcal: number // sampling error of the mean burn (SD / sqrt(n)), in the band
  mean_intake_kcal: number // all complete days of the window (the numerator)
  intake_days: number
  mean_intake_full_days_kcal: number // the fully covered subset only (cross-check)
  intake_gap_kcal: number // full-days mean minus all-days mean
  slope_kg_per_week: number
  provisional: boolean // fitted while a confounder window was open (bracket-central slope)
  flag: string | null
}

const r3 = (n: number) => Math.round(n * 1000) / 1000

export interface CalibrationParams {
  days: Array<{ date: string; kcal: number; complete: boolean }>
  burns: Map<string, DayBurn>
  window: { from: string; to: string }
  slope: { central: number; lo: number; hi: number } // kg per day
  kcalPerKg: number
  provisional: boolean
  nowIso: string
}

/**
 * factor = (mean intake over ALL complete days - slope x 7,700) / mean WHOOP
 * burn over the complete, fully covered days. The numerator is the baseline's
 * own maintenance: intake and weight slope cover the same period (the days a
 * coverage rule drops, mostly late nights, are where the late eating happens,
 * so averaging intake over the covered subset alone would bias it low). The
 * factor band carries the weight trend's error (slope +- SE, widened by the
 * confounder bracket while provisional) and the mean burn's sampling error:
 * logging error is applied once, on the day, in the balance. An implausible
 * factor (outside FACTOR_SANE) is rejected with the reason.
 */
export function calibrate(p: CalibrationParams): { cal: Calibration | null; issue: string | null } {
  const inWin = p.days.filter((d) => d.date >= p.window.from && d.date <= p.window.to && d.complete && d.kcal > 0)
  const S = inWin.filter((d) => {
    const b = p.burns.get(d.date)
    return b?.coverage === 'full' && b.burn_kcal != null
  })
  if (S.length < MIN_FACTOR_DAYS) return { cal: null, issue: `${S.length} of ${MIN_FACTOR_DAYS} complete, fully covered days needed for a factor` }
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
  const meanIntake = mean(inWin.map((d) => d.kcal))
  const meanIntakeS = mean(S.map((d) => d.kcal))
  const burnsS = S.map((d) => p.burns.get(d.date)!.burn_kcal!)
  const meanBurn = mean(burnsS)
  if (!(meanBurn > 0)) return { cal: null, issue: 'no WHOOP burn on the fully covered days' }
  const sd = burnsS.length > 1 ? Math.sqrt(burnsS.reduce((n, b) => n + (b - meanBurn) ** 2, 0) / (burnsS.length - 1)) : 0
  const se = sd / Math.sqrt(burnsS.length)
  const maint = (slope: number) => meanIntake - slope * p.kcalPerKg
  const f = maint(p.slope.central) / meanBurn
  if (!(f >= FACTOR_SANE.lo && f <= FACTOR_SANE.hi)) {
    return {
      cal: null,
      issue: `implausible factor ${Number.isFinite(f) ? f.toFixed(2) : String(f)} (sane ${FACTOR_SANE.lo}-${FACTOR_SANE.hi}): maintenance ${Math.round(maint(p.slope.central))} vs WHOOP ${Math.round(meanBurn)} kcal; check the weight trend (water swings) before trusting any balance`,
    }
  }
  const gap = Math.round(meanIntakeS - meanIntake)
  return {
    cal: {
      factor: r3(f),
      factor_lo: r3(Math.max(0, maint(p.slope.hi) / (meanBurn + se))),
      factor_hi: r3(maint(p.slope.lo) / Math.max(1, meanBurn - se)),
      computed_at: p.nowIso,
      n: S.length,
      window: p.window,
      maintenance: Math.round(maint(p.slope.central)),
      mean_burn_kcal: Math.round(meanBurn),
      burn_se_kcal: Math.round(se),
      mean_intake_kcal: Math.round(meanIntake),
      intake_days: inWin.length,
      mean_intake_full_days_kcal: Math.round(meanIntakeS),
      intake_gap_kcal: gap,
      slope_kg_per_week: Math.round(p.slope.central * 7 * 100) / 100,
      provisional: p.provisional,
      flag:
        Math.abs(gap) > INTAKE_GAP_FLAG_KCAL
          ? `Intake on the ${S.length} fully covered days averages ${Math.abs(gap)} kcal ${gap < 0 ? 'less' : 'more'} than on all ${inWin.length} complete days: the days WHOOP cannot line up eat differently, so read the factor loosely.`
          : null,
    },
    issue: null,
  }
}

export function computeCalibration(p: CalibrationParams): Calibration | null {
  return calibrate(p).cal
}

/** balance = intake - burn x factor; band = logging range x factor band. */
export function balanceOf(
  intake: { kcal: number; kcal_lo: number; kcal_hi: number },
  burn: number,
  cal: Pick<Calibration, 'factor' | 'factor_lo' | 'factor_hi'>,
): { balance: number; lo: number; hi: number } {
  return {
    balance: Math.round(intake.kcal - burn * cal.factor),
    lo: Math.round(intake.kcal_lo - burn * cal.factor_hi),
    hi: Math.round(intake.kcal_hi - burn * cal.factor_lo),
  }
}

// ── the day contract (the phone reads it) ─────────────────────────

export interface DayEnergy {
  burn_kcal: number | null
  calibrated: boolean
  factor: number | null
  balance_kcal: number | null
  balance_lo: number | null
  balance_hi: number | null
  so_far: boolean
  coverage: Coverage
  note: string | null
  /** Additive to the locked contract: the factor was fitted while a
   *  confounder window was open (bracket-central slope). Older phones ignore it. */
  provisional: boolean
}

/** Phone-sized: one short sentence each (the note is rendered on the card). */
export const REASON_TEXT: Record<ExclusionReason, string> = {
  sleep_after_0400: 'Sleep began after 04:00, so the WHOOP day is offset.',
  split_cycle: 'Two WHOOP cycles share this day, so the burn is loose.',
  unscored: 'WHOOP has not scored this day.',
  partial_day: 'The WHOOP cycle spills past this food day.',
  in_progress: 'The WHOOP cycle is still running.',
}

/**
 * day().energy: burn only while uncalibrated, a balance once calibrated.
 * The balance needs the day's intake to be whole: a meal still pending (its
 * kcal is missing) or a past day not marked fully logged gets no balance,
 * since it would read as a deficit he did not run. The note is phone-sized
 * (the card shows it under the number): no formula restatement, no factor
 * (the tag carries it), null when there is nothing to add.
 */
export function dayEnergy(p: {
  date: string
  today: string
  intake: { kcal: number; kcal_lo: number; kcal_hi: number; estimated: number; pending?: number; complete?: boolean }
  burn: DayBurn | null
  cal: Calibration | null
}): DayEnergy {
  const soFar = p.date === p.today
  const burn = p.burn?.burn_kcal ?? null
  const coverage: Coverage = p.burn?.coverage ?? 'none'
  const reason = p.burn?.reason ?? null
  const reasonText = reason && (reason !== 'in_progress' || !soFar) ? REASON_TEXT[reason] : null
  const join = (...xs: Array<string | null | false>) => xs.filter((x): x is string => !!x).join(' ') || null
  const base: DayEnergy = {
    burn_kcal: burn,
    calibrated: p.cal != null,
    factor: p.cal?.factor ?? null,
    balance_kcal: null,
    balance_lo: null,
    balance_hi: null,
    so_far: soFar,
    coverage,
    note: null,
    provisional: p.cal?.provisional === true,
  }
  if (burn == null) {
    base.note = soFar ? 'No WHOOP burn for today yet.' : join('No scored WHOOP cycle for this day.', reason !== 'unscored' && reasonText)
    return base
  }
  if (!p.cal) {
    base.note = join('No balance until the baseline calibrates WHOOP.', reasonText)
    return base
  }
  const pending = p.intake.pending ?? 0
  if (pending > 0) {
    base.note = join(`${pending} meal${pending === 1 ? '' : 's'} not estimated yet, so no balance${soFar ? ' yet' : ''}.`, reasonText)
    return base
  }
  if (p.intake.estimated === 0) {
    base.note = join(`No estimated meals${soFar ? ' yet' : ''}, so no balance.`, reasonText)
    return base
  }
  if (!soFar && p.intake.complete === false) {
    base.note = join('Day not marked fully logged, so no balance.', reasonText)
    return base
  }
  const b = balanceOf(p.intake, burn, p.cal)
  base.balance_kcal = b.balance
  base.balance_lo = b.lo
  base.balance_hi = b.hi
  base.note = join(p.cal.provisional && 'Provisional factor (confounder window).', soFar && 'So far today, not a projection.', reasonText)
  return base
}

/** "-450 kcal deficit (-700 to -200)" / "+200 kcal surplus (...)". */
export function balanceText(e: Pick<DayEnergy, 'balance_kcal' | 'balance_lo' | 'balance_hi'>): string | null {
  if (e.balance_kcal == null) return null
  const signed = (n: number) => `${n > 0 ? '+' : n < 0 ? '-' : ''}${Math.abs(n).toLocaleString('en-US')}`
  const word = e.balance_kcal < 0 ? 'deficit' : e.balance_kcal > 0 ? 'surplus' : 'even'
  const band = e.balance_lo != null && e.balance_hi != null ? ` (${signed(e.balance_lo)} to ${signed(e.balance_hi)})` : ''
  return `${signed(e.balance_kcal)} kcal ${word}${band}`
}

/** Exclusion counts + rates over the baseline days (complete logged days). */
export function exclusionStats(
  baselineDays: string[],
  burns: Map<string, DayBurn>,
): { days: number; full: number; excluded: Record<ExclusionReason, number>; rate: Record<ExclusionReason, number>; flag: string | null } {
  const excluded = Object.fromEntries(EXCLUSION_REASONS.map((r) => [r, 0])) as Record<ExclusionReason, number>
  let full = 0
  for (const d of baselineDays) {
    const b = burns.get(d)
    if (!b) continue
    if (b.reason) excluded[b.reason]++
    else if (b.coverage === 'full') full++
  }
  const n = baselineDays.length
  const rate = Object.fromEntries(EXCLUSION_REASONS.map((r) => [r, n ? Math.round((excluded[r] / n) * 100) / 100 : 0])) as Record<ExclusionReason, number>
  const flag =
    n >= MIN_FACTOR_DAYS && excluded.sleep_after_0400 / n > SLEEP_FLAG_RATE
      ? `Sleep started after 04:00 on ${excluded.sleep_after_0400} of ${n} baseline days, so those days never calibrate. Assigning WHOOP burn by waking day (instead of the 04:00 food day) would keep them.`
      : n >= MIN_FACTOR_DAYS && excluded.partial_day / n > SLEEP_FLAG_RATE
        ? `${excluded.partial_day} of ${n} baseline days had no WHOOP day lining up with the 04:00 food day (typically sleep before ~23:15), so those days never calibrate. Assigning WHOOP burn by waking day would keep them.`
        : null
  return { days: n, full, excluded, rate, flag }
}
