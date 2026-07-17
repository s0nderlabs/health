import { describe, expect, test, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LiveListener, type LiveListenerOpts } from '../src/live.js'
import { LiveState } from '../src/livestate.js'

const TOKEN = 'test-token-1234'

interface Emitted {
  cls: string
  key: string
}

function makeListener() {
  const events: Emitted[] = []
  const state = new LiveState({
    getMaxHr: () => 190,
    getRestHr: () => 56,
    getHotBpm: () => null,
    emit: (cls, key) => events.push({ cls, key }),
  })
  const listener = new LiveListener(state, () => TOKEN)
  listener.start(0, '127.0.0.1') // port 0 = ephemeral
  // @ts-expect-error reach into the private server for the assigned port
  const port = listener.server.port as number
  return { listener, state, events, port }
}

function connect(port: number, token = TOKEN): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/stream?token=${token}`)
    ws.onopen = () => resolve(ws)
    ws.onerror = (e) => reject(new Error(`ws error: ${e}`))
  })
}

function hrFrame(tsMs: number, bpm: number, rrRaw?: number): string {
  const bytes = rrRaw != null ? [0x10, bpm, rrRaw & 0xff, rrRaw >> 8] : [0x00, bpm]
  return JSON.stringify({
    type: 'hr',
    ts: tsMs,
    raw: Buffer.from(bytes).toString('base64'),
  })
}

let cleanup: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanup) fn()
  cleanup = []
})

describe('LiveListener', () => {
  test('rejects a connection with a bad token', async () => {
    const { listener, port } = makeListener()
    cleanup.push(() => listener.stop())
    await expect(connect(port, 'wrong')).rejects.toThrow()
  })

  test('rejects when no token is configured (empty = locked)', async () => {
    const state = new LiveState({
      getMaxHr: () => 190,
      getRestHr: () => 56,
      getHotBpm: () => null,
      emit: () => {},
    })
    const listener = new LiveListener(state, () => '')
    listener.start(0, '127.0.0.1')
    cleanup.push(() => listener.stop())
    // @ts-expect-error private
    const port = listener.server.port as number
    await expect(connect(port, '')).rejects.toThrow()
  })

  test('hello handshake is acknowledged and source recorded', async () => {
    const { listener, port } = makeListener()
    cleanup.push(() => listener.stop())
    const ws = await connect(port)
    const reply = await new Promise<string>((resolve) => {
      ws.onmessage = (e) => resolve(String(e.data))
      ws.send(JSON.stringify({ type: 'hello', source: 'mac', device: 'WHOOP TEST' }))
    })
    expect(JSON.parse(reply).type).toBe('ok')
    // hello alone marks the relayer; band status comes from status/hr messages
    expect(listener.status().relayer_connected).toBe(true)
    expect(listener.status().relayer_source).toBe('mac')
    ws.close()
  })

  test('hr frames flow into the state machine and mark the band connected', async () => {
    const { listener, state, port } = makeListener()
    cleanup.push(() => listener.stop())
    const ws = await connect(port)
    const t0 = Date.now() - 60_000
    for (let i = 0; i < 5; i++) ws.send(hrFrame(t0 + i * 1000, 70 + i))
    await Bun.sleep(150)
    const snap = state.snapshot(t0 + 5000)
    expect(snap.samples_buffered).toBe(5)
    expect(snap.bpm).toBe(74)
    expect(listener.status().band_connected).toBe(true)
    expect(listener.status().frames).toBe(5)
    ws.close()
  })

  test('a phantom 223 frame is rejected on the production WS path and surfaced in status', async () => {
    const { listener, state, port } = makeListener()
    cleanup.push(() => listener.stop())
    const ws = await connect(port)
    const t0 = Date.now() - 60_000
    // Steady ~111 bpm, then the Jul 12 artifact: a well-formed frame whose
    // payload says 223 (2x the true rate), RR attached like the band sends.
    for (let i = 0; i < 10; i++) ws.send(hrFrame(t0 + i * 1000, 111))
    ws.send(hrFrame(t0 + 10_000, 223, 550))
    ws.send(hrFrame(t0 + 11_000, 112))
    await Bun.sleep(200)
    const snap = state.snapshot(t0 + 12_000) as Record<string, any>
    expect(snap.bpm).toBe(112) // clean sample after the artifact was accepted
    expect(snap.samples_buffered).toBe(11) // 223 never entered the ring
    expect(snap.rejected_samples).toBe(1)
    expect(snap.last_rejected.bpm).toBe(223)
    expect(listener.status().rejected_samples).toBe(1)
    expect(listener.status().frames).toBe(12) // received, counted, then gated
    ws.close()
  })

  test('a full synthetic workout drives session events end to end', async () => {
    const { listener, events, port } = makeListener()
    cleanup.push(() => listener.stop())
    const ws = await connect(port)
    const t0 = Date.now() - 600_000 // frames span ~540s and must not land in the future
    let t = 0
    // 2 min warm (session threshold 116 with maxHr 190/rest 56)
    for (let i = 0; i < 120; i++) ws.send(hrFrame(t0 + t++ * 1000, 125))
    // 90s hard in Z4: crosses the 60s z4 evidence latch, so the session
    // confirms and its milestone clears the confidence gate.
    for (let i = 0; i < 90; i++) ws.send(hrFrame(t0 + t++ * 1000, 160))
    // 6 min cooldown below 90
    for (let i = 0; i < 360; i++) ws.send(hrFrame(t0 + t++ * 1000, 80))
    await Bun.sleep(400)
    const classes = events.map((e) => e.cls)
    expect(classes).toContain('live.session')
    expect(classes).toContain('live.confirm')
    expect(classes).toContain('live.zone')
    expect(classes).toContain('live.rest')
    ws.close()
  })

  test('a future-ts frame is rejected (clock skew must not starve the feed)', async () => {
    const { listener, state, port } = makeListener()
    cleanup.push(() => listener.stop())
    const ws = await connect(port)
    ws.send(hrFrame(Date.now() + 120_000, 70)) // 2 min ahead of daemon clock
    ws.send(hrFrame(Date.now() - 1000, 72)) // sane frame still flows after
    await Bun.sleep(150)
    expect(listener.status().parse_errors).toBe(1)
    expect(listener.status().frames).toBe(1)
    expect(state.snapshot(Date.now()).bpm).toBe(72)
    ws.close()
  })

  test('malformed frames are counted, not fatal', async () => {
    const { listener, port } = makeListener()
    cleanup.push(() => listener.stop())
    const ws = await connect(port)
    ws.send('not json at all')
    ws.send(JSON.stringify({ type: 'hr', ts: 'garbage', raw: '!!!' }))
    ws.send(JSON.stringify({ type: 'wat' }))
    ws.send(hrFrame(Date.now() - 1000, 70))
    await Bun.sleep(150)
    expect(listener.status().parse_errors).toBe(3)
    expect(listener.status().frames).toBe(1)
    ws.close()
  })

  test('band status message updates feed state', async () => {
    const { listener, port } = makeListener()
    cleanup.push(() => listener.stop())
    const ws = await connect(port)
    ws.send(JSON.stringify({ type: 'status', connected: true, device: 'WHOOP 4A0' }))
    await Bun.sleep(100)
    expect(listener.status().band_connected).toBe(true)
    expect(listener.status().band_device).toBe('WHOOP 4A0')
    ws.send(JSON.stringify({ type: 'status', connected: false }))
    await Bun.sleep(100)
    expect(listener.status().band_connected).toBe(false)
    ws.close()
  })

  test('disconnect clears relayer and band state', async () => {
    const { listener, port } = makeListener()
    cleanup.push(() => listener.stop())
    const ws = await connect(port)
    ws.send(JSON.stringify({ type: 'status', connected: true }))
    await Bun.sleep(100)
    ws.close()
    await Bun.sleep(150)
    expect(listener.status().relayer_connected).toBe(false)
    expect(listener.status().band_connected).toBe(false)
  })

  test('healthz responds without auth, stream 404s elsewhere', async () => {
    const { listener, port } = makeListener()
    cleanup.push(() => listener.stop())
    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200)
    expect((await fetch(`http://127.0.0.1:${port}/nope`)).status).toBe(404)
    expect((await fetch(`http://127.0.0.1:${port}/stream?token=${TOKEN}`)).status).toBe(426)
  })
})

