// Keychain-backed WHOOP token rotator.
//
// WHOOP refresh tokens ROTATE and are SINGLE-USE: every refresh invalidates the
// old pair and returns a new refresh token. Losing the new one forces a manual
// re-consent. Two rules keep this safe:
//   1. persist the new token pair to the Keychain BEFORE it is used anywhere
//   2. exactly ONE process refreshes: the daemon. The MCP server never imports
//      this module's refresh path; setup only runs while the daemon is stopped.

import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RUNTIME_DIR, loadConfig } from './config.js'

const TOKEN_URL = 'https://api.prod.whoop.com/oauth/oauth2/token'

// Bounds a hung token request so the poll chain can never freeze silently
// (Jul 22 2026: a refresh hung the chain for Bun's default 300s idle timeout
// while WHOOP had already processed the rotation, and the lost response
// burned the token). The bound is deliberately LONG, not tight: a
// slow-but-alive rotation response arriving in the tail still carries the
// ONLY copy of the new refresh token, and an early abort would convert that
// recoverable slowness into a burned credential. Visibility comes from the
// 30s warning log below, never from aborting early.
const TOKEN_ABORT_MS = 240_000
const TOKEN_SLOW_WARN_MS = 30_000

function log(msg: string): void {
  process.stderr.write(`healthd auth: ${new Date().toISOString()} ${msg}\n`)
}

// ── In-flight rotation marker ─────────────────────────────────────
// Written before a refresh POST, cleared after any token success. If a
// process dies or a response is lost mid-rotation, the surviving marker
// makes the next failure instantly diagnosable ("a rotation at T never
// concluded") instead of a bare invalid_request an hour later. Best-effort
// forensics: marker I/O must never become the failure itself.

function inflightPath(): string {
  return join(process.env.HEALTH_RUNTIME_DIR ?? RUNTIME_DIR, 'refresh-inflight.json')
}

function markInflight(refreshToken: string): void {
  try {
    const prior = readInflight()
    if (prior) {
      log(
        `WARNING: a rotation attempt from ${prior.started_at} (token ...${prior.token_tail}) never concluded; if WHOOP processed it, this refresh will be rejected and re-consent is required`,
      )
    }
    writeFileSync(
      inflightPath(),
      JSON.stringify({ started_at: new Date().toISOString(), token_tail: refreshToken.slice(-6) }),
    )
  } catch {}
}

function clearInflight(): void {
  try {
    unlinkSync(inflightPath())
  } catch {}
}

function readInflight(): { started_at: string; token_tail: string } | null {
  try {
    return JSON.parse(readFileSync(inflightPath(), 'utf8'))
  } catch {
    return null
  }
}

// Overridable for tests only, so test runs never touch the real token store.
// Read at CALL time, not module load: bun test shares one module registry
// across files, so a load-time capture would silently ignore the override
// whenever another test file imported this module first (and the tests would
// then write over the REAL token store).
const SECRET_SERVICE = () => process.env.HEALTH_SECRET_SERVICE ?? 'whoop-client-secret'
const TOKEN_SERVICE = () => process.env.HEALTH_TOKEN_SERVICE ?? 'whoop-tokens'

export interface TokenStore {
  access_token: string
  refresh_token: string
  expires_in: number
  scope: string
  token_type: string
  obtained_at: string // ISO, stamped at save time
}

export class AuthBrokenError extends Error {
  constructor(detail: string) {
    super(`WHOOP auth is broken (refresh rejected): ${detail}. Re-run: bun run setup`)
    this.name = 'AuthBrokenError'
  }
}

export function keychainRead(service: string): string | null {
  const p = Bun.spawnSync(['security', 'find-generic-password', '-s', service, '-w'])
  return p.exitCode === 0 ? p.stdout.toString().trim() : null
}

export function keychainWrite(service: string, value: string): void {
  const p = Bun.spawnSync([
    'security', 'add-generic-password', '-U',
    '-a', process.env.USER ?? 'health',
    '-s', service,
    '-w', value,
  ])
  if (p.exitCode !== 0) {
    throw new Error(`keychain write failed for ${service}: ${p.stderr.toString()}`)
  }
}

export function readClientSecret(): string {
  const service = SECRET_SERVICE()
  const secret = keychainRead(service)
  if (!secret) {
    throw new Error(
      `No ${service} in Keychain. Run: bun run setup (or: security add-generic-password -U -a "$USER" -s ${service} -w <SECRET>)`,
    )
  }
  return secret
}

export function loadTokens(): TokenStore | null {
  const raw = keychainRead(TOKEN_SERVICE())
  if (!raw) return null
  try {
    return JSON.parse(raw) as TokenStore
  } catch {
    return null
  }
}

export function saveTokens(raw: Omit<TokenStore, 'obtained_at'>): TokenStore {
  const store: TokenStore = { ...raw, obtained_at: new Date().toISOString() }
  keychainWrite(TOKEN_SERVICE(), JSON.stringify(store))
  return store
}

/** Remove the stored pair (setup uses this when WHOOP rejects a refresh:
 *  a burned pair in the Keychain would otherwise make setup skip consent). */
