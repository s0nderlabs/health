// Live HR ingest: a WebSocket listener BLE relayers stream into. Relayers are
// dumb pipes; every frame carries the raw 0x2A37 bytes and interpretation
// happens here (hrparse) so the parser exists exactly once. The mac relayer
// connects over loopback; the phone relayer reaches the same port through a
// tailnet-only `tailscale serve` proxy (TLS terminates in tailscaled).
//
// Protocol (JSON per message):
//   relayer -> daemon:
//     {type:'hello', source:'mac'|'phone', device?}  -> {type:'ok'} | {type:'standdown'}
//     {type:'hr', ts:<ISO|epoch-ms>, raw:<base64>}      (buffered frames replay with original ts)
//     {type:'status', connected:bool, device?, rssi?}
//     {type:'steps', samples:[{uuid,start,end,count}]}  -> {type:'steps_ack', received, added}
//     {type:'intent', activity}                         -> {type:'intent_ack', activity, surfaced}
//   daemon -> relayer (arbitration; the band broadcasts to ONE receiver, mac
//   has priority when its feed is live):
//     {type:'standdown'}          drop BLE, keep the socket, wait for resume
//     {type:'resume'}             start scanning again
//     {type:'pause', seconds:N}   drop BLE for N seconds so the mac can try a
//                                 blind reacquire; a standdown or resume follows
//     {type:'plan_updated'}       the workout plan file changed; refetch GET /plan

import { readFileSync, statSync, watch, type FSWatcher } from 'node:fs'
import { dirname } from 'node:path'
import type { LiveState } from './livestate.js'
import { parseBase64Frame } from './hrparse.js'

function log(msg: string): void {
  process.stderr.write(`healthd live: ${msg}\n`)
}

export interface StepsSample {
  uuid: string
  start: string
  end: string
  count: number
}

export interface LiveListenerOpts {
  /** Phone-side workout intent; returns whether the event surfaced. */
  onIntent?: (activity: string) => boolean
  /** Validated HealthKit steps: new/updated samples + UUIDs deleted upstream. */
  onSteps?: (samples: StepsSample[], deletedUuids: string[]) => { added: number; deleted: number }
  /** Path of the workout-plan JSON served at GET /plan (empty = disabled). */
  getPlanPath?: () => string
  /** Persist "a phone relayer was alive at <iso>" (cert-expiry watchdog). */
  onPhoneSeen?: (atIso: string) => void
  timing?: Partial<ArbTiming>
}

/** Arbitration timing; overridable so tests run in milliseconds. */
export interface ArbTiming {
  macFreshMs: number // mac feed counts as live this long after its last frame
  arbTickMs: number // arbitration cadence
  probeIntervalMs: number // min gap between pause probes
  pauseMs: number // probe window: how long the phone stays quiet
  planDebounceMs: number // collapse editor write bursts into one plan_updated
  phoneSeenThrottleMs: number // meta-write throttle while frames stream
}

const DEFAULT_TIMING: ArbTiming = {
  macFreshMs: 15_000,
  arbTickMs: 5_000,
  probeIntervalMs: 600_000,
  pauseMs: 25_000,
  planDebounceMs: 750,
  phoneSeenThrottleMs: 60_000,
}

type RelayerMode = 'active' | 'standdown' | 'paused'

interface RelayerData {
  source: string
  device: string | null
  mode: RelayerMode
}

interface RelayerWs {
  data: RelayerData
  send: (s: string) => void
}

export interface LiveFeedStatus {
  relayer_connected: boolean
  relayer_source: string | null
  relayers: Array<{ source: string; device: string | null; mode: RelayerMode }>
  active_source: string | null
  band_connected: boolean
  band_device: string | null
  last_frame_at: string | null
  frames: number
  parse_errors: number
}