// ── Arbitration + phone surfaces ──────────────────────────────────

// Millisecond-scale timing so state transitions are observable in-test.
const FAST = {
  macFreshMs: 250,
  arbTickMs: 40,
  probeIntervalMs: 300,
  pauseMs: 200,
  planDebounceMs: 50,
  phoneSeenThrottleMs: 50,
  dualUpWindowMs: 200,
  // Generous vs the arb tick so "no release inside the grace window"
  // assertions survive suite-load event-loop drift.
  dualUpCooldownMs: 1000,
  dualUpExhaustedMs: 3000,
  dualUpMaxAttempts: 2,
  // Long enough that recency never trips in fast tests EXCEPT the one test
  // that overrides it to prove staleness blocks the release.
  dualUpPeerRecentMs: 60_000,
}

function makeArbListener(opts: LiveListenerOpts = {}) {
  const events: Emitted[] = []
  const state = new LiveState({
    getMaxHr: () => 190,
    getRestHr: () => 56,
    getHotBpm: () => null,
    emit: (cls, key) => events.push({ cls, key }),
  })
  const listener = new LiveListener(state, () => TOKEN, { timing: FAST, ...opts })
  listener.start(0, '127.0.0.1')
  // @ts-expect-error reach into the private server for the assigned port
  const port = listener.server.port as number
  return { listener, state, events, port }
}

/** Connect + collect every inbound message; resolves after the hello reply. */
async function relayer(
  port: number,
  source: string,
  transport?: string,
  opts?: { caps?: string[]; battery?: { level: number; charging: boolean } },
): Promise<{ ws: WebSocket; msgs: string[]; helloReply: string }> {
  const ws = await connect(port)
  const msgs: string[] = []
  ws.onmessage = (e) => msgs.push(String(e.data))
  const hello: Record<string, unknown> = { type: 'hello', source, device: `${source}-test` }
  if (transport) hello.transport = transport
  if (opts?.caps) hello.caps = opts.caps
  ws.send(JSON.stringify(hello))
  await waitFor(() => msgs.length >= 1)
  if (opts?.battery) ws.send(JSON.stringify({ type: 'battery', ...opts.battery }))
  return { ws, msgs, helloReply: msgs[0] }
}

const DUAL_CAPS = { caps: ['release', 'battery'], battery: { level: 0.9, charging: true } }

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('waitFor timed out')
    await Bun.sleep(20)
  }
}

const parsed = (msgs: string[]) => msgs.map((m) => JSON.parse(m) as { type: string })
const has = (msgs: string[], type: string) => parsed(msgs).some((m) => m.type === type)

