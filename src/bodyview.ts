// GET /body: the phone's Body tab, one payload. Built from FoodService's
// existing reads (weighins, latestWeight's 30-day window, avg7, dayBody,
// baseline's goal + confounders): selection and shape, plus the plain
// arithmetic the composition figure needs (a metric's % times the weigh-in's
// kg). Served on the live listener behind the same token as GET /meals.
//
//   latest        the newest weigh-in that COUNTS (last 30 days), its own fat
//                 and that fat's basis
//   avg7          7-day mean of counted readings up to latest (n >= 3), with
//                 anchored_at = the reading it is anchored on (latest), so a
//                 stale week never passes for this one
//   trend         vs the 7 days before; only when BOTH weeks have n >= 3.
//                 delta_kg is avg7.kg - prev_avg_kg as SENT, so the line on
//                 the phone always adds up
//   metrics       exactly day.body (dayBody()): the newest S400 reading that
//                 is his, which may be a later one than latest (a repeat
//                 counts for the body, not the trend); the phone labels it
//   compartments  the figure's 4-compartment split of THAT reading: water,
//                 fat, protein (each % x kg) and mineral (bone_kg), each with
//                 its metric's basis and note and a 7-day series
//   unassigned    weight minus the four (kg, pct), or over_kg when they add
//                 up to more than the weight: never stretched to 100%
//   goal          the goal record + derived numbers, or null
//   goal_ghost    the weight at the goal's target fat % holding TODAY's
//                 lean mass: the figure's own reading's lean_kg (S400, weight
//                 x (1 - the displayed fat)) / (1 - target), his call. It
//                 moves as he gains muscle; the goal record's scan-based
//                 weight_at_target_kg stays in goal.derived as the REFERENCE
//                 (the goal is still checked against a scan). Null with no
//                 goal record or when that reading has no lean_kg
//   confounders   windows that touch the history span, active first
//   baseline_status  provisional | collecting | ready
//   history       every weigh-in of the last 30 days, newest first, the
//                 excluded ones too (with their reason); pair_key is shared
//                 by two sources' copies of one weigh-in (the same instant).
//                 A "possible other person" or "not his" row keeps its date,
//                 source and reason but never its kg or fat: not his body
//                 to show.

import { addDays } from './meals.js'
import { mayNotBeHis, type FoodService } from './food.js'
import type { GoalView } from './confounders.js'
import type { MetricBasis, MetricView } from './bodycomp.js'
import { SCALE_SOURCE } from './scale.js'

/** The span the tab covers (history, confounders, latest). */
export const BODY_HISTORY_DAYS = 30
/** The composition series: the figure's 7-day sparkline. */
const SERIES_DAYS = 7

type FatBasis = 'device' | 'raw' | 'provisional' | 'calibrated' | null

export interface BodyHistoryRow {
  measured_at: string
  /** Null on a "possible other person" or "not his" row (masked). */
  kg: number | null
  fat_pct: number | null
  fat_basis: FatBasis
  source: string | null
  excluded: string | null
  pair_key: string | null
}

export type CompartmentKey = 'water' | 'fat' | 'protein' | 'mineral'

export interface BodyCompartment {
  key: CompartmentKey
  label: string
  kg: number
  /** % of the weigh-in's kg. */
  pct: number
  basis: MetricBasis
  note: string | null
  /** The same compartment on his counted S400 readings of the 7 days up to
   *  the figure's reading (that reading included), oldest first. */
  series: Array<{ measured_at: string; kg: number }>
}

export interface BodyPage {
  latest: { measured_at: string; kg: number; fat_pct: number | null; fat_basis: FatBasis; source: string | null } | null
  avg7: { kg: number; n: number; anchored_at: string } | null
  trend: { delta_kg: number; prev_avg_kg: number } | null
  metrics: ReturnType<FoodService['dayBody']>
  compartments: BodyCompartment[]
  unassigned: { kg: number; pct: number; over_kg: number } | null
  goal: GoalView | null
  goal_ghost: { kg: number; lean_kg: number; lean_basis: 'scale'; lean_source: string } | null
  confounders: Array<{ kind: string; label: string; sentence: string; window_to: string; status: 'active' | 'closed' }>
  baseline_status: 'provisional' | 'collecting' | 'ready'
  history: BodyHistoryRow[]
}

