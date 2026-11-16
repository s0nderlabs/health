import { describe, expect, test } from 'bun:test'
import {
  LiveState,
  RING_CAP,
  INTENT_MATCH_BEFORE_MS,
  INTENT_REARM_FUSE_MS,
  IDLE_END_S,
  intentRearmPlan,
} from '../src/livestate.js'
import type { SessionSummary } from '../src/livestate.js'
import { parseBase64Frame } from '../src/hrparse.js'

const T0 = Date.parse('2026-07-09T10:00:00.000Z')

interface Emitted {
  cls: string
  key: string
  content: string
  meta: Record<string, string>
}

function harness(
  opts: {
    maxHr?: number
    restHr?: number
    hotBpm?: number | null
    hasScoredOverlap?: (startIso: string, endIso: string) => boolean
  } = {},
) {
  const events: Emitted[] = []
  const summaries: SessionSummary[] = []
  const intentClaims: string[] = []
  const overlapProbes: Array<[string, string]> = []
  let intentReleases = 0
  const state = new LiveState({
    getMaxHr: () => opts.maxHr ?? 190,
    getRestHr: () => opts.restHr ?? 56,
    getHotBpm: () => opts.hotBpm ?? null,
    emit: (cls, key, payload) => events.push({ cls, key, ...payload }),
    onSessionEnd: (s) => summaries.push(s),
    hasScoredOverlap: opts.hasScoredOverlap
      ? (a, b) => {
          overlapProbes.push([a, b])
          return opts.hasScoredOverlap!(a, b)
        }
      : undefined,
    onIntentClaim: (iso) => intentClaims.push(iso),
    onIntentRelease: () => intentReleases++,
  })
  return { state, events, summaries, intentClaims, overlapProbes, releases: () => intentReleases }
}

// With maxHr 190 / restHr 56: hot = 116, cool = 90 (Karvonen 45% / 25%).
function feed(
  state: LiveState,
  fromS: number,
  seconds: number,
  bpm: number | ((i: number) => number),
  rr: number[] = [],
): void {
  for (let i = 0; i < seconds; i++) {
    const b = typeof bpm === 'function' ? bpm(i) : bpm
    state.addSample(T0 + (fromS + i) * 1000, { bpm: b, rr_ms: rr, contact: null })
  }
}

describe('session detection', () => {
  test('resting HR never starts a session', () => {
    const { state, events } = harness()
    feed(state, 0, 600, 62)
    expect(events).toHaveLength(0)
  })

  test('90s sustained above threshold starts a session', () => {
    const { state, events } = harness()
    feed(state, 0, 60, 70)
    // Ramp like a real heart: a 70->125 step between adjacent samples is
    // exactly what the doubling gate exists to reject.
    feed(state, 60, 3, (i) => 90 + i * 15)
    feed(state, 63, 95, 125)
    const starts = events.filter((e) => e.cls === 'live.session')
    expect(starts).toHaveLength(1)
    expect(starts[0].key).toContain('live.session:')
    expect(starts[0].meta.started_at).toBeDefined()
  })

  test('a brief spike does not start a session', () => {
    const { state, events } = harness()
    feed(state, 0, 60, 70)
    feed(state, 60, 45, 130) // hot but only 45s
    feed(state, 105, 120, 70)
    expect(events.filter((e) => e.cls === 'live.session')).toHaveLength(0)
  })

  test('config hot_bpm override is respected', () => {
    const { state, events } = harness({ hotBpm: 100 })
    feed(state, 0, 95, 105) // hot under override, cold under Karvonen
    expect(events.filter((e) => e.cls === 'live.session')).toHaveLength(1)
  })

  test('no-contact samples are skipped entirely (no session, no ring)', () => {
    const { state, events } = harness()
    for (let i = 0; i < 120; i++) {
      state.addSample(T0 + i * 1000, { bpm: 130, rr_ms: [], contact: false })
    }
    expect(events).toHaveLength(0)
    expect(state.snapshot(T0 + 120_000).samples_buffered).toBe(0)
  })

  test('a feed gap resets the hot streak (no session bridged across it)', () => {
    const { state, events } = harness()
    feed(state, 0, 60, 130) // 60s hot
    feed(state, 90, 60, 130) // 30s gap, then 60s hot: must NOT combine to 90
    expect(events.filter((e) => e.cls === 'live.session')).toHaveLength(0)
    feed(state, 150, 35, 130) // continuous now: 60+35 = 95s sustained
    expect(events.filter((e) => e.cls === 'live.session')).toHaveLength(1)
  })
})

describe('zoneOf (Karvonen)', () => {
  // % of heart-rate reserve above resting, edges 40/60/70/80/90, matching
  // WHOOP's bands. At max 190 / rest 56 (reserve 134) the edges land at
  // 109.6 / 136.4 / 149.8 / 163.2 / 176.6.
  test('zone edges match WHOOP bands', () => {
    const { state } = harness()
    expect(state.zoneOf(109)).toBe(0)
    expect(state.zoneOf(110)).toBe(1)
    expect(state.zoneOf(136)).toBe(1)
    expect(state.zoneOf(137)).toBe(2)
    expect(state.zoneOf(149)).toBe(2)
    expect(state.zoneOf(150)).toBe(3)
    expect(state.zoneOf(163)).toBe(3)
    expect(state.zoneOf(164)).toBe(4)
    expect(state.zoneOf(176)).toBe(4)
    expect(state.zoneOf(177)).toBe(5)
  })

  test('the Jul 22 field case: 134 bpm is Zone 1, not Zone 3', () => {
    // At his real numbers (max 187, rolling rest 59), the %-max model called
    // 134 bpm "Zone 3" mid-ride while WHOOP's app showed Zone 1.
    const { state } = harness({ maxHr: 187, restHr: 59 })
    expect(state.zoneOf(134)).toBe(1)
  })
})

describe('zone milestones', () => {
  // Milestones obey the confidence contract (low = silent), so these tests
  // declare an intent up front: the session is high-confidence throughout
  // and the zone logic itself is what's under test.
  test('sustained Z4 announces only the highest zone reached', () => {
    const { state, events } = harness()
    state.noteIntent(T0)
    feed(state, 0, 95, 125) // session starts (Z1: 51% of reserve)
    feed(state, 95, 30, 170) // Z4 (85% of reserve)
    const zones = events.filter((e) => e.cls === 'live.zone')
    expect(zones).toHaveLength(1)
    expect(zones[0].meta.zone).toBe('4')
  })

  test('gradual ramp announces each zone as it is earned', () => {
    const { state, events } = harness()
    state.noteIntent(T0)
    feed(state, 0, 95, 125)
    feed(state, 95, 60, 152) // Z3 (72% of reserve)
    feed(state, 155, 60, 168) // Z4 (84%)
    feed(state, 215, 60, 180) // Z5 (93%)
    const zones = events.filter((e) => e.cls === 'live.zone').map((e) => e.meta.zone)
    expect(zones).toEqual(['3', '4', '5'])
  })

  test('a zone is announced once per session', () => {
    const { state, events } = harness()
    state.noteIntent(T0)
    feed(state, 0, 95, 125)
    feed(state, 95, 30, 160) // Z3 (78% of reserve)
    feed(state, 125, 60, 125) // back down
    feed(state, 185, 30, 160) // Z3 again
    expect(events.filter((e) => e.cls === 'live.zone')).toHaveLength(1)
  })

  test('a 10s zone touch does not announce', () => {
    const { state, events } = harness()
    state.noteIntent(T0)
    feed(state, 0, 95, 125)
    feed(state, 95, 10, 160)
    feed(state, 105, 60, 125)
    expect(events.filter((e) => e.cls === 'live.zone')).toHaveLength(0)
  })
})

describe('session end', () => {
  test('sustained cooldown ends the session with a summary', () => {
    const { state, events, summaries } = harness()
    feed(state, 0, 95, 125)
    feed(state, 95, 300, 165) // 5 min of work
    feed(state, 395, 310, 80) // cooldown below 90
    const rests = events.filter((e) => e.cls === 'live.rest')
    expect(rests).toHaveLength(1)
    expect(summaries).toHaveLength(1)
    expect(summaries[0].reason).toBe('cooldown')
    expect(summaries[0].max_bpm).toBe(165)
    expect(summaries[0].recovery_60s_drop).toBe(165 - 80)
    expect(rests[0].content).toContain('HR recovery')
    // The summary describes the WORK: the 5-min cooldown tail is excluded
    // from duration and average, and the ~90s detection window is INCLUDED
    // (seeded from the ring), so duration and average cover the same span.
    expect(summaries[0].duration_s).toBe(395)
    expect(summaries[0].avg_bpm).toBe(155)
  })

  test('feed silence ends the session via tick (after the relayer-buffer window)', () => {
    const { state, events, summaries } = harness()
    feed(state, 0, 95, 125)
    feed(state, 95, 120, 150)
    // Shorter than the relayer's ~10min offline buffer: must NOT end yet.
    state.tick(T0 + (215 + 300) * 1000)
    expect(events.filter((e) => e.cls === 'live.rest')).toHaveLength(0)
    state.tick(T0 + (215 + 720) * 1000)
    expect(events.filter((e) => e.cls === 'live.rest')).toHaveLength(1)
    expect(summaries[0].reason).toBe('feed_drop')
    expect(events.filter((e) => e.cls === 'live.rest')[0].content).toContain('broadcast stopped')
  })

  test('tick without a session does nothing', () => {
    const { state, events } = harness()
    feed(state, 0, 60, 70)
    state.tick(T0 + 10_000_000)
    expect(events).toHaveLength(0)
  })

  test('a new session after the first gets a distinct dedupe key', () => {
    const { state, events } = harness()
    feed(state, 0, 95, 125)
    feed(state, 95, 310, 80) // end via cooldown
    feed(state, 405, 95, 125) // second session
    const starts = events.filter((e) => e.cls === 'live.session')
    expect(starts).toHaveLength(2)
    expect(starts[0].key).not.toBe(starts[1].key)
  })
})