describe('arbitration (mac priority)', () => {
  test('phone hello gets ok when no mac feed exists', async () => {
    const { listener, port } = makeArbListener()
    cleanup.push(() => listener.stop())
    const phone = await relayer(port, 'phone')
    expect(JSON.parse(phone.helloReply).type).toBe('ok')
    phone.ws.close()
  })

  test('phone hello gets standdown while the mac feed is fresh', async () => {
    const { listener, port } = makeArbListener()
    cleanup.push(() => listener.stop())
    const mac = await relayer(port, 'mac')
    mac.ws.send(hrFrame(Date.now() - 1000, 72))
    await Bun.sleep(50)
    const phone = await relayer(port, 'phone')
    expect(JSON.parse(phone.helloReply).type).toBe('standdown')
    const st = listener.status()
    expect(st.relayers.find((r) => r.source === 'phone')?.mode).toBe('standdown')
    mac.ws.close()
    phone.ws.close()
  })

  test('standing-down phone resumes when the mac feed goes silent, stands down when it returns', async () => {
    const { listener, port } = makeArbListener()
    cleanup.push(() => listener.stop())
    const mac = await relayer(port, 'mac')
    mac.ws.send(hrFrame(Date.now() - 1000, 72))
    await Bun.sleep(50)
    const phone = await relayer(port, 'phone')
    expect(JSON.parse(phone.helloReply).type).toBe('standdown')

    // Mac stops streaming -> freshness expires -> phone resumed.
    await waitFor(() => has(phone.msgs, 'resume'))

    // Mac frames return; the phone is not streaming, so it stands down again.
    mac.ws.send(hrFrame(Date.now() - 500, 74))
    await waitFor(() => parsed(phone.msgs).filter((m) => m.type === 'standdown').length >= 1)
    mac.ws.close()
    phone.ws.close()
  })

  test('rest-time probe pauses the streaming phone, resumes when the mac never takes over', async () => {
    const { listener, port } = makeArbListener()
    cleanup.push(() => listener.stop())
    const mac = await relayer(port, 'mac') // connected but silent (band out of its range)
    const phone = await relayer(port, 'phone', 'wifi')
    expect(JSON.parse(phone.helloReply).type).toBe('ok')
    // Phone is the active feed.
    const feed = setInterval(() => phone.ws.send(hrFrame(Date.now() - 500, 70)), 60)
    cleanup.push(() => clearInterval(feed))

    await waitFor(() => has(phone.msgs, 'pause'))
    const pause = parsed(phone.msgs).find((m) => m.type === 'pause') as { seconds?: number }
    expect(pause.seconds).toBeGreaterThan(0)
    // The pause window expires with no mac frames -> resume.
    await waitFor(() => has(phone.msgs, 'resume'))
    mac.ws.close()
    phone.ws.close()
  })

  test('probe converts to standdown when the mac grabs the band', async () => {
    const { listener, port } = makeArbListener()
    cleanup.push(() => listener.stop())
    const mac = await relayer(port, 'mac')
    const phone = await relayer(port, 'phone', 'wifi')
    const feed = setInterval(() => phone.ws.send(hrFrame(Date.now() - 500, 70)), 60)
    cleanup.push(() => clearInterval(feed))

    await waitFor(() => has(phone.msgs, 'pause'))
    clearInterval(feed) // phone honors the pause
    mac.ws.send(hrFrame(Date.now() - 400, 71)) // mac reacquired during the window
    await waitFor(() => has(phone.msgs, 'standdown'))
    expect(listener.status().relayers.find((r) => r.source === 'phone')?.mode).toBe('standdown')
    mac.ws.close()
    phone.ws.close()
  })

  test('active_source clears after all relayers disconnect (no phantom source)', async () => {
    const { listener, port } = makeArbListener()
    cleanup.push(() => listener.stop())
    const mac = await relayer(port, 'mac')
    mac.ws.send(hrFrame(Date.now() - 500, 72))
    await waitFor(() => listener.status().active_source === 'mac')
    mac.ws.close()
    await waitFor(() => !listener.status().relayer_connected)
    // frameArrival must be cleared on close, else status keeps naming 'mac'.
    expect(listener.status().active_source).toBeNull()
    expect(listener.status().relayer_source).toBeNull()
  })

  test('no probe while a live session is active', async () => {
    const { listener, state, port } = makeArbListener()
    cleanup.push(() => listener.stop())
    const mac = await relayer(port, 'mac')
    const phone = await relayer(port, 'phone', 'wifi')
    // Drive the state machine into a session through the phone feed.
    const t0 = Date.now() - 300_000
    for (let i = 0; i < 120; i++) phone.ws.send(hrFrame(t0 + i * 1000, 150))
    await waitFor(() => state.sessionActive())
    // Keep the phone feed fresh across two probe intervals.
    const feed = setInterval(() => phone.ws.send(hrFrame(Date.now() - 500, 150)), 60)
    cleanup.push(() => clearInterval(feed))
    await Bun.sleep(FAST.probeIntervalMs * 2 + 100)
    expect(has(phone.msgs, 'pause')).toBe(false)
    mac.ws.close()
    phone.ws.close()
  })

  test('no probe while the phone is on cellular (mac cannot win, hole for nothing)', async () => {
    const { listener, port } = makeArbListener()
    cleanup.push(() => listener.stop())
    const mac = await relayer(port, 'mac')
    const phone = await relayer(port, 'phone', 'cellular')
    const feed = setInterval(() => phone.ws.send(hrFrame(Date.now() - 500, 70)), 60)
    cleanup.push(() => clearInterval(feed))
    await Bun.sleep(FAST.probeIntervalMs * 2 + 100)
    expect(has(phone.msgs, 'pause')).toBe(false)
    mac.ws.close()
    phone.ws.close()
  })

  test('no probe when the phone never reported a transport (pre-fix client)', async () => {
    const { listener, port } = makeArbListener()
    cleanup.push(() => listener.stop())
    const mac = await relayer(port, 'mac')
    const phone = await relayer(port, 'phone')
    const feed = setInterval(() => phone.ws.send(hrFrame(Date.now() - 500, 70)), 60)
    cleanup.push(() => clearInterval(feed))
    await Bun.sleep(FAST.probeIntervalMs * 2 + 100)
    expect(has(phone.msgs, 'pause')).toBe(false)
    mac.ws.close()
    phone.ws.close()
  })

  test('gym: the sole phone holder is never released when the mac has not seen the band', async () => {
    // The Jul 10 incident: gym wifi passes dualEligible, the mac relayer is
    // connected (at home) but the band has never been near it. Releasing the
    // phone here punches a hole in the live feed for nothing.
    const { listener, port } = makeArbListener()
    cleanup.push(() => listener.stop())
    const mac = await relayer(port, 'mac', undefined, { caps: ['release'] })
    const phone = await relayer(port, 'phone', 'wifi', DUAL_CAPS)
    const feed = setInterval(() => phone.ws.send(hrFrame(Date.now() - 500, 70)), 60)
    cleanup.push(() => clearInterval(feed))
    await Bun.sleep(FAST.dualUpCooldownMs + 500)
    expect(has(phone.msgs, 'release')).toBe(false)
    // No pause probe either: dual-capable phones never reach the legacy path.
    expect(has(phone.msgs, 'pause')).toBe(false)
    mac.ws.close()
    phone.ws.close()
  })

  test('home blip: band recency survives status:false, the phone is released to re-dual', async () => {
    const { listener, port } = makeArbListener()
    cleanup.push(() => listener.stop())
    const mac = await relayer(port, 'mac', undefined, { caps: ['release'] })
    mac.ws.send(hrFrame(Date.now() - 500, 65)) // the mac held the band moments ago
    await Bun.sleep(50)
    mac.ws.send(JSON.stringify({ type: 'status', connected: false })) // blip wipes freshness
    const phone = await relayer(port, 'phone', 'wifi', DUAL_CAPS)
    const feed = setInterval(() => phone.ws.send(hrFrame(Date.now() - 500, 70)), 60)
    cleanup.push(() => clearInterval(feed))
    await waitFor(() => has(phone.msgs, 'release'))
    mac.ws.close()
    phone.ws.close()
  })

  test('stale recency blocks the release: a mac that held the band too long ago reads as away', async () => {
    const { listener, port } = makeArbListener({ timing: { ...FAST, dualUpPeerRecentMs: 400 } })
    cleanup.push(() => listener.stop())
    const mac = await relayer(port, 'mac', undefined, { caps: ['release'] })
    mac.ws.send(hrFrame(Date.now() - 500, 65))
    await Bun.sleep(700) // recency window (400ms) expires
    const phone = await relayer(port, 'phone', 'wifi', DUAL_CAPS)
    const feed = setInterval(() => phone.ws.send(hrFrame(Date.now() - 500, 70)), 60)
    cleanup.push(() => clearInterval(feed))
    await Bun.sleep(FAST.dualUpCooldownMs + 500)
    expect(has(phone.msgs, 'release')).toBe(false)
    mac.ws.close()
    phone.ws.close()
  })

  test('dual-up releases the mac when the walked-home phone parks (it held the band minutes ago)', async () => {
    const { listener, port } = makeArbListener()
    cleanup.push(() => listener.stop())
    const mac = await relayer(port, 'mac', undefined, { caps: ['release'] })
    const phone = await relayer(port, 'phone', 'wifi', DUAL_CAPS)
    phone.ws.send(hrFrame(Date.now() - 500, 70)) // walked in still holding the band
    await Bun.sleep(50)
    phone.ws.send(JSON.stringify({ type: 'status', connected: false })) // mac wrestles it away
    const macFeed = setInterval(() => mac.ws.send(hrFrame(Date.now() - 500, 65)), 60)
    cleanup.push(() => clearInterval(macFeed))
    await waitFor(() => has(phone.msgs, 'standdown'))
    await waitFor(() => has(mac.msgs, 'release'))
    mac.ws.close()
    phone.ws.close()
  })

  test('a parked phone that never held the band does not cost the mac its hold', async () => {
    const { listener, port } = makeArbListener()
    cleanup.push(() => listener.stop())
    const mac = await relayer(port, 'mac', undefined, { caps: ['release'] })
    const macFeed = setInterval(() => mac.ws.send(hrFrame(Date.now() - 500, 65)), 60)
    cleanup.push(() => clearInterval(macFeed))
    await Bun.sleep(80)
    const phone = await relayer(port, 'phone', 'wifi', DUAL_CAPS)
    expect(JSON.parse(phone.helloReply).type).toBe('standdown')
    await Bun.sleep(FAST.dualUpCooldownMs + 500)
    expect(has(mac.msgs, 'release')).toBe(false)
    mac.ws.close()
    phone.ws.close()
  })

  test('no dual-up release without the caps/battery gate; legacy probe covers it', async () => {
    const { listener, port } = makeArbListener()
    cleanup.push(() => listener.stop())
    const mac = await relayer(port, 'mac', undefined, { caps: ['release'] })
    const phone = await relayer(port, 'phone', 'wifi', {
      caps: ['release', 'battery'],
      battery: { level: 0.2, charging: false }, // low + unplugged: standby too costly
    })
    const feed = setInterval(() => phone.ws.send(hrFrame(Date.now() - 500, 70)), 60)
    cleanup.push(() => clearInterval(feed))
    await waitFor(() => has(phone.msgs, 'pause'))
    expect(has(phone.msgs, 'release')).toBe(false)
    mac.ws.close()
    phone.ws.close()
  })

  test('dual hold: mac is the single writer, phone frames are shadowed', async () => {
    const { listener, state, port } = makeArbListener()
    cleanup.push(() => listener.stop())
    const mac = await relayer(port, 'mac', undefined, { caps: ['release'] })
    const phone = await relayer(port, 'phone', 'wifi', DUAL_CAPS)
    let t = Date.now() - 5000
    const feeds = setInterval(() => {
      t += 1000
      mac.ws.send(hrFrame(t, 70))
      phone.ws.send(hrFrame(t + 100, 180)) // interleaved copy from the standby
    }, 60)
    cleanup.push(() => clearInterval(feeds))
    await waitFor(() => listener.status().dual)
    expect(listener.status().active_source).toBe('mac')
    const bpm = state.snapshot(Date.now()).bpm as number
    expect(bpm).toBeLessThan(120) // phone's 180s never reached the math
    mac.ws.close()
    phone.ws.close()
  })

  test('losing a dual leg starts a grace period: the surviving sole holder is not released (walk-out)', async () => {
    const { listener, port } = makeArbListener()
    cleanup.push(() => listener.stop())
    const mac = await relayer(port, 'mac', undefined, { caps: ['release'] })
    const phone = await relayer(port, 'phone', 'wifi', DUAL_CAPS)
    let t = Date.now() - 8000
    const feeds = setInterval(() => {
      t += 1000
      mac.ws.send(hrFrame(t, 70))
      phone.ws.send(hrFrame(t + 100, 72))
    }, 60)
    cleanup.push(() => clearInterval(feeds))
    await waitFor(() => listener.status().dual)
    // Walk-out: the mac's BLE drops (status admission), phone keeps streaming.
    clearInterval(feeds)
    mac.ws.send(JSON.stringify({ type: 'status', connected: false }))
    const phoneFeed = setInterval(() => {
      t += 1000
      phone.ws.send(hrFrame(t, 95))
    }, 60)
    cleanup.push(() => clearInterval(phoneFeed))
    await waitFor(() => !listener.status().dual)
    // Inside the grace window: no release at the sole holder.
    await Bun.sleep(FAST.dualUpCooldownMs - 400)
    expect(has(phone.msgs, 'release')).toBe(false)
    // Wifi drops as he leaves; now ineligible: still never released.
    phone.ws.send(JSON.stringify({ type: 'transport', transport: 'cellular' }))
    await Bun.sleep(FAST.dualUpCooldownMs + 200)
    expect(has(phone.msgs, 'release')).toBe(false)
    mac.ws.close()
    phone.ws.close()
  })

  test('a status disconnect clears freshness: failover to the standby is immediate, not macFreshMs later', async () => {
    const { listener, state, port } = makeArbListener()
    cleanup.push(() => listener.stop())
    const mac = await relayer(port, 'mac', undefined, { caps: ['release'] })
    const phone = await relayer(port, 'phone', 'wifi', DUAL_CAPS)
    let t = Date.now() - 8000
    for (let i = 0; i < 6; i++) {
      t += 1000
      mac.ws.send(hrFrame(t, 70))
      // Distinct marker value, but a physiological step: the artifact gate
      // must not eat the promotion frame.
      phone.ws.send(hrFrame(t + 100, 100))
    }
    await waitFor(() => listener.status().dual)
    // Mac admits the drop; the phone's very next frame must take the pen
    // (no macFreshMs coasting).
    mac.ws.send(JSON.stringify({ type: 'status', connected: false }))
    await Bun.sleep(50)
    t += 1000
    phone.ws.send(hrFrame(t, 100))
    await waitFor(() => listener.status().active_source === 'phone', 1000)
    await waitFor(() => (state.snapshot(Date.now()).bpm as number) > 90, 1000)
    mac.ws.close()
    phone.ws.close()
  })

  test('a standby draining below the battery floor is tolerated, never release-churned', async () => {
    // Jul 12 field bug: releasing the low-battery standby is pointless (its
    // pending-connect anchor re-grabs the band within a minute) and churned
    // 111 release/reconnect holes in 2h. The daemon now keeps the dual hold
    // and never pushes a battery release.
    const { listener, port } = makeArbListener()
    cleanup.push(() => listener.stop())
    const mac = await relayer(port, 'mac', undefined, { caps: ['release'] })
    const phone = await relayer(port, 'phone', 'wifi', DUAL_CAPS)
    let t = Date.now() - 5000
    const feeds = setInterval(() => {
      t += 1000
      mac.ws.send(hrFrame(t, 70))
      phone.ws.send(hrFrame(t + 100, 72))
    }, 60)
    cleanup.push(() => clearInterval(feeds))
    await waitFor(() => listener.status().dual)
    phone.ws.send(JSON.stringify({ type: 'battery', level: 0.3, charging: false }))
    // Many arb ticks pass; the standby stays held and unmolested.
    await Bun.sleep(FAST.arbTickMs * 6)
    expect(has(phone.msgs, 'release')).toBe(false)
    expect(listener.status().dual).toBe(true)
    // Recovery (>= 0.4) closes the episode; still no release traffic.
    phone.ws.send(JSON.stringify({ type: 'battery', level: 0.8, charging: true }))
    await Bun.sleep(FAST.arbTickMs * 2)
    expect(has(phone.msgs, 'release')).toBe(false)
    mac.ws.close()
    phone.ws.close()
  })

  test('failover: mac goes stale mid-dual and the phone promotes with its next frame', async () => {
    const { listener, state, port } = makeArbListener()
    cleanup.push(() => listener.stop())
    const mac = await relayer(port, 'mac', undefined, { caps: ['release'] })
    const phone = await relayer(port, 'phone', 'wifi', DUAL_CAPS)
    let t = Date.now() - 10000
    for (let i = 0; i < 5; i++) {
      t += 1000
      mac.ws.send(hrFrame(t, 70))
      // Distinct marker value, but a physiological step: the artifact gate
      // must not eat the promotion frames.
      phone.ws.send(hrFrame(t + 100, 100))
    }
    await waitFor(() => listener.status().dual)
    // Mac dies; the phone keeps streaming.
    await Bun.sleep(FAST.macFreshMs + 100)
    for (let i = 0; i < 4; i++) {
      t += 1000
      phone.ws.send(hrFrame(t, 100))
    }
    await waitFor(() => listener.status().active_source === 'phone')
    await waitFor(() => (state.snapshot(Date.now()).bpm as number) > 90)
    mac.ws.close()
    phone.ws.close()
  })

  test('a transport message flips probe eligibility mid-connection', async () => {
    const { listener, port } = makeArbListener()
    cleanup.push(() => listener.stop())
    const mac = await relayer(port, 'mac')
    const phone = await relayer(port, 'phone', 'cellular')
    const feed = setInterval(() => phone.ws.send(hrFrame(Date.now() - 500, 70)), 60)
    cleanup.push(() => clearInterval(feed))
    await Bun.sleep(FAST.probeIntervalMs + 100)
    expect(has(phone.msgs, 'pause')).toBe(false)
    // Arriving home: the phone joins wifi and reports it.
    phone.ws.send(JSON.stringify({ type: 'transport', transport: 'wifi' }))
    await waitFor(() => has(phone.msgs, 'pause'))
    expect(listener.status().relayers.find((r) => r.source === 'phone')?.transport).toBe('wifi')
    mac.ws.close()
    phone.ws.close()
  })
})

