// Live HR ingest: a WebSocket listener BLE relayers stream into. Relayers are
// dumb pipes; every frame carries the raw 0x2A37 bytes and interpretation
// happens here (hrparse) so the parser exists exactly once. The mac relayer
// connects over loopback; the phone relayer reaches the same port through a
// tailnet-only `tailscale serve` proxy (TLS terminates in tailscaled).
//
// Protocol (JSON per message):
//   relayer -> daemon:
//     {type:'hello', source:'mac'|'phone', device?, transport?, caps?:[...]}
//         -> {type:'ok'} | {type:'standdown'}
//     {type:'hr', ts:<ISO|epoch-ms>, raw:<base64>}      (buffered frames replay with original ts)
//     {type:'status', connected:bool, device?, rssi?, transport?}
//     {type:'transport', transport:'wifi'|'cellular'}   (network path changed)
//     {type:'battery', level:0..1, charging:bool}       (phone power state changed)
//     {type:'steps', samples:[{uuid,start,end,count}]}  -> {type:'steps_ack', received, added}
//     {type:'intent', activity}                         -> {type:'intent_ack', activity, surfaced}
//   daemon -> relayer (arbitration; the band normally serves ONE receiver, but
//   accepts a second central when two connects land inside its post-drop
//   advertising window; the daemon exploits that deliberately, see dual-up):
//     {type:'standdown'}          drop BLE, keep the socket, wait for resume
//     {type:'resume'}             start scanning again
//     {type:'pause', seconds:N}   drop BLE for N seconds so the mac can try a
//                                 blind reacquire; a standdown or resume follows
//     {type:'release'}            drop the band NOW but keep hunting it (caps
//                                 gated; the dual-up race: both receivers'
//                                 anchors fire into the advertising window)
//     {type:'plan_updated'}       the workout plan file changed; refetch GET /plan
//
// DUAL-UP (deterministic-through-retries dual connection): at home, at rest,
// phone on wifi + power-eligible, the daemon periodically forces the band
// free (release to whichever leg holds it) so BOTH pre-armed pending connects
// race into the advertising window. When both win, the band streams to both:
// mac is the single WRITER into LiveState, the phone is a hot standby whose
// frames are shadowed (they keep freshness, never feed the math), and a
// stale mac promotes the phone with zero gap. A lost leg is re-dualed at the
// next eligible window. Legacy pause-probes remain for clients without caps.

import { readFileSync, statSync, watch, type FSWatcher } from 'node:fs'
import { dirname } from 'node:path'
import type { LiveState } from './livestate.js'
import { parseBase64Frame } from './hrparse.js'

function log(msg: string): void {
  process.stderr.write(`healthd live: ${msg}\n`)
}

function parseTransport(v: unknown): 'wifi' | 'cellular' | 'unknown' {
  return v === 'wifi' || v === 'cellular' ? v : 'unknown'
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
  dualUpWindowMs: number // how long after a release we wait for both legs
  dualUpCooldownMs: number // min gap between dual-up attempts
  dualUpExhaustedMs: number // rest period after maxAttempts strikeout
  dualUpMaxAttempts: number // attempts per epoch before backing off long
  dualUpPeerRecentMs: number // the other leg must have seen band frames this recently before we release a holder
}

const DEFAULT_TIMING: ArbTiming = {
  macFreshMs: 15_000,
  arbTickMs: 5_000,
  probeIntervalMs: 600_000,
  pauseMs: 25_000,
  planDebounceMs: 750,
  phoneSeenThrottleMs: 60_000,
  dualUpWindowMs: 15_000,
  dualUpCooldownMs: 180_000,
  dualUpExhaustedMs: 1_800_000,
  dualUpMaxAttempts: 4,
  dualUpPeerRecentMs: 600_000,
}

type RelayerMode = 'active' | 'standdown' | 'paused'
type Transport = 'wifi' | 'cellular' | 'unknown'

interface RelayerData {
  source: string
  device: string | null
  mode: RelayerMode
  transport: Transport
  caps: string[]
  battery: { level: number; charging: boolean } | null
}

interface RelayerWs {
  data: RelayerData
  send: (s: string) => void
}

