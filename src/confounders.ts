// Confounders: dated life changes the baseline must know about (creatine
// water, an intake step-down), plus the optional goal record.
//
// Rules (locked spec, Nov 16 2026):
// - A record is {kind, date, details}, with a window (date .. window_end, or
//   closed_at when closed by hand). While any window is open the baseline is
//   PROVISIONAL: intake stats + raw slope are shown, no accepted target unless
//   he explicitly accepts one.
// - NO fitted offset (unidentifiable at n ~ 14). Instead a BRACKET: subtract a
//   FIXED offset curve, sign x kg x (1 - e^(-t / tau)), t = days since the
//   record's date, for every kg in each record's 3-value set, and report the
//   resulting maintenance grid as a range + a central value (the middle kg).
// - Once every window closes, the clean estimate fits post-window weigh-ins
//   only (FoodService does that by shortening the baseline window).

import type { Database } from 'bun:sqlite'
import { addDays, completeIntake, daysBetween, weightFit, type BaselineDay } from './meals.js'

export interface BracketSpec {
  sign: 1 | -1 // +1: the confounder adds scale weight (water), -1: removes it
  kg: [number, number, number] // low, central, high size of the effect
  tau_days: number // time constant of the fixed curve
}

export interface ConfounderDetails {
  summary?: string // what happened, one short clause
  effect?: string // what it does to the scale while the window is open
  label?: string // the provisional-status label; "{to}" becomes "Dec 13"
  bracket?: BracketSpec
  [k: string]: unknown
}

export interface ConfounderRow {
  id: number
  kind: string
  date: string
  details: ConfounderDetails
  window_end: string
  closed_at: string | null
  created_at: string
}

export interface ConfounderView {
  id: number
  kind: string
  date: string
  details: ConfounderDetails
  window: { from: string; to: string }
  status: 'active' | 'closed'
  bracket: BracketSpec | null
  label: string
  sentence: string
}

/** A seed record: what confounder_add takes, as data. */
export interface ConfounderSeed {
  kind: string
  date: string
  window_days?: number
  details: ConfounderDetails
}

/**
 * Per-kind defaults: the generic science only (window, what it does to the
 * scale, the fixed bracket curve). The personal part of a record (its date,
 * dose, what he ate before) is NEVER in source: it is added at runtime with
 * health__meal confounder_add and lives only in the local database.
 */
export const KIND_DEFAULTS: Record<string, { window_days: number; details: ConfounderDetails }> = {
  creatine_start: {
    window_days: 28,
    details: {
      effect: 'expect about +1 to 2 kg of water in the muscles while it saturates, so the scale trend reads high',
      label: 'creatine saturation through ~{to}, weight trend inflated',
      bracket: { sign: 1, kg: [0, 1, 2], tau_days: 9 },
    },
  },
  intake_step_down: {
    window_days: 14,
    details: {
      effect: 'expect an early non-fat drop of about 0.5 to 2 kg (gut content, glycogen, water) over 1 to 2 weeks, so the early trend reads low',
      label: 'intake step-down through ~{to}, early water loss in the trend',
      bracket: { sign: -1, kg: [0.5, 1, 2], tau_days: 4 },
    },
  },
}

/** A record's window + details with the kind's defaults filled in (the
 *  caller's own fields win). */
export function withKindDefaults(kind: string, windowDays: number | null, details: ConfounderDetails): { window_days: number; details: ConfounderDetails } {
  const d = KIND_DEFAULTS[kind]
  return {
    window_days: windowDays ?? d?.window_days ?? 14,
    details: d ? { ...d.details, ...details } : details,
  }
}

export const fmtMonDay = (day: string) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })

const TITLES: Record<string, string> = {
  creatine_start: 'Creatine',
  intake_step_down: 'Intake step-down',
}

export function viewOf(c: ConfounderRow, today: string): ConfounderView {
  const to = c.closed_at && c.closed_at < c.window_end ? c.closed_at : c.window_end
  // A hand close counts from its own date: a close dated ahead (from before
  // closeConfounder refused those) keeps the window open until then.
  const status: 'active' | 'closed' =
    today <= c.window_end && (c.closed_at == null || today < c.closed_at) ? 'active' : 'closed'
  const title = TITLES[c.kind] ?? c.kind.replace(/_/g, ' ').replace(/^./, (x) => x.toUpperCase())
  const label = (c.details.label ?? `${title.toLowerCase()} through ~{to}`).replace('{to}', fmtMonDay(to))
  const since = `${title} since ${fmtMonDay(c.date)}${c.details.summary ? ` (${c.details.summary})` : ''}`
  const sentence =
    status === 'active'
      ? `${since}: ${c.details.effect ?? 'it moves the weight trend'} through ~${fmtMonDay(to)}.`
      : `${since}: window closed ${fmtMonDay(to)}, so it no longer bends the trend.`
  return {
    id: c.id,
    kind: c.kind,
    date: c.date,
    details: c.details,
    window: { from: c.date, to },
    status,
    bracket: validBracket(c.details.bracket),
    label,
    sentence,
  }
}

