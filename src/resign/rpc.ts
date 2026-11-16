// One-shot daemon RPC for the re-sign runner: connect, hello (no events),
// one call, close. Deliberately NOT IpcClient: its reconnect loop would keep a
// headless run alive forever when the daemon is down. Everything is bounded
// by one timeout, and a failure is a value (never a throw), because "daemon
// unreachable" is a normal branch of the run (build only, no install).

import { Database } from 'bun:sqlite'
import { LineBuffer, type IpcMsg } from '../ipc.js'

export type RpcOutcome<T> = { ok: true; data: T } | { ok: false; error: string }

export async function oneShotRpc<T = unknown>(
  socketPath: string,
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 5_000,
): Promise<RpcOutcome<T>> {
  return new Promise<RpcOutcome<T>>((resolve) => {
    let settled = false
    let sock: { end: () => void } | null = null
    const lines = new LineBuffer()
    const finish = (r: RpcOutcome<T>) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        sock?.end()
      } catch {
        // already closed
      }
      resolve(r)
    }
    const timer = setTimeout(() => finish({ ok: false, error: `rpc ${method} timed out after ${timeoutMs}ms` }), timeoutMs)
    Bun.connect({
      unix: socketPath,
      socket: {
        open(socket) {
          sock = socket
          socket.write(JSON.stringify({ t: 'hello', session: 'resign', proto: 1, events: false }) + '\n')
          socket.write(JSON.stringify({ t: 'rpc', id: 1, method, params }) + '\n')
        },
        data(_socket, chunk) {
          for (const msg of lines.push(chunk) as IpcMsg[]) {
            if (msg.t !== 'result' || msg.id !== 1) continue
            finish(msg.ok ? { ok: true, data: msg.data as T } : { ok: false, error: msg.error ?? 'rpc failed' })
          }
        },
        close() {
          finish({ ok: false, error: 'daemon closed the connection' })
        },
        error(_socket, err) {
          finish({ ok: false, error: String(err) })
        },
        connectError(_socket, err) {
          finish({ ok: false, error: String(err) })
        },
      },
    }).catch((err) => finish({ ok: false, error: String(err) }))
  })
}

export interface DbClock {
  signed_until: string | null
  phone_app_version: string | null
  phone_hello_at: string | null
}

/** Daemon-down fallback (step 2): the phone's self-reported clock straight
 *  from health.db meta, read-only. Any error (missing db, WAL that needs a
 *  writer, schema drift) means the clock is unknown: null. */
export function readDbClock(dbPath: string): DbClock | null {
  try {
    const db = new Database(dbPath, { readonly: true })
    try {
      const get = (k: string): string | null => {
        const row = db.query('SELECT value FROM meta WHERE key = ?').get(k) as { value: string | null } | null
        return row?.value ? row.value : null
      }
      return {
        signed_until: get('phone_app_signed_until'),
        phone_app_version: get('phone_app_version'),
        phone_hello_at: get('phone_app_hello_at'),
      }
    } finally {
      db.close()
    }
  } catch {
    return null
  }
}
