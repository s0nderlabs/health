#!/usr/bin/env bun
// Strava leg setup. Two phases, run in order:
//
//   bun run setup:strava               OAuth consent -> tokens in Keychain,
//                                      plus webhook path/verify_token in config
//   (restart the daemon)               launchctl kickstart -k gui/$UID/com.s0nderlabs.health
//   bun run setup:strava --subscribe   create the webhook subscription (the
//                                      daemon must be up: Strava's challenge
//                                      GET hits the funnel within seconds)
//
// The subscription phase is separate on purpose: Strava validates the
// callback BEFORE returning, so the daemon has to be serving the challenge
// path first, and the daemon only learns the path from the config this
// script writes. --unsubscribe deletes the app's subscription.
//
// Client credentials are expected in the Keychain already (service
// dev.strava, accounts client-id / client-secret). The API app is SHARED
// with clawdrunner; this script never edits the app itself.

import { randomBytes } from 'node:crypto'
import { loadConfig, saveConfig, configFileWritable } from '../src/config.js'
import { exchangeStravaCode, loadStravaTokens, readClientCreds } from '../src/strava.js'

const AUTHORIZE_URL = 'https://www.strava.com/oauth/authorize'
const SUBSCRIPTION_URL = 'https://www.strava.com/api/v3/push_subscriptions'
// activity:read_all covers Only-Me rides (and their webhook events);
// activity:write is the rename/description PUT. That is the entire ask.
const SCOPES = 'activity:read_all,activity:write'
// The app's Authorization Callback Domain is 127.0.0.1 (clawdrunner's
// setting, which suits us); Strava matches the domain only, so the port is
// arbitrary. 8791: 8788 is held by another local daemon on this machine.
const REDIRECT_URI = 'http://127.0.0.1:8791/exchange'

function say(msg = ''): void {
  console.log(msg)
}

function funnelHost(): string | null {
  try {
    const out = Bun.spawnSync(['tailscale', 'funnel', 'status']).stdout.toString()
    const m = out.match(/https:\/\/([a-z0-9.-]+\.ts\.net)\b/i)
    return m ? m[1] : null
  } catch {
    return null // tailscale not installed: same answer as no funnel
  }
}

const mode = process.argv.includes('--unsubscribe')
  ? 'unsubscribe'
  : process.argv.includes('--subscribe')
    ? 'subscribe'
    : 'auth'

let clientId: string
let clientSecret: string
try {
  ;({ clientId, clientSecret } = readClientCreds())
} catch {
  console.error('No Strava client credentials in the Keychain yet. Create an API app at')
  console.error('https://www.strava.com/settings/api, then store both values:')
  console.error('  security add-generic-password -s "dev.strava" -a "client-id" -w "<Client ID>" -U')
  console.error('  security add-generic-password -s "dev.strava" -a "client-secret" -w "<Client Secret>" -U')
  console.error('and re-run this command.')
  process.exit(1)
}

if (mode === 'subscribe' || mode === 'unsubscribe') {
  // Validate EVERYTHING before touching the app's one subscription slot: the
  // app is shared, and a delete followed by a failed create would leave it
  // with no subscription at all.
  const cfg = loadConfig()
  let callbackUrl = ''
  if (mode === 'subscribe') {
    if (!cfg.strava.webhook_path || !cfg.strava.verify_token) {
      console.error('No webhook path/verify_token in config yet. Run `bun run setup:strava` first.')
      process.exit(1)
    }
    const host = funnelHost()
    if (!host) {
      console.error('No Tailscale Funnel detected (`tailscale funnel status`); the callback needs a public HTTPS host.')
      process.exit(1)
    }
    callbackUrl = `https://${host}${cfg.strava.webhook_path}`
    const daemonUp = await fetch(`http://127.0.0.1:${cfg.webhook.port}/healthz`).then(
      (r) => r.ok,
      () => false,
    )
    if (!daemonUp) {
      console.error(
        `The daemon is not answering on 127.0.0.1:${cfg.webhook.port} and must be up for Strava's challenge.`,
      )
      console.error('Start it, then retry: launchctl kickstart -k gui/$UID/com.s0nderlabs.health')
      process.exit(1)
    }
  }

  const listRes = await fetch(`${SUBSCRIPTION_URL}?client_id=${clientId}&client_secret=${clientSecret}`)
  const listBody: unknown = await listRes.json().catch(() => null)
  if (!listRes.ok || !Array.isArray(listBody)) {
    console.error(`Could not list subscriptions (${listRes.status}): ${JSON.stringify(listBody)}`)
    process.exit(1)
  }
  const existing = listBody as Array<{ id: number; callback_url: string }>

  for (const sub of existing) {
    say(`Deleting existing subscription ${sub.id} (${sub.callback_url})`)
    const del = await fetch(
      `${SUBSCRIPTION_URL}/${sub.id}?client_id=${clientId}&client_secret=${clientSecret}`,
      { method: 'DELETE' },
    )
    if (!del.ok && del.status !== 404) {
      console.error(`Delete of subscription ${sub.id} failed (${del.status}); aborting before it gets worse.`)
      process.exit(1)
    }
  }
  if (mode === 'unsubscribe') {
    say(existing.length ? 'Unsubscribed.' : 'No subscription existed.')
    process.exit(0)
  }

  say(`Creating subscription -> ${callbackUrl}`)
  const res = await fetch(SUBSCRIPTION_URL, {
    method: 'POST',
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      callback_url: callbackUrl,
      verify_token: cfg.strava.verify_token,
    }),
  })
  const text = await res.text()
  if (!res.ok) {
    console.error(`Subscription failed: ${res.status} ${text}`)
    console.error('The old subscription (if any) was already removed; fix the cause and re-run --subscribe.')
    process.exit(1)
  }
  say(`Subscribed: ${text}`)
  process.exit(0)
}

