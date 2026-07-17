// Live HR state machine. Consumes parsed 1Hz-ish samples from a BLE relayer
// and turns them into: a rolling snapshot (for health__live), auto-detected
// workout sessions (WHOOP cannot signal starts; a sustained-hot heart rate
// can), zone milestones, and an end-of-session recovery summary. Pure and
// clock-injected: all time comes from sample timestamps and tick(now).

import type { HrSample } from './hrparse.js'

export const RING_CAP = 7200 // ~2h at 1Hz
const EMA_ALPHA = 2 / 31 // ~30s smoothing at 1Hz
const GAP_RESET_S = 10 // a feed gap this long resets smoothing
const HOT_SUSTAIN_S = 90 // sustained-hot before a session starts
const ZONE_SUSTAIN_S = 15 // time in zone before a milestone fires
const COOL_SUSTAIN_S = 300 // sustained-cool before a session ends
// Must exceed the relayer's ~10-min offline buffer: a mid-workout socket
// outage replays gapless frames on reconnect, and ending the session at 3
// minutes of daemon-side silence would split one workout into two.
const FEED_DROP_END_S = 720
const RMSSD_WINDOW_S = 300
const RMSSD_MIN_INTERVALS = 30
// Artifact gates. Optical wrist HR under vibration/grip pressure emits
// physiologically impossible values (a harmonic lock doubles the true rate:
// a broadcast can read 223 while the true rate is ~111, and WHOOP's own
// cleaned scoring shows the real peak). Broadcast is the raw path, so
// the sanity pass lives here, between parse and state.
const CEILING_MARGIN = 15 // bpm above max HR before a sample is impossible
// The doubling gate's reference window. Tight on purpose: clearing both bars
// across 2.5s implies >= 18 bpm/s, double the max real cardiac slew, so a
// genuine rise seen across a short feed gap is never eaten; still wide
// enough to catch the onset step on a slow ~1Hz feed.
const DOUBLE_WINDOW_MS = 2500
const DOUBLE_RATIO = 1.6 // HR cannot jump 1.6x between adjacent samples...
const DOUBLE_MIN_JUMP = 45 // ...but an orthostatic stand-up spike can be 1.6x
// of a low resting rate, so a small absolute jump is never rejected.
// A garbage-only stream (every frame rejected) proves the feed is alive but
// cannot hold a session open forever: past this bound with no ACCEPTED
// sample, the session ends anyway.
const GARBAGE_END_S = FEED_DROP_END_S * 2
// Confidence tiers. A passive elevation (hot shower, stress, heat, a brisk
// walk) can hold workout-threshold HR for 10+ minutes and fire a full session
// sequence; at a Karvonen-45% start threshold, HR level alone cannot separate
// it from a warmup. The detector stays eager, the ANNOUNCEMENT is tiered:
// consumers decide what to do per level. Duration alone is deliberately NOT
// evidence (a shower runs 15min, stress runs hours);
// what separates exercise on an HR-only feed is EXERCISE SIGNATURE:
// - effort cycling: lifting oscillates across the hot line (sets vs rests);
//   heat/stress/fever plateaus cross it once. Counted as hot-streak starts.
// - sustained depth: steady cardio holds Z3+ for minutes on end, or touches
//   Z4; a shower peaks into low Z3 briefly and vasodilation cannot hold it.
const CONFIRM_MIN_ALIVE_S = 720 // 12 min: duration UPGRADES evidence to high, never creates it
const HOT_CYCLES_EVIDENCE = 4 // distinct hot streaks = interval/set structure
// A hot streak only counts as a NEW effort cycle after an OBSERVED descent
// this far below the hot line. Two failure modes this kills: optical noise
// hugging the threshold (116 +/- 2 re-crosses endlessly but never descends),
// and feed gaps (a gap resets the streak for detection purposes but is
// absence of data, not a rest interval, so it must not re-arm the counter).
const HOT_REARM_DROP = 8
const DEEP_ZONE = 3
const DEEP_SUSTAIN_S = 300 // continuous Z3+ this long = steady-cardio depth
const Z4_SUSTAIN_S = 60 // one continuous Z4+ minute = unambiguous effort
const INTENT_MATCH_BEFORE_MS = 30 * 60_000 // declared-intent lookback (mirrors engine claim window)
// RR-vs-bpm consistency: the band emits RR only with beat-level confidence, so
// a frame's implied rate (60000/meanRR) matching its bpm field proves a real
// pulse; a mismatch is the cadence-lock signature (bpm reads step rate, RR
// reads the true heart). ABSENCE is neutral: movement suppresses RR emission,
// so real workouts legitimately run RR-dry. NOTE: this is an ARTIFACT gate
// only; it cannot separate exercise from resting tachycardia (a shower is a
// real pulse with pristine RR).
const RR_MIN_SAMPLES = 10 // below this, consistency is unknowable, not suspect
const RR_MATCH_TOL = 0.15
const RR_SUSPECT_BELOW = 0.5 // majority-mismatch = artifact-suspect, cap to low

