// Lift videos: clips go from the phone straight to the Mac for review.
//
// The phone trims a set out of a camera clip (or sends the whole clip) and
// uploads it with a background URLSession uploadTask(fromFile:), so the upload
// survives the app being suspended between sets. The daemon streams the body
// to disk (never buffered in memory), files it into the same tree his
// Syncthing already fills, and raises lift.video so the main session knows a
// clip landed. Nothing here reviews a clip: review belongs to the main
// session (one agent per clip).
//
//   POST /lift-video?token=        body = the clip bytes, header X-Lift-Meta =
//                                  base64url(JSON meta), see parseLiftMeta
//     -> 200 {path, bytes, duplicate, dedupe: null|'retry'|'syncthing'}
//     -> 400 {error} bad meta / name / empty body, 413 over the size cap
//   POST /lift-video/probe?token=  body streamed to nowhere -> 200 {bytes, ms}
//                                  (the phone's background-transport test)
//
// Storage: <root>/<YYYY-MM-DD local date of recorded_at>/Video/<file>, root
// defaulting to ~/Pictures/lift. A full clip keeps its camera name
// (IMG_8946.MOV); a trimmed one becomes IMG_8946_trim_12.3-41.0s.MOV. The
// name is strictly validated and never a client path. A file of that name
// that is already there is NEVER overwritten: a full clip of the same size is
// Syncthing's copy of the same clip (dedupe 'syncthing', nothing written);
// anything else lands under <stem>_app.<ext> (then _app2, ...).
//
// Idempotency: lift_videos keys every upload by its client_id. A retry (the
// background session re-sends after a lost response) returns the first
// result with duplicate:true, dedupe:'retry', writes nothing and raises no
// event. A retry that lands while an attempt of the same client_id is still
// in flight SUPERSEDES it: the phone only retries after a failure, so the
// older socket is almost certainly dead (a network handoff can leave it open
// for a while), and inheriting its failure would lose a clip whose new body
// is complete. The older attempt is aborted, its partial removed, and the
// new one ingests its own body (or, if the older one won the race and was
// already recorded, gets that result as a retry).
//
// Orphans: a daemon killed mid-upload leaves <dir>/.partial-<client_id>;
// sweepPartials() (run at daemon start) removes those.
//
// TCC: ~/Pictures was probed OK under launchd (no privacy prompt). The daemon
// must never open Desktop / Documents / Downloads (an unseen prompt hangs it),
// so a root configured under any of them is refused.