function validBracket(b: unknown): BracketSpec | null {
  if (!b || typeof b !== 'object') return null
  const o = b as Record<string, unknown>
  const kg = o.kg
  if (o.sign !== 1 && o.sign !== -1) return null
  if (!Array.isArray(kg) || kg.length !== 3 || !kg.every((x) => typeof x === 'number' && x >= 0 && x <= 10)) return null
  if (typeof o.tau_days !== 'number' || !(o.tau_days > 0 && o.tau_days <= 60)) return null
  return { sign: o.sign, kg: [kg[0], kg[1], kg[2]], tau_days: o.tau_days }
}

/** The fixed curve: sum of sign x kg x (1 - e^(-t / tau)), zero before each anchor. */
export function offsetKg(day: string, parts: Array<{ anchor: string; spec: BracketSpec; kg: number }>): number {
  let off = 0
  for (const p of parts) {
    const t = daysBetween(p.anchor, day)
    if (t <= 0) continue
    off += p.spec.sign * p.kg * (1 - Math.exp(-t / p.spec.tau_days))
  }
  return off
}

export interface Bracket {
  anchors: Array<{ kind: string; date: string; kg: [number, number, number]; tau_days: number; sign: 1 | -1 }>
  grid: Array<{ kg: number[]; maintenance: number; slope_kg_per_week: number }>
  range: { lo: number; hi: number }
  central: number
  central_slope_kg_per_day: number
  central_se_kg_per_day: number
  slope_kg_per_day: { lo: number; hi: number }
  note: string
}

/** The 3 x 3 (x 3 ...) maintenance grid over the fixed offset curves. */
export function computeBracket(
  days: BaselineDay[],
  weights: Array<{ date: string; kg: number }>,
  records: ConfounderView[],
  window: { from: string; to: string },
  kcalPerKg: number,
): Bracket | null {
  const recs = records.filter((r) => r.bracket)
  if (!recs.length) return null
  const intake = completeIntake(days, window.from, window.to)
  if (intake.mean == null) return null
  // Cartesian product of each record's kg set; index 1 is the central value.
  let combos: number[][] = [[]]
  for (const r of recs) combos = combos.flatMap((c) => r.bracket!.kg.map((k) => [...c, k]))
  const fitFor = (kgs: number[]) => {
    const parts = recs.map((r, i) => ({ anchor: r.date, spec: r.bracket!, kg: kgs[i] }))
    return weightFit(weights.map((w) => ({ date: w.date, kg: w.kg - offsetKg(w.date, parts) })), window.from, window.to)
  }
  const grid: Bracket['grid'] = []
  const slopes: number[] = []
  for (const kgs of combos) {
    const fit = fitFor(kgs)
    if (!fit) return null
    slopes.push(fit.slope)
    grid.push({ kg: kgs, maintenance: Math.round(intake.mean - fit.slope * kcalPerKg), slope_kg_per_week: Math.round(fit.slope * 7 * 100) / 100 })
  }
  const central = fitFor(recs.map((r) => r.bracket!.kg[1]))!
  const ms = grid.map((g) => g.maintenance)
  return {
    anchors: recs.map((r) => ({ kind: r.kind, date: r.date, kg: r.bracket!.kg, tau_days: r.bracket!.tau_days, sign: r.bracket!.sign })),
    grid,
    range: { lo: Math.min(...ms), hi: Math.max(...ms) },
    central: Math.round(intake.mean - central.slope * kcalPerKg),
    central_slope_kg_per_day: central.slope,
    central_se_kg_per_day: central.se,
    slope_kg_per_day: { lo: Math.min(...slopes), hi: Math.max(...slopes) },
    note: `Maintenance after subtracting fixed water curves (${recs.map((r) => `${TITLES[r.kind] ?? r.kind} ${r.bracket!.kg.join('/')} kg`).join(', ')}); central = the middle values. A bracket, not a fit.`,
  }
}

/** Raw slope over the first 10 days after the earliest anchor: least trustworthy. */
export function earlySlope(
  weights: Array<{ date: string; kg: number }>,
  anchor: string,
): { from: string; to: string; kg_per_week: number; days: number; note: string } | null {
  const to = addDays(anchor, 9)
  const fit = weightFit(weights, anchor, to)
  if (!fit) return null
  return {
    from: anchor,
    to,
    kg_per_week: Math.round(fit.slope * 7 * 100) / 100,
    days: new Set(weights.filter((w) => w.date >= anchor && w.date <= to).map((w) => w.date)).size,
    note: 'Raw slope over the first 10 days after the change: the LEAST trustworthy part of the trend (both water shifts move fastest here).',
  }
}

// ── storage ───────────────────────────────────────────────────────

export class ConfounderBook {
  constructor(private db: Database) {}

