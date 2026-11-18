import { localDate } from '../src/signing.js'
import { describe, expect, test, afterEach, beforeAll, afterAll } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { connect as netConnect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LIFT_IDLE_TIMEOUT_S, LiveListener, boundedBody } from '../src/live.js'
import { LiveState } from '../src/livestate.js'
import {
  LiftVideoService,
  appVariant,
  isTailnetIPv4,
  parseLiftMeta,
  routeOf,
  transferText,
  parseTailnetIPv4,
  resolveLiftRoot,
  resolveLiftVideoConfig,
  tailnetPlan,
  targetName,
} from '../src/liftvideo.js'
import { DEFAULT_CONFIG } from '../src/types.js'
import { BadRequest } from '../src/http.js'

// Synthetic data only: random bytes stand in for clips, temp dirs for the
// lift root. Nothing here touches ~/Pictures.

const TOKEN = 'test-token-lift'
let savedTz: string | undefined
beforeAll(() => {
  savedTz = process.env.TZ
  process.env.TZ = 'Asia/Jakarta'
})
afterAll(() => {
  if (savedTz === undefined) delete process.env.TZ
  else process.env.TZ = savedTz
})

interface Ev {
  key: string
  content: string
  meta: Record<string, string>
}

let cleanup: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanup.reverse()) fn()
  cleanup = []
})

function setup(
  opts: {
    maxBytes?: number
    root?: string
    withFood?: boolean
    foodHttp?: (req: Request, url: URL) => Promise<Response | null>
    liftIdleTimeoutS?: number
  } = {},
) {
  const root = opts.root ?? mkdtempSync(join(tmpdir(), 'healthd-lift-test-'))
  if (!opts.root) cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const db = new Database(':memory:')
  const events: Ev[] = []
  const logs: string[] = []
  const svc = new LiftVideoService({
    db,
    log: (m) => logs.push(m),
    getRoot: () => root,
    emit: (key, payload) => {
      events.push({ key, ...payload })
      return true
    },
    maxBytes: opts.maxBytes,
  })
  const state = new LiveState({ getMaxHr: () => 190, getRestHr: () => 56, getHotBpm: () => null, emit: () => {} })
  const listener = new LiveListener(state, () => TOKEN, {
    liftVideoHttp: (req, url) => svc.handleHttp(req, url),
    ...(opts.withFood ? { foodHttp: async () => Response.json({ ok: true }) } : {}),
    ...(opts.foodHttp ? { foodHttp: opts.foodHttp } : {}),
    ...(opts.liftIdleTimeoutS ? { liftIdleTimeoutS: opts.liftIdleTimeoutS } : {}),
  })
  listener.start(0, '127.0.0.1')
  cleanup.push(() => listener.stop())
  // @ts-expect-error private server, for the ephemeral port
  const port = listener.server.port as number
  return { root, db, events, svc, listener, port, logs }
}

const RECORDED = '2026-11-16T05:12:00+07:00' // local (Jakarta) date 2026-11-16

function meta(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    client_id: crypto.randomUUID(),
    original_name: 'IMG_8946.MOV',
    recorded_at: RECORDED,
    original_duration_s: 58.2,
    trim_start_s: 12.3,
    trim_end_s: 41.0,
    full_clip: false,
    fps: 60,
    width: 1920,
    height: 1080,
    codec: 'hevc',
    ...over,
  }
}

const enc = (m: unknown) => Buffer.from(JSON.stringify(m)).toString('base64url')

function clip(n: number, seed = 7): Uint8Array {
  const b = new Uint8Array(n)
  let x = seed
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff
    b[i] = x & 0xff
  }
  return b
}

async function post(
  port: number,
  body: BodyInit | null,
  m: unknown,
  o: { token?: string | null; path?: string; rawMeta?: string } = {},
): Promise<Response> {
  const token = o.token === undefined ? TOKEN : o.token
  const q = token == null ? '' : `?token=${token}`
  const headers: Record<string, string> = {}
  if (o.rawMeta !== undefined) headers['x-lift-meta'] = o.rawMeta
  else if (m !== undefined) headers['x-lift-meta'] = enc(m)
  return fetch(`http://127.0.0.1:${port}${o.path ?? '/lift-video'}${q}`, { method: 'POST', headers, body })
}

/** A slow streamed (chunked) body: `chunks` pieces, `delayMs` apart. */
function slowStream(data: Uint8Array, chunks: number, delayMs: number): ReadableStream<Uint8Array> {
  const size = Math.ceil(data.length / chunks)
  let i = 0
  return new ReadableStream({
    async pull(c) {
      if (i >= data.length) return c.close()
      await Bun.sleep(delayMs)
      c.enqueue(data.subarray(i, i + size))
      i += size
    },
  })
}

