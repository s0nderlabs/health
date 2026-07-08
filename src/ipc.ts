// Daemon <-> MCP-server IPC: newline-delimited JSON over a unix socket.
// The daemon is the server. Sessions say hello with their name; only the
// configured event_target session receives event pushes (main-only inbound),
// every session may use RPC (reads, config, status).

import type { Socket } from 'bun'
import { unlinkSync, existsSync } from 'fs'
import type { HealthEvent } from './types.js'

export interface HelloMsg { t: 'hello'; session: string; proto: number }
export interface HelloOkMsg { t: 'hello_ok'; events: boolean }
export interface EventMsg { t: 'event'; id: number; content: string; meta: Record<string, string> }
export interface AckMsg { t: 'ack'; id: number }
export interface RpcMsg { t: 'rpc'; id: number; method: string; params: Record<string, unknown> }
export interface ResultMsg { t: 'result'; id: number; ok: boolean; data?: unknown; error?: string }
export type IpcMsg = HelloMsg | HelloOkMsg | EventMsg | AckMsg | RpcMsg | ResultMsg

type RpcHandler = (method: string, params: Record<string, unknown>) => Promise<unknown>

function frame(msg: IpcMsg): string {
  return JSON.stringify(msg) + '\n'
}

// Bun's socket.write returns the number of bytes actually written, which can be
// LESS than the payload when the kernel buffer is full (backpressure). Large
// frames (a 365-day health__trend RPC result is multiple MB) would otherwise be
// silently truncated mid-frame. writeFrame queues the unwritten remainder per
// socket and flushWrites drains it on the 'drain' event, preserving order.
const pendingWrites = new WeakMap<Socket<unknown>, Buffer[]>()

function writeFrame(socket: Socket<unknown>, msg: IpcMsg): void {
  const buf = Buffer.from(frame(msg))
  const queued = pendingWrites.get(socket)
  if (queued && queued.length) {
    queued.push(buf) // already backed up: preserve order, wait for drain
    return
  }
  const written = socket.write(buf)
  if (written < buf.length) {
    pendingWrites.set(socket, [buf.subarray(written)])
  }
}

function flushWrites(socket: Socket<unknown>): void {
  const queue = pendingWrites.get(socket)
  if (!queue) return
  while (queue.length) {
    const buf = queue[0]
    const written = socket.write(buf)
    if (written < buf.length) {
      queue[0] = buf.subarray(written)
      return // still backed up; wait for the next drain
    }
    queue.shift()
  }
  pendingWrites.delete(socket)
}

/** Accumulates stream chunks, yields complete newline-terminated JSON messages. */
class LineBuffer {
  private buf = ''
  push(chunk: Buffer | string): IpcMsg[] {
    this.buf += chunk.toString()
    const out: IpcMsg[] = []
    let idx: number
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim()
      this.buf = this.buf.slice(idx + 1)
      if (!line) continue
      try {
        out.push(JSON.parse(line) as IpcMsg)
      } catch {
        // Skip malformed frames rather than killing the connection.
      }
    }
    return out
  }
}

interface Session {
  socket: Socket<unknown>
  name: string
  lines: LineBuffer
}

export class IpcServer {
  private sessions = new Map<Socket<unknown>, Session>()
  private listener: ReturnType<typeof Bun.listen> | null = null

  constructor(
    private socketPath: string,
    private opts: {
      eventTarget: () => string
      onRpc: RpcHandler
      onAck: (eventId: number) => void
      onSubscriberConnected: () => void
      onSubscriberDisconnected?: () => void
    },
  ) {}

  private dropSocket(socket: Socket<unknown>): void {
    const session = this.sessions.get(socket)
    const wasTarget = session?.name === this.opts.eventTarget()
    this.sessions.delete(socket)
    pendingWrites.delete(socket)
    if (wasTarget) this.opts.onSubscriberDisconnected?.()
  }

  start(): void {
    if (existsSync(this.socketPath)) unlinkSync(this.socketPath) // stale socket from a previous run
    const self = this
    this.listener = Bun.listen({
      unix: this.socketPath,
      socket: {
        open(socket) {
          self.sessions.set(socket, { socket, name: '', lines: new LineBuffer() })
        },
        data(socket, chunk) {
          const session = self.sessions.get(socket)
          if (!session) return
          for (const msg of session.lines.push(chunk)) self.handle(session, msg)
        },
        drain(socket) {
          flushWrites(socket)
        },
        close(socket) {
          self.dropSocket(socket)
        },
        error(socket) {
          self.dropSocket(socket)
        },
      },
    })
  }