export class LiveListener {
  private server: ReturnType<typeof Bun.serve> | null = null
  private relayers = new Set<RelayerWs>()
  private bandConnected = false
  private bandDevice: string | null = null
  private lastFrameAt = 0
  private frames = 0
  private parseErrors = 0
  private lastParseErrorLog = 0
  private timing: ArbTiming
  // Frame ARRIVAL times per source (wall clock, not frame ts: a buffer flush
  // replays old timestamps but proves the feed is alive right now).
  private frameArrival = new Map<string, number>()
  private arbTimer: ReturnType<typeof setInterval> | null = null
  private probing: RelayerWs | null = null
  private probeStartedAt = 0
  private lastProbeAt = 0
  private planWatcher: FSWatcher | null = null
  private planDebounce: ReturnType<typeof setTimeout> | null = null
  private lastPhoneSeenWrite = 0

  constructor(
    private state: LiveState,
    private getToken: () => string,
    private opts: LiveListenerOpts = {},
  ) {
    this.timing = { ...DEFAULT_TIMING, ...opts.timing }
  }

  start(port: number, bind: string): void {
    const self = this
    this.server = Bun.serve<RelayerData, never>({
      port,
      hostname: bind,
      fetch(req, server) {
        const url = new URL(req.url)
        if (req.method === 'GET' && url.pathname === '/healthz') {
          return new Response('ok', { status: 200 })
        }
        if (req.method === 'GET' && url.pathname === '/plan') {
          if (!self.authorized(req, url)) return new Response('unauthorized', { status: 401 })
          return self.servePlan()
        }
        if (url.pathname !== '/stream') return new Response('not found', { status: 404 })
        if (!self.authorized(req, url)) {
          log('rejected stream connection (bad token)')
          return new Response('unauthorized', { status: 401 })
        }
        if (server.upgrade(req, { data: { source: 'unknown', device: null, mode: 'active' } })) {
          return undefined as unknown as Response
        }
        return new Response('expected a websocket', { status: 426 })
      },
      websocket: {
        open(ws) {
          self.relayers.add(ws)
          log(`relayer connected (${self.relayers.size} total)`)
        },
        message(ws, msg) {
          // One bad frame (SQLite hiccup inside the emit path, state bug) must
          // degrade to a dropped frame, never escape into Bun's ws handler and
          // bounce the whole daemon mid-workout.
          try {
            self.onMessage(ws, typeof msg === 'string' ? msg : msg.toString())
          } catch (err) {
            self.countParseError(`frame handling threw: ${err}`)
          }
        },
        close(ws) {
          self.relayers.delete(ws)
          if (self.probing === ws) {
            self.probing = null // a probe target that vanished ends the probe
          }
          // Its feed is gone: drop its freshness so status() can't keep naming
          // a departed relayer as the active source. If a same-source relayer
          // is still streaming, its next frame re-stamps the arrival time.
          if (![...self.relayers].some((r) => r.data.source === ws.data.source)) {
            self.frameArrival.delete(ws.data.source)
          }
          // The departing relayer may have been the one holding the band;
          // a survivor's next hr frame re-asserts connected within a second.
          self.bandConnected = false
          if (self.relayers.size === 0) self.bandDevice = null
          if (ws.data.source !== 'mac' && ws.data.source !== 'unknown') self.phoneSeen(true)
          log(`relayer disconnected (${ws.data.source}, ${self.relayers.size} left)`)
        },
      },
    })
    this.arbTimer = setInterval(() => {
      try {
        this.arbitrate()
      } catch (err) {
        log(`arbitration failed: ${err}`)
      }
    }, this.timing.arbTickMs)
    this.startPlanWatch()
    log(`listening on ${bind}:${port}/stream`)
  }

  private authorized(req: Request, url: URL): boolean {
    const token =
      url.searchParams.get('token') ??
      req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ??
      ''
    const expected = this.getToken()
    return !!expected && token === expected
  }

  // ── Arbitration (mac-priority; the band broadcasts to one receiver) ──

  private sourceFresh(source: string, now = Date.now()): boolean {
    const at = this.frameArrival.get(source)
    return at != null && now - at <= this.timing.macFreshMs
  }

  private push(ws: RelayerWs, obj: Record<string, unknown>): void {
    try {
      ws.send(JSON.stringify(obj))
    } catch (err) {
      log(`push to ${ws.data.source} failed: ${err}`)
    }
  }