describe('rMSSD', () => {
  test('computes over resting RR (constant 50ms diffs -> 50.0)', () => {
    const { state } = harness()
    for (let i = 0; i < 60; i++) {
      state.addSample(T0 + i * 1000, { bpm: 60, rr_ms: [i % 2 ? 1050 : 1000], contact: null })
    }
    expect(state.rmssd()).toBe(50)
  })

  test('needs a minimum pair count', () => {
    const { state } = harness()
    feed(state, 0, 20, 60, [1000])
    expect(state.rmssd()).toBeNull()
  })

  test('elevated-HR samples are excluded from the window', () => {
    const { state } = harness()
    feed(state, 0, 60, 150, [1000, 1050]) // hot: RR untrustworthy
    expect(state.rmssd()).toBeNull()
  })

  test('RR gaps do not fabricate variability (burst pairing)', () => {
    const { state } = harness()
    // Bursts of steady 1000ms RR separated by 30s silent gaps: a naive
    // successive-diff would still be 0 here, so make the bursts DIFFER:
    // 1000ms bursts and 900ms bursts. Cross-gap diffs (100ms) must be
    // discarded; within-burst diffs are 0 -> rMSSD 0, not ~100.
    let t = 0
    for (let burst = 0; burst < 8; burst++) {
      const rr = burst % 2 ? 900 : 1000
      for (let i = 0; i < 10; i++) state.addSample(T0 + t++ * 1000, { bpm: 60, rr_ms: [rr], contact: null })
      t += 30 // silent gap: samples with no RR
      for (let i = 0; i < 5; i++) state.addSample(T0 + (t - 5 + i) * 1000, { bpm: 60, rr_ms: [], contact: null })
    }
    expect(state.rmssd()).toBe(0)
  })

  test('artifact jumps (>200ms) are rejected', () => {
    const { state } = harness()
    for (let i = 0; i < 80; i++) {
      // mostly steady 1000/1010, every 10th packet an ectopic 1500
      const rr = i % 10 === 9 ? 1500 : i % 2 ? 1010 : 1000
      state.addSample(T0 + i * 1000, { bpm: 60, rr_ms: [rr], contact: null })
    }
    const v = state.rmssd()
    expect(v).not.toBeNull()
    expect(v!).toBeLessThan(20) // the 500ms jumps must not dominate
  })

  test('non-physiological RR values are dropped', () => {
    const { state } = harness()
    for (let i = 0; i < 80; i++) {
      const rr = i % 5 === 4 ? 150 : i % 2 ? 1050 : 1000 // 150ms = junk
      state.addSample(T0 + i * 1000, { bpm: 60, rr_ms: [rr], contact: null })
    }
    const v = state.rmssd()
    expect(v).not.toBeNull()
    expect(v!).toBe(50)
  })

  test('multi-RR packets pair within the packet and across adjacent packets', () => {
    const { state } = harness()
    for (let i = 0; i < 20; i++) {
      state.addSample(T0 + i * 1000, { bpm: 60, rr_ms: [1000, 1050], contact: null })
    }
    expect(state.rmssd()).toBe(50)
  })

  test('packets more than 1.5s apart do not pair (missing beats between)', () => {
    const { state } = harness()
    for (let i = 0; i < 40; i++) {
      state.addSample(T0 + i * 2000, { bpm: 60, rr_ms: [i % 2 ? 1050 : 1000], contact: null })
    }
    expect(state.rmssd()).toBeNull() // no valid pairs at all
  })
})

describe('input hygiene', () => {
  test('replayed and out-of-order timestamps are dropped', () => {
    const { state } = harness()
    feed(state, 0, 10, 70)
    state.addSample(T0 + 5_000, { bpm: 200, rr_ms: [], contact: null })
    const snap = state.snapshot(T0 + 10_000)
    expect(snap.samples_buffered).toBe(10)
  })

  test('junk bpm values are rejected', () => {
    const { state } = harness()
    state.addSample(T0, { bpm: 0, rr_ms: [], contact: null })
    state.addSample(T0 + 1000, { bpm: 251, rr_ms: [], contact: null })
    expect(state.snapshot(T0 + 2000).samples_buffered).toBe(0)
  })

  test('ring buffer is capped', () => {
    const { state } = harness()
    feed(state, 0, RING_CAP + 500, 62)
    expect(state.snapshot(T0 + (RING_CAP + 500) * 1000).samples_buffered).toBe(RING_CAP)
  })
})

describe('artifact gates', () => {
  // Field numbers: maxHr 187 -> ceiling 202. A harmonic lock can broadcast
  // a phantom 223 (2x a ~111 true HR) that would become the session max.
  test('phantom 223 is rejected by the physiological ceiling', () => {
    const { state } = harness({ maxHr: 187 })
    feed(state, 0, 30, 110)
    expect(state.addSample(T0 + 30_000, { bpm: 223, rr_ms: [], contact: null })).toBe('ceiling')
    const snap = state.snapshot(T0 + 31_000) as Record<string, any>
    expect(snap.rejected_samples).toBe(1)
    expect(snap.last_rejected).toEqual({
      rejected_at: new Date(T0 + 30_000).toISOString(),
      bpm: 223,
      reason: 'ceiling',
    })
    expect(snap.samples_buffered).toBe(30) // never entered the ring
  })

  test('doubling gate rejects 90 -> 180 between adjacent samples', () => {
    const { state } = harness({ maxHr: 187 })
    state.addSample(T0, { bpm: 90, rr_ms: [], contact: null })
    expect(state.addSample(T0 + 2_000, { bpm: 180, rr_ms: [], contact: null })).toBe('double')
    expect(state.rejectedSamples()).toBe(1)
  })

  test('a hard 180 is accepted when the last accepted sample is older than the window', () => {
    const { state } = harness({ maxHr: 187 })
    state.addSample(T0, { bpm: 90, rr_ms: [], contact: null })
    expect(state.addSample(T0 + 8_000, { bpm: 180, rr_ms: [], contact: null })).toBeNull()
    expect(state.rejectedSamples()).toBe(0)
  })

  test('a real ramp to 180 is never rejected', () => {
    const { state } = harness({ maxHr: 187 })
    feed(state, 0, 10, (i) => 90 + i * 10) // 90 -> 180 over 10s
    expect(state.rejectedSamples()).toBe(0)
    expect(state.snapshot(T0 + 10_000).samples_buffered).toBe(10)
  })

  test('normal warmup ramp 60 -> 110 -> 158 is fully accepted', () => {
    const { state } = harness({ maxHr: 187 })
    feed(state, 0, 50, (i) => 60 + i) // 60 -> 109
    feed(state, 50, 48, (i) => 110 + i) // 110 -> 157
    state.addSample(T0 + 98_000, { bpm: 158, rr_ms: [], contact: null })
    expect(state.rejectedSamples()).toBe(0)
    expect(state.snapshot(T0 + 99_000).samples_buffered).toBe(99)
  })

  test('orthostatic stand-up spike (62 -> 95 in 2s) is accepted: absolute-jump floor', () => {
    const { state } = harness({ maxHr: 187 })
    state.addSample(T0, { bpm: 62, rr_ms: [], contact: null })
    // 1.53x and +33: under both bars; a real stand-up does this.
    expect(state.addSample(T0 + 2_000, { bpm: 95, rr_ms: [], contact: null })).toBeNull()
    expect(state.rejectedSamples()).toBe(0)
  })

  test('rejected samples touch nothing and recovery is automatic', () => {
    const { state } = harness({ maxHr: 187 })
    // Build a live session: ramp to hot (hot = 115 at maxHr 187 / rest 56).
    feed(state, 0, 10, (i) => 100 + i * 5) // 100 -> 145
    feed(state, 10, 100, 150)
    const before = state.snapshot(T0 + 110_000) as Record<string, any>
    expect(before.session).not.toBeNull()
    expect(before.session.max_bpm).toBe(150)

    expect(state.addSample(T0 + 110_500, { bpm: 223, rr_ms: [], contact: null })).toBe('ceiling')
    const after = state.snapshot(T0 + 111_000) as Record<string, any>
    expect(after.session.max_bpm).toBe(150) // max unchanged
    expect(after.session.zone_seconds[5]).toBe(0) // no phantom Z5 credit
    expect(after.samples_buffered).toBe(before.samples_buffered) // no ring entry
    expect(after.bpm_smoothed).toBe(before.bpm_smoothed) // no EMA movement
    expect(after.rejected_samples).toBe(1)

    // Next clean sample sails through: the gate compares against the last
    // ACCEPTED sample, which the artifact never became.
    expect(state.addSample(T0 + 111_000, { bpm: 151, rr_ms: [], contact: null })).toBeNull()
    expect(state.rejectedSamples()).toBe(1)
  })

  test('a sustained plausible level is accepted once the window passes (quarantine, not a wall)', () => {
    const { state } = harness({ maxHr: 187 })
    feed(state, 0, 10, 90)
    // Step to 180 and HOLD: onset burst rejected while the reference sample
    // is inside the window, accepted once it ages past it.
    const results: (string | null)[] = []
    for (let i = 0; i < 10; i++) {
      results.push(state.addSample(T0 + (10 + i) * 1000, { bpm: 180, rr_ms: [], contact: null }))
    }
    expect(results.slice(0, 2)).toEqual(['double', 'double'])
    expect(results[2]).toBeNull()
  })

  test('a rejection storm defers feed_drop (feed is alive), but garbage cannot hold a session forever', () => {
    const { state, events, summaries } = harness()
    feed(state, 0, 95, 125) // session starts
    feed(state, 95, 800, 223) // ceiling storm: every frame rejected, lastTs frozen
    // Old behavior would have ended here (now - lastTs > 720s), but rejected
    // frames are liveness evidence: the workout must not split.
    state.tick(T0 + 900_000)
    expect(events.filter((e) => e.cls === 'live.rest')).toHaveLength(0)
    // Past the garbage bound with no accepted sample: end anyway.
    state.tick(T0 + (94 + 1440) * 1000)
    expect(events.filter((e) => e.cls === 'live.rest')).toHaveLength(1)
    expect(summaries[0].reason).toBe('feed_drop')
  })

  test('last_rejected ages out of the snapshot; the counter is cumulative', () => {
    const { state } = harness({ maxHr: 187 })
    feed(state, 0, 10, 110)
    state.addSample(T0 + 10_000, { bpm: 223, rr_ms: [], contact: null })
    const fresh = state.snapshot(T0 + 11_000) as Record<string, any>
    expect(fresh.last_rejected?.bpm).toBe(223)
    const later = state.snapshot(T0 + 10_000 + (RING_CAP + 10) * 1000) as Record<string, any>
    expect(later.last_rejected).toBeNull()
    expect(later.rejected_samples).toBe(1)
  })

  test('end-to-end: the 223 wire frame is parsed then rejected, and the snapshot says so', () => {
    const { state } = harness({ maxHr: 187 })
    feed(state, 0, 10, 111)
    // The SIG encodings of a 223 bpm broadcast frame: u8, u8+RR (the band's
    // usual shape), and u16.
    const frames = [
      Buffer.from([0x00, 223]).toString('base64'),
      Buffer.from([0x10, 223, 0x1c, 0x01]).toString('base64'),
      Buffer.from([0x01, 223, 0x00]).toString('base64'),
    ]
    frames.forEach((b64, i) => {
      const sample = parseBase64Frame(b64)
      expect(sample).not.toBeNull()
      expect(sample!.bpm).toBe(223)
      expect(state.addSample(T0 + (20 + i) * 1000, sample!)).toBe('ceiling')
    })
    const snap = state.snapshot(T0 + 30_000) as Record<string, any>
    expect(snap.rejected_samples).toBe(3)
    expect(snap.last_rejected.bpm).toBe(223)
    expect(snap.last_rejected.reason).toBe('ceiling')
    expect(snap.samples_buffered).toBe(10)
  })
})