export type RejectReason = 'ceiling' | 'double'
export type SessionConfidence = 'low' | 'medium' | 'high'

export interface LiveDeps {
  /** Resolved max HR (config override or observed-workout-derived). */
  getMaxHr: () => number
  /** Resting HR from the latest recovery, or a safe default. */
  getRestHr: () => number
  /** Config override for the session-start threshold, if set. */
  getHotBpm: () => number | null
  emit: (
    cls: 'live.session' | 'live.confirm' | 'live.zone' | 'live.rest',
    dedupeKey: string,
    payload: { content: string; meta: Record<string, string> },
    // bypassCooldown: the once-per-session confirm is self-throttled here; it
    // must be immune to any class cooldown (and must never re-anchor the
    // live.session cooldown against a later session's start, hence its own
    // class).
    opts?: { bypassCooldown?: boolean },
  ) => void
  onSessionEnd?: (summary: SessionSummary) => void
}

export interface SessionSummary {
  started_at: string
  ended_at: string
  reason: 'cooldown' | 'feed_drop' | 'yield'
  duration_s: number
  avg_bpm: number
  max_bpm: number
  zone_seconds: number[] // index 0..5
  recovery_60s_drop: number | null // classic HRR: bpm drop 60s after last hot
  confidence: SessionConfidence // final level at session end
  intent_matched: boolean // a declared intent covered this session
  demoted: boolean // ended low-confidence with no intent: probably not a workout
  rr_presence: number | null // fraction of samples carrying RR intervals
  rr_consistency: number | null // of those, fraction whose implied rate matches bpm
}

interface Session {
  startTs: number
  sumBpm: number
  n: number
  maxBpm: number
  zoneSeconds: number[]
  // Wall-clock moment the feed entered at-or-above each zone (null = not in
  // it). Real elapsed time, not per-sample accrual: a lossy sub-1Hz feed must
  // not slow milestone detection.
  zoneSince: (number | null)[]
  announced: Set<number>
  lastHotTs: number
  bpmAtLastHot: number
  recovery60Drop: number | null
  // Stats frozen at the moment sustained cooling began, so the summary
  // describes the WORK, not the work plus five minutes of cooldown tail.
  // RR counters are frozen too: the tail is RR-rich real-pulse data that
  // would otherwise outvote work-window mismatches and lift the artifact cap.
  coolSnap: {
    ts: number
    sumBpm: number
    n: number
    zoneSeconds: number[]
    rrSamples: number
    rrConsistent: number
  } | null
  // Confidence evidence (see the tier constants). Latches never un-latch; RR
  // counters accumulate over accepted samples (incl. the ring-seeded start).
  intentMatched: boolean
  hotCycles: number // effort cycles (starts at 1: the detection streak)
  cycleArmed: boolean // an observed sub-(hot-REARM) descent primes the next cycle
  deepHeld: boolean // continuous Z3+ for DEEP_SUSTAIN_S, latched
  z4Held: boolean // continuous Z4+ for Z4_SUSTAIN_S, latched
  rrSamples: number
  rrConsistent: number
  confirmAnnounced: boolean
}

export class LiveState {
  private ring: { ts: number; bpm: number; rr: number[] }[] = []
  private ema: number | null = null
  private lastTs = 0
  // Wall-clock anchors (null = condition not currently holding). Elapsed real
  // time, not summed per-sample dt: dt capping made a lossy feed accrue up to
  // 4.5x slower than reality and misplaced session starts.
  private hotSince: number | null = null
  private coolSince: number | null = null
  private session: Session | null = null
  private rejected = 0
  private lastRejected: { ts: number; bpm: number; reason: RejectReason } | null = null
  private lastIntentTs = 0

  constructor(private deps: LiveDeps) {}