export function clearTokens(): void {
  Bun.spawnSync(['security', 'delete-generic-password', '-s', TOKEN_SERVICE()])
}

async function tokenRequest(params: Record<string, string>): Promise<TokenStore> {
  const config = loadConfig()
  const body = new URLSearchParams({
    ...params,
    client_id: config.whoop.client_id,
    client_secret: readClientSecret(),
  })

  // Retrying a refresh with the SAME single-use token after a transport
  // failure is the correct move under every server configuration: if the
  // request never reached WHOOP the retry simply works; if WHOOP processed
  // it, the token is already consumed and the retry only surfaces the 4xx
  // fast (the lost response WAS the damage, a retry cannot deepen it); and
  // if WHOOP ever enables Ory's rotation grace window, a FAST retry with the
  // old token is precisely the path that recovers a lost rotation. Never
  // remove the fast replay.
  const isRefresh = params.grant_type === 'refresh_token'
  if (isRefresh) markInflight(params.refresh_token)
  let lastError: Error | null = null
  let unanswered = 0
  const delays = [0, 2000, 5000]
  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (delays[attempt]) await Bun.sleep(delays[attempt])
    const slowWarn = setTimeout(() => {
      log(
        `token request attempt ${attempt + 1}/${delays.length} still unanswered after ${TOKEN_SLOW_WARN_MS / 1000}s (waiting up to ${TOKEN_ABORT_MS / 1000}s: a slow rotation response carries the only copy of the new token)`,
      )
    }, TOKEN_SLOW_WARN_MS)
    let text: string
    let status: number
    let ok: boolean
    try {
      const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(TOKEN_ABORT_MS),
      })
      // The abort signal stays armed until the BODY is fully read: a body
      // that stalls past the bound must land in this catch like any other
      // transport failure, not escape the retry loop (review find, Jul 23).
      text = await res.text()
      status = res.status
      ok = res.ok
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      unanswered++
      log(`token request attempt ${attempt + 1}/${delays.length} got no response (${lastError.message})`)
      continue
    } finally {
      clearTimeout(slowWarn)
    }
    if (ok) {
      const saved = saveTokens(JSON.parse(text))
      clearInflight()
      return saved
    }
    if (status >= 400 && status < 500) {
      // The refresh token is burned or the client creds are wrong. Retrying
      // cannot help. Note: WHOOP's Ory config answers ANY invalid refresh
      // token with invalid_request (not invalid_grant), so the error text
      // alone never distinguishes "burned" from "malformed".
      const lostHint =
        unanswered > 0 && isRefresh
          ? ' [an earlier attempt this cycle got no response: if WHOOP processed that rotation, the response (and the only copy of the new token) is gone and re-consent is required]'
          : ''
      // A 4xx is a CONCLUDED attempt (the server answered): the marker only
      // exists to expose attempts whose outcome is unknown, and leaving it
      // would warn on every cycle of an already-diagnosed broken state.
      clearInflight()
      throw new AuthBrokenError(`${status} ${text}${lostHint}`)
    }
    lastError = new Error(`token endpoint ${status}: ${text}`)
    log(`token request attempt ${attempt + 1}/${delays.length}: ${lastError.message}`)
  }
  throw lastError ?? new Error('token request failed')
}

export async function exchangeCode(code: string): Promise<TokenStore> {
  const config = loadConfig()
  return tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.whoop.redirect_uri,
  })
}

// ── Rotator ───────────────────────────────────────────────────────

let cached: TokenStore | null = null
let refreshing: Promise<TokenStore> | null = null

function isFresh(t: TokenStore): boolean {
  const ageSec = (Date.now() - Date.parse(t.obtained_at)) / 1000
  // Rotate at HALF the token's lifetime, not at expiry-minus-margin: a
  // rotation that fails (transiently or terminally) is then discovered with
  // ~30 minutes of still-valid access token in hand, leaving a long quiet
  // window to retry and alert instead of going straight to hard-down.
  return ageSec < Math.min(t.expires_in / 2, t.expires_in - 120)
}

async function doRefresh(refreshToken: string): Promise<TokenStore> {
  const rotated = await tokenRequest({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: 'offline',
  })
  cached = rotated
  return rotated
}

/**
 * Returns a valid access token, refreshing (single-flight) when stale.
 * Daemon-only: see the module header.
 */
export async function getAccessToken(): Promise<string> {
  if (cached && isFresh(cached)) return cached.access_token

  const stored = loadTokens()
  if (!stored) {
    throw new Error('No WHOOP tokens in Keychain. Run: bun run setup')
  }
  if (isFresh(stored)) {
    cached = stored
    return stored.access_token
  }

  if (!refreshing) {
    refreshing = doRefresh(stored.refresh_token).finally(() => {
      refreshing = null
    })
  }
  const rotated = await refreshing
  return rotated.access_token
}

/** Force one refresh cycle regardless of freshness (single-flight shared). */
export async function forceRefresh(): Promise<TokenStore> {
  const stored = loadTokens()
  if (!stored) throw new Error('No WHOOP tokens in Keychain. Run: bun run setup')
  if (!refreshing) {
    refreshing = doRefresh(stored.refresh_token).finally(() => {
      refreshing = null
    })
  }
  return refreshing
}