describe('session confidence + demotion', () => {
  // Harness defaults: hot 116, cool 90; Karvonen zones at max 190 / rest 56:
  // Z2 136, Z3 150, Z4 163, Z5 177. Depth evidence = Z2+, hard = Z3+.
  const confirms = (events: Emitted[]) => events.filter((e) => e.meta.kind === 'confirm')
  const starts = (events: Emitted[]) => events.filter((e) => e.cls === 'live.session' && e.meta.kind !== 'confirm')
  const rests = (events: Emitted[]) => events.filter((e) => e.cls === 'live.rest')

  test('a passive elevation (smooth shallow plateau) stays low and is demoted', () => {
    const { state, events, summaries } = harness()
    feed(state, 0, 60, 70)
    feed(state, 60, 4, (i) => 85 + i * 10) // physiological ramp 85 -> 115
    feed(state, 64, 570, 122) // ~9.5 min smooth Z1 plateau, one hot streak
    expect(starts(events)).toHaveLength(1)
    expect(starts(events)[0].meta.confidence).toBe('low')
    expect(starts(events)[0].content).toContain('Unconfirmed')
    expect(starts(events)[0].content).not.toContain('log it')
    expect(confirms(events)).toHaveLength(0)
    feed(state, 634, 310, 75) // cooldown end
    expect(rests(events)).toHaveLength(1)
    expect(rests(events)[0].meta.demoted).toBe('true')
    expect(rests(events)[0].meta.confidence).toBe('low')
    expect(rests(events)[0].content).toContain('Elevation ended')
    expect(rests(events)[0].content).toContain('ignore for training load')
    expect(summaries[0].demoted).toBe(true)
    expect(summaries[0].confidence).toBe('low')
    expect(summaries[0].intent_matched).toBe(false)
  })

  test('duration alone is not evidence: a 16-min smooth plateau never confirms and demotes', () => {
    const { state, events } = harness()
    feed(state, 0, 30, 80)
    feed(state, 30, 4, (i) => 88 + i * 10)
    feed(state, 34, 960, 124) // 16 min, structureless, Z1
    expect(confirms(events)).toHaveLength(0)
    expect(starts(events)).toHaveLength(1)
    feed(state, 994, 310, 70)
    expect(rests(events)[0].meta.demoted).toBe('true')
    expect(rests(events)[0].meta.confidence).toBe('low')
  })

  test('set/rest oscillation earns effort_cycles and confirms (lifting pattern)', () => {
    const { state, events, summaries } = harness()
    feed(state, 0, 95, 125) // hot streak 1 starts the session
    for (let c = 0; c < 3; c++) {
      feed(state, 95 + c * 180, 90, 100) // inter-set rest: sub-hot, above cool
      feed(state, 185 + c * 180, 90, 130) // next set: hot streak 2..4
    }
    expect(confirms(events)).toHaveLength(1)
    expect(confirms(events)[0].meta.confidence).toBe('medium') // < 12 min at 4th streak
    expect(confirms(events)[0].meta.confidence_reasons).toContain('effort_cycles')
    expect(confirms(events)[0].content).toContain('log it') // undeclared: invite rides the confirm
    feed(state, 635, 200, 130) // keep working past the 12-min bar
    feed(state, 835, 310, 70) // cooldown end
    expect(rests(events)[0].meta.confidence).toBe('high') // evidence + duration
    expect(rests(events)[0].meta.demoted).toBeUndefined()
    expect(rests(events)[0].content).toContain('Session over')
    expect(summaries[0].demoted).toBe(false)
    expect(summaries[0].confidence).toBe('high')
    // No RR in this feed: absence is neutral, never a verdict.
    expect(summaries[0].rr_consistency).toBeNull()
    expect(summaries[0].rr_presence).toBe(0)
  })

  test('sustained depth earns evidence and confirms (steady cardio)', () => {
    const { state, events } = harness()
    feed(state, 0, 95, 125)
    feed(state, 95, 301, 140) // Z2 (depth zone) held past 5 min
    expect(confirms(events)).toHaveLength(1)
    expect(confirms(events)[0].meta.confidence).toBe('medium')
    expect(confirms(events)[0].meta.confidence_reasons).toContain('sustained_depth')
  })

  test('one continuous hard-effort minute is evidence on its own', () => {
    const { state, events } = harness()
    feed(state, 0, 95, 125)
    feed(state, 95, 30, 140)
    feed(state, 125, 61, 155) // Z3 (hard zone) for 61s
    expect(confirms(events)).toHaveLength(1)
    expect(confirms(events)[0].meta.confidence_reasons).toContain('hard_effort')
  })

  test('evidence without duration ends medium and is not demoted', () => {
    const { state, events, summaries } = harness()
    feed(state, 0, 95, 125)
    feed(state, 95, 301, 140)
    feed(state, 396, 310, 70) // ends at ~6.6 min of work
    expect(rests(events)[0].meta.confidence).toBe('medium')
    expect(rests(events)[0].meta.demoted).toBeUndefined()
    expect(rests(events)[0].content).toContain('Session over')
    expect(summaries[0].demoted).toBe(false)
  })

  test('the cooldown tail cannot buy the duration upgrade', () => {
    const { state, summaries } = harness()
    feed(state, 0, 95, 125)
    feed(state, 95, 500, 140) // deep evidence; WORK ends at 595s (< 720)
    feed(state, 595, 310, 70) // tail crosses the 12-min mark in wall time
    expect(summaries[0].confidence).toBe('medium') // frozen at cooling onset
  })

  test('a declared intent makes the start high-confidence with no separate confirm', () => {
    const { state, events } = harness()
    state.noteIntent(T0 + 10_000)
    feed(state, 20, 95, 125)
    expect(starts(events)).toHaveLength(1)
    expect(starts(events)[0].meta.confidence).toBe('high')
    expect(starts(events)[0].meta.confidence_reasons).toContain('intent')
    expect(starts(events)[0].content).toContain('declared intent')
    expect(confirms(events)).toHaveLength(0)
  })

  test('a tap during an unevidenced session defers, then claims at first evidence', () => {
    // Review find: stapling a tap to whatever elevation is open would mark a
    // lingering shower "high" and strand the real workout unmatched. A tap
    // during a LOW session arms the window instead; the session claims it
    // the moment it develops an exercise signature.
    const { state, events } = harness()
    feed(state, 0, 200, 122) // low-confidence session running
    state.noteIntent(T0 + 200_000)
    expect(confirms(events)).toHaveLength(0) // not stapled blindly
    feed(state, 200, 301, 140) // sustained depth (Z2): evidence arrives, claim lands
    expect(confirms(events)).toHaveLength(1)
    expect(confirms(events)[0].meta.confidence).toBe('high')
    expect(confirms(events)[0].meta.confidence_reasons).toContain('intent')
    expect(confirms(events)[0].content).not.toContain('log it')
  })

  test('a tap during an EVIDENCED session claims it immediately', () => {
    const { state, events } = harness()
    feed(state, 0, 95, 125)
    feed(state, 95, 301, 140) // sustained_z3: medium confirm fires
    expect(confirms(events)).toHaveLength(1)
    expect(confirms(events)[0].meta.confidence).toBe('medium')
    state.noteIntent(T0 + 400_000) // tap lands on the evidenced session
    feed(state, 396, 310, 70) // end
    expect(rests(events)[0].meta.intent_matched).toBe('true')
    expect(rests(events)[0].meta.confidence).toBe('high')
  })

  test('a tap during an open phantom stays armed for the real session after it', () => {
    const { state, events } = harness()
    feed(state, 0, 200, 122) // passive elevation, low, still open
    state.noteIntent(T0 + 200_000) // tapped on the way to the gym
    feed(state, 200, 310, 70) // the elevation cools off, session ends
    expect(rests(events)[0].meta.demoted).toBe('true') // not stapled to the phantom
    feed(state, 510, 95, 125) // the real session starts
    expect(starts(events)[1].meta.confidence).toBe('high') // claims the tap
  })

  test('an intent elevates exactly one session: the post-workout shower stays low', () => {
    const { state, events } = harness()
    state.noteIntent(T0)
    feed(state, 10, 95, 125) // session 1 claims the intent
    feed(state, 105, 310, 70) // cooldown end
    feed(state, 425, 95, 125) // second start, still inside 30 min of the tap
    expect(starts(events)).toHaveLength(2)
    expect(starts(events)[0].meta.confidence).toBe('high')
    expect(starts(events)[1].meta.confidence).toBe('low')
  })

  test('a stale intent (>30 min old) does not match a new start', () => {
    const { state, events } = harness()
    state.noteIntent(T0)
    feed(state, 31 * 60, 95, 125) // starts 31 min after the tap
    expect(starts(events)[0].meta.confidence).toBe('low')
  })

  test('majority RR mismatch caps confidence at low even with effort structure (cadence lock)', () => {
    const { state, events, summaries } = harness()
    // bpm ~125-130 while RR says ~850ms (a ~70 bpm true pulse): the lock signature.
    feed(state, 0, 95, 125, [850])
    for (let c = 0; c < 3; c++) {
      feed(state, 95 + c * 180, 90, 100, [850])
      feed(state, 185 + c * 180, 90, 130, [850])
    }
    expect(confirms(events)).toHaveLength(0)
    expect(starts(events)[0].meta.confidence).toBe('low')
    expect(starts(events)[0].meta.confidence_reasons).toBe('rr_suspect')
    feed(state, 635, 310, 70, [850])
    expect(rests(events)[0].meta.demoted).toBe('true')
    expect(summaries[0].rr_consistency).not.toBeNull()
    expect(summaries[0].rr_consistency!).toBeLessThan(0.5)
  })

  test('consistent RR never blocks and lands in the summary', () => {
    const { state, events, summaries } = harness()
    feed(state, 0, 95, 125, [480]) // 60000/480 = 125: matches
    feed(state, 95, 301, 140, [430]) // ~139.5: matches
    expect(confirms(events)).toHaveLength(1)
    feed(state, 396, 310, 70, [860]) // ~69.8: matches
    expect(summaries[0].rr_consistency).toBe(1)
    expect(summaries[0].rr_presence).toBe(1)
    expect(rests(events)[0].meta.rr_consistency).toBe('1')
  })

  test('snapshot exposes live confidence while a session runs', () => {
    const { state } = harness()
    feed(state, 0, 95, 125)
    const snap = state.snapshot(T0 + 95_000) as Record<string, any>
    expect(snap.session.confidence).toBe('low')
    expect(snap.session.intent_matched).toBe(false)
  })

  test('feed gaps on a structureless plateau cannot fabricate effort cycles', () => {
    // Edge-hunt find: gap resets used to re-count the hot streak. A fever/
    // sauna plateau with three BLE reconnect gaps must stay low and demote.
    const { state, events } = harness()
    feed(state, 0, 95, 125)
    feed(state, 95, 120, 125)
    feed(state, 246, 120, 125) // 31s gap
    feed(state, 397, 120, 125) // 31s gap
    feed(state, 548, 120, 125) // 31s gap
    expect(confirms(events)).toHaveLength(0)
    feed(state, 668, 310, 70)
    expect(rests(events)[0].meta.demoted).toBe('true')
  })

  test('optical noise hugging the hot line cannot fabricate effort cycles', () => {
    // Edge-hunt find: dips of a few bpm below hot (116) never reach the
    // re-arm line (108), so threshold noise is not set/interval structure.
    const { state, events } = harness()
    feed(state, 0, 95, 122)
    feed(state, 95, 600, (i) => 116 + (i % 4 < 2 ? 2 : -2)) // 118/114 flapping
    expect(confirms(events)).toHaveLength(0)
    feed(state, 695, 310, 70)
    expect(rests(events)[0].meta.demoted).toBe('true')
  })

  test('junk RR intervals are filtered, never flag a real workout as suspect', () => {
    // Edge-hunt find: 150ms junk (the rMSSD tests model the same value) used
    // to count as mismatched RR and demote a genuine sustained-depth ride.
    const { state, events, summaries } = harness()
    feed(state, 0, 95, 125, [150])
    feed(state, 95, 301, 140, [150]) // deep evidence with junk-only RR
    expect(confirms(events)).toHaveLength(1)
    expect(confirms(events)[0].meta.confidence_reasons).toContain('sustained_depth')
    feed(state, 396, 310, 70, [150])
    expect(rests(events)[0].meta.demoted).toBeUndefined()
    expect(summaries[0].rr_consistency).toBeNull() // junk never became samples
    expect(summaries[0].rr_presence).toBe(0)
  })

  test('a declared intent outranks the rr_suspect cap (cadence-locked treadmill run)', () => {
    // Edge-hunt find: the artifact gate used to override intent and emit
    // "could be non-exercise" prose for a session the user declared.
    const { state, events } = harness()
    state.noteIntent(T0)
    feed(state, 10, 95, 125, [850]) // RR says ~70: lock signature
    expect(starts(events)[0].meta.confidence).toBe('high')
    expect(starts(events)[0].meta.confidence_reasons).toBe('intent')
    expect(starts(events)[0].content).toContain('declared intent')
  })

  test('a redundant tap during a matched session cannot leak onto the next session', () => {
    // Edge-hunt find: a second mid-session tap used to linger in
    // lastIntentTs and staple onto the post-workout shower.
    const { state, events } = harness()
    state.noteIntent(T0)
    feed(state, 10, 95, 125) // session 1 claims the tap
    state.noteIntent(T0 + 200_000) // re-tap mid-session (already matched)
    feed(state, 200, 310, 70) // session 1 ends
    feed(state, 520, 95, 125) // shower 5 min later, inside any naive window
    expect(starts(events)).toHaveLength(2)
    expect(starts(events)[1].meta.confidence).toBe('low')
  })

  test('an unclaimed intent matches the next session within 30 min (intended: the tap says so)', () => {
    const { state, events } = harness()
    state.noteIntent(T0)
    feed(state, 25 * 60, 95, 125) // first detected session, 25 min after the tap
    expect(starts(events)[0].meta.confidence).toBe('high')
  })

  test('an emit failure retries the confirm on the next sample instead of losing it', () => {
    const events: Emitted[] = []
    let failures = 1
    const state = new LiveState({
      getMaxHr: () => 190,
      getRestHr: () => 56,
      getHotBpm: () => null,
      emit: (cls, key, payload) => {
        if (cls === 'live.confirm' && failures > 0) {
          failures--
          throw new Error('store hiccup')
        }
        events.push({ cls, key, ...payload })
      },
    })
    feed(state, 0, 95, 125)
    feed(state, 95, 301, 140) // earns sustained_z3: first confirm emit throws
    feed(state, 396, 5, 140) // next samples retry
    const confirms = events.filter((e) => e.cls === 'live.confirm')
    expect(confirms).toHaveLength(1)
  })

  test('a low session grazing Z3 stays silent; the milestone fires once confidence arrives', () => {
    // Review find: zone milestones used to bypass the confidence contract
    // (a passive elevation's 15s Z3 graze pinged the coach).
    const { state, events } = harness()
    feed(state, 0, 95, 125)
    feed(state, 95, 30, 152) // Z3 past the 15s milestone bar, but still low
    expect(events.filter((e) => e.cls === 'live.zone')).toHaveLength(0)
    feed(state, 125, 40, 152) // crosses the 60s hard-effort evidence bar
    const zones = events.filter((e) => e.cls === 'live.zone')
    expect(zones).toHaveLength(1)
    expect(zones[0].meta.confidence).toBe('medium')
  })

  test('a feed_drop mid-cooldown judges the work window, not the tail', () => {
    // Review find: feed_drop ends used to measure duration/confidence to the
    // last sample, letting the cooldown tail buy the 12-min duration bar.
    const { state, summaries } = harness()
    feed(state, 0, 95, 125)
    feed(state, 95, 500, 140) // deep evidence; work ends at 595s (< 720)
    feed(state, 595, 200, 70) // cooling when the band leaves range
    state.tick(T0 + (795 + 720) * 1000) // feed_drop
    expect(summaries[0].reason).toBe('feed_drop')
    expect(summaries[0].confidence).toBe('medium') // not bought by the tail
    expect(summaries[0].duration_s).toBe(595)
  })

  test('a confirmed session is never demoted by late RR degradation', () => {
    // Review find: contradictory events (confirm then "probably not a
    // workout") when mismatched RR accumulates after the confirm fired.
    const { state, events, summaries } = harness()
    feed(state, 0, 95, 125) // no RR yet
    feed(state, 95, 301, 140) // sustained_z3: confirm fires (rr unknown)
    expect(confirms(events)).toHaveLength(1)
    feed(state, 396, 100, 140, [850]) // majority-mismatch RR arrives late
    feed(state, 496, 310, 70)
    expect(summaries[0].demoted).toBe(false)
    expect(rests(events)[0].meta.demoted).toBeUndefined()
    expect(summaries[0].confidence).toBe('low') // forensics stay honest
  })

  test('RR consistency of exactly 0.5 is not suspect (strict bound)', () => {
    const { state, events, summaries } = harness()
    feed(state, 0, 95, 125) // start, no RR
    feed(state, 95, 250, 140) // deep evidence building
    feed(state, 345, 5, 140, [430]) // 5 consistent (~139.5)
    feed(state, 350, 5, 140, [1000]) // 5 in-range mismatches (60 implied)
    feed(state, 355, 60, 140)
    expect(confirms(events)).toHaveLength(1) // sustained_z3 landed despite the mix
    feed(state, 415, 310, 70)
    expect(summaries[0].rr_consistency).toBe(0.5)
    expect(summaries[0].confidence).not.toBe('low')
  })
})