import type { Database } from 'bun:sqlite'
import { link, mkdir, open, readdir, rename, stat, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { BadRequest, requireClientId } from './http.js'
import type { HealthConfig } from './types.js'
import { localDate } from './signing.js'

/** Hard cap on one clip (also the listeners' Bun maxRequestBodySize). */
export const LIFT_VIDEO_MAX_BYTES = 4 * 1024 ** 3
export const LIFT_META_HEADER = 'x-lift-meta'
/** Default port of the tailnet-only plain-HTTP listener. */
/** The tailnet listener's port: fixed, the phone dials it as a constant
 *  (Settings.liftTailnetPort), so it is not configurable. */
export const TAILNET_PORT = 8791
const MAX_META_HEADER_CHARS = 4096
const NAME_RE = /^[A-Za-z0-9_-]{1,80}\.(MOV|mov|MP4|mp4)$/
const MAX_DURATION_S = 6 * 3600
const MAX_NAME_VARIANTS = 50
const PARTIAL_RE = /^\.partial-[A-Za-z0-9-]{8,64}$/
const DATE_DIR_RE = /^\d{4}-\d{2}-\d{2}$/

export const LIFT_VIDEO_SCHEMA = `
CREATE TABLE IF NOT EXISTS lift_videos (
  client_id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  dedupe TEXT,
  original_name TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  date TEXT NOT NULL,
  full_clip INTEGER NOT NULL,
  trim_start_s REAL NOT NULL,
  trim_end_s REAL NOT NULL,
  original_duration_s REAL NOT NULL,
  fps REAL,
  width INTEGER,
  height INTEGER,
  codec TEXT,
  syncthing_original TEXT NOT NULL,
  received_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lift_videos_date ON lift_videos (date);
`

export type LiftDedupe = null | 'retry' | 'syncthing'

export interface LiftUploadResult {
  path: string
  bytes: number
  duplicate: boolean
  dedupe: LiftDedupe
}

export interface LiftMeta {
  client_id: string
  original_name: string
  recorded_at: string // normalised ISO
  original_duration_s: number
  trim_start_s: number
  trim_end_s: number
  full_clip: boolean
  fps: number | null
  width: number | null
  height: number | null
  codec: string | null
}

// ── pure helpers (unit tested) ────────────────────────────────────

function finiteNum(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** One decimal, as in the file name and the event prose. */
export function oneDecimal(n: number): string {
  return (Math.round(n * 10) / 10).toFixed(1)
}

/**
 * Decode and validate the X-Lift-Meta header (base64url JSON). Every field the
 * contract names is checked; fps / width / height / codec are descriptive and
 * may be absent (null), but a present one of the wrong shape is refused.
 * A full clip's trim window is normalised to [0, duration].
 */
export function parseLiftMeta(header: string | null, now = Date.now()): LiftMeta {
  if (!header) throw new BadRequest('X-Lift-Meta header is required')
  if (header.length > MAX_META_HEADER_CHARS) throw new BadRequest('X-Lift-Meta is too long')
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(header.trim())) throw new BadRequest('X-Lift-Meta must be base64url JSON')
  let raw: unknown
  try {
    raw = JSON.parse(Buffer.from(header.trim(), 'base64url').toString('utf8'))
  } catch {
    throw new BadRequest('X-Lift-Meta must be base64url JSON')
  }
  if (typeof raw !== 'object' || raw == null || Array.isArray(raw)) throw new BadRequest('X-Lift-Meta must be a JSON object')
  const m = raw as Record<string, unknown>

  const client_id = requireClientId(m)
  const original_name = typeof m.original_name === 'string' ? m.original_name : ''
  if (!NAME_RE.test(original_name)) throw new BadRequest('original_name must be a bare camera file name (letters, digits, _ -, .MOV or .MP4)')

  const recordedMs = typeof m.recorded_at === 'string' ? Date.parse(m.recorded_at) : NaN
  if (!Number.isFinite(recordedMs)) throw new BadRequest('recorded_at must be an ISO 8601 timestamp')
  if (recordedMs > now + 86_400_000) throw new BadRequest('recorded_at is in the future')
  if (recordedMs < Date.UTC(2000, 0, 1)) throw new BadRequest('recorded_at is implausibly old')

  const duration = finiteNum(m.original_duration_s)
  if (duration == null || duration <= 0 || duration > MAX_DURATION_S) throw new BadRequest('original_duration_s must be a positive number of seconds')
  if (typeof m.full_clip !== 'boolean') throw new BadRequest('full_clip must be true or false')

  let start = 0
  let end = duration
  if (!m.full_clip) {
    const s = finiteNum(m.trim_start_s)
    const e = finiteNum(m.trim_end_s)
    if (s == null || e == null) throw new BadRequest('trim_start_s and trim_end_s are required for a trimmed clip')
    // 0.05 s slack: the phone's trim end can round a hair past the asset's
    // reported duration.
    if (s < 0 || e <= s || e > duration + 0.05) throw new BadRequest('trim window must satisfy 0 <= trim_start_s < trim_end_s <= original_duration_s')
    // The file name carries one decimal: a window that collapses there would
    // name a clip "_trim_12.3-12.3s".
    if (oneDecimal(s) === oneDecimal(e)) throw new BadRequest('trim window is shorter than 0.1 s')
    start = s
    end = Math.min(e, duration)
  }

  // 0 = unknown (AVFoundation reports 0 for an unknown frame rate or size):
  // treated as absent, never a reason to refuse the clip.
  const optNum = (key: string, max: number, int: boolean): number | null => {
    const v = m[key]
    if (v == null || v === 0) return null
    const n = finiteNum(v)
    if (n == null || n <= 0 || n > max || (int && !Number.isInteger(n))) throw new BadRequest(`${key} is malformed`)
    return n
  }
  const fps = optNum('fps', 1000, false)
  const width = optNum('width', 16384, true)
  const height = optNum('height', 16384, true)
  let codec: string | null = null
  if (m.codec != null) {
    if (typeof m.codec !== 'string' || !/^[A-Za-z0-9.]{2,16}$/.test(m.codec)) throw new BadRequest('codec is malformed')
    codec = m.codec.toLowerCase()
  }

  return {
    client_id,
    original_name,
    recorded_at: new Date(recordedMs).toISOString(),
    original_duration_s: duration,
    trim_start_s: start,
    trim_end_s: end,
    full_clip: m.full_clip,
    fps,
    width,
    height,
    codec,
  }
}


function splitName(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf('.')
  return { stem: name.slice(0, dot), ext: name.slice(dot + 1) }
}

/** The stored file name: the camera name for a full clip, else
 *  <stem>_trim_<start>-<end>s.<ext> with one decimal. */
export function targetName(meta: Pick<LiftMeta, 'original_name' | 'full_clip' | 'trim_start_s' | 'trim_end_s'>): string {
  if (meta.full_clip) return meta.original_name
  const { stem, ext } = splitName(meta.original_name)
  return `${stem}_trim_${oneDecimal(meta.trim_start_s)}-${oneDecimal(meta.trim_end_s)}s.${ext}`
}

/** The n-th (1-based) no-clobber variant: <stem>_app.<ext>, <stem>_app2.<ext>, ... */
export function appVariant(name: string, n: number): string {
  const { stem, ext } = splitName(name)
  return `${stem}_app${n > 1 ? n : ''}.${ext}`
}

export function defaultLiftRoot(): string {
  return join(homedir(), 'Pictures', 'lift')
}

/** The configured root ('' = ~/Pictures/lift, ~/ expanded), or why it is
 *  refused: relative, or inside a TCC-guarded folder the daemon must never
 *  open (Desktop / Documents / Downloads). */
export function resolveLiftRoot(configured: string | undefined, home = homedir()): { root: string } | { error: string } {
  let r = (configured ?? '').trim()
  if (!r) return { root: join(home, 'Pictures', 'lift') }
  if (r === '~' || r.startsWith('~/')) r = join(home, r.slice(1))
  if (!isAbsolute(r)) return { error: 'lift_video.root must be an absolute path' }
  const abs = resolve(r)
  // Case-insensitive: APFS is, so ~/documents/lift IS ~/Documents/lift.
  const absLc = abs.toLowerCase()
  for (const guarded of ['Desktop', 'Documents', 'Downloads']) {
    const g = join(home, guarded).toLowerCase()
    if (absLc === g || absLc.startsWith(g + sep)) return { error: `lift_video.root may not be under ~/${guarded} (macOS privacy prompt hangs the daemon)` }
  }
  return { root: abs }
}

/** The lift_video config block from disk, field by field: a malformed value
 *  (a hand-edited "false" string, a numeric root) falls back to its default
 *  instead of starting a listener or failing every upload. */
export function resolveLiftVideoConfig(raw: unknown, defaults: HealthConfig['lift_video']): HealthConfig['lift_video'] {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  return {
    root: typeof r.root === 'string' ? r.root : defaults.root,
    tailnet_listener: typeof r.tailnet_listener === 'boolean' ? r.tailnet_listener : defaults.tailnet_listener,
  }
}

/** What the periodic tailnet check does: start a listener on a newly found
 *  address, rebind when the Mac's tailnet IP changed (node re-auth, account
 *  switch), keep a good bind, or wait while no tailnet IP answers (a CLI
 *  hiccup must not tear down a working listener). */
export function tailnetPlan(bound: string | null, found: string | null): 'start' | 'rebind' | 'keep' | 'wait' {
  if (!found) return bound ? 'keep' : 'wait'
  if (!bound) return 'start'
  return bound === found ? 'keep' : 'rebind'
}

/** 100.64.0.0/10, the tailnet (CGNAT) range Tailscale assigns from. */
export function isTailnetIPv4(ip: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.trim())
  if (!m) return false
  const o = m.slice(1).map(Number)
  if (o.some((x) => x > 255)) return false
  return o[0] === 100 && o[1] >= 64 && o[1] <= 127
}