// ── auth phase ────────────────────────────────────────────────────

const cfg = loadConfig()
if (!cfg.strava.webhook_path || !cfg.strava.verify_token) {
  if (!configFileWritable()) {
    console.error('config.json is malformed; refusing to write over it. Repair it first.')
    process.exit(1)
  }
  saveConfig({
    ...cfg,
    strava: {
      ...cfg.strava,
      webhook_path: cfg.strava.webhook_path || `/strava/${randomBytes(16).toString('hex')}`,
      verify_token: cfg.strava.verify_token || randomBytes(16).toString('hex'),
    },
  })
  say('Generated webhook path + verify token into config.')
}

if (loadStravaTokens()) {
  say('Strava tokens already in Keychain. Delete them first to force a re-consent:')
  say('  security delete-generic-password -s dev.strava-tokens')
  process.exit(0)
}

// CSRF guard, same as the WHOOP onboarding flow: the loopback listener must
// only accept the callback WE initiated, not any local navigation that
// happens to carry a code.
const state = crypto.randomUUID().replaceAll('-', '')

const authUrl = new URL(AUTHORIZE_URL)
authUrl.searchParams.set('client_id', clientId)
authUrl.searchParams.set('redirect_uri', REDIRECT_URI)
authUrl.searchParams.set('response_type', 'code')
authUrl.searchParams.set('approval_prompt', 'auto')
authUrl.searchParams.set('scope', SCOPES)
authUrl.searchParams.set('state', state)

say()
say('Open this URL in your browser and approve access:')
say()
say(String(authUrl))
say()
say(`Waiting for the callback on ${REDIRECT_URI} ...`)

await new Promise<void>((resolve, reject) => {
  const server = Bun.serve({
    port: 8791,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname !== '/exchange') return new Response('not found', { status: 404 })
      const fail = (msg: string, e: Error): Response => {
        server.stop()
        reject(e)
        return new Response(msg, { status: 400 })
      }
      const err = url.searchParams.get('error')
      if (err) return fail('Consent failed, see terminal.', new Error(`consent failed: ${err}`))
      if (url.searchParams.get('state') !== state) {
        return fail('State mismatch.', new Error('state mismatch (possible CSRF), aborting'))
      }
      // Strava echoes the granted scopes; a consent with the write scope
      // unticked would produce a renamer that can never rename. Catch it now.
      const scope = url.searchParams.get('scope') ?? ''
      if (!scope.includes('activity:write')) {
        return fail(
          'activity:write was not granted; re-run setup and leave every permission ticked.',
          new Error(`granted scope "${scope}" is missing activity:write`),
        )
      }
      const code = url.searchParams.get('code')
      if (!code) return fail('No code in callback.', new Error('no authorization code in callback'))
      try {
        await exchangeStravaCode(code) // persists to Keychain before returning
      } catch (e) {
        return fail('Token exchange failed, see terminal.', e instanceof Error ? e : new Error(String(e)))
      }
      setTimeout(() => {
        server.stop()
        resolve()
      }, 200)
      return new Response('<h3>health: Strava authorized</h3><p>Back to the terminal.</p>', {
        headers: { 'Content-Type': 'text/html' },
      })
    },
  })
})

say('Tokens stored in Keychain (service dev.strava-tokens).')
say()
say('Next:')
say('  1. Restart the daemon so it serves the webhook path:')
say('     launchctl kickstart -k gui/$UID/com.s0nderlabs.health')
say('  2. Create the subscription: bun run setup:strava --subscribe')