describe('snapshot', () => {
  test('live vs stale feed', () => {
    const { state } = harness()
    feed(state, 0, 10, 72)
    expect(state.snapshot(T0 + 12_000).feed).toBe('live')
    expect(state.snapshot(T0 + 60_000).feed).toBe('stale')
  })

  test('carries session progress while active', () => {
    const { state } = harness()
    feed(state, 0, 95, 125)
    const snap = state.snapshot(T0 + 95_000) as { session: { max_bpm: number } | null }
    expect(snap.session).not.toBeNull()
    expect(snap.session!.max_bpm).toBe(125)
  })
})

describe('Sep 1 batch: post-score silence + restart intent persistence', () => {
  test('confirm stays silent once WHOOP scored a workout covering the start', () => {
    const { state, events, summaries, overlapProbes } = harness({ hasScoredOverlap: () => true })
    feed(state, 0, 400, 145) // hot + zone-2 depth: evidence latches at ~300s
    expect(events.filter((e) => e.cls === 'live.confirm').length).toBe(0)
    // The probe asks about the session START (+-60s), not any-overlap of the
    // whole window: adjacency to some other workout must not silence us.
    expect(overlapProbes.length).toBeGreaterThan(0)
    expect(overlapProbes[0][0]).toBe(new Date(T0 - 60_000).toISOString())
    expect(overlapProbes[0][1]).toBe(new Date(T0 + 60_000).toISOString())
    feed(state, 400, 320, 70) // sustained cool: session ends normally
    expect(summaries.length).toBe(1)
    // The silence changes no verdicts: the session was already non-low when
    // the latch fired, and confidence latches never un-latch.
    expect(summaries[0].confidence).toBe('medium')
    expect(summaries[0].demoted).toBe(false)
  })

  test('the same evidence without a scored overlap still confirms (control)', () => {
    const { state, events } = harness()
    feed(state, 0, 400, 145)
    expect(events.filter((e) => e.cls === 'live.confirm').length).toBe(1)
  })

  test('intent claim and release round-trip (the restart-persistence hooks)', () => {
    const { state, events, summaries, intentClaims, releases } = harness()
    state.noteIntent(T0)
    feed(state, 0, 120, 130) // session starts ~90s in, intent-matched at start
    expect(intentClaims.length).toBe(1)
    // The persisted value is the SESSION START iso: the daemon's re-arm age
    // arithmetic depends on exactly this being the claimed session's start.
    expect(intentClaims[0]).toBe(new Date(T0).toISOString())
    expect(events.find((e) => e.cls === 'live.session')?.meta.confidence).toBe('high')
    expect(releases()).toBe(0) // still open
    feed(state, 120, 320, 70) // cool to the end
    expect(summaries[0]?.intent_matched).toBe(true)
    expect(releases()).toBe(1)
  })

  test('a plain undeclared session never touches the intent hooks', () => {
    const { state, summaries, intentClaims, releases } = harness()
    feed(state, 0, 200, 130)
    feed(state, 200, 320, 70)
    expect(summaries.length).toBe(1)
    expect(intentClaims.length).toBe(0)
    expect(releases()).toBe(0)
  })
})

