#!/usr/bin/env bun
// Guided setup: WHOOP dev app -> credentials in Keychain -> OAuth consent ->
// full backfill -> launchd install. Idempotent: re-running skips what's done
// and refreshes what changed (paths after a plugin update, for example).
//
// Single-tenant by design: every installer registers their OWN WHOOP dev app.
// Nothing here talks to any server except WHOOP itself.

import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { loadConfig, saveConfig, ensureRuntimeDir, LOG_PATH, PID_PATH } from '../src/config.js'
import { keychainRead, keychainWrite, loadTokens, exchangeCode } from '../src/auth.js'
import { Store } from '../src/store.js'
import { backfill } from '../src/poller.js'

const SECRET_SERVICE = process.env.HEALTH_SECRET_SERVICE ?? 'whoop-client-secret'
const LAUNCHD_LABEL = 'com.s0nderlabs.health'
const PLIST_PATH = join(homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`)
const PLUGIN_ROOT = join(import.meta.dir, '..')

const AUTH_URL = 'https://api.prod.whoop.com/oauth/oauth2/auth'
const SCOPES = [
  'offline', // the refresh-token scope; exact string
  'read:recovery',
  'read:cycles',
  'read:workout',
  'read:sleep',
  'read:profile',
  'read:body_measurement',
].join(' ')

function say(msg = ''): void {
  console.log(msg)
}

async function ask(question: string): Promise<string> {
  process.stdout.write(question)
  for await (const line of console) return line.trim()
  return ''
}

say('health setup')
say('============')
say()

// ── Step 1: WHOOP dev app credentials ─────────────────────────────

const config = loadConfig()

if (config.whoop.client_id) {
  say(`Client ID already configured: ${config.whoop.client_id.slice(0, 8)}... (enter to keep, or paste a new one)`)
} else {
  say('You need your own (free) WHOOP developer app:')
  say('  1. Sign in at https://developer-dashboard.whoop.com')
  say('  2. Create a Team, then an App')
  say('  3. Scopes: offline + all six read scopes')
  say(`  4. Redirect URI: ${config.whoop.redirect_uri}`)
  say('  5. Copy the Client ID and Client Secret')
  say()
}

const clientIdInput = await ask('Client ID: ')
if (clientIdInput) config.whoop.client_id = clientIdInput
if (!config.whoop.client_id) {
  console.error('A client ID is required. Register the app first, then re-run setup.')
  process.exit(1)
}

const redirectInput = await ask(`Redirect URI [${config.whoop.redirect_uri}]: `)
if (redirectInput) config.whoop.redirect_uri = redirectInput
saveConfig(config)
say('Config saved.')

if (keychainRead(SECRET_SERVICE)) {
  const rotate = await ask('Client secret already in Keychain. Replace it? [y/N]: ')
  if (rotate.toLowerCase() === 'y') {
    const secret = await ask('Client Secret: ')
    if (secret) keychainWrite(SECRET_SERVICE, secret)
  }
} else {
  const secret = await ask('Client Secret: ')
  if (!secret) {
    console.error('A client secret is required.')
    process.exit(1)
  }
  keychainWrite(SECRET_SERVICE, secret)
  say('Secret stored in the macOS Keychain (never on disk).')
}

// ── Step 2: OAuth consent (the only interactive auth moment, ever) ─

if (loadTokens()) {
  say('Tokens already present in Keychain; skipping consent. (Delete the whoop-tokens Keychain item to redo.)')
} else {
  const state = crypto.randomUUID().replaceAll('-', '').slice(0, 8) // must be exactly 8 chars
  const redirect = new URL(config.whoop.redirect_uri)
  const port = Number(redirect.port || 80)

  const authUrl = new URL(AUTH_URL)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('client_id', config.whoop.client_id)
  authUrl.searchParams.set('redirect_uri', config.whoop.redirect_uri)
  authUrl.searchParams.set('scope', SCOPES)
  authUrl.searchParams.set('state', state)

  say()
  say('Open this URL in your browser and approve access:')
  say()
  say(String(authUrl))
  say()
  say(`Waiting for the callback on ${config.whoop.redirect_uri} ...`)

  try {
    await new Promise<void>((resolve, reject) => {
      const server = Bun.serve({
        port,
        async fetch(req) {
          const url = new URL(req.url)
          if (url.pathname !== redirect.pathname) return new Response('not found', { status: 404 })
          // Any terminal outcome stops the server so setup never hangs on the
          // open listener; then resolve/reject drives the outer try/catch.
          const fail = (msg: string, e: Error): Response => {
            server.stop()
            reject(e)
            return new Response(msg, { status: 400 })
          }
          const err = url.searchParams.get('error')
          if (err) {
            return fail('Consent failed, see terminal.',
              new Error(`consent failed: ${err} ${url.searchParams.get('error_description') ?? ''}`))
          }
          if (url.searchParams.get('state') !== state) {
            return fail('State mismatch.', new Error('state mismatch (possible CSRF), aborting'))
          }
          const code = url.searchParams.get('code')!
          try {
            await exchangeCode(code) // persists to Keychain before returning
          } catch (e) {
            // A bad client secret or network failure must not hang setup forever.
            return fail('Token exchange failed, see terminal.', e instanceof Error ? e : new Error(String(e)))
          }
          setTimeout(() => {
            server.stop()
            resolve()
          }, 200)
          return new Response('<h3>health: authorized</h3><p>Back to the terminal.</p>', {
            headers: { 'Content-Type': 'text/html' },
          })
        },
      })
    })
  } catch (e) {
    console.error(`\nSetup failed during authorization: ${e instanceof Error ? e.message : e}`)
    console.error('Fix the issue (usually a wrong client secret) and re-run: bun run setup')
    process.exit(1)
  }
  say('Tokens stored in Keychain. From here on everything is headless.')
}

// ── Step 3: stop any running daemon FIRST ─────────────────────────
//
// backfill() below refreshes the WHOOP token via getAccessToken. WHOOP refresh
// tokens are single-use and rotate, so exactly one process may refresh at a
// time (auth.ts header). If an older daemon is live, its 5-minute poll could
// refresh concurrently with setup and burn the token (forcing a re-consent) or
// collide on the SQLite writer. So bring the daemon down before touching data,
// and bootstrap the fresh one only at the very end (Step 4).
const setupUid = Bun.spawnSync(['id', '-u']).stdout.toString().trim()
Bun.spawnSync(['launchctl', 'bootout', `gui/${setupUid}/${LAUNCHD_LABEL}`])
if (existsSync(PID_PATH)) await Bun.sleep(1000) // let it release the token + db

// ── Step 3b: backfill the archive ─────────────────────────────────

ensureRuntimeDir()
const store = new Store()
if (store.getMeta('backfill_done')) {
  say(`Archive already backfilled (${store.getMeta('backfill_done')}); the daemon keeps it current.`)
} else {
  say('Backfilling your full WHOOP history into the local archive...')
  const counts = await backfill(store)
  say(`Backfill done: ${JSON.stringify(counts)}`)
}
store.close()

// ── Step 4: launchd (always-on daemon) ────────────────────────────

// Prefer the stable PATH symlink over process.execPath: Homebrew's execPath
// is version-pinned (Cellar/bun/x.y.z) and dies on the next brew upgrade.
const bunPath = Bun.which('bun') ?? process.execPath
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LAUNCHD_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${bunPath}</string>
        <string>run</string>
        <string>${join(PLUGIN_ROOT, 'src', 'daemon.ts')}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${PLUGIN_ROOT}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ProcessType</key>
    <string>Background</string>
    <key>StandardOutPath</key>
    <string>${LOG_PATH}</string>
    <key>StandardErrorPath</key>
    <string>${LOG_PATH}</string>
</dict>
</plist>
`

mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true })
writeFileSync(PLIST_PATH, plist)

