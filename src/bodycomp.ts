// S400 body composition beyond fat: the published Mi Scale formulas, per
// weigh-in, from the raw values the scale leg stores (kg, 50 kHz impedance)
// and the profile (height, birth date, sex).
//
// Every number here is a FORMULA ESTIMATE (basis 'formula'): a trend signal,
// never a measurement. Xiaomi Home runs its own unpublished model, so each
// metric can be calibrated against values he copies from the Xiaomi report
// (health__meal weighin_pair), metric by metric, with the same fit as the fat
// calibration (scalecal.ts fitCalibration).
//
// References (read, ported by hand, never imported):
//   - openScale @ 2f5eeb7, android_app/.../bluetooth/libs/MiScaleLib.kt
//     (GPLv3; the formulas are reverse-engineered Mi Fit maths by prototux,
//     MIBCS-reverse-engineering), worked numbers in MiScaleLibTest.kt.
//   - xiaomi_mi_scale @ e9db989, src/Xiaomi_Scale_Body_Metrics.py
//     (bodyMetrics), for what MiScaleLib does not carry: getBMR and
//     getProteinPercentage, plus its value clamps where noted.
// Sex coding follows MiScaleLib: male = 1, female = 0.
//
// NO body age and NO body score: Xiaomi publishes no method for either, and
// the open ports only guess (metabolic age is a fitted regression of unknown
// origin, the body score a weighted table). They are left out on purpose.

import { ageAt, fatPercent, type BodyProfile } from './scale.js'
import { fitCalibration, calibratedValue, pairCount, provenanceOf, type CalModel, type CalPair, type FatProvenance } from './scalecal.js'

export type Sex = 'male' | 'female'
const sexCode = (s: Sex) => (s === 'male' ? 1 : 0)

// ── formulas (one per reference function) ───────────────────────────

/** MiScaleLib.getLBMCoefficient (= bodyMetrics.getLBMCoefficient). */
export function lbmCoefficient(kg: number, heightCm: number, age: number, impedance: number): number {
  let lbm = (heightCm * 9.058 / 100) * (heightCm / 100)
  lbm += kg * 0.32 + 12.226
  lbm -= impedance * 0.0068
  lbm -= age * 0.0542
  return lbm
}

/** MiScaleLib.getBMI: kg / m^2 (no clamp; bodyMetrics.getBMI clamps 10-90). */
export function bmiOf(kg: number, heightCm: number): number {
  return kg / (((heightCm * heightCm) / 100) / 100)
}

/** MiScaleLib.getBoneMass (kg), exact, including its >2.2 kg +/-0.1 step and
 *  the 8 kg cap (female > 5.1, male > 5.2). */
export function boneMassKg(kg: number, heightCm: number, age: number, sex: Sex, impedance: number): number {
  const base = sexCode(sex) === 0 ? 0.245691014 : 0.18016894
  let bone = (base - lbmCoefficient(kg, heightCm, age, impedance) * 0.05158) * -1
  bone = bone > 2.2 ? bone + 0.1 : bone - 0.1
  if (sexCode(sex) === 0 && bone > 5.1) bone = 8
  else if (sexCode(sex) === 1 && bone > 5.2) bone = 8
  return bone
}

/** MiScaleLib.getLBM: weight minus fat mass minus bone (kg), with its caps
 *  (female >= 84, male >= 93.5 -> 120). This is what Xiaomi Home calls
 *  "muscle mass" (bodyMetrics.getMuscleMass is the same expression): NOT
 *  skeletal muscle. `fatPct` is the Mi formula fat % (scale.ts fatPercent). */
export function xiaomiMuscleKg(kg: number, heightCm: number, age: number, sex: Sex, impedance: number, fatPct: number): number {
  let m = kg - fatPct * 0.01 * kg - boneMassKg(kg, heightCm, age, sex, impedance)
  if (sexCode(sex) === 0 && m >= 84) m = 120
  else if (sexCode(sex) === 1 && m >= 93.5) m = 120
  return m
}