describe('phone surfaces (steps, intent, plan, watchdog)', () => {
  test('steps samples are validated, forwarded, and acked', async () => {
    const captured: unknown[] = []
    const { listener, port } = makeArbListener({
      onSteps: (samples) => {
        captured.push(...samples)
        return { added: samples.length, deleted: 0 }
      },
    })
    cleanup.push(() => listener.stop())
    const phone = await relayer(port, 'phone')
    phone.ws.send(
      JSON.stringify({
        type: 'steps',
        samples: [
          { uuid: 'sample-0001-ok', start: new Date(Date.now() - 3_600_000).toISOString(), end: new Date().toISOString(), count: 512 },
          { uuid: 'short', start: 'garbage', end: 12, count: -5 }, // junk, filtered
          { uuid: 'sample-0002-ok', start: new Date(Date.now() - 7_200_000).toISOString(), end: new Date(Date.now() - 3_600_000).toISOString(), count: 1024.6 },
        ],
      }),
    )
    await waitFor(() => has(phone.msgs, 'steps_ack'))
    const ack = parsed(phone.msgs).find((m) => m.type === 'steps_ack') as { received: number; added: number }
    expect(ack.received).toBe(2)
    expect(ack.added).toBe(2)
    expect(captured.length).toBe(2)
    expect((captured[1] as { count: number }).count).toBe(1025) // rounded
    phone.ws.close()
  })

  test('steps deletions are forwarded and acked (an all-deletes batch still acks)', async () => {
    let sawSamples = -1
    let sawDeleted: string[] = []
    const { listener, port } = makeArbListener({
      onSteps: (samples, deleted) => {
        sawSamples = samples.length
        sawDeleted = deleted
        return { added: 0, deleted: deleted.length }
      },
    })
    cleanup.push(() => listener.stop())
    const phone = await relayer(port, 'phone')
    // A pure-deletion batch: WHOOP removed a bad sample. The ack MUST still
    // fire so the phone can advance its HealthKit anchor.
    phone.ws.send(JSON.stringify({ type: 'steps', samples: [], deleted: ['gone-uuid-0001', 'x'] }))
    await waitFor(() => has(phone.msgs, 'steps_ack'))
    const ack = parsed(phone.msgs).find((m) => m.type === 'steps_ack') as { received: number; deleted: number }
    expect(ack.received).toBe(0)
    expect(ack.deleted).toBe(1) // 'x' too short, filtered
    expect(sawSamples).toBe(0)
    expect(sawDeleted).toEqual(['gone-uuid-0001'])
    phone.ws.close()
  })

  test('a malformed deleted field is a parse error, not a crash', async () => {
    const { listener, port } = makeArbListener({ onSteps: () => ({ added: 0, deleted: 0 }) })
    cleanup.push(() => listener.stop())
    const phone = await relayer(port, 'phone')
    phone.ws.send(JSON.stringify({ type: 'steps', samples: [], deleted: 'not-an-array' }))
    await waitFor(() => listener.status().parse_errors >= 1)
    expect(has(phone.msgs, 'steps_ack')).toBe(false)
    phone.ws.close()
  })

  test('a non-array steps payload is a parse error, not a crash', async () => {
    const { listener, port } = makeArbListener({ onSteps: () => ({ added: 0, deleted: 0 }) })
    cleanup.push(() => listener.stop())
    const phone = await relayer(port, 'phone')
    phone.ws.send(JSON.stringify({ type: 'steps', samples: 'nope' }))
    await waitFor(() => listener.status().parse_errors >= 1)
    expect(has(phone.msgs, 'steps_ack')).toBe(false)
    phone.ws.close()
  })

  test('intent fires the callback and acks with the surfaced flag', async () => {
    let got = ''
    const { listener, port } = makeArbListener({
      onIntent: (activity) => {
        got = activity
        return true
      },
    })
    cleanup.push(() => listener.stop())
    const phone = await relayer(port, 'phone')
    phone.ws.send(JSON.stringify({ type: 'intent', activity: '  deadlifts  ' }))
    await waitFor(() => has(phone.msgs, 'intent_ack'))
    const ack = parsed(phone.msgs).find((m) => m.type === 'intent_ack') as { activity: string; surfaced: boolean }
    expect(got).toBe('deadlifts')
    expect(ack.activity).toBe('deadlifts')
    expect(ack.surfaced).toBe(true)
    phone.ws.close()
  })

  test('GET /plan: auth required, 404 without a file, serves the file, 503 on malformed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'health-plan-'))
    const planPath = join(dir, 'plan.json')
    const { listener, port } = makeArbListener({ getPlanPath: () => planPath })
    cleanup.push(() => listener.stop())

    expect((await fetch(`http://127.0.0.1:${port}/plan`)).status).toBe(401)
    expect((await fetch(`http://127.0.0.1:${port}/plan?token=${TOKEN}`)).status).toBe(404)

    writeFileSync(planPath, JSON.stringify({ day: 'Day 4', lifts: [{ name: 'Deadlift', weight_kg: 140 }] }))
    const res = await fetch(`http://127.0.0.1:${port}/plan?token=${TOKEN}`)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { day: string }).day).toBe('Day 4')

    writeFileSync(planPath, '{broken json')
    expect((await fetch(`http://127.0.0.1:${port}/plan?token=${TOKEN}`)).status).toBe(503)
  })

  test('plan file change pushes plan_updated to connected relayers (atomic rename included)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'health-plan-'))
    const planPath = join(dir, 'plan.json')
    const { listener, port } = makeArbListener({ getPlanPath: () => planPath })
    cleanup.push(() => listener.stop())
    const phone = await relayer(port, 'phone')

    // Atomic write (tmp + rename), the way /gym will write it.
    writeFileSync(planPath + '.tmp', JSON.stringify({ day: 'Day 1' }))
    renameSync(planPath + '.tmp', planPath)
    await waitFor(() => has(phone.msgs, 'plan_updated'))
    phone.ws.close()
  })

  test('phone liveness is persisted for the cert-expiry watchdog', async () => {
    const seen: string[] = []
    const { listener, port } = makeArbListener({ onPhoneSeen: (at) => seen.push(at) })
    cleanup.push(() => listener.stop())
    const phone = await relayer(port, 'phone')
    expect(seen.length).toBe(1) // hello is an unthrottled write
    const mac = await relayer(port, 'mac')
    expect(seen.length).toBe(1) // mac hello never counts as the phone
    phone.ws.close()
    mac.ws.close()
  })
})