  /** A workout intent was declared (phone tap or MCP tool). An intent within
   *  30min before a detected start marks that session intent-matched: the
   *  user said so, confidence is instantly high. Claim-once throughout: one
   *  tap elevates exactly one session. */
  noteIntent(ts: number): void {
    // A re-tap during an already-matched session is redundant: swallow it
    // WITHOUT re-arming, or it would linger and staple onto the post-workout
    // shower half an hour later.
    if (this.session?.intentMatched) return
    if (this.session) {
      // An EVIDENCED open session is plausibly what the tap names: claim it.
      // An unevidenced (low) one is ambiguous: the tap may name the warmup
      // in progress OR the next activity while a passive elevation is still
      // open. Arm the window instead; the warmup case claims it the moment
      // evidence arrives (maybeConfirm), the next-activity case claims it at
      // that session's start.
      const { level } = this.confidenceOf(this.session, this.lastTs || ts)
      if (level !== 'low') {
        this.session.intentMatched = true
        this.lastIntentTs = 0
        this.maybeConfirm(this.lastTs || ts)
        return
      }
    }
    // Mirror the engine's 3-min retry absorb: a re-tap keeps the FIRST
    // anchor, so livestate's 30-min window and the engine's claim window
    // never drift apart on an absorbed retry press.
    if (this.lastIntentTs > 0 && ts - this.lastIntentTs <= 3 * 60_000) return
    this.lastIntentTs = ts
  }

  /** % of max HR -> zone 0-5. Edges: 50/60/70/80/90. */
  zoneOf(bpm: number): number {
    const pct = bpm / this.deps.getMaxHr()
    if (pct < 0.5) return 0
    if (pct < 0.6) return 1
    if (pct < 0.7) return 2
    if (pct < 0.8) return 3
    if (pct < 0.9) return 4
    return 5
  }

  private hotBpm(): number {
    const override = this.deps.getHotBpm()
    if (override != null) return override
    // Karvonen: rest + 45% of heart-rate reserve.
    const rest = this.deps.getRestHr()
    return Math.round(rest + 0.45 * (this.deps.getMaxHr() - rest))
  }

  private coolBpm(): number {
    const rest = this.deps.getRestHr()
    return Math.round(rest + 0.25 * (this.deps.getMaxHr() - rest))
  }

  /** Returns the artifact-gate reject reason, or null when the sample was accepted. */
  addSample(ts: number, s: HrSample): RejectReason | null {
    if (s.bpm <= 0) return null // no reading
    // A band reporting no skin contact is measuring air: no ring, no state.
    if (s.contact === false) return null
    if (ts <= this.lastTs) return null // replays/out-of-order from a buffer flush

    // Artifact gates: a rejected sample must not touch ring, EMA, zones, max,
    // or streaks. The ceiling kills impossible values outright; the doubling
    // gate kills the onset step of a sub-ceiling harmonic lock (readings that
    // then HOLD a plausible value longer than the window get accepted, which
    // is the safe side: a sustained plausible level is indistinguishable from
    // a real effort).
    const ceiling = Math.min(250, this.deps.getMaxHr() + CEILING_MARGIN)
    if (s.bpm > ceiling) return this.reject(ts, s.bpm, 'ceiling')
    // The ring tail is by construction the last ACCEPTED sample (rejects
    // never enter it), so a transient artifact burst self-heals: the next
    // clean sample is compared against real HR, not the artifact.
    const la = this.ring[this.ring.length - 1]
    if (
      la &&
      ts - la.ts <= DOUBLE_WINDOW_MS &&
      s.bpm >= la.bpm * DOUBLE_RATIO &&
      s.bpm - la.bpm >= DOUBLE_MIN_JUMP
    ) {
      return this.reject(ts, s.bpm, 'double')
    }

    const dt = this.lastTs ? Math.min((ts - this.lastTs) / 1000, 2) : 1
    const gap = this.lastTs ? (ts - this.lastTs) / 1000 : 0
    this.lastTs = ts

    this.ring.push({ ts, bpm: s.bpm, rr: s.rr_ms })
    if (this.ring.length > RING_CAP) this.ring.splice(0, this.ring.length - RING_CAP)

    if (gap > GAP_RESET_S) {
      // A feed gap breaks continuity: smoothing and streaks must not bridge it.
      this.ema = s.bpm
      this.hotSince = null
      this.coolSince = null
      if (this.session) this.session.zoneSince = [null, null, null, null, null, null]
    } else {
      this.ema = this.ema == null ? s.bpm : this.ema + EMA_ALPHA * (s.bpm - this.ema)
    }

    const hot = this.hotBpm()
    const cool = this.coolBpm()

    if (s.bpm >= hot) {
      if (this.hotSince == null) this.hotSince = ts
      this.coolSince = null
      if (this.session) {
        // Effort structure: a return to hot counts as a new cycle only when
        // an observed descent re-armed it (sets vs rests). Threshold-hugging
        // noise and feed gaps never arm, so they cannot fake structure.
        if (this.session.cycleArmed) {
          this.session.hotCycles++
          this.session.cycleArmed = false
        }
        this.session.lastHotTs = ts
        this.session.bpmAtLastHot = s.bpm
        this.session.recovery60Drop = null
      }
    } else {
      this.hotSince = null
      if (this.session && s.bpm <= hot - HOT_REARM_DROP) this.session.cycleArmed = true
      if (s.bpm < cool) {
        if (this.coolSince == null) this.coolSince = ts
      } else {
        this.coolSince = null
      }
    }

    if (!this.session && this.hotSince != null && ts - this.hotSince >= HOT_SUSTAIN_S * 1000) {
      this.startSession(this.hotSince)
    }

    if (this.session) this.updateSession(ts, s.bpm, dt, s.rr_ms)
    return null
  }