const uid = Bun.spawnSync(['id', '-u']).stdout.toString().trim()
// Re-bootstrap cleanly whether or not an older copy is loaded.
Bun.spawnSync(['launchctl', 'bootout', `gui/${uid}/${LAUNCHD_LABEL}`])
// Give any previously running daemon a moment to release the pidfile.
if (existsSync(PID_PATH)) await Bun.sleep(1000)
const boot = Bun.spawnSync(['launchctl', 'bootstrap', `gui/${uid}`, PLIST_PATH])
if (boot.exitCode !== 0) {
  console.error(`launchctl bootstrap failed: ${boot.stderr.toString()}`)
  process.exit(1)
}
say(`LaunchAgent installed and started (${LAUNCHD_LABEL}). Logs: ${LOG_PATH}`)

// ── Step 5: what's next ───────────────────────────────────────────

say()
say('Done. Optional next steps:')
say('  - Real-time webhooks: expose the receiver publicly (e.g. tailscale funnel --bg ' + String(loadConfig().webhook.port) + ')')
say('    then register the public URL + your webhook path in the WHOOP dashboard (Model Version v2).')
say('  - Load the plugin in Claude Code: --channels=plugin:health@s0nderlabs (or your marketplace).')
say('  - Type /health in a session for your first read.')