  /**
   * The state machine, run every arbTickMs:
   * - mac feed live -> every idle/paused phone stands down (a phone that is
   *   itself streaming is left alone; physically that means synthetic tests).
   * - mac feed dead -> paused phones resume when their window expires,
   *   standing-down phones resume immediately.
   * - phone is the active feed + a mac relayer is connected + the user is AT
   *   REST -> once per probeInterval, pause the phone briefly so the mac can
   *   blind-reacquire the band (it cannot see the band while the phone holds
   *   it). Never during a live session: no holes punched in workout data.
   */
  private arbitrate(now = Date.now()): void {
    const macFresh = this.sourceFresh('mac', now)
    for (const ws of this.relayers) {
      if (ws.data.source === 'mac' || ws.data.source === 'unknown') continue
      if (macFresh) {
        const idle = ws.data.mode === 'active' && !this.sourceFresh(ws.data.source, now)
        if (ws.data.mode === 'paused' || idle) {
          if (this.probing === ws) this.probing = null
          ws.data.mode = 'standdown'
          this.push(ws, { type: 'standdown' })
          log(`${ws.data.source} standing down (mac feed live)`)
        }
      } else if (ws.data.mode === 'paused') {
        if (now - this.probeStartedAt >= this.timing.pauseMs) {
          if (this.probing === ws) this.probing = null
          ws.data.mode = 'active'
          this.push(ws, { type: 'resume' })
          log(`probe over, mac did not take the band: ${ws.data.source} resumed`)
        }
      } else if (ws.data.mode === 'standdown') {
        ws.data.mode = 'active'
        this.push(ws, { type: 'resume' })
        log(`mac feed dropped: ${ws.data.source} resumed`)
      }
    }

    // Probe initiation: only when the phone owns the feed, a mac relayer is
    // around to take over, and a 25s gap costs nothing (resting HR).
    if (macFresh || this.probing || this.state.sessionActive()) return
    if (now - this.lastProbeAt < this.timing.probeIntervalMs) return
    const macConnected = [...this.relayers].some((r) => r.data.source === 'mac')
    if (!macConnected) return
    for (const ws of this.relayers) {
      if (ws.data.source === 'mac' || ws.data.source === 'unknown') continue
      if (ws.data.mode === 'active' && this.sourceFresh(ws.data.source, now)) {
        ws.data.mode = 'paused'
        this.probing = ws
        this.probeStartedAt = now
        this.lastProbeAt = now
        this.push(ws, { type: 'pause', seconds: this.timing.pauseMs / 1000 })
        log(`probing: paused ${ws.data.source} so the mac can try the band`)
        break
      }
    }
  }

  // ── Inbound messages ─────────────────────────────────────────────

