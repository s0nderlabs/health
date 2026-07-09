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

export interface LiveDeps {
  /** Resolved max HR (config override or observed-workout-derived). */
  getMaxHr: () => number
  /** Resting HR from the latest recovery, or a safe default. */
  getRestHr: () => number
  /** Config override for the session-start threshold, if set. */
  getHotBpm: () => number | null
  emit: (
    cls: 'live.session' | 'live.zone' | 'live.rest',
    dedupeKey: string,
    payload: { content: string; meta: Record<string, string> },
  ) => void
  onSessionEnd?: (summary: SessionSummary) => void
}

export interface SessionSummary {
  started_at: string
  ended_at: string
  reason: 'cooldown' | 'feed_drop'
  duration_s: number
  avg_bpm: number
  max_bpm: number
  zone_seconds: number[] // index 0..5
  recovery_60s_drop: number | null // classic HRR: bpm drop 60s after last hot
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
  coolSnap: { ts: number; sumBpm: number; n: number; zoneSeconds: number[] } | null
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

  constructor(private deps: LiveDeps) {}

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

  addSample(ts: number, s: HrSample): void {
    if (s.bpm <= 0 || s.bpm > 250) return // junk guard
    // A band reporting no skin contact is measuring air: no ring, no state.
    if (s.contact === false) return
    if (ts <= this.lastTs) return // replays/out-of-order from a buffer flush
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
        this.session.lastHotTs = ts
        this.session.bpmAtLastHot = s.bpm
        this.session.recovery60Drop = null
      }
    } else {
      this.hotSince = null
      if (s.bpm < cool) {
        if (this.coolSince == null) this.coolSince = ts
      } else {
        this.coolSince = null
      }
    }

    if (!this.session && this.hotSince != null && ts - this.hotSince >= HOT_SUSTAIN_S * 1000) {
      this.startSession(this.hotSince)
    }

    if (this.session) this.updateSession(ts, s.bpm, dt)
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
    }
    // The session began when the hot streak began, and those ~90 detection
    // seconds are in the ring: seed the stats so duration, average, and zone
    // time all describe the same span.
    const s = this.session
    for (const p of this.ring) {
      if (p.ts < startTs || p.ts >= this.lastTs) continue
      s.sumBpm += p.bpm
      s.n++
      if (p.bpm > s.maxBpm) s.maxBpm = p.bpm
      s.zoneSeconds[this.zoneOf(p.bpm)] += 1
    }
    const iso = new Date(startTs).toISOString()
    this.deps.emit('live.session', `live.session:${iso}`, {
      content: `Live HR has been at workout intensity for ${HOT_SUSTAIN_S}s (now ${Math.round(this.ema ?? 0)} bpm). Looks like a session starting. If so, log it: /health starting <activity>.`,
      meta: { class: 'live.session', bpm: String(Math.round(this.ema ?? 0)), started_at: iso },
    })
  }

  private updateSession(ts: number, bpm: number, dt: number): void {
    const s = this.session!
    if (bpm < this.coolBpm()) {
      if (!s.coolSnap) s.coolSnap = { ts, sumBpm: s.sumBpm, n: s.n, zoneSeconds: [...s.zoneSeconds] }
    } else {
      s.coolSnap = null
    }
    s.sumBpm += bpm
    s.n++
    if (bpm > s.maxBpm) s.maxBpm = bpm
    const zone = this.zoneOf(bpm)
    s.zoneSeconds[zone] += dt

    for (let z = 3; z <= 5; z++) {
      if (zone >= z) {
        if (s.zoneSince[z] == null) s.zoneSince[z] = ts
      } else {
        s.zoneSince[z] = null
      }
    }
    // Announce only the HIGHEST newly-earned zone; a jump straight to Z5
    // should not also fire Z3 and Z4 in the same breath.
    let earned = 0
    for (let z = 3; z <= 5; z++) {
      const since = s.zoneSince[z]
      if (since != null && ts - since >= ZONE_SUSTAIN_S * 1000 && !s.announced.has(z)) earned = z
    }
    if (earned >= 3) {
      for (let z = 3; z <= earned; z++) s.announced.add(z)
      const startIso = new Date(s.startTs).toISOString()
      this.deps.emit('live.zone', `live.zone:${startIso}:z${earned}`, {
        content: `Zone ${earned} reached: ${bpm} bpm (${Math.round((bpm / this.deps.getMaxHr()) * 100)}% of max), ${fmtMinSec((ts - s.startTs) / 1000)} into the session.`,
        meta: { class: 'live.zone', zone: String(earned), bpm: String(bpm), started_at: startIso },
      })
    }

    // Classic 60s heart-rate-recovery: drop measured one minute after the
    // last hot sample. Captured once per quiet spell, refreshed if effort resumes.
    if (s.recovery60Drop == null && s.bpmAtLastHot > 0 && ts - s.lastHotTs >= 60_000) {
      s.recovery60Drop = s.bpmAtLastHot - bpm
    }

    if (this.coolSince != null && ts - this.coolSince >= COOL_SUSTAIN_S * 1000) {
      this.endSession(ts, 'cooldown')
    }
  }

  /** Time-driven transitions; call every ~30s. Ends a session on feed silence. */
  tick(now: number): void {
    if (this.session && this.lastTs && now - this.lastTs >= FEED_DROP_END_S * 1000) {
      this.endSession(this.lastTs, 'feed_drop')
    }
  }

  private endSession(endTs: number, reason: 'cooldown' | 'feed_drop'): void {
    const s = this.session!
    this.session = null
    this.hotSince = null
    this.coolSince = null
    // A cooldown end means the last 5 min were tail, not work: report the
    // session as it stood when sustained cooling began.
    const stats = reason === 'cooldown' && s.coolSnap ? s.coolSnap : { ts: endTs, sumBpm: s.sumBpm, n: s.n, zoneSeconds: s.zoneSeconds }
    if (stats.n === 0) return

    const summary: SessionSummary = {
      started_at: new Date(s.startTs).toISOString(),
      ended_at: new Date(stats.ts).toISOString(),
      reason,
      duration_s: Math.round((stats.ts - s.startTs) / 1000),
      avg_bpm: Math.round(stats.sumBpm / stats.n),
      max_bpm: s.maxBpm,
      zone_seconds: stats.zoneSeconds.map((z) => Math.round(z)),
      recovery_60s_drop: s.recovery60Drop,
    }

    const zoneLine = summary.zone_seconds
      .map((sec, z) => (z >= 2 && sec >= 60 ? `Z${z} ${fmtMinSec(sec)}` : null))
      .filter(Boolean)
      .join(', ')
    const recovery =
      summary.recovery_60s_drop != null
        ? ` HR recovery: -${summary.recovery_60s_drop} bpm in the minute after the last effort.`
        : ''
    this.deps.emit('live.rest', `live.rest:${summary.started_at}`, {
      content: `Session over (${reason === 'feed_drop' ? 'broadcast stopped' : 'cooled down'}): ${fmtMinSec(summary.duration_s)}, avg ${summary.avg_bpm} bpm, peak ${summary.max_bpm}.${zoneLine ? ` Zones: ${zoneLine}.` : ''}${recovery}`,
      meta: {
        class: 'live.rest',
        duration_s: String(summary.duration_s),
        avg_bpm: String(summary.avg_bpm),
        max_bpm: String(summary.max_bpm),
        started_at: summary.started_at,
      },
    })
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
      session: s
        ? {
            started_at: new Date(s.startTs).toISOString(),
            elapsed_s: last ? Math.round((last.ts - s.startTs) / 1000) : 0,
            avg_bpm: s.n ? Math.round(s.sumBpm / s.n) : null,
            max_bpm: s.maxBpm,
            zone_seconds: s.zoneSeconds.map((z) => Math.round(z)),
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