  list(): ConfounderRow[] {
    return (
      this.db.query('SELECT * FROM confounders ORDER BY date ASC, id ASC').all() as Array<Omit<ConfounderRow, 'details'> & { details: string }>
    ).map((r) => ({ ...r, details: parseDetails(r.details) }))
  }

  get(id: number): ConfounderRow | null {
    const r = this.db.query('SELECT * FROM confounders WHERE id = ?').get(id) as (Omit<ConfounderRow, 'details'> & { details: string }) | null
    return r ? { ...r, details: parseDetails(r.details) } : null
  }

  /** Insert unless (kind, date) exists. Returns the row id either way. */
  add(p: { kind: string; date: string; window_days: number; details: ConfounderDetails; now: string }): { id: number; created: boolean } {
    const res = this.db.run(
      'INSERT OR IGNORE INTO confounders (kind, date, details, window_end, created_at) VALUES (?, ?, ?, ?, ?)',
      [p.kind, p.date, JSON.stringify(p.details), addDays(p.date, p.window_days), p.now],
    )
    const row = this.db.query('SELECT id FROM confounders WHERE kind = ? AND date = ?').get(p.kind, p.date) as { id: number }
    return { id: row.id, created: res.changes > 0 }
  }

  close(id: number, date: string): boolean {
    return this.db.run('UPDATE confounders SET closed_at = ? WHERE id = ?', [date, id]).changes > 0
  }

  /** Seed records (kind defaults filled in); idempotent on (kind, date),
   *  never re-opens a closed one. */
  seed(records: ConfounderSeed[], now: string): number {
    let n = 0
    for (const r of records) {
      const d = withKindDefaults(r.kind, r.window_days ?? null, r.details)
      if (this.add({ kind: r.kind, date: r.date, window_days: d.window_days, details: d.details, now }).created) n++
    }
    return n
  }
}

function parseDetails(s: string): ConfounderDetails {
  try {
    const v = JSON.parse(s)
    return v && typeof v === 'object' && !Array.isArray(v) ? v : { summary: String(v) }
  } catch {
    return { summary: s }
  }
}

// ── goal record ───────────────────────────────────────────────────

export interface GoalRecord {
  target_bf_pct: number
  milestone_kg: number | null
  lean_mass_ref_kg: number
  lean_mass_ref_source: string | null
  set_at: string
}

export interface GoalView extends GoalRecord {
  derived: {
    weight_at_target_kg: number // lean mass held, at the target fat %
    weight_at_target_on_creatine_kg: number | null
    latest_kg: number | null
    to_milestone_kg: number | null
    note: string
  }
}

const round1 = (n: number) => Math.round(n * 10) / 10

/** Derived numbers: weight at target = lean mass / (1 - fat %), plus the
 *  creatine water (central bracket value) while he keeps taking it. */
export function goalView(g: GoalRecord, latestKg: number | null, creatineKg: number | null): GoalView {
  const atTarget = g.lean_mass_ref_kg / (1 - g.target_bf_pct / 100)
  return {
    ...g,
    derived: {
      weight_at_target_kg: round1(atTarget),
      weight_at_target_on_creatine_kg: creatineKg == null ? null : round1(atTarget + creatineKg),
      latest_kg: latestKg,
      to_milestone_kg: latestKg != null && g.milestone_kg != null ? round1(latestKg - g.milestone_kg) : null,
      note: `At ${g.target_bf_pct}% fat holding ${g.lean_mass_ref_kg} kg lean mass${g.lean_mass_ref_source ? ` (${g.lean_mass_ref_source})` : ''}. The scale's fat % is a TREND only, never a goal check: the goal is checked against a body-composition scan.`,
    },
  }
}

export function parseGoal(raw: unknown, prev: GoalRecord | null, now: string): GoalRecord {
  if (!raw || typeof raw !== 'object') throw new Error('goal fields are required')
  const o = raw as Record<string, unknown>
  const num = (v: unknown, field: string, min: number, max: number, fallback: number | null | undefined): number | null => {
    if (v === undefined) return fallback ?? null
    if (v === null) return null
    const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
    if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) throw new Error(`${field} must be a number ${min}-${max}`)
    return n
  }
  const bf = num(o.target_bf_pct, 'target_bf_pct', 3, 40, prev?.target_bf_pct)
  const lean = num(o.lean_mass_ref_kg, 'lean_mass_ref_kg', 20, 150, prev?.lean_mass_ref_kg)
  if (bf == null) throw new Error('target_bf_pct is required')
  if (lean == null) throw new Error('lean_mass_ref_kg is required')
  const src = o.lean_mass_ref_source === undefined ? (prev?.lean_mass_ref_source ?? null) : typeof o.lean_mass_ref_source === 'string' ? o.lean_mass_ref_source.trim().slice(0, 80) || null : null
  return {
    target_bf_pct: bf,
    milestone_kg: num(o.milestone_kg, 'milestone_kg', 30, 300, prev?.milestone_kg),
    lean_mass_ref_kg: lean,
    lean_mass_ref_source: src,
    set_at: now,
  }
}