  private onMessage(ws: RelayerWs, text: string): void {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(text) as Record<string, unknown>
    } catch {
      this.countParseError('bad json')
      return
    }
    switch (msg.type) {
      case 'hello': {
        ws.data.source = String(msg.source ?? 'unknown')
        ws.data.device = msg.device ? String(msg.device) : null
        log(`hello from ${ws.data.source}${ws.data.device ? ` (${ws.data.device})` : ''}`)
        if (ws.data.source !== 'mac' && ws.data.source !== 'unknown') {
          this.phoneSeen(true)
          if (this.sourceFresh('mac')) {
            ws.data.mode = 'standdown'
            ws.send(JSON.stringify({ type: 'standdown' }))
            log(`${ws.data.source} standing down at hello (mac feed live)`)
            break
          }
        }
        ws.data.mode = 'active'
        ws.send(JSON.stringify({ type: 'ok' }))
        break
      }
      case 'hr': {
        const ts = typeof msg.ts === 'number' ? msg.ts : Date.parse(String(msg.ts ?? ''))
        const sample = typeof msg.raw === 'string' ? parseBase64Frame(msg.raw) : null
        if (!Number.isFinite(ts) || !sample) {
          this.countParseError(`bad hr frame from ${ws.data.source}`)
          return
        }
        // Daemon clock is authoritative: one ahead-of-clock frame (phone
        // clock skew) would otherwise starve the monotonic-ts guard until
        // a daemon restart.
        if (ts > Date.now() + 60_000) {
          this.countParseError(`future-ts frame from ${ws.data.source}`)
          return
        }
        this.frames++
        this.lastFrameAt = Date.now()
        this.frameArrival.set(ws.data.source, this.lastFrameAt)
        this.bandConnected = true
        if (ws.data.source !== 'mac' && ws.data.source !== 'unknown') this.phoneSeen()
        this.state.addSample(ts, sample)
        break
      }
      case 'status': {
        this.bandConnected = Boolean(msg.connected)
        this.bandDevice = msg.device ? String(msg.device) : this.bandDevice
        log(
          `band ${this.bandConnected ? 'connected' : 'disconnected'}${this.bandDevice ? ` (${this.bandDevice})` : ''}`,
        )
        break
      }
      case 'steps': {
        const clean = this.validateSteps(msg.samples)
        const deleted = this.validateUuids(msg.deleted)
        if (clean == null || deleted == null) {
          this.countParseError(`bad steps payload from ${ws.data.source}`)
          return
        }
        let added = 0
        let removed = 0
        try {
          const res = this.opts.onSteps?.(clean, deleted)
          added = res?.added ?? 0
          removed = res?.deleted ?? 0
        } catch (err) {
          log(`steps persist failed: ${err}`)
        }
        if (ws.data.source !== 'mac' && ws.data.source !== 'unknown') this.phoneSeen()
        // The ack is what lets the phone advance its HealthKit anchor, so it
        // must be sent for every well-formed batch (even an all-deletes one).
        this.push(ws, { type: 'steps_ack', received: clean.length, added, deleted: removed })
        if (clean.length > 0 || deleted.length > 0)
          log(`steps: ${clean.length} samples (${added} new) + ${deleted.length} deletions (${removed} removed) from ${ws.data.source}`)
        break
      }
      case 'intent': {
        const activity = typeof msg.activity === 'string' ? msg.activity.trim().slice(0, 80) : ''
        if (!activity) {
          this.countParseError(`empty intent from ${ws.data.source}`)
          return
        }
        let surfaced = false
        try {
          surfaced = this.opts.onIntent?.(activity) ?? false
        } catch (err) {
          log(`intent failed: ${err}`)
        }
        log(`workout intent from ${ws.data.source}: ${activity} (surfaced=${surfaced})`)
        this.push(ws, { type: 'intent_ack', activity, surfaced })
        break
      }
      default:
        this.countParseError(`unknown message type ${String(msg.type)}`)
    }
  }

  /** Steps samples arrive from the phone; trust nothing about their shape. */
  private validateSteps(raw: unknown): StepsSample[] | null {
    if (!Array.isArray(raw) || raw.length > 5000) return null
    const clean: StepsSample[] = []
    for (const s of raw) {
      if (typeof s !== 'object' || s == null) continue
      const r = s as Record<string, unknown>
      const uuid = typeof r.uuid === 'string' && r.uuid.length >= 8 && r.uuid.length <= 64 ? r.uuid : null
      const start = typeof r.start === 'string' ? Date.parse(r.start) : NaN
      const end = typeof r.end === 'string' ? Date.parse(r.end) : NaN
      const count =
        typeof r.count === 'number' && Number.isFinite(r.count) && r.count >= 0 && r.count <= 100_000
          ? Math.round(r.count)
          : null
      if (!uuid || !Number.isFinite(start) || !Number.isFinite(end) || count == null) continue
      if (end < start || end > Date.now() + 86_400_000) continue // skew junk
      clean.push({
        uuid,
        start: new Date(start).toISOString(),
        end: new Date(end).toISOString(),
        count,
      })
    }
    return clean
  }

  /** Deleted-UUID list from the phone; absent = empty, malformed = reject. */
  private validateUuids(raw: unknown): string[] | null {
    if (raw == null) return []
    if (!Array.isArray(raw) || raw.length > 5000) return null
    const out: string[] = []
    for (const u of raw) {
      if (typeof u === 'string' && u.length >= 8 && u.length <= 64) out.push(u)
    }
    return out
  }

  private phoneSeen(force = false): void {
    const now = Date.now()
    if (!force && now - this.lastPhoneSeenWrite < this.timing.phoneSeenThrottleMs) return
    this.lastPhoneSeenWrite = now
    try {
      this.opts.onPhoneSeen?.(new Date(now).toISOString())
    } catch (err) {
      log(`phone-seen persist failed: ${err}`)
    }
  }

  // ── Plan delivery (the /gym session plan, authored by Claude) ────

  private servePlan(): Response {
    const path = this.opts.getPlanPath?.() ?? ''
    if (!path) return Response.json({ error: 'plan delivery disabled' }, { status: 404 })
    try {
      const text = readFileSync(path, 'utf8')
      JSON.parse(text) // refuse to serve a half-written or malformed file
      return new Response(text, { headers: { 'content-type': 'application/json' } })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return Response.json({ error: 'no plan yet' }, { status: 404 })
      }
      return Response.json({ error: 'plan file malformed' }, { status: 503 })
    }
  }

  private planMtime(path: string): number {
    try {
      return statSync(path).mtimeMs
    } catch {
      return 0
    }
  }

  private startPlanWatch(): void {
    const path = this.opts.getPlanPath?.() ?? ''
    if (!path) return
    // Watch the DIRECTORY: atomic writes (tmp + rename) replace the file's
    // inode, which silently kills a watcher pointed at the file itself, and
    // macOS reports the rename under the SOURCE name, so filename filtering
    // misses it. The dir is also the runtime dir (SQLite WAL churn), so every
    // event just triggers an mtime check on the plan file itself.
    let lastMtime = this.planMtime(path)
    try {
      this.planWatcher = watch(dirname(path), () => {
        if (this.planDebounce) clearTimeout(this.planDebounce)
        this.planDebounce = setTimeout(() => {
          this.planDebounce = null
          const mtime = this.planMtime(path)
          if (mtime === lastMtime) return
          lastMtime = mtime
          let pushed = 0
          for (const ws of this.relayers) {
            this.push(ws, { type: 'plan_updated' })
            pushed++
          }
          if (pushed > 0) log(`plan changed, notified ${pushed} relayer(s)`)
        }, this.timing.planDebounceMs)
      })
    } catch (err) {
      log(`plan watch unavailable (${err}); phones will still fetch on open`)
    }
  }

  // ── Bookkeeping ──────────────────────────────────────────────────

  private countParseError(what: string): void {
    this.parseErrors++
    if (Date.now() - this.lastParseErrorLog > 60_000) {
      this.lastParseErrorLog = Date.now()
      log(`dropped frame: ${what} (${this.parseErrors} total)`)
    }
  }

  status(): LiveFeedStatus {
    const now = Date.now()
    let active: string | null = null
    let activeAt = 0
    for (const [source, at] of this.frameArrival) {
      if (now - at <= this.timing.macFreshMs && at > activeAt) {
        active = source
        activeAt = at
      }
    }
    const first = this.relayers.values().next().value as RelayerWs | undefined
    return {
      relayer_connected: this.relayers.size > 0,
      relayer_source: active ?? first?.data.source ?? null,
      relayers: [...this.relayers].map((r) => ({
        source: r.data.source,
        device: r.data.device,
        mode: r.data.mode,
      })),
      active_source: active,
      band_connected: this.bandConnected,
      band_device: this.bandDevice,
      last_frame_at: this.lastFrameAt ? new Date(this.lastFrameAt).toISOString() : null,
      frames: this.frames,
      parse_errors: this.parseErrors,
    }
  }

  stop(): void {
    if (this.arbTimer) clearInterval(this.arbTimer)
    if (this.planDebounce) clearTimeout(this.planDebounce)
    this.planWatcher?.close()
    this.server?.stop(true)
  }
}
