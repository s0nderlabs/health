// Live HR ingest: a WebSocket listener BLE relayers stream into. Relayers are
// dumb pipes; every frame carries the raw 0x2A37 bytes and interpretation
// happens here (hrparse) so the parser exists exactly once. Loopback-only
// today (Mac relayer); the phone relayer later binds this to the tailnet.
//
// Protocol (JSON per message, relayer -> daemon):
//   {type:'hello', source:'mac'|'phone', device?}   -> {type:'ok'} | {type:'standdown'}
//   {type:'hr', ts:<ISO|epoch-ms>, raw:<base64>}       (buffered frames replay with original ts)
//   {type:'status', connected:bool, device?, rssi?}

import type { LiveState } from './livestate.js'
import { parseBase64Frame } from './hrparse.js'

function log(msg: string): void {
  process.stderr.write(`healthd live: ${msg}\n`)
}

interface RelayerData {
  source: string
  device: string | null
}

export interface LiveFeedStatus {
  relayer_connected: boolean
  relayer_source: string | null
  band_connected: boolean
  band_device: string | null
  last_frame_at: string | null
  frames: number
  parse_errors: number
}

export class LiveListener {
  private server: ReturnType<typeof Bun.serve> | null = null
  private relayers = new Set<{ data: RelayerData }>()
  private bandConnected = false
  private bandDevice: string | null = null
  private lastFrameAt = 0
  private frames = 0
  private parseErrors = 0
  private lastParseErrorLog = 0

  constructor(
    private state: LiveState,
    private getToken: () => string,
  ) {}

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
        if (url.pathname !== '/stream') return new Response('not found', { status: 404 })
        const token =
          url.searchParams.get('token') ??
          req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ??
          ''
        const expected = self.getToken()
        if (!expected || token !== expected) {
          log('rejected stream connection (bad token)')
          return new Response('unauthorized', { status: 401 })
        }
        if (server.upgrade(req, { data: { source: 'unknown', device: null } })) {
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
          // The departing relayer may have been the one holding the band;
          // a survivor's next hr frame re-asserts connected within a second.
          self.bandConnected = false
          if (self.relayers.size === 0) self.bandDevice = null
          log(`relayer disconnected (${ws.data.source}, ${self.relayers.size} left)`)
        },
      },
    })
    log(`listening on ${bind}:${port}/stream`)
  }

  private onMessage(ws: { data: RelayerData; send: (s: string) => void }, text: string): void {
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
        this.bandConnected = true
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
      default:
        this.countParseError(`unknown message type ${String(msg.type)}`)
    }
  }

  private countParseError(what: string): void {
    this.parseErrors++
    if (Date.now() - this.lastParseErrorLog > 60_000) {
      this.lastParseErrorLog = Date.now()
      log(`dropped frame: ${what} (${this.parseErrors} total)`)
    }
  }

  status(): LiveFeedStatus {
    const relayer = this.relayers.values().next().value as { data: RelayerData } | undefined
    return {
      relayer_connected: this.relayers.size > 0,
      relayer_source: relayer?.data.source ?? null,
      band_connected: this.bandConnected,
      band_device: this.bandDevice,
      last_frame_at: this.lastFrameAt ? new Date(this.lastFrameAt).toISOString() : null,
      frames: this.frames,
      parse_errors: this.parseErrors,
    }
  }

  stop(): void {
    this.server?.stop(true)
  }
}