/** Janssen et al. skeletal muscle mass (kg), MiScaleLib.getMuscle's SMM path
 *  before its percent-of-weight conversion: 0.401 * (H^2 / R) + 3.825 * sex
 *  - 0.071 * age + 5.102 (H cm, R ohm at 50 kHz). Null when R <= 0 (the
 *  reference then falls back to an LBM ratio; that guess is not ported). */
export function janssenSmmKg(heightCm: number, age: number, sex: Sex, impedance: number): number | null {
  if (!(impedance > 0)) return null
  return 0.401 * ((heightCm * heightCm) / impedance) + 3.825 * sexCode(sex) - 0.071 * age + 5.102
}

/** MiScaleLib.getWater (%): (100 - fat) * 0.7, times 1.02 below 50 else 0.98.
 *  (bodyMetrics.getWaterPercentage differs only at the edges: <= 50, and a
 *  >= 65 -> 75 cap with a 35-75 clamp.) */
export function waterPct(fatPct: number): number {
  const water = (100 - fatPct) * 0.7
  return (water < 50 ? 1.02 : 0.98) * water
}

/** MiScaleLib.getVisceralFat, exact (no clamp; the female branch can go
 *  negative, see the reference's own test). computeMetrics applies
 *  bodyMetrics.getVisceralFat's 1-50 clamp. */
export function visceralFatRaw(kg: number, heightCm: number, age: number, sex: Sex): number {
  const h = heightCm
  if (sexCode(sex) === 0) {
    if (kg > (13 - h * 0.5) * -1) {
      const subsubcalc = (h * 1.45 + h * 0.1158 * h) - 120
      const subcalc = (kg * 500) / subsubcalc
      return subcalc - 6 + age * 0.07
    }
    const subcalc = 0.691 + h * -0.0024 + h * -0.0024
    return (h * 0.027 - subcalc * kg) * -1 + age * 0.07 - age
  }
  if (h < kg * 1.6) {
    const subcalc = (h * 0.4 - h * (h * 0.0826)) * -1
    return (kg * 305) / (subcalc + 48) - 2.9 + age * 0.15
  }
  const subcalc = 0.765 + h * -0.0015
  return (h * 0.143 - kg * subcalc) * -1 + age * 0.15 - 5.0
}

const overflow = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

/** bodyMetrics.getBMR (kcal/day; MiScaleLib has none): the Mi Fit linear
 *  model, its 5000 cap (female > 2996, male > 2322), clamped 500-10000. */
export function bmrKcal(kg: number, heightCm: number, age: number, sex: Sex): number {
  let bmr: number
  if (sex === 'female') bmr = 864.6 + kg * 10.2036 - heightCm * 0.39336 - age * 6.204
  else bmr = 877.8 + kg * 14.916 - heightCm * 0.726 - age * 8.976
  if (sex === 'female' && bmr > 2996) bmr = 5000
  else if (sex === 'male' && bmr > 2322) bmr = 5000
  return overflow(bmr, 500, 10000)
}

/** bodyMetrics.getProteinPercentage(orig=True) (%; MiScaleLib has no
 *  getProtein): muscle mass as % of weight minus water %, clamped 5-32. Its
 *  inputs are bodyMetrics' own clamped helpers: getBoneMass (0.5-8),
 *  getMuscleMass (10-120), getWaterPercentage (<= 50 -> 1.02, >= 65 -> 75,
 *  35-75), all ported here as written. */
export function proteinPct(kg: number, heightCm: number, age: number, sex: Sex, impedance: number, fatPct: number): number {
  return proteinDetail(kg, heightCm, age, sex, impedance, fatPct).value
}

/** proteinPct plus whether any reference cap, sentinel or clamp fired on the
 *  way (bone 8, muscle 120, water 75, or a 0.5-8 / 10-120 / 35-75 / 5-32
 *  clamp): then the number is the reference's error marker, not an estimate. */