  /** Per-sample RR-vs-bpm consistency accounting (see the RR constants).
   *  Only physiologically possible intervals participate (same 300-2000ms
   *  range as the rMSSD path): junk like a 150ms interval is garbage-in, not
   *  a cadence-lock signature, and must not flag a real workout as suspect. */
  private rrAccount(s: Session, bpm: number, rr: number[]): void {
    let sum = 0
    let n = 0
    for (const v of rr) {
      if (v >= 300 && v <= 2000) {
        sum += v
        n++
      }
    }
    if (n === 0) return
    s.rrSamples++
    if (Math.abs(60000 / (sum / n) - bpm) <= bpm * RR_MATCH_TOL) s.rrConsistent++
  }

  private rrStats(s: Session): { presence: number | null; consistency: number | null } {
    // While cooling, judge the WORK window (frozen in coolSnap): the tail's
    // resting pulse emits pristine RR that would dilute a work-window
    // mismatch below the suspect bar.
    const n = s.coolSnap?.n ?? s.n
    const rrSamples = s.coolSnap?.rrSamples ?? s.rrSamples
    const rrConsistent = s.coolSnap?.rrConsistent ?? s.rrConsistent
    return {
      presence: n > 0 ? Math.round((rrSamples / n) * 100) / 100 : null,
      consistency:
        rrSamples >= RR_MIN_SAMPLES ? Math.round((rrConsistent / rrSamples) * 100) / 100 : null,
    }
  }

  private confidenceOf(s: Session, nowTs: number): { level: SessionConfidence; reasons: string[] } {
    // The user's explicit word outranks every inference, the artifact gate
    // included: a declared session with a noisy optical stream is still the
    // declared session (rr stats stay in the summary for forensics).
    if (s.intentMatched) return { level: 'high', reasons: ['intent'] }
    // Majority RR mismatch is the cadence-lock signature: the elevation itself
    // is untrustworthy, so nothing else can upgrade it.
    const { consistency } = this.rrStats(s)
    if (consistency != null && consistency < RR_SUSPECT_BELOW) {
      return { level: 'low', reasons: ['rr_suspect'] }
    }
    const reasons: string[] = []
    if (s.hotCycles >= HOT_CYCLES_EVIDENCE) reasons.push('effort_cycles')
    if (s.deepHeld) reasons.push('sustained_z3')
    if (s.z4Held) reasons.push('z4')
    // Exercise signature: interval/set structure or sustained depth. Duration
    // alone is NOT evidence (showers run 15 min, stress runs hours); it only
    // upgrades an already-evidenced session to high.
    const evidence = reasons.length > 0
    const aliveOk = nowTs - s.startTs >= CONFIRM_MIN_ALIVE_S * 1000
    if (evidence && aliveOk) reasons.push('duration')
    const level: SessionConfidence = evidence && aliveOk ? 'high' : evidence ? 'medium' : 'low'
    return { level, reasons }
  }