describe('intentRearmPlan (the boot-guard policy, pure)', () => {
  const NOW = T0 + 3600_000

  test('claimed open session, unscored and fresh: arms with the 5-min fuse', () => {
    const plan = intentRearmPlan({
      openSessionIso: new Date(NOW - 45 * 60_000).toISOString(),
      lastTapIso: null,
      now: NOW,
      scoredCoveringOpen: false,
    })
    expect(plan.clearOpen).toBe(false)
    expect(plan.armAt).toBe(NOW - (INTENT_MATCH_BEFORE_MS - INTENT_REARM_FUSE_MS))
  })

  test('a scored workout covering the open start consumes the key, arms nothing', () => {
    const plan = intentRearmPlan({
      openSessionIso: new Date(NOW - 45 * 60_000).toISOString(),
      lastTapIso: null,
      now: NOW,
      scoredCoveringOpen: true,
    })
    expect(plan).toEqual({ armAt: null, clearOpen: true })
  })

  test('ancient or garbage open keys are consumed without arming', () => {
    expect(
      intentRearmPlan({
        openSessionIso: new Date(NOW - 5 * 3600_000).toISOString(),
        lastTapIso: null,
        now: NOW,
        scoredCoveringOpen: false,
      }),
    ).toEqual({ armAt: null, clearOpen: true })
    expect(
      intentRearmPlan({ openSessionIso: 'garbage', lastTapIso: null, now: NOW, scoredCoveringOpen: false }),
    ).toEqual({ armAt: null, clearOpen: true })
  })

  test('an unclaimed tap restores its ORIGINAL timestamp (natural expiry)', () => {
    const tap = new Date(NOW - 10 * 60_000).toISOString()
    expect(
      intentRearmPlan({ openSessionIso: null, lastTapIso: tap, now: NOW, scoredCoveringOpen: false }),
    ).toEqual({ armAt: Date.parse(tap), clearOpen: false })
    const stale = new Date(NOW - 40 * 60_000).toISOString()
    expect(
      intentRearmPlan({ openSessionIso: null, lastTapIso: stale, now: NOW, scoredCoveringOpen: false })
        .armAt,
    ).toBe(null)
  })

  test('a claimed open session outranks a fresher unclaimed tap', () => {
    const plan = intentRearmPlan({
      openSessionIso: new Date(NOW - 45 * 60_000).toISOString(),
      lastTapIso: new Date(NOW - 60_000).toISOString(),
      now: NOW,
      scoredCoveringOpen: false,
    })
    expect(plan.armAt).toBe(NOW - (INTENT_MATCH_BEFORE_MS - INTENT_REARM_FUSE_MS))
  })

  test('the fuse holds: a session detected past 5 min does NOT inherit', () => {
    const { state, events } = harness()
    state.noteIntent(T0 - (INTENT_MATCH_BEFORE_MS - INTENT_REARM_FUSE_MS)) // as the boot guard arms at T0
    feed(state, 360, 120, 130) // hot from +6min: start lands past the fuse
    expect(events.find((e) => e.cls === 'live.session')?.meta.confidence).toBe('low')
  })

  test('the fuse admits: a session detected within 5 min inherits', () => {
    const { state, events } = harness()
    state.noteIntent(T0 - (INTENT_MATCH_BEFORE_MS - INTENT_REARM_FUSE_MS))
    feed(state, 0, 120, 130) // hot immediately: start at +90s, inside the fuse
    expect(events.find((e) => e.cls === 'live.session')?.meta.confidence).toBe('high')
  })
})

