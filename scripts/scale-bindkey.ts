#!/usr/bin/env bun
// One-time fetch of the Xiaomi S400 scale's BLE bindkey from the Xiaomi cloud.
//
//   bun scripts/scale-bindkey.ts [--server cn] [--config <path>] [--did <did>]
//
// QR-code login (no password): a QR opens in Preview, scan it with the Xiaomi
// Home app and confirm. The tool then lists the account's devices, picks the
// scale, stores its bindkey in the macOS Keychain (service dev.s400-bindkey,
// account = the scale's MAC) and writes a `scale` block {mac, did, model,
// keychain_service, keychain_account} into the health config.
//
// The Xiaomi session lives only in this process's memory and is never printed
// or written anywhere. The bindkey is never printed either.

import { mkdtempSync, rmSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'
import {
  runBindkeyFlow,
  describeDevice,
  isValidBindkey,
  SCALE_KEYCHAIN_SERVICE,
  XIAOMI_SERVERS,
  type CloudDevice,
} from '../src/scale-cloud.js'

function usage(code: number): never {
  console.log('usage: bun scripts/scale-bindkey.ts [--server cn] [--config <path>] [--did <did>]')
  process.exit(code)
}

const argv = process.argv.slice(2)
let server = 'cn'
let configPath = process.env.HEALTH_CONFIG_PATH ?? join(homedir(), '.config', 'health', 'config.json')
let did: string | undefined
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  const val = (): string => {
    const v = argv[++i]
    if (!v) usage(2)
    return v
  }
  if (a === '--server') server = val()
  else if (a === '--config') configPath = val()
  else if (a === '--did') did = val()
  else if (a === '-h' || a === '--help') usage(0)
  else usage(2)
}
if (!(XIAOMI_SERVERS as readonly string[]).includes(server)) {
  console.error(`unknown server "${server}" (one of: ${XIAOMI_SERVERS.join(', ')})`)
  process.exit(2)
}

/** Keychain write with the key on STDIN (security -i), never on argv, then a
 *  read-back compare. Child output is captured and never echoed. */
function keychainStore(account: string, hex: string): void {
  if (!isValidBindkey(hex) || !/^[0-9A-F:]+$/.test(account)) throw new Error('refusing a malformed Keychain write')
  const cmd = `add-generic-password -U -s ${SCALE_KEYCHAIN_SERVICE} -a ${account} -w ${hex}\n`
  const w = Bun.spawnSync(['security', '-i'], { stdin: new TextEncoder().encode(cmd), stdout: 'pipe', stderr: 'pipe' })
  if (w.exitCode !== 0) throw new Error(`Keychain write failed (security exit ${w.exitCode})`)
  const r = Bun.spawnSync(['security', 'find-generic-password', '-s', SCALE_KEYCHAIN_SERVICE, '-a', account, '-w'], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (r.exitCode !== 0 || r.stdout.toString().trim() !== hex) {
    throw new Error('Keychain read-back did not match after the write')
  }
}

let tempDir: string | null = null
const cleanup = (): void => {
  if (tempDir) {
    try { rmSync(tempDir, { recursive: true, force: true }) } catch {}
    tempDir = null
  }
}
process.on('SIGINT', () => { cleanup(); process.exit(130) })
process.on('SIGTERM', () => { cleanup(); process.exit(143) })

const choose = process.stdin.isTTY
  ? async (list: CloudDevice[]): Promise<number | null> => {
      console.log('Which device is the scale?')
      list.forEach((d, i) => console.log(`  ${i + 1}. ${describeDevice(d)}`))
      const ans = prompt('Number:')
      const n = Number((ans ?? '').trim())
      return Number.isInteger(n) ? n - 1 : null
    }
  : undefined

try {
  await runBindkeyFlow(
    { server, configPath, did },
    {
      fetch: (url, init) => fetch(url, init),
      say: (line) => console.log(line),
      openImage: (p) => {
        const r = Bun.spawnSync(['open', '-a', 'Preview', p], { stdout: 'pipe', stderr: 'pipe' })
        if (r.exitCode !== 0) throw new Error('open failed')
      },
      makeTempDir: () => (tempDir = mkdtempSync(join(tmpdir(), 's400-qr-'))),
      removeDir: () => cleanup(),
      keychainStore,
      choose,
      now: () => Date.now(),
      sleep: (ms) => Bun.sleep(ms),
      randomBytes: (n) => new Uint8Array(randomBytes(n)),
    },
  )
  process.exit(0)
} catch (err) {
  cleanup()
  // Our errors are written to be secret-free; anything else gets a generic line.
  const name = (err as Error)?.name
  const safe = name === 'XiaomiFlowError' || name === 'PickError' || (err as Error)?.message?.startsWith('Keychain') ||
    (err as Error)?.message?.startsWith('config at') || (err as Error)?.message === 'refusing a malformed Keychain write'
  console.error(`scale-bindkey failed: ${safe ? (err as Error).message : 'unexpected error (details suppressed to keep secrets out of the terminal)'}`)
  process.exit(1)
}
