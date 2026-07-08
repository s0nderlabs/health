// Keychain-backed WHOOP token rotator.
//
// WHOOP refresh tokens ROTATE and are SINGLE-USE: every refresh invalidates the
// old pair and returns a new refresh token. Losing the new one forces a manual
// re-consent. Two rules keep this safe:
//   1. persist the new token pair to the Keychain BEFORE it is used anywhere
//   2. exactly ONE process refreshes: the daemon. The MCP server never imports
//      this module's refresh path; setup only runs while the daemon is stopped.

import { loadConfig } from './config.js'

const TOKEN_URL = 'https://api.prod.whoop.com/oauth/oauth2/token'

// Overridable for tests only, so test runs never touch the real token store.
const SECRET_SERVICE = process.env.HEALTH_SECRET_SERVICE ?? 'whoop-client-secret'
const TOKEN_SERVICE = process.env.HEALTH_TOKEN_SERVICE ?? 'whoop-tokens'

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
  const secret = keychainRead(SECRET_SERVICE)
  if (!secret) {
    throw new Error(
      `No ${SECRET_SERVICE} in Keychain. Run: bun run setup (or: security add-generic-password -U -a "$USER" -s ${SECRET_SERVICE} -w <SECRET>)`,
    )
  }
  return secret
}

export function loadTokens(): TokenStore | null {
  const raw = keychainRead(TOKEN_SERVICE)
  if (!raw) return null
  try {
    return JSON.parse(raw) as TokenStore
  } catch {
    return null
  }
}

export function saveTokens(raw: Omit<TokenStore, 'obtained_at'>): TokenStore {
  const store: TokenStore = { ...raw, obtained_at: new Date().toISOString() }
  keychainWrite(TOKEN_SERVICE, JSON.stringify(store))
  return store
}

async function tokenRequest(params: Record<string, string>): Promise<TokenStore> {
  const config = loadConfig()
  const body = new URLSearchParams({
    ...params,
    client_id: config.whoop.client_id,
    client_secret: readClientSecret(),
  })

  let lastError: Error | null = null
  for (const delayMs of [0, 2000, 5000]) {
    if (delayMs) await Bun.sleep(delayMs)
    let res: Response
    try {
      res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      })
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      continue // network blip: retry
    }
    const text = await res.text()
    if (res.ok) return saveTokens(JSON.parse(text))
    if (res.status >= 400 && res.status < 500) {
      // The refresh token is burned or the client creds are wrong. Retrying
      // cannot help and risks making it worse.
      throw new AuthBrokenError(`${res.status} ${text}`)
    }
    lastError = new Error(`token endpoint ${res.status}: ${text}`)
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
  return ageSec < t.expires_in - 120
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