const round1 = (n: number) => Math.round(n * 10) / 10
const round2 = (n: number) => Math.round(n * 100) / 100

/** Bottom-up order of the figure's bands; the metric each comes from. */
const COMPARTMENTS: ReadonlyArray<{ key: CompartmentKey; label: string; metric: MetricView['key'] }> = [
  { key: 'mineral', label: 'Mineral', metric: 'bone_kg' },
  { key: 'protein', label: 'Protein', metric: 'protein_pct' },
  { key: 'water', label: 'Water', metric: 'water_pct' },
  { key: 'fat', label: 'Fat', metric: 'fat_pct' },
]

/** One reading's compartments (kg), from its metric views as shown. A
 *  missing metric (a dropped sentinel) is simply absent: its mass then sits
 *  in `unassigned`, never spread over the others. */
function split(views: ReadonlyArray<Pick<MetricView, 'key' | 'value' | 'basis' | 'note'>>, kg: number) {
  const out: Array<{ key: CompartmentKey; label: string; kg: number; basis: MetricBasis; note: string | null }> = []
  for (const c of COMPARTMENTS) {
    const v = views.find((m) => m.key === c.metric)
    if (!v) continue
    out.push({ key: c.key, label: c.label, kg: c.metric === 'bone_kg' ? v.value : (v.value / 100) * kg, basis: v.basis, note: v.note })
  }
  return out
}

/** Same instant: counted first, then the S400 copy, then by source, so a
 *  pair renders in one stable order whatever SQLite returns. */
function byNewest(a: BodyHistoryRow, b: BodyHistoryRow): number {
  if (a.measured_at !== b.measured_at) return a.measured_at < b.measured_at ? 1 : -1
  const ca = a.excluded == null ? 0 : 1
  const cb = b.excluded == null ? 0 : 1
  if (ca !== cb) return ca - cb
  const sa = a.source === SCALE_SOURCE ? 0 : 1
  const sb = b.source === SCALE_SOURCE ? 0 : 1
  if (sa !== sb) return sa - sb
  return (a.source ?? '').localeCompare(b.source ?? '')
}