/** First tailnet IPv4 in `tailscale ip -4` output. */
export function parseTailnetIPv4(out: string): string | null {
  for (const line of out.split(/\s+/)) {
    if (isTailnetIPv4(line)) return line.trim()
  }
  return null
}

const TAILSCALE_CANDIDATES = [
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  '/opt/homebrew/bin/tailscale',
  '/usr/local/bin/tailscale',
]

/** The Mac's tailnet IPv4 via the tailscale CLI (app bundle first: launchd's
 *  PATH is minimal), or null when none answers with one. */
export async function discoverTailnetIPv4(timeoutMs = 5000): Promise<string | null> {
  const which = Bun.which('tailscale')
  const bins = [...TAILSCALE_CANDIDATES, ...(which ? [which] : [])].filter((b, i, a) => a.indexOf(b) === i && existsSync(b))
  for (const bin of bins) {
    try {
      const proc = Bun.spawn([bin, 'ip', '-4'], { stdout: 'pipe', stderr: 'ignore' })
      const timer = setTimeout(() => proc.kill(), timeoutMs)
      try {
        const out = await new Response(proc.stdout).text()
        if ((await proc.exited) === 0) {
          const ip = parseTailnetIPv4(out)
          if (ip) return ip
        }
      } finally {
        clearTimeout(timer)
      }
    } catch {
      // try the next candidate
    }
  }
  return null
}