  /** Emit the once-per-session confirmation the moment confidence first leaves
   *  'low'. This is the event conservative consumers (a future phone card)
   *  key on; the eager start event stays coach-only awareness. */
  private maybeConfirm(ts: number): void {
    const s = this.session
    if (!s || s.confirmAnnounced) return
    // Late claim: a tap that landed while this session was still unevidenced
    // (the ambiguous case in noteIntent) belongs to it the moment it develops
    // an exercise signature.
    if (
      !s.intentMatched &&
      this.lastIntentTs > 0 &&
      ts - this.lastIntentTs <= INTENT_MATCH_BEFORE_MS &&
      this.confidenceOf(s, ts).level !== 'low'
    ) {
      s.intentMatched = true
      this.lastIntentTs = 0
    }
    const { level, reasons } = this.confidenceOf(s, ts)
    if (level === 'low') return
    // Latch before emitting so a re-entrant call cannot double-fire, but
    // un-latch on an emit failure (a store hiccup must cost one retry on the
    // next sample, not the whole session's confirm, and must never bubble up
    // into frame or intent handling).
    s.confirmAnnounced = true
    const startIso = new Date(s.startTs).toISOString()
    const invite = s.intentMatched ? '' : ' If so, log it: /health starting <activity>.'
    try {
      this.deps.emit(
        'live.confirm',
        `live.confirm:${startIso}`,
        {
          content: `Session confirmed (${reasons.join(' + ')}): ${fmtMinSec((ts - s.startTs) / 1000)} in, avg ${s.n ? Math.round(s.sumBpm / s.n) : 0} bpm, peak ${s.maxBpm}.${invite}`,
          meta: {
            class: 'live.confirm',
            kind: 'confirm',
            confidence: level,
            confidence_reasons: reasons.join(','),
            bpm: String(Math.round(this.ema ?? 0)),
            started_at: startIso,
          },
        },
        { bypassCooldown: true },
      )
    } catch {
      s.confirmAnnounced = false
    }
  }

  private reject(ts: number, bpm: number, reason: RejectReason): RejectReason {
    this.rejected++
    this.lastRejected = { ts, bpm, reason }
    return reason
  }

  /** Cumulative artifact-gate rejections (for status/observability). */
  rejectedSamples(): number {
    return this.rejected
  }

  private startSession(startTs: number): void {
    this.session = {
      startTs,
      sumBpm: 0,
      n: 0,
      maxBpm: 0,
      zoneSeconds: [0, 0, 0, 0, 0, 0],
      zoneSince: [null, null, null, null, null, null],
      announced: new Set(),
      lastHotTs: startTs,
      bpmAtLastHot: 0,
      recovery60Drop: null,
      coolSnap: null,
      // An intent declared shortly before the detected start (or during the
      // 90s detection ramp, where lastIntentTs > startTs) matches immediately.
      intentMatched: this.lastIntentTs > 0 && startTs - this.lastIntentTs <= INTENT_MATCH_BEFORE_MS,
      hotCycles: 1,
      cycleArmed: false,
      deepHeld: false,
      z4Held: false,
      rrSamples: 0,
      rrConsistent: 0,
      confirmAnnounced: false,
    }
    // Claim-once (mirrors the engine's intent stapling): one tap elevates one
    // session. Without this, the post-workout hot shower 20 min after a
    // declared lift would inherit the same intent and read as high confidence.
    if (this.session.intentMatched) this.lastIntentTs = 0
    // The session began when the hot streak began, and those ~90 detection
    // seconds are in the ring: seed the stats so duration, average, and zone
    // time all describe the same span. (The current sample is excluded here
    // and counted by the updateSession call that follows.)
    const s = this.session
    for (const p of this.ring) {
      if (p.ts < startTs || p.ts >= this.lastTs) continue
      s.sumBpm += p.bpm
      s.n++
      if (p.bpm > s.maxBpm) s.maxBpm = p.bpm
      s.zoneSeconds[this.zoneOf(p.bpm)] += 1
      this.rrAccount(s, p.bpm, p.rr)
    }
    const { level, reasons } = this.confidenceOf(s, this.lastTs || startTs)
    // A start that is already medium/high (pre-declared intent) carries its
    // level on this event; the separate confirm exists for late upgrades.
    if (level !== 'low') s.confirmAnnounced = true
    const iso = new Date(startTs).toISOString()
    const now = Math.round(this.ema ?? 0)
    // The prose matches the tier: a low start must not read as a prompt (it
    // may be a shower/walk/stress plateau; the confirm event carries the
    // call-to-action if evidence shows up).
    const content =
      level === 'low'
        ? `Sustained HR elevation for ${HOT_SUSTAIN_S}s (now ${now} bpm). Unconfirmed: could be a session starting or non-exercise (heat, stress, walking); a confirm event follows if it develops an exercise signature.`
        : `Live HR has been at workout intensity for ${HOT_SUSTAIN_S}s (now ${now} bpm).${s.intentMatched ? ' Matches the declared intent: this is the session.' : ' Looks like a session starting. If so, log it: /health starting <activity>.'}`
    // A declared/evidenced start is immune to the class cooldown: that
    // cooldown exists to mute LOW-confidence start flapping, and it must
    // never swallow the one start event of a session the user asked for
    // (a phantom's start minutes earlier would otherwise anchor it away).
    this.deps.emit(
      'live.session',
      `live.session:${iso}`,
      {
        content,
        meta: {
          class: 'live.session',
          confidence: level,
          ...(reasons.length ? { confidence_reasons: reasons.join(',') } : {}),
          bpm: String(now),
          started_at: iso,
        },
      },
      level !== 'low' ? { bypassCooldown: true } : undefined,
    )
  }