describe('idle end (no effort for IDLE_END_S)', () => {
  const IDLE_MIN = Math.round(IDLE_END_S / 60)
  // Generic profile: rest 56, max 181 -> hot (start line) 112, cool 87.
  const H = { maxHr: 181, restHr: 56 }
  const rests = (events: Emitted[]) => events.filter((e) => e.cls === 'live.rest')
  // 70 -> 130 in 10-bpm steps: a physiological ramp the doubling gate accepts.
  // The first hot (>= 112) sample is the 120 at s=14: the session start.
  const ramp = (state: LiveState) => {
    feed(state, 0, 10, 70)
    feed(state, 10, 6, (i) => 80 + i * 10)
  }
  const START_S = 14

  test('tennis shape: 60 min of play then 2 h of everyday HR grazing the cool line ends idle', () => {
    const { state, events, summaries } = harness(H)
    ramp(state)
    // 130-165 play: 150 s rallies at 145-165, 30 s changeovers at 130.
    const play = (i: number) => (i % 180 < 150 ? 145 + ((i * 5) % 21) : 130)
    feed(state, 16, 3600, play)
    const lastEffortS = 16 + 3599
    const lastEffortBpm = play(3599)
    // 85-110 wobbling across the cool line: the 5-min sustained-cool end
    // never holds (the field bug). Nothing here reaches the start line.
    feed(state, 3616, 7200, (i) => 85 + ((i * 7) % 26))
    expect(summaries).toHaveLength(1)
    const s = summaries[0]
    expect(s.reason).toBe('idle')
    // Duration, average, zones describe the play, not the tail.
    expect(s.duration_s).toBe(lastEffortS - START_S)
    expect(s.avg_bpm).toBeGreaterThanOrEqual(140)
    expect(s.max_bpm).toBe(165)
    expect(s.zone_seconds[0]).toBe(0) // no everyday-life Z0 tail
    const zoneTotal = s.zone_seconds.reduce((a, b) => a + b, 0)
    expect(Math.abs(zoneTotal - s.duration_s)).toBeLessThanOrEqual(2)
    // Recovery read from the sample 60s after the last effort; the archived
    // end includes that minute.
    const bpmAt60 = 85 + (((lastEffortS + 60 - 3616) * 7) % 26)
    expect(s.recovery_60s_drop).toBe(lastEffortBpm - bpmAt60)
    expect(s.ended_at).toBe(new Date(T0 + (lastEffortS + 60) * 1000).toISOString())
    // It fired exactly IDLE_END_S after the last effort sample: one rest
    // event, coach-readable reason.
    expect(rests(events)).toHaveLength(1)
    expect(rests(events)[0].content).toContain(`Session over (ended after ${IDLE_MIN} min without effort)`)
    expect(rests(events)[0].content).toContain('HR recovery: -')
    expect(rests(events)[0].meta.duration_s).toBe(String(s.duration_s))
  })

  test('the idle end fires on the sample IDLE_END_S after the last effort, not before', () => {
    const { state, summaries } = harness(H)
    ramp(state)
    feed(state, 16, 600, 140)
    const lastEffortS = 615
    feed(state, 616, IDLE_END_S - 1, (i) => 95 + (i % 10)) // up to last + IDLE_END_S - 1
    expect(summaries).toHaveLength(0)
    feed(state, lastEffortS + IDLE_END_S, 1, 98)
    expect(summaries).toHaveLength(1)
    expect(summaries[0].reason).toBe('idle')
    expect(summaries[0].duration_s).toBe(lastEffortS - START_S)
  })

  test('ride shape: 4x8 min intervals with 4 min recoveries never idle-ends mid-ride', () => {
    const { state, summaries } = harness(H)
    ramp(state)
    let t = 16
    for (let rep = 0; rep < 4; rep++) {
      feed(state, t, 480, (i) => 150 + (i % 11)) // 150-160 work
      t += 480
      feed(state, t, 240, (i) => 115 + (i % 11)) // 115-125 recovery
      t += 240
      expect(summaries).toHaveLength(0)
    }
    feed(state, t, 310, 75) // the ride's real end: sustained cool
    expect(summaries).toHaveLength(1)
    expect(summaries[0].reason).toBe('cooldown')
  })

  test('lift shape: 40 s sets every 5-6 min with 95-105 rests never idle-ends; ends normally after', () => {
    const lift = (state: LiveState): number => {
      ramp(state)
      feed(state, 16, 120, (i) => 120 + (i % 6)) // warmup row starts the session
      let t = 136
      for (let set = 0; set < 8; set++) {
        feed(state, t, 40, (i) => 125 + Math.round((i * 20) / 39)) // set peaks 125-145
        t += 40
        const rest = set % 2 ? 320 : 260 // set-to-set 5-6 min
        feed(state, t, rest, (i) => 95 + (i % 11)) // 95-105 between sets
        t += rest
      }
      return t
    }
    {
      const { state, summaries } = harness(H)
      const t = lift(state)
      expect(summaries).toHaveLength(0) // never idle-ended mid-lift
      feed(state, t, 310, 75)
      expect(summaries).toHaveLength(1)
      expect(summaries[0].reason).toBe('cooldown')
    }
    {
      // Same lift, but he stays at 95-105 afterwards (above the cool line):
      // the idle end closes it IDLE_END_S after the last set.
      const { state, summaries } = harness(H)
      const t = lift(state)
      const lastSetEndS = t - 320 - 1 // the 8th set's final second (set index 7 -> 320s rest)
      feed(state, t, IDLE_END_S + 600, (i) => 95 + (i % 11))
      expect(summaries).toHaveLength(1)
      expect(summaries[0].reason).toBe('idle')
      expect(summaries[0].duration_s).toBe(lastSetEndS - START_S)
    }
  })

  test('a sustained effort in the tail (a flight of stairs, 30 s at 120) resets the idle clock', () => {
    const { state, summaries } = harness(H)
    ramp(state)
    feed(state, 16, 1200, 140) // 20 min of work, last effort at 1215
    feed(state, 1216, 600, (i) => 95 + (i % 6)) // 10 min tail
    const stairsS = 1816
    feed(state, stairsS, 30, 120) // a flight of stairs: 30 s at 120
    const lastStairsS = stairsS + 29
    feed(state, lastStairsS + 1, IDLE_END_S - 1, (i) => 95 + (i % 6))
    // Past IDLE_END_S from the work's end, but the stairs reset the clock.
    expect(lastStairsS + IDLE_END_S - 1).toBeGreaterThan(1215 + IDLE_END_S)
    expect(summaries).toHaveLength(0)
    feed(state, lastStairsS + IDLE_END_S, 5, 97)
    expect(summaries).toHaveLength(1)
    expect(summaries[0].reason).toBe('idle')
    expect(summaries[0].duration_s).toBe(lastStairsS - START_S)
  })

  test('a single sample at the line (one-step optical jitter) does NOT reset the idle clock', () => {
    const { state, summaries } = harness(H)
    ramp(state)
    feed(state, 16, 1200, 140) // last effort at 1215
    feed(state, 1216, 600, (i) => 95 + (i % 6))
    feed(state, 1816, 1, 120) // one isolated sample
    // Run past the work's idle mark but stop well short of the jitter's own
    // (1816 + IDLE_END_S): only an end anchored at 1215 can fire in here.
    const tailEndS = 1215 + IDLE_END_S + 100
    expect(tailEndS).toBeLessThan(1816 + IDLE_END_S)
    feed(state, 1817, tailEndS - 1817 + 1, (i) => 95 + (i % 6))
    expect(summaries).toHaveLength(1)
    expect(summaries[0].reason).toBe('idle')
    expect(summaries[0].duration_s).toBe(1215 - START_S)
  })

  test('restart re-arm: the idle clock starts at re-arm, never earlier; the re-armed session still idle-ends', () => {
    // The daemon restarted 45 min into a declared session; the boot guard
    // re-arms the intent at T0 on a FRESH LiveState.
    const plan = intentRearmPlan({
      openSessionIso: new Date(T0 - 45 * 60_000).toISOString(),
      lastTapIso: null,
      now: T0,
      scoredCoveringOpen: false,
    })
    expect(plan.armAt).not.toBeNull()
    const { state, summaries, releases } = harness(H)
    state.noteIntent(plan.armAt!)
    feed(state, 0, 300, 135) // still working after the restart: re-detected
    const lastEffortS = 299
    // A clock counted from the original start (45 min ago) would end on the
    // very next sample; it must run from the re-armed session instead.
    feed(state, 300, IDLE_END_S - 1, (i) => 98 + (i % 6))
    expect(summaries).toHaveLength(0)
    feed(state, lastEffortS + IDLE_END_S, 1, 98)
    expect(summaries).toHaveLength(1)
    expect(summaries[0].reason).toBe('idle')
    expect(summaries[0].started_at).toBe(new Date(T0).toISOString())
    expect(summaries[0].duration_s).toBe(lastEffortS)
    expect(summaries[0].intent_matched).toBe(true)
    expect(releases()).toBe(1)
  })

  test('tick-only path: a sparse feed ends idle on the tick that crosses IDLE_END_S', () => {
    const { state, events, summaries } = harness(H)
    ramp(state)
    feed(state, 16, 600, 145)
    const lastEffortS = 615
    // Low-rate feed: one sample a minute, none on the IDLE_END_S mark.
    for (let m = 1; m * 60 < IDLE_END_S; m++) {
      state.addSample(T0 + (lastEffortS + m * 60) * 1000, { bpm: 100, rr_ms: [], contact: null })
    }
    state.tick(T0 + (lastEffortS + IDLE_END_S - 1) * 1000)
    expect(summaries).toHaveLength(0)
    state.tick(T0 + (lastEffortS + IDLE_END_S) * 1000)
    expect(summaries).toHaveLength(1)
    expect(summaries[0].reason).toBe('idle')
    expect(summaries[0].duration_s).toBe(lastEffortS - START_S)
    // The 60s sample landed: recovery read, archived end = last effort + 60s.
    expect(summaries[0].recovery_60s_drop).toBe(45)
    expect(summaries[0].ended_at).toBe(new Date(T0 + (lastEffortS + 60) * 1000).toISOString())
    expect(rests(events)[0].content).toContain('without effort')
  })

  test('no sample in the minute after the last effort: recovery unavailable, end = last effort', () => {
    const { state, events, summaries } = harness(H)
    ramp(state)
    feed(state, 16, 600, 145)
    const lastEffortS = 615
    // First sample at +90 s (inside the 120 s heard-time bar, so the idle
    // clock keeps running), then one a minute: none lands on the 60 s mark.
    for (let k = 0; 90 + k * 60 < IDLE_END_S; k++) {
      state.addSample(T0 + (lastEffortS + 90 + k * 60) * 1000, { bpm: 100, rr_ms: [], contact: null })
    }
    expect(summaries).toHaveLength(0)
    state.tick(T0 + (lastEffortS + IDLE_END_S) * 1000)
    expect(summaries).toHaveLength(1)
    expect(summaries[0].reason).toBe('idle')
    expect(summaries[0].recovery_60s_drop).toBeNull()
    expect(summaries[0].ended_at).toBe(new Date(T0 + lastEffortS * 1000).toISOString())
    expect(rests(events)[0].content).toContain('HR recovery unavailable')
  })

  test('feed silence still ends as feed_drop, never idle', () => {
    const { state, summaries } = harness(H)
    ramp(state)
    feed(state, 16, 600, 145)
    const lastS = 615
    for (let k = 1; k <= 60; k++) {
      state.tick(T0 + (lastS + k * 30) * 1000)
      if (summaries.length) break
    }
    expect(summaries).toHaveLength(1)
    expect(summaries[0].reason).toBe('feed_drop')
  })

  test('silence after a quiet tail is not idle (replayable effort may hide in it): feed_drop owns it', () => {
    const { state, summaries } = harness(H)
    ramp(state)
    feed(state, 16, 600, 145)
    // A quiet tail long enough that the idle mark (615 + IDLE_END_S) lands
    // in the silence, before feed_drop: only the freshness guard stops it.
    const quietS = IDLE_END_S - 500
    feed(state, 616, quietS, 100)
    const lastS = 615 + quietS
    expect(615 + IDLE_END_S).toBeLessThan(lastS + 720)
    for (let k = 1; k <= 60; k++) {
      state.tick(T0 + (lastS + k * 30) * 1000)
      if (summaries.length) break
    }
    expect(summaries).toHaveLength(1)
    expect(summaries[0].reason).toBe('feed_drop')
  })

  test('an artifact storm (alive feed, every frame rejected) never idle-ends a workout', () => {
    const { state, summaries } = harness(H)
    ramp(state)
    feed(state, 16, 300, 145) // last effort at 315
    // Quiet accepted rest (none when IDLE_END_S <= 900) so the storm, capped
    // under the garbage bound, still ends past the idle mark.
    const quietS = Math.max(0, IDLE_END_S + 100 - 1000)
    feed(state, 316, quietS, 100)
    const stormS = 316 + quietS
    feed(state, stormS, 1000, 223) // ceiling storm: all rejected
    state.tick(T0 + (stormS + 1000) * 1000) // > IDLE_END_S since the last accepted effort
    expect(stormS + 1000 - 315).toBeGreaterThan(IDLE_END_S)
    expect(summaries).toHaveLength(0)
  })
})