// ── body streaming ────────────────────────────────────────────────

/** A 413: over the cap, by header or mid-stream. */
export class TooLarge extends Error {}

/** A 503: the lift root is misconfigured (uploads refused, nothing written). */
class Unavailable extends Error {}

/** The older attempt of a client_id, aborted by a newer one (its 400 goes to
 *  a socket the phone has almost certainly given up on). */
class Superseded extends BadRequest {}

/** Content-Length, refused up front: over the cap = 413, garbage = 400.
 *  null = absent (chunked). */
function declaredLength(req: Request, cap: number): number | null {
  const h = req.headers.get('content-length')
  if (h == null) return null
  if (!/^\d+$/.test(h.trim())) throw new BadRequest('bad Content-Length')
  const n = Number(h.trim())
  if (n > cap) throw new TooLarge(`clip over the ${Math.round(cap / 1024 ** 2)} MiB cap`)
  return n
}

/** Pump the body chunk by chunk (each awaited, so the socket is
 *  backpressured by the disk and nothing piles up in memory). An abort (a
 *  newer attempt superseding this one) ends the wait for the next chunk at
 *  once, even on a stalled socket that would never deliver one. */
async function pump(
  req: Request,
  cap: number,
  sink: ((chunk: Uint8Array) => Promise<unknown>) | null,
  signal?: AbortSignal,
): Promise<number> {
  if (!req.body) return 0
  const reader = req.body.getReader()
  let aborted: Promise<never> | null = null
  if (signal) {
    aborted = new Promise<never>((_, reject) => {
      if (signal.aborted) reject(signal.reason)
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
    aborted.catch(() => {}) // observed through the race below
  }
  let n = 0
  try {
    for (;;) {
      const { done, value } = await (aborted ? Promise.race([reader.read(), aborted]) : reader.read())
      if (done) break
      n += value.byteLength
      if (n > cap) throw new TooLarge(`clip over the ${Math.round(cap / 1024 ** 2)} MiB cap`)
      if (sink) await sink(value)
    }
  } catch (err) {
    await reader.cancel(err).catch(() => {})
    throw err
  }
  return n
}

// ── the service ───────────────────────────────────────────────────

export interface LiftVideoDeps {
  db: Database
  /** config lift_video.root ('' = ~/Pictures/lift). */
  getRoot: () => string
  /** Queue a lift.video channel event; returns whether it surfaced. */
  emit: (key: string, payload: { content: string; meta: Record<string, string> }) => boolean
  log?: (msg: string) => void
  /** Tests shrink the cap; production uses LIFT_VIDEO_MAX_BYTES. */
  maxBytes?: number
  now?: () => number
}

interface LiftRow {
  client_id: string
  path: string
  bytes: number
  dedupe: string | null
}

export class LiftVideoService {
  /** The live attempt per client_id: abort() supersedes it, settled resolves
   *  once it is fully done (its partial removed on failure). */
  private inflight = new Map<string, { abort: (reason: Error) => void; settled: Promise<void> }>()
  /** Partials being written right now (the sweep never touches these). */
  private activePartials = new Set<string>()
  private maxBytes: number
  private now: () => number
  private log: (msg: string) => void

  constructor(private deps: LiftVideoDeps) {
    LiftVideoService.ensureSchema(deps.db)
    this.maxBytes = deps.maxBytes ?? LIFT_VIDEO_MAX_BYTES
    this.now = deps.now ?? Date.now
    this.log = deps.log ?? (() => {})
  }

  static ensureSchema(db: Database): void {
    db.run(LIFT_VIDEO_SCHEMA)
  }

  /** The routes (mounted behind the listener's token check). Null = not ours. */
  async handleHttp(req: Request, url: URL): Promise<Response | null> {
    if (req.method !== 'POST') return null
    try {
      if (url.pathname === '/lift-video/probe') return Response.json(await this.probe(req))
      if (url.pathname === '/lift-video') return Response.json(await this.upload(req))
    } catch (err) {
      if (err instanceof TooLarge) return Response.json({ error: err.message }, { status: 413 })
      if (err instanceof BadRequest) return Response.json({ error: err.message }, { status: 400 })
      if (err instanceof Unavailable) return Response.json({ error: err.message }, { status: 503 })
      this.log(`${url.pathname} failed: ${err}`)
      return Response.json({ error: 'internal error' }, { status: 500 })
    }
    return null
  }

  /** POST /lift-video/probe: the body to nowhere, timed. */
  private async probe(req: Request): Promise<{ bytes: number; ms: number }> {
    const t0 = performance.now()
    declaredLength(req, this.maxBytes)
    const bytes = await pump(req, this.maxBytes, null)
    return { bytes, ms: Math.round(performance.now() - t0) }
  }

  /** POST /lift-video. Every check that needs no body bytes runs first. */
  private async upload(req: Request): Promise<LiftUploadResult> {
    const declared = declaredLength(req, this.maxBytes)
    if (declared === 0) throw new BadRequest('empty body')
    const meta = parseLiftMeta(req.headers.get(LIFT_META_HEADER), this.now())
    const rootRes = resolveLiftRoot(this.deps.getRoot())
    if ('error' in rootRes) {
      this.log(`refusing uploads: ${rootRes.error}`)
      throw new Unavailable(rootRes.error)
    }
    const id = meta.client_id
    // The newest attempt wins: abort any in-flight one and wait until it has
    // cleaned up. Re-checked after every wait (a third attempt may have
    // registered meanwhile; it then supersedes this one in turn).
    for (let cur = this.inflight.get(id); cur; cur = this.inflight.get(id)) {
      cur.abort(new Superseded('superseded by a newer upload of this clip'))
      await cur.settled
      // Its own finally normally deregisters it first; never spin on a
      // settled entry if microtask order ever puts us ahead of that.
      if (this.inflight.get(id) === cur) this.inflight.delete(id)
    }
    // From here to inflight.set nothing awaits: lookup + register are atomic.
    const prior = this.lookup(id)
    if (prior) {
      // A retry: the first upload's answer. Its own body is still on the wire
      // (a background upload sends the whole file regardless); drain it so
      // the client reads a clean response, never a reset mid-send.
      await pump(req, this.maxBytes, null).catch(() => 0)
      return prior
    }
    const ac = new AbortController()
    const job = this.ingest(meta, req, rootRes.root, declared, ac.signal)
    const entry = { abort: (reason: Error) => ac.abort(reason), settled: job.then(() => {}, () => {}) }
    this.inflight.set(id, entry)
    try {
      return await job
    } finally {
      if (this.inflight.get(id) === entry) this.inflight.delete(id)
    }
  }

  /**
   * Remove orphaned .partial-<client_id> files (a daemon killed mid-upload
   * never ran its cleanup) under <root>/<YYYY-MM-DD>/Video. Only names the
   * daemon itself creates, never one being written now. Returns the count.
   */
  async sweepPartials(): Promise<number> {
    const rootRes = resolveLiftRoot(this.deps.getRoot())
    if ('error' in rootRes || !existsSync(rootRes.root)) return 0
    let removed = 0
    const dates = await readdir(rootRes.root).catch(() => [] as string[])
    for (const d of dates) {
      if (!DATE_DIR_RE.test(d)) continue
      const dir = join(rootRes.root, d, 'Video')
      const names = await readdir(dir).catch(() => [] as string[])
      for (const name of names) {
        if (!PARTIAL_RE.test(name)) continue
        const p = join(dir, name)
        if (this.activePartials.has(p)) continue
        try {
          await unlink(p)
          removed++
        } catch {
          // gone already, or not ours to remove: leave it
        }
      }
    }
    if (removed) this.log(`removed ${removed} orphaned partial upload${removed === 1 ? '' : 's'}`)
    return removed
  }

  private lookup(clientId: string): LiftUploadResult | null {
    const row = this.deps.db
      .query('SELECT client_id, path, bytes, dedupe FROM lift_videos WHERE client_id = ?')
      .get(clientId) as LiftRow | null
    return row ? { path: row.path, bytes: row.bytes, duplicate: true, dedupe: 'retry' } : null
  }

  /** Stream to <dir>/.partial-<client_id>, then place it under its final
   *  name without ever clobbering a file, record it, raise the event. */
  private async ingest(
    meta: LiftMeta,
    req: Request,
    root: string,
    declared: number | null,
    signal: AbortSignal,
  ): Promise<LiftUploadResult> {
    const date = localDate(Date.parse(meta.recorded_at))
    const dir = join(root, date, 'Video')
    await mkdir(dir, { recursive: true })
    const partial = join(dir, `.partial-${meta.client_id}`)
    this.activePartials.add(partial)
    try {
      return await this.ingestInto(meta, req, dir, partial, date, declared, signal)
    } finally {
      this.activePartials.delete(partial)
    }
  }

  private async ingestInto(
    meta: LiftMeta,
    req: Request,
    dir: string,
    partial: string,
    date: string,
    declared: number | null,
    signal: AbortSignal,
  ): Promise<LiftUploadResult> {
    let bytes: number
    const fh = await open(partial, 'w', 0o644)
    let closed = false
    try {
      bytes = await pump(req, this.maxBytes, async (chunk) => {
        // write() may land short of the whole chunk: loop until it is all down.
        let off = 0
        while (off < chunk.byteLength) {
          const { bytesWritten } = await fh.write(chunk, off, chunk.byteLength - off)
          if (bytesWritten <= 0) throw new Error('disk write made no progress')
          off += bytesWritten
        }
      }, signal)
      if (bytes === 0) throw new BadRequest('empty body')
      if (declared != null && bytes !== declared) throw new BadRequest(`upload incomplete (${bytes} of ${declared} bytes)`)
      await fh.sync()
      // Inside the try: a failed close must still remove the partial.
      closed = true
      await fh.close()
    } catch (err) {
      if (!closed) await fh.close().catch(() => {})
      await unlink(partial).catch(() => {})
      // A client that hung up mid-send surfaces as a stream error: that is a
      // failed upload, not a daemon fault.
      if (err instanceof BadRequest || err instanceof TooLarge) throw err
      throw new BadRequest(`upload interrupted: ${(err as Error).message ?? err}`)
    }

    let placed: { path: string; dedupe: LiftDedupe; renamedFrom: string | null }
    try {
      placed = await this.place(partial, dir, meta, bytes)
    } finally {
      await unlink(partial).catch(() => {})
    }

    const syncthingOriginal = join(dir, meta.original_name)
    const receivedAt = new Date(this.now()).toISOString()
    try {
      this.deps.db.run(
        `INSERT INTO lift_videos (client_id, path, bytes, dedupe, original_name, recorded_at, date, full_clip,
           trim_start_s, trim_end_s, original_duration_s, fps, width, height, codec, syncthing_original, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          meta.client_id, placed.path, bytes, placed.dedupe, meta.original_name, meta.recorded_at, date,
          meta.full_clip ? 1 : 0, meta.trim_start_s, meta.trim_end_s, meta.original_duration_s,
          meta.fps, meta.width, meta.height, meta.codec, syncthingOriginal, receivedAt,
        ],
      )
    } catch (err) {
      // No row = the phone retries as a fresh upload. Take back the file this
      // attempt placed, or the retry would read it as Syncthing's copy (full
      // clip) or save a second _app copy (trimmed). Never Syncthing's own file.
      if (placed.dedupe == null) await unlink(placed.path).catch(() => {})
      throw err
    }
    try {
      this.deps.emit(`lift.video:${meta.client_id}`, liftVideoEvent(meta, placed, bytes, syncthingOriginal))
    } catch (err) {
      this.log(`lift.video emit failed: ${err}`)
    }
    this.log(
      `${placed.path} (${bytes} bytes${placed.dedupe ? `, dedupe ${placed.dedupe}` : ''}${placed.renamedFrom ? `, ${placed.renamedFrom} was taken` : ''})`,
    )
    return { path: placed.path, bytes, duplicate: placed.dedupe != null, dedupe: placed.dedupe }
  }

  /**
   * Final name, no clobber ever. link() is the atomic create-if-absent (a
   * rename would silently replace a file Syncthing dropped in a moment ago);
   * the partial is unlinked by the caller either way.
   */
  private async place(
    partial: string,
    dir: string,
    meta: LiftMeta,
    bytes: number,
  ): Promise<{ path: string; dedupe: LiftDedupe; renamedFrom: string | null }> {
    const base = targetName(meta)
    const sameSizeFile = async (p: string) => {
      const st = await stat(p).catch(() => null)
      return st != null && st.isFile() && st.size === bytes
    }
    for (let n = 0; n <= MAX_NAME_VARIANTS; n++) {
      const name = n === 0 ? base : appVariant(base, n)
      const target = join(dir, name)
      // Syncthing got the full clip here first: same name, same size = the
      // same clip. Keep his copy, write nothing.
      if (n === 0 && meta.full_clip && (await sameSizeFile(target))) {
        return { path: target, dedupe: 'syncthing', renamedFrom: null }
      }
      try {
        await link(partial, target)
        return { path: target, dedupe: null, renamedFrom: n === 0 ? null : base }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'EEXIST') {
          // Lost a race with Syncthing landing the same clip.
          if (n === 0 && meta.full_clip && (await sameSizeFile(target))) {
            return { path: target, dedupe: 'syncthing', renamedFrom: null }
          }
          continue
        }
        if (code === 'ENOTSUP' || code === 'EPERM' || code === 'EXDEV') {
          // A volume without hard links: check-then-rename (not atomic, but
          // still never over a file that is already there).
          if (existsSync(target)) continue
          await rename(partial, target)
          return { path: target, dedupe: null, renamedFrom: n === 0 ? null : base }
        }
        throw err
      }
    }
    throw new Error(`no free file name for ${base} in ${dir}`)
  }
}

function sizeText(bytes: number): string {
  const mb = bytes / 1e6
  if (mb >= 1000) return `${(mb / 1000).toFixed(2)} GB`
  if (mb >= 10) return `${Math.round(mb)} MB`
  return `${mb.toFixed(1)} MB`
}

function fpsText(fps: number): string {
  return String(Math.round(fps * 100) / 100)
}

/** The lift.video event: plain prose plus routing meta. */
export function liftVideoEvent(
  meta: LiftMeta,
  placed: { path: string; dedupe: LiftDedupe; renamedFrom: string | null },
  bytes: number,
  syncthingOriginal: string,
): { content: string; meta: Record<string, string> } {
  const span = meta.full_clip
    ? `full clip, ${oneDecimal(meta.original_duration_s)} s`
    : `trimmed ${oneDecimal(meta.trim_start_s)}-${oneDecimal(meta.trim_end_s)} s of ${oneDecimal(meta.original_duration_s)} s`
  const resolution = meta.width && meta.height ? `${meta.width}x${meta.height}` : null
  const spec = [resolution, meta.fps ? `${fpsText(meta.fps)} fps` : null, meta.codec ? meta.codec.toUpperCase() : null]
    .filter(Boolean)
    .join(' ')
  const notes: string[] = []
  if (placed.dedupe === 'syncthing') notes.push('Syncthing had already delivered this exact clip, so nothing was rewritten.')
  if (placed.renamedFrom) notes.push(`A different file named ${placed.renamedFrom} was already there, so this one was saved under its own name.`)
  if (!meta.full_clip) notes.push(`The untrimmed original is expected at ${syncthingOriginal} via Syncthing: skip it.`)
  const content =
    `Lift clip from the phone: ${placed.path} (${span}${spec ? `, ${spec}` : ''}, ${sizeText(bytes)}).` +
    (notes.length ? ` ${notes.join(' ')}` : '') +
    ' Not auto-reviewed.'
  return {
    content,
    meta: {
      class: 'lift.video',
      path: placed.path,
      client_id: meta.client_id,
      original_name: meta.original_name,
      recorded_at: meta.recorded_at,
      trim_start_s: oneDecimal(meta.trim_start_s),
      trim_end_s: oneDecimal(meta.trim_end_s),
      original_duration_s: oneDecimal(meta.original_duration_s),
      full_clip: String(meta.full_clip),
      ...(meta.fps ? { fps: fpsText(meta.fps) } : {}),
      ...(resolution ? { resolution } : {}),
      ...(meta.codec ? { codec: meta.codec } : {}),
      bytes: String(bytes),
      // Only a trimmed clip has an untrimmed original to skip: for a full clip
      // that path IS the clip that just landed.
      ...(meta.full_clip ? {} : { syncthing_original: syncthingOriginal }),
      ...(placed.dedupe ? { dedupe: placed.dedupe } : {}),
    },
  }
}
