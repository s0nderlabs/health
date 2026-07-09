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

  test('a full synthetic workout drives session events end to end', async () => {
    const { listener, events, port } = makeListener()
    cleanup.push(() => listener.stop())
    const ws = await connect(port)
    const t0 = Date.now() - 600_000 // frames span ~540s and must not land in the future
    let t = 0
    // 2 min warm (session threshold 116 with maxHr 190/rest 56)
    for (let i = 0; i < 120; i++) ws.send(hrFrame(t0 + t++ * 1000, 125))
    // 1 min hard in Z4
    for (let i = 0; i < 60; i++) ws.send(hrFrame(t0 + t++ * 1000, 160))
    // 6 min cooldown below 90
    for (let i = 0; i < 360; i++) ws.send(hrFrame(t0 + t++ * 1000, 80))
    await Bun.sleep(400)
    const classes = events.map((e) => e.cls)
    expect(classes).toContain('live.session')
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
): Promise<{ ws: WebSocket; msgs: string[]; helloReply: string }> {
  const ws = await connect(port)
  const msgs: string[] = []
  ws.onmessage = (e) => msgs.push(String(e.data))
  const hello: Record<string, unknown> = { type: 'hello', source, device: `${source}-test` }
  if (transport) hello.transport = transport
  ws.send(JSON.stringify(hello))
  await waitFor(() => msgs.length >= 1)
  return { ws, msgs, helloReply: msgs[0] }
}

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
