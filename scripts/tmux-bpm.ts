// tmux status-line segment: live BPM off the health daemon, colored by zone.
// Wire it as e.g. `#(bun run /path/to/scripts/tmux-bpm.ts)` in status-right;
// tmux re-runs it on its status-interval. Prints NOTHING when there is no
// live feed (the segment simply disappears), so a dead daemon or a parked
// band never leaves junk in the bar. One-shot, ~50ms, exits hard on timeout.
import { connect } from 'net'
import { homedir } from 'os'

// oh-my-tmux-friendly inline colors; zone 0/1 stay quiet, effort warms up.
const ZONE_FG = ['#8a8a8a', '#8a8a8a', '#d7af5f', '#d78700', '#d75f5f', '#ff5f5f']

const sock = connect(`${homedir()}/.claude/channels/health/daemon.sock`)
let buf = ''
const send = (o: unknown) => sock.write(`${JSON.stringify(o)}\n`)
const bail = () => {
  process.exit(0) // empty segment, never an error string in the status bar
}

sock.on('connect', () => send({ t: 'hello', session: 'tmux-bpm', proto: 1, events: false }))
sock.on('data', (chunk) => {
  buf += chunk.toString()
  let i: number
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i)
    buf = buf.slice(i + 1)
    if (!line.trim()) continue
    let msg: { t?: string; id?: number; ok?: boolean; data?: Record<string, unknown> }
    try {
      msg = JSON.parse(line)
    } catch {
      bail()
      return
    }
    if (msg.t === 'hello_ok') send({ t: 'rpc', id: 1, method: 'live', params: {} })
    if (msg.t === 'result' && msg.id === 1) {
      const d = msg.ok ? (msg.data ?? {}) : {}
      const bpm = d.bpm as number | null
      if (d.feed !== 'live' || typeof bpm !== 'number') bail()
      const zone = typeof d.zone === 'number' ? d.zone : 0
      const fg = ZONE_FG[Math.min(Math.max(zone, 0), 5)]
      const src = d.active_source === 'mac' ? '' : '·'
      console.log(`#[fg=${fg}]♥ ${bpm}${src}#[default]`)
      process.exit(0)
    }
  }
})
sock.on('error', bail)
setTimeout(bail, 1500)