describe('idle end, production profile (near-line shapes)', () => {
  // daemon.ts floors max HR at 187: rest 56 / max 187 -> hot (start line)
  // 115, Z1 floor (the idle effort line) 108, cool 89.
  const P = { maxHr: 187, restHr: 56 }
  const rests = (events: Emitted[]) => events.filter((e) => e.cls === 'live.rest')
  const ramp = (state: LiveState) => {
    feed(state, 0, 10, 70)
    feed(state, 10, 6, (i) => 80 + i * 10) // first hot (>= 115) sample: 120 at s=14
  }
  const START_S = 14
  const tickEvery = (state: LiveState, fromS: number, toS: number, stepS = 30) => {
    for (let t = fromS; t <= toS; t += stepS) state.tick(T0 + t * 1000)
  }

  test('heavy singles peaking under the start line (rests 96-101) keep one session open', () => {
    const { state, summaries } = harness(P)
    ramp(state)
    feed(state, 16, 150, 125) // warmup sets start the session
    let t = 166
    let lastSingleS = 0
    for (let c = 0; c < 6; c++) {
      feed(state, t, 20, (i) => 104 + Math.round((i * 9) / 19)) // single: 104 -> 113
      lastSingleS = t + 19
      t += 20
      feed(state, t, 280, (i) => 96 + (i % 6)) // rest 96-101
      t += 280
      expect(summaries).toHaveLength(0) // never idle-ended mid-lift
    }
    feed(state, t, IDLE_END_S + 100, (i) => 96 + (i % 6))
    expect(summaries).toHaveLength(1)
    expect(summaries[0].reason).toBe('idle')
    // The session covers the singles, not just the warmup.
    expect(summaries[0].duration_s).toBe(lastSingleS - START_S)
  })

  test('an easy Z1 stretch at 106-113 (descent, recovery spin) is not idle: one session, intent kept', () => {
    const { state, summaries, releases } = harness(P)
    state.noteIntent(T0)
    feed(state, 0, 600, 122)
    // Longer than the idle window, all under the start line.
    const z1S = IDLE_END_S + 300
    feed(state, 600, z1S, (i) => 106 + (i % 8))
    feed(state, 600 + z1S, 900, 124)
    expect(summaries).toHaveLength(0)
    feed(state, 1500 + z1S, 400, 80)
    expect(summaries).toHaveLength(1)
    expect(summaries[0].reason).toBe('cooldown')
    expect(summaries[0].intent_matched).toBe(true)
    expect(summaries[0].duration_s).toBe(1500 + z1S)
    expect(releases()).toBe(1)
  })

  test('a feed gap shorter than feed_drop counts as unknown, not idle (no split on the returning sample)', () => {
    const { state, summaries } = harness(P)
    ramp(state)
    feed(state, 16, 600, 130) // last effort at 615
    // Observed rest + the 661 s gap crosses IDLE_END_S on the returning
    // sample; the observed rest alone does not.
    const restS = IDLE_END_S - 660
    feed(state, 616, restS, 100)
    const lastS = 615 + restS
    tickEvery(state, lastS + 5, lastS + 645) // 11 min of silence, ticking
    expect(summaries).toHaveLength(0)
    feed(state, lastS + 661, 1, 105) // the feed returns below the line
    expect(lastS + 661 - 615).toBeGreaterThan(IDLE_END_S)
    state.tick(T0 + (lastS + 666) * 1000)
    expect(summaries).toHaveLength(0)
    feed(state, lastS + 662, 300, 130) // the workout was still on
    feed(state, lastS + 962, 310, 75)
    expect(summaries).toHaveLength(1)
    expect(summaries[0].reason).toBe('cooldown')
    expect(summaries[0].started_at).toBe(new Date(T0 + START_S * 1000).toISOString())
  })

  test('the gap is discounted, observed quiet still ends idle (IDLE_END_S of HEARD time)', () => {
    const H = { maxHr: 181, restHr: 56 }
    const { state, summaries } = harness(H)
    feed(state, 0, 1800, 140) // last effort at 1799
    // Observed quiet + the 630 s gap exceeds IDLE_END_S on the returning
    // sample, so only the discount keeps it open there.
    const obsS = IDLE_END_S - 300
    feed(state, 1800, obsS, 100)
    const lastS = 1799 + obsS
    tickEvery(state, lastS + 1, lastS + 621)
    feed(state, lastS + 630, 1, 100) // 630 s gap
    expect(lastS + 630 - 1799).toBeGreaterThan(IDLE_END_S)
    state.tick(T0 + (lastS + 636) * 1000)
    expect(summaries).toHaveLength(0)
    // Observed idle = (ts - 1799) - 630: reaches IDLE_END_S at this ts.
    const endS = 1799 + 630 + IDLE_END_S
    feed(state, lastS + 631, endS - 1 - (lastS + 631) + 1, 100)
    expect(summaries).toHaveLength(0)
    feed(state, endS, 1, 100)
    expect(summaries).toHaveLength(1)
    expect(summaries[0].reason).toBe('idle')
    expect(summaries[0].duration_s).toBe(1799)
  })

  test('a long artifact storm then one low accepted sample does not idle-end a ride that continues', () => {
    const { state, summaries } = harness(P)
    ramp(state)
    feed(state, 16, 600, 150) // last accepted effort at 615
    // Quiet accepted riding first (none when IDLE_END_S <= 900) so the low
    // sample after the storm lands past the idle mark.
    const quietS = Math.max(0, IDLE_END_S - 900)
    feed(state, 616, quietS, 100)
    const stormS = 616 + quietS
    feed(state, stormS, 900, 230) // ceiling storm (ceiling 202): all rejected
    tickEvery(state, stormS + 14, stormS + 884)
    feed(state, stormS + 900, 1, 110)
    expect(stormS + 900 - 615).toBeGreaterThan(IDLE_END_S)
    feed(state, stormS + 901, 300, 150) // the ride continues
    expect(summaries).toHaveLength(0)
    feed(state, stormS + 1201, 310, 75)
    expect(summaries).toHaveLength(1)
    expect(summaries[0].reason).toBe('cooldown')
  })

  test('a one-sample touch of the line every 14 min cannot hold the session open (bounded tail)', () => {
    const { state, summaries } = harness(P)
    ramp(state)
    feed(state, 16, 3600, 140) // last effort at 3615
    let t = 3616
    for (let k = 0; k < 12; k++) {
      feed(state, t, 839, (i) => 95 + ((i * 5) % 14)) // 95-108 wobble
      t += 839
      feed(state, t, 1, 116)
      t += 1
    }
    expect(summaries).toHaveLength(1)
    expect(summaries[0].reason).toBe('idle')
    expect(summaries[0].duration_s).toBe(3615 - START_S)
    expect(state.sessionActive()).toBe(false)
  })

  test('3 h at 100 with one 113 sample every 10 min idle-ends (generic profile, hot 112)', () => {
    const { state, summaries } = harness({ maxHr: 181, restHr: 56 })
    feed(state, 0, 1800, 140)
    feed(state, 1800, 10800, (i) => (i % 600 === 599 ? 113 : 100))
    expect(summaries).toHaveLength(1)
    expect(summaries[0].reason).toBe('idle')
    expect(summaries[0].duration_s).toBe(1799)
  })

  test('cadence lock (bpm ~92, RR proving ~144) is effort: no mid-ride idle split', () => {
    const { state, summaries } = harness(P)
    feed(state, 0, 600, 140, [430, 430])
    const lockS = IDLE_END_S + 100 // longer than the idle window
    feed(state, 600, lockS, 92, [415, 420])
    feed(state, 600 + lockS, 300, 142, [420, 425])
    expect(summaries).toHaveLength(0)
    feed(state, 900 + lockS, 310, 75)
    expect(summaries).toHaveLength(1)
    expect(summaries[0].reason).toBe('cooldown')
  })

  test('no live.confirm from the idle tail: confirm and end judge the same work window', () => {
    const { state, events, summaries } = harness()
    feed(state, 0, 600, 160, [1000]) // mismatched RR: cadence-lock signature
    feed(state, 600, IDLE_END_S, 100, [600]) // consistent resting RR in the tail
    expect(events.filter((e) => e.cls === 'live.confirm')).toHaveLength(0)
    expect(summaries).toHaveLength(1)
    expect(summaries[0].reason).toBe('idle')
    expect(summaries[0].confidence).toBe('low')
    expect(summaries[0].demoted).toBe(true)
  })

  test('a yield long after the last effort archives the work, not the tail', () => {
    const { state, summaries } = harness({ maxHr: 181, restHr: 56 })
    feed(state, 0, 3600, 140)
    feed(state, 3600, 840, 100)
    state.yieldInterrupt(T0 + 4440 * 1000)
    expect(summaries[0].reason).toBe('yield')
    expect(summaries[0].duration_s).toBe(3599)
    expect(summaries[0].avg_bpm).toBe(140)
    expect(summaries[0].zone_seconds[0]).toBe(0)
  })

  test('a yield right after the effort keeps its short tail (unchanged)', () => {
    const { state, summaries } = harness({ maxHr: 181, restHr: 56 })
    feed(state, 0, 3600, 140)
    feed(state, 3600, 60, 100)
    state.yieldInterrupt(T0 + 3660 * 1000)
    expect(summaries[0].reason).toBe('yield')
    expect(summaries[0].duration_s).toBe(3660)
  })

  test('a feed_drop after a long quiet tail archives the work, not the tail', () => {
    const { state, summaries } = harness({ maxHr: 181, restHr: 56 })
    feed(state, 0, 3600, 140)
    feed(state, 3600, 400, 100)
    tickEvery(state, 4000, 4800)
    expect(summaries[0].reason).toBe('feed_drop')
    expect(summaries[0].duration_s).toBe(3599)
  })

  test('the start sample is the last effort: idle IDLE_END_S after it, recovery read at +60 s', () => {
    const { state, events, summaries } = harness({ maxHr: 181, restHr: 56 })
    feed(state, 0, 91, 125) // start at s=90
    feed(state, 91, IDLE_END_S - 2, 100) // up to s = 90 + IDLE_END_S - 2
    expect(summaries).toHaveLength(0)
    feed(state, 90 + IDLE_END_S - 1, 1, 100)
    expect(summaries).toHaveLength(0)
    feed(state, 90 + IDLE_END_S, 1, 100)
    expect(summaries).toHaveLength(1)
    expect(summaries[0].reason).toBe('idle')
    expect(summaries[0].recovery_60s_drop).toBe(25)
    expect(rests(events)[0].content).toContain('HR recovery: -25 bpm')
  })

  test('live.rest meta carries the end reason, archived ended_at, and the recovery read', () => {
    const { state, events, summaries } = harness({ maxHr: 181, restHr: 56 })
    feed(state, 0, 91, 125)
    feed(state, 91, IDLE_END_S, 100)
    const meta = rests(events)[0].meta
    expect(meta.reason).toBe('idle')
    expect(meta.ended_at).toBe(summaries[0].ended_at)
    expect(meta.recovery_60s_drop).toBe('25')
  })

  // Field regression (the probe that raised IDLE_END_S from 900): a 12-min
  // break after heavy squats, sitting at ~94, idle-ended the lift at 15 min
  // and the bench, deadlift and accessory work never re-opened a session.
  const longBreakLift = (breakS: number) => {
    const h = harness(P)
    const { state } = h
    // A rise from `from` to `peak` over rampS, then a decay toward `floor`.
    let t = 0
    const set = (rampS: number, from: number, peak: number, restS: number, floor: number, tau: number): number => {
      feed(state, t, rampS, (i) => Math.round(from + ((peak - from) * i) / (rampS - 1)))
      const peakS = t + rampS - 1
      t += rampS
      feed(state, t, restS, (i) => Math.round(floor + (peak - floor) * Math.exp(-(i + 1) / tau)))
      t += restS
      return peakS
    }
    feed(state, 0, 600, (i) => 121 + (i % 3)) // 10-min warmup at ~122 starts the session
    t = 600
    for (let k = 0; k < 5; k++) set(50, 100, 145, 220, 98, 40) // squat
    feed(state, t, breakS, 94) // the long break
    t += breakS
    for (let k = 0; k < 5; k++) set(40, 100, 130, 180, 97, 40) // bench
    for (let k = 0; k < 4; k++) set(20, 100, 124, 330, 96, 40) // deadlift singles
    let lastAccessoryPeakS = 0
    for (let k = 0; k < 6; k++) lastAccessoryPeakS = set(35, 100, 118, 120, 99, 40) // accessories
    return { ...h, t, lastAccessoryPeakS }
  }

  for (const breakMin of [12, 20]) {
    test(`a ${breakMin}-min break after heavy squats does not split or end the lift (field regression)`, () => {
      const { state, events, summaries, t, lastAccessoryPeakS } = longBreakLift(breakMin * 60)
      // Still one open session through the last accessory set and its rest.
      expect(summaries).toHaveLength(0)
      expect(rests(events)).toHaveLength(0)
      expect(state.sessionActive()).toBe(true)
      feed(state, t, 3000, (i) => 92 + (i % 5)) // 50 min at 92-96 afterwards
      expect(events.filter((e) => e.cls === 'live.session')).toHaveLength(1)
      expect(summaries).toHaveLength(1)
      expect(rests(events)).toHaveLength(1)
      const s = summaries[0]
      expect(s.reason).toBe('idle')
      const startS = (Date.parse(s.started_at) - T0) / 1000
      expect(startS + s.duration_s).toBeGreaterThanOrEqual(lastAccessoryPeakS)
    })
  }
})