  private updateSession(ts: number, bpm: number, dt: number, rr: number[]): void {
    const s = this.session!
    if (bpm < this.coolBpm()) {
      if (!s.coolSnap) {
        s.coolSnap = {
          ts,
          sumBpm: s.sumBpm,
          n: s.n,
          zoneSeconds: [...s.zoneSeconds],
          rrSamples: s.rrSamples,
          rrConsistent: s.rrConsistent,
        }
      }
    } else {
      s.coolSnap = null
    }
    s.sumBpm += bpm
    s.n++
    if (bpm > s.maxBpm) s.maxBpm = bpm
    this.rrAccount(s, bpm, rr)
    const zone = this.zoneOf(bpm)
    s.zoneSeconds[zone] += dt

    for (let z = 3; z <= 5; z++) {
      if (zone >= z) {
        if (s.zoneSince[z] == null) s.zoneSince[z] = ts
      } else {
        s.zoneSince[z] = null
      }
    }
    // Depth evidence latches. Ride on zoneSince, so feed gaps (which wipe
    // zoneSince) reset the STREAK but never a latch already earned.
    const deepSince = s.zoneSince[DEEP_ZONE]
    if (deepSince != null && ts - deepSince >= DEEP_SUSTAIN_S * 1000) s.deepHeld = true
    const z4Since = s.zoneSince[4]
    if (z4Since != null && ts - z4Since >= Z4_SUSTAIN_S * 1000) s.z4Held = true
    // Announce only the HIGHEST newly-earned zone; a jump straight to Z5
    // should not also fire Z3 and Z4 in the same breath.
    let earned = 0
    for (let z = 3; z <= 5; z++) {
      const since = s.zoneSince[z]
      if (since != null && ts - since >= ZONE_SUSTAIN_S * 1000 && !s.announced.has(z)) earned = z
    }
    if (earned >= 3) {
      // The confidence contract covers milestones too: a low session's zone
      // touch stays silent (a passive elevation can graze Z3 for 15s), and
      // it is NOT marked announced, so the milestone fires the moment the
      // session earns its confidence while still in the zone.
      const conf = this.confidenceOf(s, ts)
      if (conf.level !== 'low') {
        for (let z = 3; z <= earned; z++) s.announced.add(z)
        const startIso = new Date(s.startTs).toISOString()
        this.deps.emit('live.zone', `live.zone:${startIso}:z${earned}`, {
          content: `Zone ${earned} reached: ${bpm} bpm (${Math.round((bpm / this.deps.getMaxHr()) * 100)}% of max), ${fmtMinSec((ts - s.startTs) / 1000)} into the session.`,
          meta: {
            class: 'live.zone',
            zone: String(earned),
            bpm: String(bpm),
            confidence: conf.level,
            started_at: startIso,
          },
        })
      }
    }

    // Classic 60s heart-rate-recovery: drop measured one minute after the
    // last hot sample. Captured once per quiet spell, refreshed if effort resumes.
    if (s.recovery60Drop == null && s.bpmAtLastHot > 0 && ts - s.lastHotTs >= 60_000) {
      s.recovery60Drop = s.bpmAtLastHot - bpm
    }

    this.maybeConfirm(ts)

    if (this.coolSince != null && ts - this.coolSince >= COOL_SUSTAIN_S * 1000) {
      this.endSession(ts, 'cooldown')
    }
  }

  /** Is a workout session currently in progress? (Arbitration probe guard.) */
  sessionActive(): boolean {
    return this.session != null
  }

  /** The band is being surrendered to an external receiver: close any open
   *  session NOW with an honest reason, instead of letting the feed-drop
   *  timer report "broadcast stopped" 12 minutes into the yield. */
  yieldInterrupt(ts: number): void {
    if (this.session) this.endSession(ts, 'yield')
    this.hotSince = null
  }