export function proteinDetail(
  kg: number, heightCm: number, age: number, sex: Sex, impedance: number, fatPct: number,
): { value: number; outOfRange: boolean } {
  let out = false
  const clampTrack = (v: number, lo: number, hi: number) => {
    const c = overflow(v, lo, hi)
    if (c !== v) out = true
    return c
  }
  // bodyMetrics.getBoneMass
  const boneRaw = boneMassKg(kg, heightCm, age, sex, impedance)
  if (boneRaw === 8) out = true
  const bone = clampTrack(boneRaw, 0.5, 8)
  // bodyMetrics.getMuscleMass
  let muscle = kg - fatPct * 0.01 * kg - bone
  if ((sex === 'female' && muscle >= 84) || (sex === 'male' && muscle >= 93.5)) {
    muscle = 120
    out = true
  }
  muscle = clampTrack(muscle, 10, 120)
  // bodyMetrics.getWaterPercentage
  let water = (100 - fatPct) * 0.7
  const coefficient = water <= 50 ? 1.02 : 0.98
  if (water * coefficient >= 65) {
    water = 75
    out = true
  }
  const waterPctPy = clampTrack(water * coefficient, 35, 75)
  return { value: clampTrack((muscle / kg) * 100 - waterPctPy, 5, 32), outOfRange: out }
}

// ── impedance inference (rows stored before impedances were) ────────

/** Invert scale.ts fatPercent: the 50 kHz impedance (ohm) that gives this
 *  fat %, by bisection over 1-3000 ohm (fatPercent is non-decreasing in
 *  impedance). Null at the formula's clamps (<= 5 %, >= 63 % where the
 *  reference jumps to 75) or out of reach. */
