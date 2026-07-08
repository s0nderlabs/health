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

// Session identity (for daemon logs): the c launcher exports ATTN_SESSION.
const sessionName = process.env.HEALTH_SESSION ?? process.env.ATTN_SESSION ?? 'main'

// Only CHANNEL-ENABLED sessions may receive events. An installed plugin's MCP
// server auto-loads in EVERY session, but Claude Code renders channel
// notifications only for sessions started with the health channel; a
// channel-less session would silently swallow (and ack) events. CC gives the
// server no protocol signal for this, so detect it from the parent claude
// process's argv. HEALTH_EVENTS=1/0 overrides for edge cases.
function sessionHasChannel(): boolean {
  if (process.env.HEALTH_EVENTS === '1') return true
  if (process.env.HEALTH_EVENTS === '0') return false
  try {
    const ps = Bun.spawnSync(['ps', '-p', String(process.ppid), '-o', 'command='])
    const cmd = ps.stdout.toString()
    // A session can run BOTH copies at once (installed plugin + local dev
    // server); each copy answers only to ITS OWN channel flag, so the copies
    // never both subscribe for the same session.
    if (process.env.CLAUDE_PLUGIN_ROOT) {
      // installed plugin copy: enabled via --channels or the dev plugin form
      return /--channels[= ]\S*plugin:health@|--dangerously-load-development-channels[= ]\S*plugin:health@/.test(cmd)
    }
    // local/project copy: enabled via the dev server form
    return /--dangerously-load-development-channels[= ]\S*server:health/.test(cmd)
  } catch {
    return true // cannot inspect: fail open, a dropped notification beats a lost event
  }
}
const wantEvents = sessionHasChannel()

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
  wantEvents,
)

const mcp = await connectMcp(ipc)
resolveMcp!(mcp)
log(`mcp connected (session: ${sessionName}, channel: ${wantEvents ? 'events on' : 'tools only'})`)

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