  /** Time-driven transitions; call every ~30s. Ends a session on feed silence. */
  tick(now: number): void {
    if (!this.session || !this.lastTs) return
    // Rejected frames prove the feed is ALIVE (the band is talking, the data
    // is untrustworthy), so they defer a feed_drop end: a mid-ride artifact
    // storm must not split one workout into two. But garbage cannot hold a
    // session open forever (cooldown needs accepted samples to fire), so past
    // GARBAGE_END_S with no accepted sample the session ends anyway, anchored
    // at the last trustworthy sample.
    const lastEvidence = Math.max(this.lastTs, this.lastRejected?.ts ?? 0)
    const silent = now - lastEvidence >= FEED_DROP_END_S * 1000
    const garbage = now - this.lastTs >= GARBAGE_END_S * 1000
    if (silent || garbage) this.endSession(this.lastTs, 'feed_drop')
  }

  private endSession(endTs: number, reason: 'cooldown' | 'feed_drop' | 'yield'): void {
    const s = this.session!
    this.session = null
    this.hotSince = null
    this.coolSince = null
    // A cooldown end means the last 5 min were tail, not work: report the
    // session as it stood when sustained cooling began.
    // The cooling snapshot (when one exists) is the end-stats source for BOTH
    // end reasons: a feed that dies mid-cooldown (band off, walked out) ended
    // its work at cooling onset just like a clean cooldown end did.
    const stats = s.coolSnap ?? { ts: endTs, sumBpm: s.sumBpm, n: s.n, zoneSeconds: s.zoneSeconds }
    // Unreachable in practice (the 90s start gate seeds ~90 samples before a
    // session can exist), kept as a divide-by-zero guard. A hit would drop
    // the summary AND the archive row, so never widen what reaches it.
    if (stats.n === 0) return

    // Final confidence, measured to when the WORK ended (the cooldown tail
    // must not buy a shower 5 extra minutes toward the duration bar; rrStats
    // is coolSnap-frozen the same way). A low-confidence, never-declared,
    // never-confirmed session is DEMOTED: archived and reported, but flagged
    // as probably-not-a-workout so coaching and training-load reads skip it.
    // A session that already ANNOUNCED a confirm is never demoted: the events
    // must not contradict each other (the rr forensics still persist).
    // WHOOP scoring an overlapping workout later upgrades the archived row
    // (see corroborateLiveSessions).
    const { level } = this.confidenceOf(s, stats.ts)
    const rr = this.rrStats(s)
    const demoted = level === 'low' && !s.intentMatched && !s.confirmAnnounced

    const summary: SessionSummary = {
      started_at: new Date(s.startTs).toISOString(),
      ended_at: new Date(stats.ts).toISOString(),
      reason,
      duration_s: Math.round((stats.ts - s.startTs) / 1000),
      avg_bpm: Math.round(stats.sumBpm / stats.n),
      max_bpm: s.maxBpm,
      zone_seconds: stats.zoneSeconds.map((z) => Math.round(z)),
      recovery_60s_drop: s.recovery60Drop,
      confidence: level,
      intent_matched: s.intentMatched,
      demoted,
      rr_presence: rr.presence,
      rr_consistency: rr.consistency,
    }

    const zoneLine = summary.zone_seconds
      .map((sec, z) => (z >= 2 && sec >= 60 ? `Z${z} ${fmtMinSec(sec)}` : null))
      .filter(Boolean)
      .join(', ')
    const recovery =
      summary.recovery_60s_drop != null
        ? ` HR recovery: -${summary.recovery_60s_drop} bpm in the minute after the last effort.`
        : ''
    const how =
      reason === 'feed_drop' ? 'broadcast stopped' : reason === 'yield' ? 'band yielded' : 'cooled down'
    const body = `${fmtMinSec(summary.duration_s)}, avg ${summary.avg_bpm} bpm, peak ${summary.max_bpm}.${zoneLine ? ` Zones: ${zoneLine}.` : ''}${recovery}`
    const content = demoted
      ? `Elevation ended (${how}): ${body} Probably not a workout (no intent declared, no exercise signature: no set/interval structure, no sustained depth); ignore for training load.`
      : `Session over (${how}): ${body}`
    // The emit can throw (a store hiccup inside the event queue); the archive
    // row must land regardless, or the session becomes uncorroboratable
    // forever (the session state is already cleared above).
    try {
      this.deps.emit('live.rest', `live.rest:${summary.started_at}`, {
        content,
        meta: {
          class: 'live.rest',
          duration_s: String(summary.duration_s),
          avg_bpm: String(summary.avg_bpm),
          max_bpm: String(summary.max_bpm),
          confidence: level,
          ...(demoted ? { demoted: 'true' } : {}),
          ...(s.intentMatched ? { intent_matched: 'true' } : {}),
          ...(rr.presence != null ? { rr_presence: String(rr.presence) } : {}),
          ...(rr.consistency != null ? { rr_consistency: String(rr.consistency) } : {}),
          started_at: summary.started_at,
        },
      })
    } catch {
      // The summary below still persists; the event is the lossy half.
    }
    this.deps.onSessionEnd?.(summary)
  }