  private handle(session: Session, msg: IpcMsg): void {
    if (msg.t === 'hello') {
      session.name = msg.session
      const isTarget = msg.session === this.opts.eventTarget()
      writeFrame(session.socket, { t: 'hello_ok', events: isTarget })
      if (isTarget) this.opts.onSubscriberConnected()
      return
    }
    if (msg.t === 'ack') {
      this.opts.onAck(msg.id)
      return
    }
    if (msg.t === 'rpc') {
      this.opts
        .onRpc(msg.method, msg.params)
        .then((data) => writeFrame(session.socket, { t: 'result', id: msg.id, ok: true, data }))
        .catch((err: unknown) =>
          writeFrame(session.socket, {
            t: 'result',
            id: msg.id,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }),
        )
    }
  }

  /** Push one event to the connected target session. False if it is not connected. */
  pushEvent(e: HealthEvent & { id: number }): boolean {
    const target = this.opts.eventTarget()
    for (const session of this.sessions.values()) {
      if (session.name === target) {
        writeFrame(session.socket, { t: 'event', id: e.id, content: e.content, meta: e.meta })
        return true
      }
    }
    return false
  }

  hasSubscriber(): boolean {
    const target = this.opts.eventTarget()
    return [...this.sessions.values()].some((s) => s.name === target)
  }

  stop(): void {
    this.listener?.stop(true)
    if (existsSync(this.socketPath)) unlinkSync(this.socketPath)
  }
}

// ── Client (MCP server side) ──────────────────────────────────────

export class IpcClient {
  private socket: Socket<unknown> | null = null
  private lines = new LineBuffer()
  private nextRpcId = 1
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private stopped = false

  constructor(
    private socketPath: string,
    private sessionName: string,
    private onEvent: (e: EventMsg) => Promise<void>,
    private log: (msg: string) => void = () => {},
  ) {}

  /** Connect with retry; resolves once connected (or keeps retrying forever in background). */
  async connectLoop(): Promise<void> {
    let delayMs = 500
    while (!this.stopped) {
      try {
        await this.connectOnce()
        return
      } catch {
        await Bun.sleep(delayMs)
        delayMs = Math.min(delayMs * 2, 15_000)
      }
    }
  }

  private connectOnce(): Promise<void> {
    const self = this
    return new Promise((resolve, reject) => {
      Bun.connect({
        unix: this.socketPath,
        socket: {
          open(socket) {
            self.socket = socket
            writeFrame(socket, { t: 'hello', session: self.sessionName, proto: 1 })
            self.log(`ipc connected as ${self.sessionName}`)
            resolve()
          },
          data(_socket, chunk) {
            for (const msg of self.lines.push(chunk)) self.handle(msg)
          },
          drain(socket) {
            flushWrites(socket)
          },
          close(socket) {
            self.socket = null
            pendingWrites.delete(socket)
            self.failPending('daemon connection closed')
            if (!self.stopped) {
              self.log('ipc disconnected, reconnecting')
              void self.connectLoop()
            }
          },
          error(_socket, err) {
            reject(err instanceof Error ? err : new Error(String(err)))
          },
          connectError(_socket, err) {
            reject(err instanceof Error ? err : new Error(String(err)))
          },
        },
      }).catch(reject)
    })
  }

  private handle(msg: IpcMsg): void {
    if (msg.t === 'event') {
      void this.onEvent(msg)
        .then(() => {
          if (this.socket) writeFrame(this.socket, { t: 'ack', id: msg.id })
        })
        .catch((err) => this.log(`event handler failed (no ack sent): ${err}`))
      return
    }
    if (msg.t === 'result') {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.ok) p.resolve(msg.data)
      else p.reject(new Error(msg.error ?? 'rpc failed'))
    }
  }

  private failPending(reason: string): void {
    for (const [, p] of this.pending) p.reject(new Error(reason))
    this.pending.clear()
  }

  get connected(): boolean {
    return this.socket != null
  }

  rpc<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<T> {
    if (!this.socket) return Promise.reject(new Error('daemon not connected'))
    const id = this.nextRpcId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      writeFrame(this.socket!, { t: 'rpc', id, method, params })
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`rpc ${method} timed out`))
      }, timeoutMs)
    })
  }

  stop(): void {
    this.stopped = true
    this.socket?.end()
  }
}