/** Raw HTTP so a Content-Length can be declared without sending the bytes. */
function rawStatus(port: number, path: string, contentLength: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const sock = netConnect(port, '127.0.0.1', () => {
      sock.write(`POST ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: ${contentLength}\r\n\r\n`)
    })
    sock.once('data', (d) => {
      sock.destroy()
      resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(d.toString())?.[1] ?? 0))
    })
    sock.once('error', reject)
  })
}

/** Sends `head`, then stalls until the request is cancelled (a dead socket
 *  the server still holds open, e.g. after a Wi-Fi to cell handoff). */
function stallingStream(head: Uint8Array): ReadableStream<Uint8Array> {
  let sent = false
  return new ReadableStream({
    async pull(c) {
      if (!sent) {
        sent = true
        c.enqueue(head)
        return
      }
      await new Promise(() => {}) // never delivers another byte
    },
  })
}

const videoDir = (root: string, date = '2026-11-16') => join(root, date, 'Video')
const ls = (dir: string) => (existsSync(dir) ? readdirSync(dir).sort() : [])

describe('lift video upload', () => {
  test('streams a full clip to disk under its camera name, no partial left', async () => {
    const { root, port, events } = setup()
    const data = clip(300_000)
    const res = await post(port, data, meta({ full_clip: true }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    const path = join(videoDir(root), 'IMG_8946.MOV')
    expect(body).toEqual({ path, bytes: 300_000, duplicate: false, dedupe: null })
    expect(new Uint8Array(readFileSync(path))).toEqual(data)
    expect(ls(videoDir(root))).toEqual(['IMG_8946.MOV'])
    expect(events.length).toBe(1)
    expect(events[0].content).toContain('full clip, 58.2 s')
  })

  test('review finding: a full clip carries no syncthing_original (it IS the clip); a trimmed one does', async () => {
    const { root, port, events } = setup()
    expect((await post(port, clip(2000), meta({ full_clip: true }))).status).toBe(200)
    expect(events[0].meta.syncthing_original).toBeUndefined()
    expect((await post(port, clip(1000, 3), meta({ client_id: '7d1c0b4e-2f6a-4c1e-9a3b-1f2e3d4c5b6a', trim_start_s: 2, trim_end_s: 9 }))).status).toBe(200)
    expect(events[1].meta.syncthing_original).toBe(join(videoDir(root), 'IMG_8946.MOV'))
  })

  test('review finding: an unknown fps / size sent as 0 is accepted as absent, never refused', async () => {
    const { port, events } = setup()
    const res = await post(port, clip(1000), meta({ fps: 0, width: 0, height: 0 }))
    expect(res.status).toBe(200)
    expect(events[0].meta.fps).toBeUndefined()
    expect(events[0].meta.resolution).toBeUndefined()
  })

  test('uploads and probes are logged with the route, size, time and rate', async () => {
    const { port, logs } = setup()
    expect((await post(port, clip(400_000), meta({ full_clip: true }))).status).toBe(200)
    expect(logs.some((l) => /^receiving IMG_8946\.MOV via tailscale host \(400000 bytes\)$/.test(l))).toBe(true)
    expect(logs.some((l) => /IMG_8946\.MOV \(400000 bytes, 0\.4 MB in \d+\.\d s(, [\d.]+ MB\/s)?\)$/.test(l))).toBe(true)
    expect((await post(port, clip(200_000), undefined, { path: '/lift-video/probe' })).status).toBe(200)
    expect(logs.some((l) => /^probe via tailscale host: 0\.2 MB in \d+\.\d s/.test(l))).toBe(true)
  })

  test('routeOf names the tailnet listener by its 100.x address', () => {
    expect(routeOf(new Request('http://100.124.102.104:8791/lift-video'))).toBe('tailnet 100.124.102.104')
    expect(routeOf(new Request('http://127.0.0.1:8790/lift-video'))).toBe('tailscale host')
    expect(transferText(50_000_000, 26_800)).toBe('50.0 MB in 26.8 s, 1.87 MB/s')
  })

  test('a trimmed clip is named <stem>_trim_<start>-<end>s.<ext> with one decimal', async () => {
    const { root, port } = setup()
    const res = await post(port, clip(1000), meta({ trim_start_s: 12.34, trim_end_s: 41 }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { path: string }
    expect(body.path).toBe(join(videoDir(root), 'IMG_8946_trim_12.3-41.0s.MOV'))
    expect(ls(videoDir(root))).toEqual(['IMG_8946_trim_12.3-41.0s.MOV'])
  })

  test('a chunked (no Content-Length) body streams the same way', async () => {
    const { root, port } = setup()
    const data = clip(50_000, 3)
    const res = await post(port, slowStream(data, 5, 1), meta())
    expect(res.status).toBe(200)
    const { path, bytes } = (await res.json()) as { path: string; bytes: number }
    expect(bytes).toBe(50_000)
    expect(new Uint8Array(readFileSync(path))).toEqual(data)
    expect(ls(videoDir(root)).some((f) => f.startsWith('.partial-'))).toBe(false)
  })

  test('a bad original_name is 400 and nothing is written', async () => {
    const { root, port, events } = setup()
    for (const bad of ['../evil.MOV', '../../x/IMG_1.MOV', 'a/b.MOV', 'IMG_1.mkv', 'IMG_1.MOV.exe', '.MOV', 'IMG 1.MOV', 'IMG_1.Mov', '/abs/IMG_1.MOV', `${'a'.repeat(81)}.MOV`]) {
      const res = await post(port, clip(100), meta({ original_name: bad }))
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: string }).error).toContain('original_name')
    }
    expect(ls(root)).toEqual([])
    expect(events.length).toBe(0)
  })

  test('missing or garbled meta is 400', async () => {
    const { root, port } = setup()
    const cases: Array<{ rawMeta?: string; m?: unknown }> = [
      { m: undefined },
      { rawMeta: '!!!not base64!!!' },
      { rawMeta: Buffer.from('not json').toString('base64url') },
      { rawMeta: enc([1, 2, 3]) },
      { m: meta({ client_id: undefined }) },
      { m: meta({ client_id: 'short' }) },
      { m: meta({ recorded_at: 'yesterday' }) },
      { m: meta({ recorded_at: '2099-01-01T00:00:00Z' }) },
      { m: meta({ full_clip: 'yes' }) },
      { m: meta({ original_duration_s: -1 }) },
      { m: meta({ trim_start_s: undefined }) },
      { m: meta({ trim_start_s: 41, trim_end_s: 12 }) },
      { m: meta({ trim_end_s: 90 }) },
      { m: meta({ trim_start_s: 12.31, trim_end_s: 12.33 }) },
      { m: meta({ width: 1920.5 }) },
      { m: meta({ codec: '../x' }) },
    ]
    for (const c of cases) {
      const res = await post(port, clip(100), c.m, c.rawMeta !== undefined ? { rawMeta: c.rawMeta } : {})
      expect(res.status).toBe(400)
    }
    expect(ls(root)).toEqual([])
  })

  test('an empty body is 400', async () => {
    const { root, port, events } = setup()
    const res = await post(port, new Uint8Array(0), meta())
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain('empty')
    const chunked = await post(port, new ReadableStream({ start: (c) => c.close() }), meta())
    expect(chunked.status).toBe(400)
    expect(ls(videoDir(root)).filter((f) => !f.startsWith('.'))).toEqual([])
    expect(ls(videoDir(root)).some((f) => f.startsWith('.partial-'))).toBe(false)
    expect(events.length).toBe(0)
  })

  test('a retry returns the first result, writes nothing, raises no second event', async () => {
    const { root, port, events, db } = setup()
    const m = meta()
    const first = (await (await post(port, clip(5000), m)).json()) as Record<string, unknown>
    expect(first.duplicate).toBe(false)
    const retry = await post(port, clip(5000), m)
    expect(retry.status).toBe(200)
    expect(await retry.json()).toEqual({ path: first.path, bytes: 5000, duplicate: true, dedupe: 'retry' })
    expect(ls(videoDir(root))).toEqual(['IMG_8946_trim_12.3-41.0s.MOV'])
    expect(events.length).toBe(1)
    expect((db.query('SELECT COUNT(*) AS n FROM lift_videos').get() as { n: number }).n).toBe(1)
  })

  test('a retry landing mid-upload supersedes the older attempt and saves its own body', async () => {
    const { root, port, events } = setup()
    const m = meta()
    const data = clip(40_000, 11)
    const a = post(port, slowStream(data, 10, 25), m)
    await Bun.sleep(60) // A is mid-stream when B lands
    const b = post(port, data, m)
    const [ra, rb] = await Promise.all([a, b])
    expect(ra.status).toBe(400)
    expect(((await ra.json()) as { error: string }).error).toContain('superseded')
    const path = join(videoDir(root), 'IMG_8946_trim_12.3-41.0s.MOV')
    expect(await rb.json()).toEqual({ path, bytes: 40_000, duplicate: false, dedupe: null })
    expect(new Uint8Array(readFileSync(path))).toEqual(data)
    expect(ls(videoDir(root))).toEqual(['IMG_8946_trim_12.3-41.0s.MOV'])
    expect(events.length).toBe(1)
  })

  test('regression: a retry never inherits the failure of a stalled first attempt', async () => {
    // Before: B waited on A, A died, B got A's 400 and its complete body was
    // never read (clip lost if the phone treats 4xx as final).
    const { root, port, events } = setup()
    const m = meta()
    const data = clip(60_000, 5)
    const ac = new AbortController()
    cleanup.push(() => ac.abort())
    const a = fetch(`http://127.0.0.1:${port}/lift-video?token=${TOKEN}`, {
      method: 'POST',
      headers: { 'x-lift-meta': enc(m) },
      body: stallingStream(data.subarray(0, 10_000)),
      signal: ac.signal,
    }).catch(() => null)
    await Bun.sleep(100) // A holds a stalled socket mid-body
    const rb = await post(port, data, m)
    expect(rb.status).toBe(200)
    const path = join(videoDir(root), 'IMG_8946_trim_12.3-41.0s.MOV')
    expect(await rb.json()).toEqual({ path, bytes: 60_000, duplicate: false, dedupe: null })
    expect(new Uint8Array(readFileSync(path))).toEqual(data)
    expect(ls(videoDir(root))).toEqual(['IMG_8946_trim_12.3-41.0s.MOV'])
    expect(events.length).toBe(1)
    // A third attempt after the win is a plain retry.
    const rc = await post(port, data, m)
    expect(await rc.json()).toEqual({ path, bytes: 60_000, duplicate: true, dedupe: 'retry' })
    ac.abort()
    await a
    expect(events.length).toBe(1)
  })

  test('regression: lift requests get a long idle timeout (server.timeout is applied)', async () => {
    expect(LIFT_IDLE_TIMEOUT_S).toBeGreaterThanOrEqual(60)
    // Plumbing proof: a 1 s per-request timeout kills a 6 s gap that Bun's
    // 10 s default would have let through, so the route sets its own timeout.
    // (uSockets timers tick every ~4 s, hence the 6 s gap; verified by hand
    // that server.timeout(req, 30) carries a 13 s gap the default kills.)
    const { root, port, events } = setup({ liftIdleTimeoutS: 1 })
    const data = clip(20_000, 9)
    const gappy = new ReadableStream<Uint8Array>({
      async start(c) {
        c.enqueue(data.subarray(0, 10_000))
        await Bun.sleep(6000)
        c.enqueue(data.subarray(10_000))
        c.close()
      },
    })
    const res = await post(port, gappy, meta()).catch(() => null)
    expect(res == null || res.status !== 200).toBe(true)
    expect(ls(videoDir(root)).filter((f) => !f.startsWith('.partial-'))).toEqual([])
    expect(events.length).toBe(0)
  }, 15_000)

  test('Syncthing dedupe: same name + same size = his file kept, nothing rewritten', async () => {
    const { root, port, events } = setup()
    mkdirSync(videoDir(root), { recursive: true })
    const his = clip(8000, 1)
    const target = join(videoDir(root), 'IMG_8946.MOV')
    writeFileSync(target, his)
    const res = await post(port, clip(8000, 2), meta({ full_clip: true }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ path: target, bytes: 8000, duplicate: true, dedupe: 'syncthing' })
    expect(new Uint8Array(readFileSync(target))).toEqual(his)
    expect(ls(videoDir(root))).toEqual(['IMG_8946.MOV'])
    expect(events.length).toBe(1)
    expect(events[0].meta.dedupe).toBe('syncthing')
    expect(events[0].content).toContain('Syncthing had already delivered')
  })

  test('same name, different size: never overwrites, saves <stem>_app.<ext> (then _app2)', async () => {
    const { root, port, events } = setup()
    mkdirSync(videoDir(root), { recursive: true })
    const his = clip(8000, 1)
    const target = join(videoDir(root), 'IMG_8946.MOV')
    writeFileSync(target, his)
    const ours = clip(9000, 2)
    const res = await post(port, ours, meta({ full_clip: true }))
    expect(await res.json()).toEqual({ path: join(videoDir(root), 'IMG_8946_app.MOV'), bytes: 9000, duplicate: false, dedupe: null })
    expect(new Uint8Array(readFileSync(target))).toEqual(his)
    expect(new Uint8Array(readFileSync(join(videoDir(root), 'IMG_8946_app.MOV')))).toEqual(ours)
    const again = (await (await post(port, clip(9500, 3), meta({ full_clip: true }))).json()) as { path: string }
    expect(again.path).toBe(join(videoDir(root), 'IMG_8946_app2.MOV'))
    expect(ls(videoDir(root))).toEqual(['IMG_8946.MOV', 'IMG_8946_app.MOV', 'IMG_8946_app2.MOV'])
    expect(events[0].content).toContain('A different file named IMG_8946.MOV was already there')
  })

  test('the probe returns the byte count and writes nothing', async () => {
    const { root, port, events, db } = setup()
    const res = await post(port, clip(123_456), undefined, { path: '/lift-video/probe' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { bytes: number; ms: number }
    expect(body.bytes).toBe(123_456)
    expect(typeof body.ms).toBe('number')
    expect(ls(root)).toEqual([])
    expect(events.length).toBe(0)
    expect((db.query('SELECT COUNT(*) AS n FROM lift_videos').get() as { n: number }).n).toBe(0)
  })

  test('401 without (or with a wrong) token through the real listener routing', async () => {
    const { root, port } = setup()
    for (const path of ['/lift-video', '/lift-video/probe']) {
      expect((await post(port, clip(10), meta(), { token: null, path })).status).toBe(401)
      expect((await post(port, clip(10), meta(), { token: 'wrong', path })).status).toBe(401)
    }
    const bearer = await fetch(`http://127.0.0.1:${port}/lift-video/probe`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
      body: clip(10),
    })
    expect(bearer.status).toBe(200)
    expect(ls(root)).toEqual([])
  })

  test('413 on an oversize Content-Length, before any byte is read', async () => {
    const { port, root } = setup({ maxBytes: 1000 })
    // Past the 4 GiB listener cap: refused at the socket (Bun's own 413).
    expect(await rawStatus(port, `/lift-video?token=${TOKEN}`, 5_000_000_000)).toBe(413)
    // Past the service cap with a declared length.
    const res = await post(port, clip(2000), meta())
    expect(res.status).toBe(413)
    const probe = await post(port, clip(2000), undefined, { path: '/lift-video/probe' })
    expect(probe.status).toBe(413)
    expect(ls(root)).toEqual([])
  })

  test('413 mid-stream on a chunked body over the cap; the partial is removed', async () => {
    const { port, root, events } = setup({ maxBytes: 1000 })
    const m = meta()
    const res = await post(port, slowStream(clip(5000), 10, 1), m)
    expect(res.status).toBe(413)
    expect(ls(videoDir(root))).toEqual([])
    expect(events.length).toBe(0)
    // Nothing was recorded: the same client_id can upload for real later.
    const ok = await post(port, clip(500), m)
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as { duplicate: boolean }).duplicate).toBe(false)
  })

  test('the event fires once with every meta field', async () => {
    const { root, port, events } = setup()
    const m = meta({ fps: 59.94 })
    await post(port, clip(54_000_00), m)
    expect(events.length).toBe(1)
    const e = events[0]
    const path = join(videoDir(root), 'IMG_8946_trim_12.3-41.0s.MOV')
    expect(e.key).toBe(`lift.video:${m.client_id}`)
    expect(e.meta).toEqual({
      class: 'lift.video',
      path,
      client_id: String(m.client_id),
      original_name: 'IMG_8946.MOV',
      recorded_at: '2026-11-15T22:12:00.000Z',
      trim_start_s: '12.3',
      trim_end_s: '41.0',
      original_duration_s: '58.2',
      full_clip: 'false',
      fps: '59.94',
      resolution: '1920x1080',
      codec: 'hevc',
      bytes: '5400000',
      syncthing_original: join(videoDir(root), 'IMG_8946.MOV'),
    })
    expect(e.content).toBe(
      `Lift clip from the phone: ${path} (trimmed 12.3-41.0 s of 58.2 s, 1920x1080 59.94 fps HEVC, 5.4 MB). ` +
        `The untrimmed original is expected at ${join(videoDir(root), 'IMG_8946.MOV')} via Syncthing: skip it. Not auto-reviewed.`,
    )
  })

  test('the date folder is the LOCAL date of recorded_at', async () => {
    const { root, port } = setup()
    // 20:30 UTC on the 16th is 03:30 on the 17th in Jakarta (the test TZ).
    const res = await post(port, clip(100), meta({ recorded_at: '2026-11-16T20:30:00Z' }))
    const { path } = (await res.json()) as { path: string }
    expect(path).toBe(join(root, '2026-11-17', 'Video', 'IMG_8946_trim_12.3-41.0s.MOV'))
    expect(localDate(Date.parse('2026-11-16T16:59:59Z'))).toBe('2026-11-16')
    expect(localDate(Date.parse('2026-11-16T17:00:00Z'))).toBe('2026-11-17')
  })

  test('a root under Downloads is refused with 503 (never opened)', async () => {
    const { port, events } = setup({ root: join(process.env.HOME ?? '/Users/x', 'Downloads', 'lift-should-not-exist') })
    const res = await post(port, clip(100), meta())
    expect(res.status).toBe(503)
    expect(events.length).toBe(0)
  })

  test('non-clip routes keep the old 128 MiB body ceiling', async () => {
    const { port } = setup({ withFood: true })
    expect(await rawStatus(port, `/meal?token=${TOKEN}`, 200 * 1024 * 1024)).toBe(413)
  })

  test('regression: a chunked body on a non-clip route is capped at 128 MiB too', async () => {
    let calls = 0
    const { port } = setup({
      foodHttp: async (req) => {
        calls++
        return Response.json({ n: (await req.arrayBuffer()).byteLength })
      },
    })
    // Small chunked body: passes through intact.
    const small = await fetch(`http://127.0.0.1:${port}/meal?token=${TOKEN}`, { method: 'POST', body: slowStream(clip(3000), 3, 1) })
    expect(await small.json()).toEqual({ n: 3000 })
    // 129 MiB chunked (no Content-Length): 413, the handler never sees it.
    const mib = new Uint8Array(1024 * 1024)
    let left = 129
    const big = new ReadableStream<Uint8Array>({
      pull(c) {
        if (left-- <= 0) return c.close()
        c.enqueue(mib)
      },
    })
    const res = await fetch(`http://127.0.0.1:${port}/meal?token=${TOKEN}`, { method: 'POST', body: big }).catch(() => null)
    if (res) expect(res.status).toBe(413)
    expect(calls).toBe(1)
  }, 20_000)

  test('boundedBody: passes declared / body-less requests, caps chunked ones', async () => {
    const declared = new Request('http://x/meal', { method: 'POST', body: 'abc', headers: { 'content-length': '3' } })
    expect(await boundedBody(declared, 2)).toBe(declared)
    const get = new Request('http://x/meals')
    expect(await boundedBody(get, 2)).toBe(get)
    const chunked = () => new Request('http://x/meal', { method: 'POST', body: slowStream(clip(100), 4, 1) })
    const over = await boundedBody(chunked(), 50)
    expect(over instanceof Response && over.status).toBe(413)
    const ok = await boundedBody(chunked(), 100)
    expect(ok instanceof Request).toBe(true)
    expect(new Uint8Array(await (ok as Request).arrayBuffer())).toEqual(clip(100))
  })

  test('regression: a failed DB insert takes back the placed file, so the retry is clean', async () => {
    for (const full_clip of [false, true]) {
      const { root, port, events, db } = setup()
      db.run(`CREATE TRIGGER boom BEFORE INSERT ON lift_videos BEGIN SELECT RAISE(ABORT, 'disk full'); END`)
      const m = meta({ full_clip })
      const data = clip(4000, 21)
      const res = await post(port, data, m)
      expect(res.status).toBe(500)
      expect(ls(videoDir(root))).toEqual([])
      expect(events.length).toBe(0)
      db.run('DROP TRIGGER boom')
      const retry = await post(port, data, m)
      const name = full_clip ? 'IMG_8946.MOV' : 'IMG_8946_trim_12.3-41.0s.MOV'
      // Before: a full clip came back dedupe "syncthing" (its own leftover),
      // a trimmed one landed a second copy under _app.
      expect(await retry.json()).toEqual({ path: join(videoDir(root), name), bytes: 4000, duplicate: false, dedupe: null })
      expect(ls(videoDir(root))).toEqual([name])
      expect(events.length).toBe(1)
    }
  })

  test('regression: orphaned partials are swept, live and foreign files are not', async () => {
    const { root, port, svc } = setup()
    const dir = videoDir(root, '2026-11-14')
    mkdirSync(dir, { recursive: true })
    const orphan = `.partial-${crypto.randomUUID()}`
    writeFileSync(join(dir, orphan), clip(100))
    writeFileSync(join(dir, 'IMG_1.MOV'), clip(100)) // his clip
    writeFileSync(join(dir, '.partial-x'), clip(10)) // not a name we create
    mkdirSync(join(root, 'notes', 'Video'), { recursive: true })
    const stray = join(root, 'notes', 'Video', `.partial-${crypto.randomUUID()}`)
    writeFileSync(stray, clip(10)) // outside a date folder
    // An upload in flight right now: its partial must survive the sweep.
    const m = meta()
    const ac = new AbortController()
    cleanup.push(() => ac.abort())
    const live = fetch(`http://127.0.0.1:${port}/lift-video?token=${TOKEN}`, {
      method: 'POST',
      headers: { 'x-lift-meta': enc(m) },
      body: stallingStream(clip(5000)),
      signal: ac.signal,
    }).catch(() => null)
    await Bun.sleep(100)
    expect(ls(videoDir(root))).toEqual([`.partial-${m.client_id}`])
    expect(await svc.sweepPartials()).toBe(1)
    expect(ls(dir)).toEqual(['.partial-x', 'IMG_1.MOV'])
    expect(existsSync(stray)).toBe(true)
    expect(ls(videoDir(root))).toEqual([`.partial-${m.client_id}`])
    ac.abort()
    await live
  })

  test('sweepPartials on a missing or refused root does nothing', async () => {
    const missing = join(tmpdir(), `healthd-lift-missing-${crypto.randomUUID()}`)
    const { svc } = setup({ root: missing })
    expect(await svc.sweepPartials()).toBe(0)
    expect(existsSync(missing)).toBe(false)
  })
})