// ── Yield (band surrendered to an external receiver) ───────────────

describe('yield', () => {
  const YIELD_MS = 60_000 // comfortably beyond test duration; expiry tested separately

  test('yield disarms every connected leg, reports caps, persists, and shows in status', async () => {
    const persisted: Array<{ until: string | null; reason?: string }> = []
    const { listener, port } = makeArbListener({
      onYieldChange: (until, reason) => persisted.push({ until, reason }),
    })
    cleanup.push(() => listener.stop())
    const mac = await relayer(port, 'mac', undefined, { caps: ['release', 'disarm'] })
    const phone = await relayer(port, 'phone', 'wifi', { caps: ['release', 'battery'] })
    const res = listener.yieldBand(YIELD_MS)
    await waitFor(() => has(mac.msgs, 'disarm') && has(phone.msgs, 'disarm'))
    // The disarm carries the window end so the phone can persist it.
    const disarm = parsed(mac.msgs).find((m) => m.type === 'disarm') as { until?: number }
    expect(typeof disarm.until).toBe('number')
    expect(res.disarmed).toEqual(['mac'])
    expect(res.capless).toEqual(['phone']) // old build: told anyway, reported as non-compliant
    expect(persisted.length).toBe(1)
    expect(persisted[0].until).toBe(res.until)
    const y = listener.status().yield
    expect(y.active).toBe(true)
    expect(y.until).toBe(res.until)
    mac.ws.close()
    phone.ws.close()
  })

  test('hello during yield is answered with disarm, not ok/standdown', async () => {
    const { listener, port } = makeArbListener()
    cleanup.push(() => listener.stop())
    listener.yieldBand(YIELD_MS)
    const mac = await relayer(port, 'mac')
    const phone = await relayer(port, 'phone', 'wifi')
    expect(JSON.parse(mac.helloReply).type).toBe('disarm')
    expect(JSON.parse(phone.helloReply).type).toBe('disarm')
    mac.ws.close()
    phone.ws.close()
  })

  test('arbitration is fully silent while yielded (no standdown/resume/release/pause)', async () => {
    const { listener, port } = makeArbListener()
    cleanup.push(() => listener.stop())
    // A dual-eligible pair mid-stream: without yield this topology standdowns
    // the idle phone and (once cooldown passes) fires dual-up releases.
    const mac = await relayer(port, 'mac', undefined, { caps: ['release', 'disarm'] })
    const phone = await relayer(port, 'phone', 'wifi', DUAL_CAPS)
    listener.yieldBand(YIELD_MS)
    await waitFor(() => has(phone.msgs, 'disarm'))
    const t0 = Date.now() - 30_000
    // The mac keeps streaming (it "missed" the disarm): feeds freshness, which
    // would drive standdown pushes at the phone were arbitration alive.
    for (let i = 0; i < 3; i++) mac.ws.send(hrFrame(t0 + i * 1000, 80))
    await Bun.sleep(FAST.arbTickMs * 8)
    const arbTypes = ['standdown', 'resume', 'release', 'pause']
    expect(parsed(phone.msgs).filter((m) => arbTypes.includes(m.type))).toEqual([])
    expect(parsed(mac.msgs).filter((m) => arbTypes.includes(m.type))).toEqual([])
    mac.ws.close()
    phone.ws.close()
  })

  test('frames during yield NEVER reach LiveState (live.* stays dark), re-push throttled, breach once', async () => {
    const breaches: string[] = []
    const { listener, state, events, port } = makeArbListener({
      timing: { ...FAST, yieldRepushMs: 100 },
      onYieldBreach: (source) => breaches.push(source),
    })
    cleanup.push(() => listener.stop())
    const mac = await relayer(port, 'mac', undefined, { caps: ['release', 'disarm'] })
    listener.yieldBand(YIELD_MS)
    await waitFor(() => has(mac.msgs, 'disarm'))
    const before = parsed(mac.msgs).filter((m) => m.type === 'disarm').length
    const t0 = Date.now() - 60_000
    // A leg that missed the disarm keeps streaming across 3 throttle windows,
    // HOT (would open a session and emit live.* were the yield gate absent).
    for (let i = 0; i < 30; i++) {
      mac.ws.send(hrFrame(t0 + i * 1000, 150 + (i % 3)))
      if (i % 10 === 9) await Bun.sleep(120)
    }
    await Bun.sleep(150)
    const after = parsed(mac.msgs).filter((m) => m.type === 'disarm').length
    expect(after).toBeGreaterThan(before) // re-pushed
    expect(after - before).toBeLessThan(30) // but throttled, not per-frame
    expect(breaches).toEqual(['mac']) // exactly once per yield
    // The yield contract: live coaching is DARK. No sample may enter the live
    // math and no live.* event may emit while the band is surrendered.
    expect(state.snapshot(t0 + 30_000).samples_buffered).toBe(0)
    expect(events).toEqual([])
    // But the breach stays visible: status tells the truth about the holdout.
    expect(listener.status().yield.breach_source).toBe('mac')
    expect(listener.status().band_connected).toBe(true)
    mac.ws.close()
  })

  test('expiry reclaims: rearm pushed, state cleared, persistence told the reason', async () => {
    const persisted: Array<{ until: string | null; reason?: string }> = []
    const { listener, port } = makeArbListener({
      onYieldChange: (until, reason) => persisted.push({ until, reason }),
    })
    cleanup.push(() => listener.stop())
    const mac = await relayer(port, 'mac', undefined, { caps: ['release', 'disarm'] })
    listener.yieldBand(150) // expires almost immediately
    await waitFor(() => has(mac.msgs, 'disarm'))
    await waitFor(() => has(mac.msgs, 'rearm')) // the arb tick reclaims on expiry
    expect(listener.status().yield.active).toBe(false)
    expect(persisted.map((p) => p.reason)).toEqual([undefined, 'expired'])
    expect(persisted[1].until).toBeNull()
    mac.ws.close()
  })

  test('manual reclaim rearms; reclaiming with no yield active is a no-op', async () => {
    const persisted: Array<{ until: string | null; reason?: string }> = []
    const { listener, port } = makeArbListener({
      onYieldChange: (until, reason) => persisted.push({ until, reason }),
    })
    cleanup.push(() => listener.stop())
    const mac = await relayer(port, 'mac', undefined, { caps: ['release', 'disarm'] })
    listener.reclaim('manual') // nothing yielded: must not push or persist
    await Bun.sleep(50)
    expect(has(mac.msgs, 'rearm')).toBe(false)
    expect(persisted.length).toBe(0)
    listener.yieldBand(YIELD_MS)
    listener.reclaim('manual')
    await waitFor(() => has(mac.msgs, 'rearm'))
    expect(listener.status().yield.active).toBe(false)
    expect(persisted.map((p) => p.reason)).toEqual([undefined, 'manual'])
    mac.ws.close()
  })

  test('arbitration resumes after reclaim (standdown flows again)', async () => {
    const { listener, port } = makeArbListener()
    cleanup.push(() => listener.stop())
    const mac = await relayer(port, 'mac', undefined, { caps: ['release', 'disarm'] })
    const phone = await relayer(port, 'phone', 'wifi')
    listener.yieldBand(YIELD_MS)
    await waitFor(() => has(phone.msgs, 'disarm'))
    listener.reclaim('manual')
    await waitFor(() => has(phone.msgs, 'rearm'))
    // Mac streams again: the idle phone must get a standdown like normal.
    const t0 = Date.now() - 30_000
    const feed = setInterval(() => mac.ws.send(hrFrame(t0, 80)), 30)
    cleanup.push(() => clearInterval(feed))
    await waitFor(() => has(phone.msgs, 'standdown'))
    mac.ws.close()
    phone.ws.close()
  })

  test('restoreYield re-applies a persisted window without pushes; hellos then disarm', async () => {
    const persisted: Array<{ until: string | null }> = []
    const { listener, port } = makeArbListener({
      onYieldChange: (until) => persisted.push({ until }),
    })
    cleanup.push(() => listener.stop())
    listener.restoreYield(Date.now() + YIELD_MS)
    expect(persisted.length).toBe(0) // already persisted; no rewrite
    expect(listener.status().yield.active).toBe(true)
    const mac = await relayer(port, 'mac')
    expect(JSON.parse(mac.helloReply).type).toBe('disarm')
    mac.ws.close()
  })

  test('an expired restoreYield is ignored', async () => {
    const { listener, port } = makeArbListener()
    cleanup.push(() => listener.stop())
    listener.restoreYield(Date.now() - 1000)
    expect(listener.status().yield.active).toBe(false)
    const mac = await relayer(port, 'mac')
    expect(JSON.parse(mac.helloReply).type).toBe('ok')
    mac.ws.close()
  })

  test('a phone yield_request runs the same yield: disarms all legs, acks, clamps minutes', async () => {
    const persisted: Array<{ until: string | null }> = []
    const { listener, port } = makeArbListener({ onYieldChange: (until) => persisted.push({ until }) })
    cleanup.push(() => listener.stop())
    const mac = await relayer(port, 'mac', undefined, { caps: ['release', 'disarm'] })
    const phone = await relayer(port, 'phone', 'wifi', { caps: ['release', 'battery', 'disarm'] })
    phone.ws.send(JSON.stringify({ type: 'yield_request', minutes: 999999 }))
    await waitFor(() => has(phone.msgs, 'yield_ack'))
    await waitFor(() => has(mac.msgs, 'disarm') && has(phone.msgs, 'disarm'))
    const ack = parsed(phone.msgs).find((m) => m.type === 'yield_ack') as { until?: number }
    // Clamped to the 720-minute ceiling, not the requested 999999.
    expect(ack.until! - Date.now()).toBeLessThanOrEqual(720 * 60_000 + 5_000)
    expect(listener.status().yield.active).toBe(true)
    expect(persisted.length).toBe(1)
    phone.ws.send(JSON.stringify({ type: 'reclaim_request' }))
    await waitFor(() => has(phone.msgs, 'reclaim_ack'))
    await waitFor(() => has(mac.msgs, 'rearm'))
    expect(listener.status().yield.active).toBe(false)
    mac.ws.close()
    phone.ws.close()
  })

  test('indefinite yield (0 ms) never expires; a daily-cadence reminder nags instead', async () => {
    const reminders: string[] = []
    const persisted: Array<{ until: string | null; reason?: string }> = []
    const { listener, port } = makeArbListener({
      timing: { ...FAST, yieldReminderMs: 150 },
      onYieldReminder: (since) => reminders.push(since),
      onYieldChange: (until, reason) => persisted.push({ until, reason }),
    })
    cleanup.push(() => listener.stop())
    const mac = await relayer(port, 'mac', undefined, { caps: ['release', 'disarm'] })
    listener.yieldBand(0) // 0 = indefinite
    await waitFor(() => has(mac.msgs, 'disarm'))
    expect(listener.status().yield.indefinite).toBe(true)
    expect(listener.status().yield.until).toBeNull()
    // Far past any timed window at test scale: still yielded, never rearmed,
    // but the reminder fired (and keeps its cadence, not per-tick spam).
    await Bun.sleep(500)
    expect(listener.status().yield.active).toBe(true)
    expect(has(mac.msgs, 'rearm')).toBe(false)
    expect(persisted.filter((p) => p.reason === 'expired')).toEqual([])
    expect(reminders.length).toBeGreaterThanOrEqual(1)
    expect(reminders.length).toBeLessThanOrEqual(4)
    // Only the explicit reclaim ends it.
    listener.reclaim('manual')
    await waitFor(() => has(mac.msgs, 'rearm'))
    expect(listener.status().yield.active).toBe(false)
    mac.ws.close()
  })

  test('a phone yield_request with no minutes is indefinite (the app toggle contract)', async () => {
    const { listener, port } = makeArbListener()
    cleanup.push(() => listener.stop())
    const phone = await relayer(port, 'phone', 'wifi', { caps: ['release', 'battery', 'disarm'] })
    phone.ws.send(JSON.stringify({ type: 'yield_request' }))
    await waitFor(() => has(phone.msgs, 'yield_ack'))
    expect(listener.status().yield.indefinite).toBe(true)
    phone.ws.close()
  })

  test('an indefinite yield survives persistence round-trip as indefinite', async () => {
    let saved: string | null = null
    const a = makeArbListener({ onYieldChange: (until) => { saved = until } })
    cleanup.push(() => a.listener.stop())
    a.listener.yieldBand(0)
    expect(saved).not.toBeNull()
    // A "restarted daemon" restoring the persisted ISO must land back in
    // indefinite mode, not a finite far-future window.
    const b = makeArbListener()
    cleanup.push(() => b.listener.stop())
    b.listener.restoreYield(Date.parse(saved as unknown as string))
    expect(b.listener.status().yield.active).toBe(true)
    expect(b.listener.status().yield.indefinite).toBe(true)
  })
})