export function bodyPage(food: FoodService): BodyPage {
  const rows = food.weighins(BODY_HISTORY_DAYS)
  // Two sources' copies of one weigh-in share the scale's own instant (the
  // same rule as the daemon's same-instant exclusion): one key for both.
  const sources = new Map<string, Set<string>>()
  for (const r of rows) {
    const s = sources.get(r.measured_at) ?? new Set<string>()
    s.add(r.source ?? '')
    sources.set(r.measured_at, s)
  }
  const history: BodyHistoryRow[] = rows
    .map((r) => {
      const masked = mayNotBeHis(r.excluded)
      return {
        measured_at: r.measured_at,
        kg: masked ? null : r.kg,
        fat_pct: masked ? null : r.fat_pct,
        fat_basis: masked ? null : r.fat_basis,
        source: r.source,
        excluded: r.excluded,
        pair_key: (sources.get(r.measured_at)?.size ?? 0) > 1 ? r.measured_at : null,
      }
    })
    .sort(byNewest)

  // The newest COUNTED weigh-in: the same row latestWeight() reads (30 days,
  // excluded == null), with its own fat (never another weigh-in's).
  const top = history.find((r) => r.excluded == null && r.kg != null) ?? null
  const latest = top
    ? { measured_at: top.measured_at, kg: round1(top.kg!), fat_pct: top.fat_pct, fat_basis: top.fat_basis, source: top.source }
    : null

  const a = latest ? food.avg7(latest.measured_at) : null
  const avg7 = a && latest ? { kg: a.kg, n: a.n, anchored_at: latest.measured_at } : null
  // The previous week is the window avg7 itself compared against (prev_kg).
  // The delta is taken from the two ROUNDED means sent, so "71.6, -0.7 vs
  // 72.4" can never read 71.6 - 72.4 = -0.8 on the phone (avg7's own delta,
  // for the event, stays as it is).
  const trend: BodyPage['trend'] = a && a.prev_kg != null ? { delta_kg: round1(a.kg - a.prev_kg), prev_avg_kg: a.prev_kg } : null

  // The figure: day.body's reading, split into four compartments.
  const metrics = food.dayBody()
  let compartments: BodyCompartment[] = []
  let unassigned: BodyPage['unassigned'] = null
  if (metrics) {
    const parts = split(metrics.metrics, metrics.kg)
    if (parts.length) {
      // The series: the same split on his counted S400 readings of the 7
      // days up to the figure's reading, plus that reading itself (it may be
      // a repeat, which does not count for the trend but is his body).
      const t = Date.parse(metrics.measured_at)
      const from = t - SERIES_DAYS * 86_400_000
      const points = rows
        .filter((r) => r.source === SCALE_SOURCE && r.metrics && (r.excluded == null || r.measured_at === metrics.measured_at))
        .filter((r) => {
          const ms = Date.parse(r.measured_at)
          return ms > from && ms <= t
        })
        .sort((x, y) => x.measured_at.localeCompare(y.measured_at))
        .map((r) => ({ measured_at: r.measured_at, parts: split(r.metrics!, round1(r.kg)) }))
      compartments = parts.map((p) => ({
        key: p.key,
        label: p.label,
        kg: p.key === 'mineral' ? round2(p.kg) : round1(p.kg),
        pct: round1((p.kg / metrics.kg) * 100),
        basis: p.basis,
        note: p.note,
        series: points.flatMap((pt) => {
          const v = pt.parts.find((x) => x.key === p.key)
          return v ? [{ measured_at: pt.measured_at, kg: p.key === 'mineral' ? round2(v.kg) : round1(v.kg) }] : []
        }),
      }))
      const sum = parts.reduce((s, p) => s + p.kg, 0)
      const rest = metrics.kg - sum
      unassigned = { kg: round2(Math.max(0, rest)), pct: round1((Math.max(0, rest) / metrics.kg) * 100), over_kg: round2(Math.max(0, -rest)) }
    }
  }

  const b = food.baseline()
  // The goal ghost: the target fat % at TODAY's lean mass, from the figure's
  // own reading (the lean_kg as shown, so "56.0 / 0.85" adds up on the
  // phone). The scan-based goal weight stays in goal.derived as the
  // reference; the phone shows both, labelled.
  const lean = metrics?.metrics.find((m) => m.key === 'lean_kg') ?? null
  const goal_ghost: BodyPage['goal_ghost'] =
    b.goal && lean && lean.value > 0
      ? { kg: round1(lean.value / (1 - b.goal.target_bf_pct / 100)), lean_kg: lean.value, lean_basis: 'scale', lean_source: `S400, ${lean.basis}` }
      : null

  const today = food.today()
  const from = addDays(today, -BODY_HISTORY_DAYS)
  const confounders = b.confounders
    .filter((c) => c.status === 'active' || c.window.to >= from)
    .sort((x, y) => (x.status === y.status ? (x.window.to < y.window.to ? 1 : x.window.to > y.window.to ? -1 : 0) : x.status === 'active' ? -1 : 1))
    .map((c) => ({ kind: c.kind, label: c.label, sentence: c.sentence, window_to: c.window.to, status: c.status }))

  return {
    latest,
    avg7,
    trend,
    metrics,
    compartments,
    unassigned,
    goal: b.goal,
    goal_ghost,
    confounders,
    baseline_status: b.status,
    history,
  }
}
