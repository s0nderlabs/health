import { describe, expect, test } from 'bun:test'
import { LiveState, RING_CAP } from '../src/livestate.js'
import type { SessionSummary } from '../src/livestate.js'
import { parseBase64Frame } from '../src/hrparse.js'

const T0 = Date.parse('2026-07-09T10:00:00.000Z')

interface Emitted {
  cls: string
  key: string
  content: string
  meta: Record<string, string>
}

function harness(opts: { maxHr?: number; restHr?: number; hotBpm?: number | null } = {}) {
  const events: Emitted[] = []
  const summaries: SessionSummary[] = []
  const state = new LiveState({
    getMaxHr: () => opts.maxHr ?? 190,
    getRestHr: () => opts.restHr ?? 56,
    getHotBpm: () => opts.hotBpm ?? null,
    emit: (cls, key, payload) => events.push({ cls, key, ...payload }),
    onSessionEnd: (s) => summaries.push(s),
  })
  return { state, events, summaries }
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

describe('zone milestones', () => {
  // Milestones obey the confidence contract (low = silent), so these tests
  // declare an intent up front: the session is high-confidence throughout
  // and the zone logic itself is what's under test.
  test('sustained Z4 announces only the highest zone reached', () => {
    const { state, events } = harness()
    state.noteIntent(T0)
    feed(state, 0, 95, 125) // session starts (Z2 at 125/190=66%)
    feed(state, 95, 30, 160) // Z4 (84%)
    const zones = events.filter((e) => e.cls === 'live.zone')
    expect(zones).toHaveLength(1)
    expect(zones[0].meta.zone).toBe('4')
  })

  test('gradual ramp announces each zone as it is earned', () => {
    const { state, events } = harness()
    state.noteIntent(T0)
    feed(state, 0, 95, 125)
    feed(state, 95, 60, 140) // Z3 (74%)
    feed(state, 155, 60, 160) // Z4
    feed(state, 215, 60, 175) // Z5 (92%)
    const zones = events.filter((e) => e.cls === 'live.zone').map((e) => e.meta.zone)
    expect(zones).toEqual(['3', '4', '5'])
  })

  test('a zone is announced once per session', () => {
    const { state, events } = harness()
    state.noteIntent(T0)
    feed(state, 0, 95, 125)
    feed(state, 95, 30, 160) // Z4
    feed(state, 125, 60, 125) // back down
    feed(state, 185, 30, 160) // Z4 again
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
  // Harness defaults: hot 116, cool 90; zones at maxHr 190: Z3 133, Z4 152.
  const confirms = (events: Emitted[]) => events.filter((e) => e.meta.kind === 'confirm')
  const starts = (events: Emitted[]) => events.filter((e) => e.cls === 'live.session' && e.meta.kind !== 'confirm')
  const rests = (events: Emitted[]) => events.filter((e) => e.cls === 'live.rest')

  test('a passive elevation (smooth shallow plateau) stays low and is demoted', () => {
    const { state, events, summaries } = harness()
    feed(state, 0, 60, 70)
    feed(state, 60, 4, (i) => 85 + i * 10) // physiological ramp 85 -> 115
    feed(state, 64, 570, 122) // ~9.5 min smooth Z2 plateau, one hot streak
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
    feed(state, 34, 960, 124) // 16 min, structureless, Z2
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

  test('sustained Z3 earns depth evidence and confirms (steady cardio)', () => {
    const { state, events } = harness()
    feed(state, 0, 95, 125)
    feed(state, 95, 301, 140) // Z3 held past 5 min
    expect(confirms(events)).toHaveLength(1)
    expect(confirms(events)[0].meta.confidence).toBe('medium')
    expect(confirms(events)[0].meta.confidence_reasons).toContain('sustained_z3')
  })

  test('one continuous Z4 minute is evidence on its own', () => {
    const { state, events } = harness()
    feed(state, 0, 95, 125)
    feed(state, 95, 30, 140)
    feed(state, 125, 61, 155) // Z4 for 61s
    expect(confirms(events)).toHaveLength(1)
    expect(confirms(events)[0].meta.confidence_reasons).toContain('z4')
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
    feed(state, 200, 301, 140) // sustained Z3: evidence arrives, claim lands
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
    // to count as mismatched RR and demote a genuine sustained-Z3 ride.
    const { state, events, summaries } = harness()
    feed(state, 0, 95, 125, [150])
    feed(state, 95, 301, 140, [150]) // deep evidence with junk-only RR
    expect(confirms(events)).toHaveLength(1)
    expect(confirms(events)[0].meta.confidence_reasons).toContain('sustained_z3')
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
    feed(state, 95, 100, 135) // Z3 sustained, but still low: 100s < 5min
    expect(events.filter((e) => e.cls === 'live.zone')).toHaveLength(0)
    feed(state, 195, 210, 135) // crosses the 5-min sustained-Z3 evidence bar
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
