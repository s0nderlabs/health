#!/usr/bin/env bun
// MCP entry: one process per CC session. Connects stdio MCP first, then joins
// the daemon socket; events stream in and are forwarded as channel
// notifications. The daemon queues while no session is connected.

import { IpcClient } from './ipc.js'
import { connectMcp, notifyChannel } from './server.js'
import { SOCKET_PATH } from './config.js'

const log = (msg: string): void => {
  process.stderr.write(`health: ${msg}\n`)
}

process.on('unhandledRejection', (err) => log(`unhandled rejection: ${err}`))
process.on('uncaughtException', (err) => log(`uncaught exception: ${err}`))

// Session identity: the c launcher exports ATTN_SESSION; the daemon only
// pushes events to the session matching config event_target (default "main").
const sessionName = process.env.HEALTH_SESSION ?? process.env.ATTN_SESSION ?? 'main'

let mcpReady: Promise<import('@modelcontextprotocol/sdk/server/index.js').Server>
let resolveMcp: (s: import('@modelcontextprotocol/sdk/server/index.js').Server) => void
mcpReady = new Promise((r) => (resolveMcp = r))

const ipc = new IpcClient(
  SOCKET_PATH,
  sessionName,
  async (evt) => {
    const mcp = await mcpReady
    await notifyChannel(mcp, evt.content, evt.meta) // ack follows this resolving
  },
  log,
)

const mcp = await connectMcp(ipc)
resolveMcp!(mcp)
log(`mcp connected (session: ${sessionName})`)

// Give the harness a beat to finish channel setup before events can flow.
await Bun.sleep(1500)
void ipc.connectLoop()

// ── Shutdown (inb0x pattern: die with the session, never orphan) ──

process.stdin.resume()

let shuttingDown = false
function shutdown(reason: string): void {
  if (shuttingDown) return
  shuttingDown = true
  log(`shutting down (${reason})`)
  try { ipc.stop() } catch {}
  setTimeout(() => process.exit(0), 300)
}

process.stdin.on('end', () => shutdown('stdin end'))
process.stdin.on('close', () => shutdown('stdin close'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

const parentPid = process.ppid
if (parentPid && parentPid > 1) {
  setInterval(() => {
    try {
      process.kill(parentPid, 0)
    } catch {
      shutdown('parent died')
    }
  }, 5000)
}