describe('lift video pure helpers', () => {
  test('parseLiftMeta normalises a full clip to the whole duration', () => {
    const m = parseLiftMeta(enc(meta({ full_clip: true, trim_start_s: 3, trim_end_s: 9, fps: undefined, width: undefined, height: undefined, codec: undefined })))
    expect(m.trim_start_s).toBe(0)
    expect(m.trim_end_s).toBe(58.2)
    expect(m.fps).toBeNull()
    expect(m.codec).toBeNull()
    expect(() => parseLiftMeta(null)).toThrow(BadRequest)
  })

  test('targetName and appVariant', () => {
    expect(targetName({ original_name: 'IMG_1.mp4', full_clip: true, trim_start_s: 0, trim_end_s: 1 })).toBe('IMG_1.mp4')
    expect(targetName({ original_name: 'IMG_1.mp4', full_clip: false, trim_start_s: 0, trim_end_s: 7.25 })).toBe('IMG_1_trim_0.0-7.3s.mp4')
    expect(appVariant('IMG_1.MOV', 1)).toBe('IMG_1_app.MOV')
    expect(appVariant('IMG_1_trim_0.0-7.3s.MOV', 3)).toBe('IMG_1_trim_0.0-7.3s_app3.MOV')
  })

  test('resolveLiftRoot: default, ~ expansion, refusals', () => {
    expect(resolveLiftRoot('', '/Users/u')).toEqual({ root: '/Users/u/Pictures/lift' })
    expect(resolveLiftRoot('~/Movies/lift', '/Users/u')).toEqual({ root: '/Users/u/Movies/lift' })
    expect('error' in resolveLiftRoot('Pictures/lift', '/Users/u')).toBe(true)
    for (const g of ['Desktop', 'Documents', 'Downloads']) {
      expect('error' in resolveLiftRoot(`/Users/u/${g}`, '/Users/u')).toBe(true)
      expect('error' in resolveLiftRoot(`/Users/u/${g}/lift`, '/Users/u')).toBe(true)
      expect('error' in resolveLiftRoot(`/Users/u/Pictures/../${g}/lift`, '/Users/u')).toBe(true)
    }
    expect(resolveLiftRoot('/Users/u/DocumentsArchive', '/Users/u')).toEqual({ root: '/Users/u/DocumentsArchive' })
  })

  test('regression: the TCC guard is case-insensitive (APFS is)', () => {
    for (const p of ['/Users/u/documents/lift', '/Users/u/DOWNLOADS', '/users/U/Desktop/x', '~/documents/lift']) {
      expect('error' in resolveLiftRoot(p, '/Users/u')).toBe(true)
    }
    expect(resolveLiftRoot('/Users/u/pictures/lift', '/Users/u')).toEqual({ root: '/Users/u/pictures/lift' })
  })

  test('regression: resolveLiftVideoConfig validates field by field', () => {
    const d = DEFAULT_CONFIG.lift_video
    expect(resolveLiftVideoConfig(undefined, d)).toEqual(d)
    expect(resolveLiftVideoConfig({ tailnet_listener: 'false', root: 5 }, d)).toEqual(d)
    expect(resolveLiftVideoConfig([1], d)).toEqual(d)
    // a stale tailnet_port from an older config is dropped (the port is fixed)
    expect(resolveLiftVideoConfig({ root: '~/Movies/lift', tailnet_listener: false, tailnet_port: 9000 }, d)).toEqual({
      root: '~/Movies/lift',
      tailnet_listener: false,
    })
  })

  test('regression: tailnetPlan rebinds on a changed tailnet IP', () => {
    expect(tailnetPlan(null, null)).toBe('wait')
    expect(tailnetPlan(null, '100.64.0.1')).toBe('start')
    expect(tailnetPlan('100.64.0.1', '100.64.0.1')).toBe('keep')
    expect(tailnetPlan('100.64.0.1', '100.100.7.7')).toBe('rebind')
    // A CLI hiccup never tears down a working bind.
    expect(tailnetPlan('100.64.0.1', null)).toBe('keep')
  })

  test('tailnet address detection', () => {
    expect(isTailnetIPv4('100.64.0.1')).toBe(true)
    expect(isTailnetIPv4('100.127.255.254')).toBe(true)
    for (const bad of ['100.63.255.255', '100.128.0.1', '0.0.0.0', '127.0.0.1', '192.168.1.5', '10.0.0.1', '100.64.0.256', 'fd7a::1', '']) {
      expect(isTailnetIPv4(bad)).toBe(false)
    }
    expect(parseTailnetIPv4('100.100.1.2\n')).toBe('100.100.1.2')
    expect(parseTailnetIPv4('192.168.0.2\n100.70.0.9\n')).toBe('100.70.0.9')
    expect(parseTailnetIPv4('no tailnet\n')).toBeNull()
  })
})