export interface LiveFeedStatus {
  relayer_connected: boolean
  relayer_source: string | null
  relayers: Array<{
    source: string
    device: string | null
    mode: RelayerMode
    transport: Transport
    battery: { level: number; charging: boolean } | null
    band_seen_ago_s: number | null
  }>
  active_source: string | null
  dual: boolean
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
  // Long-memory sibling of frameArrival: when did each source LAST deliver a
  // band frame, surviving disconnects and status:false (which wipe
  // frameArrival for zero-gap failover). This is the only signal that can
  // answer "is the band plausibly near that leg" for the dual-up gate: gym
  // wifi passes dualEligible, but a mac that has not seen the band in half
  // an hour must never cost the sole holder its connection.
  private bandSeen = new Map<string, number>()
  private arbTimer: ReturnType<typeof setInterval> | null = null
  private probing: RelayerWs | null = null
  private probeStartedAt = 0
  private lastProbeAt = 0
  // Dual-up orchestration: one release-and-race cycle at a time.
  private dualWindowUntil = 0
  private dualAttempts = 0
  private lastDualAttemptAt = 0
  private dualExhaustedUntil = 0
  private wasDual = false
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
        if (
          server.upgrade(req, {
            data: {
              source: 'unknown',
              device: null,
              mode: 'active',
              transport: 'unknown',
              caps: [],
              battery: null,
            },
          })
        ) {
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
            const wasFresh = self.sourceFresh(ws.data.source)
            self.frameArrival.delete(ws.data.source)
            // Same walk-out grace as the status:false path: a vanished live
            // feed must not trigger a release at the surviving holder.
            if (wasFresh) self.lastDualAttemptAt = Date.now()
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

  // ── Arbitration (mac-priority; dual-up keeps both legs when possible) ──

  private sourceFresh(source: string, now = Date.now()): boolean {
    const at = this.frameArrival.get(source)
    return at != null && now - at <= this.timing.macFreshMs
  }

  /** The one source allowed to WRITE into LiveState. Mac while its feed is
   *  live (home priority, phone shadows as hot standby); otherwise the
   *  freshest phone. Stale mac -> the phone's very next frame promotes it,
   *  which is the zero-gap failover dual-up exists for. */
  private primarySource(now = Date.now()): string | null {
    if (this.sourceFresh('mac', now)) return 'mac'
    let best: string | null = null
    let bestAt = 0
    for (const [source, at] of this.frameArrival) {
      if (source === 'mac') continue
      if (now - at <= this.timing.macFreshMs && at > bestAt) {
        best = source
        bestAt = at
      }
    }
    return best
  }

  /** Dual = mac and at least one phone feed fresh simultaneously. */
  private isDual(now = Date.now()): boolean {
    if (!this.sourceFresh('mac', now)) return false
    for (const [source, at] of this.frameArrival) {
      if (source !== 'mac' && now - at <= this.timing.macFreshMs) return true
    }
    return false
  }

  /** Power/transport gate for holding a standby connection: on wifi (home)
   *  and charging or comfortably charged. Battery report doubles as the
   *  capability signal: a client that reports power also handles 'release'. */
  private dualEligible(ws: RelayerWs): boolean {
    if (ws.data.transport !== 'wifi') return false
    if (!ws.data.caps.includes('release')) return false
    const b = ws.data.battery
    if (!b) return false
    return b.charging || b.level >= 0.4
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
   * - mac feed live -> idle/paused phones stand down; a phone that is ALSO
   *   fresh is the dual-hold standby and is left connected (its frames are
   *   shadowed by the single-writer ingest gate).
   * - mac feed dead -> paused phones resume when their window expires,
   *   standing-down phones resume immediately (their parked anchor usually
   *   already fired; the resume is the mode-level confirmation).
   * - DUAL-UP: at rest, phone on wifi + power-eligible, both legs present but
   *   only one holding -> release the holder so both pre-armed pending
   *   connects race into the band's post-drop advertising window. Retry with
   *   cooldowns until dual sticks; long backoff after a strikeout epoch.
   * - Legacy pause-probe: for wifi phones WITHOUT dual caps, the old blind
   *   mac-reacquire probe still runs. Never anything during a live session.
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

    this.dualUpTick(now, macFresh)
    this.legacyProbeTick(now, macFresh)
  }

  /** One release-and-race cycle at a time; see the protocol comment up top. */
  private dualUpTick(now: number, macFresh: boolean): void {
    const dual = this.isDual(now)
    if (dual) {
      if (!this.wasDual) {
        log('dual-up: both legs live (mac writes, phone shadows)')
        this.pushRole('standby')
      }
      this.wasDual = true
      this.dualAttempts = 0
      this.dualWindowUntil = 0
      // A standby draining on battery is released: a spare BLE connection is
      // a wall-power luxury. 0.35 vs the 0.4 entry bar = hysteresis, so a
      // phone hovering at the line doesn't flap. Battery-only on purpose:
      // transport flips mid-walk-out while dual is still nominally true, and
      // releasing then would drop the band on the street for nothing.
      for (const ws of this.relayers) {
        if (ws.data.source === 'mac' || ws.data.source === 'unknown') continue
        const b = ws.data.battery
        if (this.sourceFresh(ws.data.source, now) && b && !b.charging && b.level < 0.35) {
          this.push(ws, { type: 'release' })
          log(`dual-up: standby ${ws.data.source} battery low (${Math.round(b.level * 100)}%), released`)
          break
        }
      }
      return
    }
    if (this.wasDual) {
      log('dual-up: lost a leg (single holder again)')
      this.wasDual = false
      this.pushRole('primary')
      // Grace period before any re-dual attempt. Losing a leg is often the
      // START of a walk-out (mac BLE drops while home wifi still lingers);
      // releasing the surviving sole holder in that window would hole the
      // feed for nothing. By the time the cooldown elapses, a walk-out has
      // flipped transport to cellular (ineligible) and a home blip is
      // genuinely ready to re-dual.
      this.lastDualAttemptAt = now
    }

    // A window in flight: wait for it to close before judging the attempt.
    if (this.dualWindowUntil > 0) {
      if (now < this.dualWindowUntil) return
      this.dualWindowUntil = 0
      const holder = this.primarySource(now)
      log(`dual-up: window closed, single holder (${holder ?? 'none'}); attempt ${this.dualAttempts}/${this.timing.dualUpMaxAttempts}`)
      return
    }

    if (this.state.sessionActive() || this.probing) return
    if (now - this.lastDualAttemptAt < this.timing.dualUpCooldownMs) return
    // Sticky strikeout backoff: deliberately NOT cleared by hello/transport
    // churn (a wifi-edge flap or reconnect storm must never re-arm a 3-min
    // release cadence against the live holder). Natural races and app-opens
    // still form dual for free during the backoff.
    if (now < this.dualExhaustedUntil) return
    if (this.dualAttempts >= this.timing.dualUpMaxAttempts) this.dualAttempts = 0

    const mac = [...this.relayers].find((r) => r.data.source === 'mac')
    const phone = [...this.relayers].find(
      (r) => r.data.source !== 'mac' && r.data.source !== 'unknown' && this.dualEligible(r),
    )
    if (!mac || !phone) return

    // Reachability gate: a release only pays off if the OTHER leg can
    // actually reach the band, and transport is a lying proxy for that (gym
    // wifi reads exactly like home wifi). bandSeen is the ground truth:
    // unless the non-holding leg delivered band frames recently, releasing
    // the holder just punches a hole in the live feed and hands the band
    // back to the same leg seconds later. This is what let the daemon
    // release the sole phone holder mid-warmup at the gym, four times.
    const bandNear = (source: string) =>
      now - (this.bandSeen.get(source) ?? 0) <= this.timing.dualUpPeerRecentMs

    // Who holds the band decides who must let go; the other side's anchor is
    // standing (phone: pending connect always armed; mac: scanning loop).
    let released: string | null = null
    if (macFresh && !this.sourceFresh(phone.data.source, now)) {
      if (!mac.data.caps.includes('release')) return // old mac relayer build
      if (!bandNear(phone.data.source)) return // band demonstrably not with the phone
      this.push(mac, { type: 'release' })
      released = 'mac'
    } else if (!macFresh && this.sourceFresh(phone.data.source, now)) {
      if (!bandNear('mac')) return // not home: the mac has not seen the band lately
      this.push(phone, { type: 'release' })
      released = phone.data.source
    } else {
      return // nobody fresh: the band is off-wrist/away; nothing to race for
    }
    this.dualAttempts++
    this.lastDualAttemptAt = now
    this.dualWindowUntil = now + this.timing.dualUpWindowMs
    if (this.dualAttempts >= this.timing.dualUpMaxAttempts) {
      this.dualExhaustedUntil = now + this.timing.dualUpExhaustedMs
      log(`dual-up: attempts exhausted after this one, backing off ${Math.round(this.timing.dualUpExhaustedMs / 60000)}m`)
    }
    log(`dual-up: released ${released}, racing both anchors (attempt ${this.dualAttempts}/${this.timing.dualUpMaxAttempts})`)
  }

  /** Role display truth for the phone UI: standby = the mac holds the pen
   *  and the phone's stream is the shadowed hot spare. */
  private pushRole(role: 'standby' | 'primary'): void {
    for (const ws of this.relayers) {
      if (ws.data.source === 'mac' || ws.data.source === 'unknown') continue
      this.push(ws, { type: 'role', role })
    }
  }

  /** Legacy blind probe for wifi phones without dual caps. Kept verbatim
   *  from the pre-dual build; dual-capable phones never reach it. */
  private legacyProbeTick(now: number, macFresh: boolean): void {
    if (macFresh || this.probing || this.state.sessionActive()) return
    if (now - this.lastProbeAt < this.timing.probeIntervalMs) return
    const macConnected = [...this.relayers].some((r) => r.data.source === 'mac')
    if (!macConnected) return
    for (const ws of this.relayers) {
      if (ws.data.source === 'mac' || ws.data.source === 'unknown') continue
      if (ws.data.transport !== 'wifi') continue
      if (this.dualEligible(ws)) continue // dual-up owns this phone
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
        ws.data.transport = parseTransport(msg.transport)
        ws.data.caps = Array.isArray(msg.caps)
          ? msg.caps.filter((c): c is string => typeof c === 'string').slice(0, 16)
          : []
        // A relayer reconnect changes the topology: give dual-up a new epoch.
        this.dualAttempts = 0
        log(
          `hello from ${ws.data.source}${ws.data.device ? ` (${ws.data.device})` : ''}${ws.data.transport !== 'unknown' ? ` via ${ws.data.transport}` : ''}${ws.data.caps.length ? ` caps=[${ws.data.caps.join(',')}]` : ''}`,
        )
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
        this.bandSeen.set(ws.data.source, this.lastFrameAt)
        this.bandConnected = true
        // Single-writer gate: during a dual hold, only the primary source
        // feeds the live math (a second receiver's interleaved copies would
        // double the sample rate and poison RR/HRV). Freshness was stamped
        // above, so a returning mac promotes itself with this very frame,
        // and a stale mac hands the pen to the phone with zero gap.
        if (ws.data.source !== this.primarySource()) {
          if (ws.data.source !== 'mac' && ws.data.source !== 'unknown') this.phoneSeen()
          return
        }
        if (ws.data.source !== 'mac' && ws.data.source !== 'unknown') this.phoneSeen()
        this.state.addSample(ts, sample)
        break
      }
      case 'status': {
        this.bandConnected = Boolean(msg.connected)
        this.bandDevice = msg.device ? String(msg.device) : this.bandDevice
        if (msg.transport != null) ws.data.transport = parseTransport(msg.transport)
        // A relayer's own "I dropped the band" clears its freshness NOW
        // instead of letting it coast on macFreshMs. This is what makes
        // failover actually zero-gap (the standby's next frame takes the pen
        // immediately), keeps isDual/role truthful after a release, and
        // stops a just-released mac from shadowing the phone's real frames.
        // Unclean deaths (no status) still age out via macFreshMs/close.
        if (msg.connected === false) {
          const wasFresh = this.sourceFresh(ws.data.source)
          this.frameArrival.delete(ws.data.source)
          // A live feed vanishing may be the START of a walk-out; stamp the
          // dual-up grace HERE, not only on a tick-observed dual loss (a
          // short-lived dual can die between arb ticks and would otherwise
          // release the surviving sole holder into the exit).
          if (wasFresh) this.lastDualAttemptAt = Date.now()
        }
        log(
          `band ${this.bandConnected ? 'connected' : 'disconnected'}${this.bandDevice ? ` (${this.bandDevice})` : ''}`,
        )
        break
      }
      case 'transport': {
        ws.data.transport = parseTransport(msg.transport)
        this.dualAttempts = 0 // topology change: fresh dual-up epoch
        log(`${ws.data.source} transport: ${ws.data.transport}`)
        break
      }
      case 'battery': {
        const level = typeof msg.level === 'number' ? msg.level : Number.NaN
        if (Number.isFinite(level) && level >= 0 && level <= 1) {
          ws.data.battery = { level, charging: Boolean(msg.charging) }
        }
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
    // The writer, not merely the freshest: during a dual hold the freshest
    // source alternates frame-by-frame, but the pen stays with the primary.
    const active = this.primarySource(now)
    const first = this.relayers.values().next().value as RelayerWs | undefined
    return {
      relayer_connected: this.relayers.size > 0,
      relayer_source: active ?? first?.data.source ?? null,
      relayers: [...this.relayers].map((r) => ({
        source: r.data.source,
        device: r.data.device,
        mode: r.data.mode,
        transport: r.data.transport,
        battery: r.data.battery,
        // How long since this leg last delivered a band frame (long memory,
        // survives reconnects): the dual-up reachability gate made visible.
        band_seen_ago_s: this.bandSeen.has(r.data.source)
          ? Math.round((now - (this.bandSeen.get(r.data.source) as number)) / 1000)
          : null,
      })),
      active_source: active,
      dual: this.isDual(now),
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