  /**
   * Rolling rMSSD over the last 5 minutes of near-rest RR intervals. The
   * ceiling is rest+40: sleeping RHR plus the seated/standing margin (an
   * awake desk HR runs 20-30 over sleeping RHR); above that, effort makes
   * RR untrustworthy for a resting-HRV read.
   *
   * The band emits RR only when it has beat-level confidence, so RR arrives
   * in BURSTS with gaps while the wearer moves. Differencing across a gap
   * fabricates huge "variability" (a 250ms rMSSD from a real 40ms heart), so
   * pairs are formed only between temporally-adjacent packets, and pairs are
   * artifact-rejected the standard way (physiological range + max jump).
   */
  private restRrPairs(): [number, number][] {
    if (!this.lastTs) return []
    const cutoff = this.lastTs - RMSSD_WINDOW_S * 1000
    const restCeiling = this.deps.getRestHr() + 40
    const pairs: [number, number][] = []
    let prevRr: number | null = null
    let prevTs = 0
    for (const p of this.ring) {
      if (p.ts < cutoff || p.bpm >= restCeiling || p.rr.length === 0) continue
      for (const rr of p.rr) {
        if (rr < 300 || rr > 2000) {
          prevRr = null // out of physiological range: break the chain
          continue
        }
        // 1500ms = adjacent ~1Hz packets only; a skipped packet means missing
        // beats in between, and diffing across them biases the result.
        const adjacent = prevRr != null && p.ts - prevTs <= 1500
        if (adjacent && Math.abs(rr - prevRr!) <= 200) pairs.push([prevRr!, rr])
        prevRr = rr
        prevTs = p.ts
      }
    }
    return pairs
  }

  rmssd(): number | null {
    const pairs = this.restRrPairs()
    if (pairs.length < RMSSD_MIN_INTERVALS) return null
    let sum = 0
    for (const [a, b] of pairs) sum += (b - a) ** 2
    return Math.round(Math.sqrt(sum / pairs.length) * 10) / 10
  }

  snapshot(now: number): Record<string, unknown> {
    const last = this.ring[this.ring.length - 1] ?? null
    const stale = !last || now - last.ts > 15_000
    const s = this.session
    return {
      feed: stale ? 'stale' : 'live',
      bpm: last?.bpm ?? null,
      bpm_smoothed: this.ema == null ? null : Math.round(this.ema),
      zone: last && !stale ? this.zoneOf(last.bpm) : null,
      last_sample_at: last ? new Date(last.ts).toISOString() : null,
      samples_buffered: this.ring.length,
      max_hr: this.deps.getMaxHr(),
      session_threshold_bpm: this.hotBpm(),
      rmssd_5min: this.rmssd(),
      rr_pairs_5min: this.restRrPairs().length,
      rejected_samples: this.rejected,
      // Scoped to the ring horizon: a days-old artifact must not read as a
      // statement about the current feed's health.
      last_rejected:
        this.lastRejected && now - this.lastRejected.ts <= RING_CAP * 1000
          ? {
              rejected_at: new Date(this.lastRejected.ts).toISOString(),
              bpm: this.lastRejected.bpm,
              reason: this.lastRejected.reason,
            }
          : null,
      session: s
        ? {
            started_at: new Date(s.startTs).toISOString(),
            elapsed_s: last ? Math.round((last.ts - s.startTs) / 1000) : 0,
            avg_bpm: s.n ? Math.round(s.sumBpm / s.n) : null,
            max_bpm: s.maxBpm,
            zone_seconds: s.zoneSeconds.map((z) => Math.round(z)),
            confidence: this.confidenceOf(s, this.lastTs || now).level,
            intent_matched: s.intentMatched,
            rr_presence: this.rrStats(s).presence,
            rr_consistency: this.rrStats(s).consistency,
          }
        : null,
    }
  }
}

function fmtMinSec(totalS: number): string {
  const m = Math.floor(totalS / 60)
  const sec = Math.round(totalS % 60)
  return m > 0 ? `${m}m${String(sec).padStart(2, '0')}s` : `${sec}s`
}