describe('tailnet listener', () => {
  test('refuses any non-tailnet bind address', () => {
    const { listener } = setup()
    for (const ip of ['0.0.0.0', '127.0.0.1', '192.168.1.2', '100.128.0.1', '::']) {
      expect(() => listener.startTailnet(0, ip)).toThrow(/not a tailnet/)
    }
    expect(listener.tailnetAddress()).toBeNull()
  })

  test('serves /healthz and the lift routes only, same token', async () => {
    const { listener, root } = setup()
    // @ts-expect-error private bind, exercised on loopback (no tailnet in tests)
    listener.serveTailnet(0, '127.0.0.1')
    const addr = listener.tailnetAddress()!
    expect(addr).toMatch(/^127\.0\.0\.1:\d+$/)
    const base = `http://${addr}`
    expect((await fetch(`${base}/healthz`)).status).toBe(200)
    for (const p of ['/stream', '/plan', '/meals', '/meal', '/body', '/money-notif', '/scale-adv', '/route']) {
      expect((await fetch(`${base}${p}?token=${TOKEN}`)).status).toBe(404)
    }
    expect((await fetch(`${base}/lift-video/probe`, { method: 'POST', body: clip(10) })).status).toBe(401)
    const probe = await fetch(`${base}/lift-video/probe?token=${TOKEN}`, { method: 'POST', body: clip(4096) })
    expect(((await probe.json()) as { bytes: number }).bytes).toBe(4096)
    const up = await fetch(`${base}/lift-video?token=${TOKEN}`, {
      method: 'POST',
      headers: { 'x-lift-meta': enc(meta({ full_clip: true })) },
      body: clip(2048),
    })
    expect(up.status).toBe(200)
    expect(ls(videoDir(root))).toEqual(['IMG_8946.MOV'])
    listener.stop()
    expect(listener.tailnetAddress()).toBeNull()
  })

  test('stopTailnet closes only the tailnet listener and allows a rebind', async () => {
    const { listener, port } = setup()
    // @ts-expect-error private bind, exercised on loopback (no tailnet in tests)
    listener.serveTailnet(0, '127.0.0.1')
    const first = listener.tailnetAddress()!
    listener.stopTailnet()
    expect(listener.tailnetAddress()).toBeNull()
    expect(await fetch(`http://${first}/healthz`).then(() => 'up', () => 'down')).toBe('down')
    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200)
    // @ts-expect-error private bind
    listener.serveTailnet(0, '127.0.0.1')
    expect((await fetch(`http://${listener.tailnetAddress()}/healthz`)).status).toBe(200)
  })
})
