import { describe, expect, test, afterEach } from 'bun:test'
import { LiveListener } from '../src/live.js'
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