export function inferImpedance(fatPctTarget: number, kg: number, heightCm: number, age: number, sex: Sex): number | null {
  if (!Number.isFinite(fatPctTarget) || fatPctTarget <= 5 || fatPctTarget >= 63) return null
  const f = (imp: number) => fatPercent(kg, heightCm, age, sex, imp)
  let lo = 1
  let hi = 3000
  const flo = f(lo)
  const fhi = f(hi)
  if (flo == null || fhi == null) return null
  const TOL = 1e-6
  if (fatPctTarget < flo - TOL || fatPctTarget > fhi + TOL) return null
  for (let i = 0; i < 80 && hi - lo > 1e-9; i++) {
    const mid = (lo + hi) / 2
    const v = f(mid)
    if (v == null) return null
    if (v < fatPctTarget) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

// ── per-weigh-in metrics ─────────────────────────────────────────────

/** The metrics a weigh-in carries, in the order every surface lists them
 *  (visceral + muscle first: the waist / V-taper priority; visceral is a
 *  weight-only formula and says so in its note). bmi is last and never
 *  calibrated (a BMI pair only checks the height). */
export const METRIC_KEYS = ['visceral', 'muscle_kg', 'fat_pct', 'water_pct', 'protein_pct', 'bone_kg', 'smm_kg', 'lean_kg', 'bmr_kcal', 'bmi'] as const
export type MetricKey = (typeof METRIC_KEYS)[number]
/** Metrics a manual Xiaomi value can be paired with (weighin_pair). lean_kg
 *  is not one: it is weight x (1 - the displayed fat), so it follows the fat
 *  calibration and a pair of its own would only fight it. */
export const PAIRABLE_METRICS: readonly MetricKey[] = ['fat_pct', 'muscle_kg', 'water_pct', 'protein_pct', 'bone_kg', 'visceral', 'bmr_kcal', 'bmi']
/** day.body order (the iOS contract). */
export const DAY_BODY_ORDER: readonly MetricKey[] = ['visceral', 'muscle_kg', 'fat_pct', 'water_pct', 'protein_pct', 'bone_kg', 'smm_kg', 'lean_kg', 'bmr_kcal']

export interface MetricSpec {
  label: string
  unit: string
  /** Display decimals. */
  dp: number
  /** The reference function(s) the formula value comes from. */
  ref: string
  /** Depends on the impedance (so on an inferred one for old rows). */
  usesImpedance: boolean
  /** Plausible manual value range (weighin_pair input check). */
  range: [number, number]
  /** Fit units: one unit here weighs like one fat point (shrinkage prior,
   *  minimum spread, Theil-Sen spacing all live in fat points). */
  fitUnit: number
  /** A caveat every surface carries with the value (day.body note, weighins,
   *  the body.weighin line), whatever its calibration. */
  fixedNote?: string
}

/** visceral and bmr_kcal take weight, height, age and sex only: a change in
 *  them IS a weight change, never news about fat or metabolism. */
export const WEIGHT_ONLY_NOTE = 'weight-derived, no impedance'
/** body_metrics.py getProteinPercentage: "warn: guessed formula". */
export const PROTEIN_NOTE = 'guessed formula'
/** Janssen skeletal muscle sits inside Xiaomi's "muscle" (fat-free mass
 *  minus bone): a smaller, different quantity, never a rival figure. */
export const SMM_NOTE = 'a smaller part of Muscle'


export const METRICS: Record<MetricKey, MetricSpec> = {
  // Whole index, like the Xiaomi report: every surface shows the same number.
  visceral: { label: 'Visceral fat', unit: '', dp: 0, ref: 'MiScaleLib.getVisceralFat (range 1-50: bodyMetrics.getVisceralFat); weight-derived (no impedance)', usesImpedance: false, range: [1, 50], fitUnit: 1, fixedNote: WEIGHT_ONLY_NOTE },
  muscle_kg: { label: 'Muscle', unit: 'kg', dp: 1, ref: 'MiScaleLib.getLBM (= bodyMetrics.getMuscleMass): fat-free mass minus bone', usesImpedance: true, range: [10, 150], fitUnit: 1 },
  fat_pct: { label: 'Body fat', unit: '%', dp: 1, ref: 'MiScaleLib.getBodyFat / bodyMetrics.getFatPercentage', usesImpedance: true, range: [3, 70], fitUnit: 1 },
  water_pct: { label: 'Water', unit: '%', dp: 1, ref: 'MiScaleLib.getWater', usesImpedance: true, range: [20, 90], fitUnit: 1 },
  protein_pct: { label: 'Protein', unit: '%', dp: 1, ref: "bodyMetrics.getProteinPercentage (orig), flagged 'guessed formula' in the reference", usesImpedance: true, range: [5, 32], fitUnit: 0.5, fixedNote: PROTEIN_NOTE },
  bone_kg: { label: 'Bone', unit: 'kg', dp: 2, ref: 'MiScaleLib.getBoneMass', usesImpedance: true, range: [0.5, 10], fitUnit: 0.1 },
  smm_kg: { label: 'Skeletal muscle', unit: 'kg', dp: 1, ref: 'MiScaleLib.getMuscle SMM path (Janssen et al.)', usesImpedance: true, range: [5, 100], fitUnit: 1, fixedNote: SMM_NOTE },
  lean_kg: { label: 'Lean mass', unit: 'kg', dp: 1, ref: 'kg * (1 - fat): fat-free mass from MiScaleLib.getBodyFat; shown from the displayed (calibrated) fat', usesImpedance: true, range: [10, 200], fitUnit: 1 },
  bmr_kcal: { label: 'BMR', unit: 'kcal', dp: 0, ref: 'bodyMetrics.getBMR; weight-derived (no impedance)', usesImpedance: false, range: [500, 4000], fitUnit: 15, fixedNote: WEIGHT_ONLY_NOTE },
  bmi: { label: 'BMI', unit: '', dp: 1, ref: 'MiScaleLib.getBMI', usesImpedance: false, range: [10, 90], fitUnit: 1 },
}

// v2: sentinel / clamp values dropped, smm_kg never from an inferred
// impedance, visceral as a whole index.
export const METRICS_VERSION = 2

/** What scale_readings.metrics holds (JSON): the formula values at full
 *  precision, labelled basis 'formula' with each one's reference function. */
export interface StoredMetrics {
  v: number
  /** The profile the values were computed with (height|birth|sex). */
  profile: string
  age: number
  /** The 50 kHz impedance used (ohm), measured or inferred; null = none. */
  impedance_ohm: number | null
  impedance_inferred: boolean
  basis: 'formula'
  values: Partial<Record<MetricKey, number>>
  refs: Partial<Record<MetricKey, string>>
}

export function profileKey(p: Partial<BodyProfile> | undefined | null): string {
  if (!p || typeof p.height_cm !== 'number' || !(p.height_cm > 0) || typeof p.birth_date !== 'string' || (p.sex !== 'male' && p.sex !== 'female')) return ''
  return `${p.height_cm}|${p.birth_date}|${p.sex}`
}

const r4 = (v: number) => Math.round(v * 10000) / 10000

/**
 * The formula metrics of one weigh-in. impedanceLow = the measured 50 kHz
 * impedance; when it is missing and a raw fat % exists (rows stored before
 * impedances were), the impedance is INFERRED by inverting the fat formula
 * and flagged. Weight-only metrics (bmi, visceral, bmr) need no impedance.
 * Null when the profile is incomplete.
 *
 * The references mark their out-of-range answers with sentinels (BMR 5000,
 * muscle 120, bone 8, fat 75) or clamp them (visceral 1-50, fat 5-75,
 * protein 5-32). Those are error markers, not estimates, so a metric whose
 * cap or clamp fired is LEFT OUT here: no sentinel reaches day.body,
 * weighins, the event line or a calibration pair.
 *
 * smm_kg is never computed from an INFERRED impedance: Janssen is H^2/R, so
 * any profile drift since the stored fat was computed lands on R in full
 * (a 5 cm height fix moves it by kilograms), while the fat-derived metrics
 * only round-trip the stored fat.
 */
export function computeMetrics(
  r: { kg: number; measured_at: string; impedance_low: number | null; fat_raw_pct: number | null },
  profile: Partial<BodyProfile> | undefined | null,
): StoredMetrics | null {
  const key = profileKey(profile)
  if (!key) return null
  const { height_cm: h, birth_date, sex } = profile as BodyProfile
  const age = ageAt(birth_date, Date.parse(r.measured_at))
  if (age == null || !(r.kg > 0)) return null
  let imp: number | null = r.impedance_low != null && r.impedance_low > 0 ? r.impedance_low : null
  let inferred = false
  if (imp == null && r.fat_raw_pct != null) {
    imp = inferImpedance(r.fat_raw_pct, r.kg, h, age, sex)
    inferred = imp != null
  }
  const values: Partial<Record<MetricKey, number>> = {}
  values.bmi = bmiOf(r.kg, h)
  // bodyMetrics.getVisceralFat clamps to 1-50; a value outside is the
  // formula failing (the female light branch goes far negative), not 1.
  const vis = visceralFatRaw(r.kg, h, age, sex)
  if (vis >= 1 && vis <= 50) values.visceral = vis
  // bodyMetrics.getBMR: 5000 is its "over the cap" marker, 500 / 10000 its clamp.
  const bmr = bmrKcal(r.kg, h, age, sex)
  if (bmr !== 5000 && bmr > 500 && bmr < 10000) values.bmr_kcal = bmr
  const fat = imp != null ? fatPercent(r.kg, h, age, sex, imp) : null
  if (imp != null) {
    // MiScaleLib.getBoneMass: 8 is its cap marker (> 5.1 / 5.2 kg).
    const bone = boneMassKg(r.kg, h, age, sex, imp)
    if (bone !== 8 && bone >= 0.5) values.bone_kg = bone
    // MiScaleLib.getBodyFat: 75 = "over 63", 5 = clamp. Everything built on
    // fat goes with it.
    if (fat != null && fat > 5 && fat <= 63) {
      values.fat_pct = fat
      values.lean_kg = r.kg * (1 - fat / 100)
      // MiScaleLib.getLBM: 120 is its cap marker (>= 84 / 93.5 kg).
      const muscle = xiaomiMuscleKg(r.kg, h, age, sex, imp, fat)
      if (muscle !== 120 && muscle >= 10) values.muscle_kg = muscle
      values.water_pct = waterPct(fat)
      const protein = proteinDetail(r.kg, h, age, sex, imp, fat)
      if (!protein.outOfRange) values.protein_pct = protein.value
    }
    const smm = inferred ? null : janssenSmmKg(h, age, sex, imp)
    if (smm != null) values.smm_kg = smm
  }
  const refs: Partial<Record<MetricKey, string>> = {}
  for (const k of Object.keys(values) as MetricKey[]) {
    values[k] = r4(values[k]!)
    refs[k] = METRICS[k].ref
  }
  return {
    v: METRICS_VERSION,
    profile: key,
    age,
    impedance_ohm: imp == null ? null : Math.round(imp * 100) / 100,
    impedance_inferred: inferred,
    basis: 'formula',
    values,
    refs,
  }
}

export function parseMetrics(raw: string | null | undefined): StoredMetrics | null {
  if (!raw) return null
  try {
    const m = JSON.parse(raw) as StoredMetrics
    return m && typeof m === 'object' && m.values && typeof m.values === 'object' ? m : null
  } catch {
    return null
  }
}

// ── per-metric calibration ───────────────────────────────────────────

/** fitCalibration (scalecal.ts) in the metric's own units: the pairs are
 *  divided by fitUnit (so the shrinkage prior, the 1-point minimum spread and
 *  the Theil-Sen spacing mean the same thing for kcal as for fat points) and
 *  the model is scaled back. Same labels: n < 3 offset, 3+ shrunk slope. */
export function fitMetric(metric: MetricKey, pairs: CalPair[], nowIso: string): CalModel {
  const u = METRICS[metric].fitUnit
  const m = fitCalibration(
    pairs.map((p) => ({ ...p, raw_pct: p.raw_pct / u, ref_fat_pct: p.ref_fat_pct / u })),
    nowIso,
  )
  const s = (v: number | null | undefined) => (v == null ? v : Math.round(v * u * 1000) / 1000)
  return {
    ...m,
    a: m.a * u,
    residual_rms_pct: s(m.residual_rms_pct) ?? null,
    loo_rms_pct: s(m.loo_rms_pct) ?? null,
    ...(m.raw_min != null ? { raw_min: m.raw_min * u } : {}),
    ...(m.raw_max != null ? { raw_max: m.raw_max * u } : {}),
  }
}

/** A metric's displayed value: the model applied (never below 0), or the
 *  formula value when there is no model. */
export function applyMetric(model: CalModel | null, raw: number): number {
  if (!model || model.kind === 'none') return raw
  return Math.max(0, calibratedValue(model, raw))
}

export type MetricBasis = 'formula' | 'provisional' | 'calibrated'

/** A metric's basis, from the same provenance rule the fat line uses
 *  (scalecal provenanceOf / LINEAR_MIN_PAIRS): uncalibrated = formula. */
export function basisOfProvenance(p: FatProvenance): MetricBasis {
  return p.status === 'uncalibrated' ? 'formula' : p.status
}

export function basisOf(model: CalModel | null): MetricBasis {
  return basisOfProvenance(provenanceOf(model))
}

export function roundMetric(metric: MetricKey, v: number): number {
  const f = 10 ** METRICS[metric].dp
  return Math.round(v * f) / f
}

/** "1 pair" / "4 pairs, +/-0.6 kg" / null (formula). Takes a model, or the
 *  provenance of a stored reading (the fat view: its row's own fit). */
export function calibrationText(metric: MetricKey, from: CalModel | FatProvenance | null): string | null {
  const p = from && 'status' in from ? from : provenanceOf(from)
  const b = basisOfProvenance(p)
  if (b === 'formula') return null
  const pairs = pairCount(p.n)
  if (b === 'provisional') return pairs
  const unit = METRICS[metric].unit
  const rms = p.rms_pct
  // kcal whole, bone to 0.01, everything else (visceral included) to 0.1.
  const dp = unit === 'kcal' ? 0 : METRICS[metric].dp === 2 ? 2 : 1
  return rms != null ? `${pairs}, +/-${rms.toFixed(dp)}${unit === '%' ? ' pt' : unit ? ` ${unit}` : ''}` : pairs
}

// ── views (day.body, weighins rows, the body.weighin line) ──────────

/** One metric as every surface shows it (day.body is the iOS contract:
 *  {key, label, value, unit, basis, note}). */
export interface MetricView {
  key: MetricKey
  label: string
  value: number
  unit: string
  basis: MetricBasis
  /** Bare per-metric caveats, comma-joined, in this order: calibration
   *  ("1 pair", "4 pairs, +/-0.6 kg"), the metric's fixed note ("weight-
   *  derived, no impedance", "guessed formula"), "inferred impedance", and
   *  the fat it was built on ("from formula fat 23.3%", "from calibrated
   *  fat"). Null for a plain formula value. The note never names its metric:
   *  every surface shows it next to the label. */
  note: string | null
}

/** The fat view comes from the fat calibration (scalecal.ts), not a
 *  per-metric model: its value, basis and note are handed in, plus the
 *  open-formula fat of the row (scale_readings.fat_raw_pct) for `raw`. */
export interface FatOverride {
  value: number
  basis: MetricBasis
  note: string | null
  raw?: number | null
}

/** Metrics built on the FORMULA fat (MiScaleLib getLBM / getWater,
 *  bodyMetrics getProteinPercentage). */
const FAT_DEPENDENT: ReadonlySet<MetricKey> = new Set(['muscle_kg', 'water_pct', 'protein_pct'])

/** The metric views of one reading, in DAY_BODY_ORDER (bmi left out),
 *  each with its formula value (`raw`, left out when there is none).
 *
 *  Once fat is calibrated (or provisional) the card must not contradict
 *  itself: lean_kg is derived from the DISPLAYED fat (kg x (1 - fat), with
 *  fat's basis), so fat mass + lean mass = weight on every surface; the
 *  metrics the formulas build on the formula fat (muscle, water, protein)
 *  stay formula values but say which fat they assume, unless a model of
 *  their own already ties them to the reference. */
export function metricViews(
  stored: StoredMetrics | null,
  models: Partial<Record<MetricKey, CalModel>>,
  fat: FatOverride | null,
  kg: number | null = null,
): Array<MetricView & { raw?: number }> {
  const out: Array<MetricView & { raw?: number }> = []
  const formulaFat = stored?.values.fat_pct ?? fat?.raw ?? null
  const fatMoved = !!fat && fat.basis !== 'formula'
  for (const key of DAY_BODY_ORDER) {
    const spec = METRICS[key]
    if (key === 'fat_pct') {
      if (!fat) continue
      // Never the displayed value as raw: once calibrated it is not the formula.
      const raw = formulaFat
      out.push({
        key, label: spec.label, value: roundMetric(key, fat.value), unit: spec.unit, basis: fat.basis, note: fat.note,
        ...(raw != null ? { raw: r4(raw) } : {}),
      })
      continue
    }
    const raw = stored?.values[key]
    if (key === 'lean_kg' && raw != null && fat && kg != null && kg > 0) {
      out.push({
        key, label: spec.label,
        value: roundMetric(key, kg * (1 - fat.value / 100)),
        unit: spec.unit,
        basis: fat.basis,
        note: fatMoved ? `from ${fat.basis} fat` : null,
        raw: r4(raw),
      })
      continue
    }
    if (raw == null) continue
    const model = models[key] ?? null
    const basis = basisOf(model)
    const notes = [
      calibrationText(key, model),
      spec.fixedNote ?? null,
      stored!.impedance_inferred && spec.usesImpedance ? 'inferred impedance' : null,
      fatMoved && basis === 'formula' && FAT_DEPENDENT.has(key) && formulaFat != null ? `from formula fat ${formulaFat.toFixed(1)}%` : null,
    ].filter((x): x is string => !!x)
    out.push({
      key,
      label: spec.label,
      value: roundMetric(key, applyMetric(model, raw)),
      unit: spec.unit,
      basis,
      note: notes.length ? notes.join(', ') : null,
      raw: r4(raw),
    })
  }
  return out
}

/** The body.weighin extra line, visceral + muscle only: "Visceral 9
 *  (formula), muscle 58.2 kg (provisional, 1 pair)." Null when neither. */
export function bodyEventLine(views: MetricView[]): string | null {
  const part = (v: MetricView, first: boolean) => {
    const name = first ? v.label.replace(/ fat$/, '') : v.label.toLowerCase()
    const num = v.value.toFixed(METRICS[v.key].dp)
    return `${name} ${num}${v.unit ? ` ${v.unit}` : ''} (${v.basis}${v.note ? `, ${v.note}` : ''})`
  }
  const picked = (['visceral', 'muscle_kg'] as const).map((k) => views.find((v) => v.key === k)).filter((v): v is MetricView => !!v)
  if (!picked.length) return null
  const s = picked.map((v, i) => part(v, i === 0)).join(', ')
  return `${s[0].toUpperCase()}${s.slice(1)}.`
}