describe('yield parsing and session close', () => {
  test('parseYieldMinutes: 0 is INDEFINITE, never eaten by a falsy fallback', async () => {
    const { parseYieldMinutes } = await import('../src/live.js')
    expect(parseYieldMinutes(0, 240)).toBe(0) // THE xhigh-review bug, pinned
    expect(parseYieldMinutes(-5, 240)).toBe(0)
    expect(parseYieldMinutes(undefined, 240)).toBe(240)
    expect(parseYieldMinutes(null, 0)).toBe(0)
    expect(parseYieldMinutes('junk', 240)).toBe(240)
    expect(parseYieldMinutes(999999, 240)).toBe(720)
    expect(parseYieldMinutes(2, 240)).toBe(5)
  })

  test('a session open at yield time closes immediately with the yield reason, not feed_drop later', async () => {
    const { listener, state, events, port } = makeArbListener()
    cleanup.push(() => listener.stop())
    const mac = await relayer(port, 'mac', undefined, { caps: ['release', 'disarm'] })
    // Drive a hot session (mirrors the e2e synthetic workout ramp).
    const t0 = Date.now() - 30 * 60_000
    let t = t0
    for (let i = 0; i < 120; i++) mac.ws.send(hrFrame((t += 1000), 80 + i))
    for (let i = 0; i < 300; i++) mac.ws.send(hrFrame((t += 1000), 165))
    await waitFor(() => state.sessionActive())
    listener.yieldBand(60_000, t + 1000)
    expect(state.sessionActive()).toBe(false) // closed NOW, not 12 min later
    const rest = events.find((e) => e.cls === 'live.rest')
    expect(rest).toBeDefined()
    mac.ws.close()
  })
})
