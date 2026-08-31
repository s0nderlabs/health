// Strava client + token rotator + the naming rules for the ride watcher.
//
// The rename PUT is the ONLY write this plugin ever makes to any external
// service. Everything else here is read or auth plumbing. Tokens follow the
// WHOOP discipline (persist-before-use, single-flight, Keychain), though
// Strava's rotation is gentler: refresh tokens are reusable until a refresh
// succeeds, access tokens live 6 hours, and there is no top-of-hour minefield.
//
// The API app is SHARED with clawdrunner (Strava allows one app per account),
// so this module must stay a polite tenant: a handful of calls per ride, one
// webhook subscription (slot verified free before this was built), and the
// self-serve default limits (100 reads/15min) left untouched.

import type { StravaActivity, StravaTokenStore } from './types.js'

const TOKEN_URL = 'https://www.strava.com/oauth/token'
const API_BASE = 'https://www.strava.com/api/v3'

// Same test-override pattern as auth.ts: read at call time, never module load.
const CRED_SERVICE = () => process.env.HEALTH_STRAVA_CRED_SERVICE ?? 'dev.strava'
const TOKEN_SERVICE = () => process.env.HEALTH_STRAVA_TOKEN_SERVICE ?? 'dev.strava-tokens'

function log(msg: string): void {
  process.stderr.write(`healthd strava: ${new Date().toISOString()} ${msg}\n`)
}

export class StravaAuthError extends Error {
  constructor(detail: string) {
    super(`Strava auth is broken: ${detail}. Re-run: bun run setup:strava`)
    this.name = 'StravaAuthError'
  }
}

// ── Keychain ──────────────────────────────────────────────────────
// The client credentials live under ONE service with per-value accounts
// (that is how they were stored on Aug 31 2026), so reads must pass -a;
// the WHOOP-style service-only lookup would return an arbitrary match.

function keychainReadAccount(service: string, account: string): string | null {
  const p = Bun.spawnSync(['security', 'find-generic-password', '-s', service, '-a', account, '-w'])
  return p.exitCode === 0 ? p.stdout.toString().trim() : null
}

function keychainWriteAccount(service: string, account: string, value: string): void {
  const p = Bun.spawnSync([
    'security', 'add-generic-password', '-U', '-a', account, '-s', service, '-w', value,
  ])
  if (p.exitCode !== 0) {
    throw new Error(`keychain write failed for ${service}/${account}: ${p.stderr.toString()}`)
  }
}

export function readClientCreds(): { clientId: string; clientSecret: string } {
  const clientId = keychainReadAccount(CRED_SERVICE(), 'client-id')
  const clientSecret = keychainReadAccount(CRED_SERVICE(), 'client-secret')
  if (!clientId || !clientSecret) {
    throw new Error(
      `No Strava client credentials in Keychain (service ${CRED_SERVICE()}, accounts client-id/client-secret).`,
    )
  }
  return { clientId, clientSecret }
}

export function loadStravaTokens(): StravaTokenStore | null {
  const raw = keychainReadAccount(TOKEN_SERVICE(), 'tokens')
  if (!raw) return null
  try {
    return JSON.parse(raw) as StravaTokenStore
  } catch {
    return null
  }
}

export function saveStravaTokens(t: {
  access_token: string
  refresh_token: string
  expires_at: number
}): StravaTokenStore {
  const store: StravaTokenStore = { ...t, obtained_at: new Date().toISOString() }
  keychainWriteAccount(TOKEN_SERVICE(), 'tokens', JSON.stringify(store))
  return store
}

/** Is the Strava leg configured at all? (Tokens exist in the Keychain.) */
export function stravaConfigured(): boolean {
  return !!loadStravaTokens()
}

// ── Token rotator (single-flight, persist-before-use) ─────────────

let cached: StravaTokenStore | null = null
let refreshing: Promise<StravaTokenStore> | null = null

function fresh(t: StravaTokenStore, nowMs = Date.now()): boolean {
  // 30-minute margin on a 6-hour token: a refresh that fails transiently is
  // discovered with plenty of valid access left.
  return t.expires_at * 1000 - nowMs > 30 * 60_000
}

async function tokenRequest(params: Record<string, string>): Promise<StravaTokenStore> {
  const { clientId, clientSecret } = readClientCreds()
  const body = new URLSearchParams({ ...params, client_id: clientId, client_secret: clientSecret })
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(60_000),
  })
  const text = await res.text()
  if (!res.ok) {
    if (res.status >= 400 && res.status < 500) throw new StravaAuthError(`${res.status} ${text}`)
    throw new Error(`Strava token endpoint ${res.status}: ${text}`)
  }
  const parsed = JSON.parse(text) as {
    access_token: string
    refresh_token: string
    expires_at: number
  }
  // Persist BEFORE first use: Strava says always keep the newest refresh
  // token, and the WHOOP incident history says never trust "we'll save later".
  return saveStravaTokens(parsed)
}

export async function exchangeStravaCode(code: string): Promise<StravaTokenStore> {
  return tokenRequest({ grant_type: 'authorization_code', code })
}

/** Single-flight refresh, regardless of clock freshness. The 401 path needs
 *  this: a revoked-but-unexpired token looks fresh to the clock check, so
 *  only an actual refresh can replace it (the WHOOP client learned the same
 *  lesson: whoop.ts calls forceRefresh on 401). */
function refreshNow(): Promise<StravaTokenStore> {
  const stored = loadStravaTokens()
  if (!stored) return Promise.reject(new Error('No Strava tokens in Keychain. Run: bun run setup:strava'))
  if (!refreshing) {
    refreshing = tokenRequest({ grant_type: 'refresh_token', refresh_token: stored.refresh_token })
      .then((t) => (cached = t))
      .finally(() => {
        refreshing = null
      })
  }
  return refreshing
}

export async function getStravaAccessToken(): Promise<string> {
  const now = Date.now()
  if (cached && fresh(cached, now)) return cached.access_token
  const stored = loadStravaTokens()
  if (!stored) throw new Error('No Strava tokens in Keychain. Run: bun run setup:strava')
  if (fresh(stored, now)) {
    cached = stored
    return stored.access_token
  }
  return (await refreshNow()).access_token
}

export function _resetStravaTokenCacheForTests(): void {
  cached = null
}

// ── API (the four calls the watcher needs) ────────────────────────

export interface StravaApi {
  getActivity(id: number): Promise<StravaActivity>
  updateActivity(id: number, patch: { name?: string; description?: string }): Promise<StravaActivity>
  listActivitiesAfter(afterUnixSec: number): Promise<StravaActivity[]>
}

export class StravaNotFoundError extends Error {
  constructor(path: string) {
    super(`Strava resource not found: ${path}`)
    this.name = 'StravaNotFoundError'
  }
}

async function request<T>(path: string, init?: RequestInit, retried = false): Promise<T> {
  const token = await getStravaAccessToken()
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(60_000),
  })
  if (res.ok) return (await res.json()) as T
  if (res.status === 404) throw new StravaNotFoundError(path)
  if (res.status === 401 && !retried) {
    // An actual refresh, not a cache clear: a revoked-but-unexpired token
    // still looks fresh to the clock, so re-reading the Keychain would just
    // replay the same dead token. A rejected refresh surfaces StravaAuthError.
    await refreshNow()
    return request<T>(path, init, true)
  }
  if (res.status === 429 && !retried) {
    // Capped: the callers (5/15-min ticks, a 60s RPC) must never be parked
    // on a 15-minute window wait. A short breather, one retry, and if the
    // window is still shut the error lands and the NEXT tick tries again.
    log(`rate limited on ${path}, retrying in 30s`)
    await Bun.sleep(30_000)
    return request<T>(path, init, true)
  }
  const text = await res.text()
  if (res.status === 401 || res.status === 403) {
    // Post-retry auth rejection: a revoked token or a missing/revoked scope.
    // Classified so the daemon's guard nags instead of a silent stderr line.
    throw new StravaAuthError(`${init?.method ?? 'GET'} ${path} -> ${res.status} ${text}`)
  }
  throw new Error(`Strava ${init?.method ?? 'GET'} ${path} -> ${res.status}: ${text}`)
}

export const api: StravaApi = {
  getActivity: (id) => request<StravaActivity>(`/activities/${id}`),
  updateActivity: (id, patch) =>
    request<StravaActivity>(`/activities/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  listActivitiesAfter: (afterUnixSec) =>
    request<StravaActivity[]>(`/athlete/activities?after=${afterUnixSec}&per_page=30`),
}

// ── Naming rules (pure; the guards that keep the PUT polite) ──────

/** Strava's auto-titles for rides, the ONLY titles we may replace. Exact
 *  match, English set (his account language); anything else is his. */
const GENERIC_RIDE_NAME = /^(Morning|Lunch|Afternoon|Evening|Night) Ride$/

export function isGenericRideName(name: string): boolean {
  return GENERIC_RIDE_NAME.test(name.trim())
}

export function isRideType(a: Pick<StravaActivity, 'sport_type'>): boolean {
  return a.sport_type === 'Ride' || a.sport_type === 'VirtualRide' || a.sport_type === 'GravelRide'
}

/** A WHOOP-pushed activity must never be renamed OR announced (the WHOOP
 *  side of the session already has its own card; a second ping is noise). */
export function isWhoopSourced(a: Pick<StravaActivity, 'device_name' | 'external_id'>): boolean {
  const hay = `${a.device_name ?? ''} ${a.external_id ?? ''}`.toLowerCase()
  return hay.includes('whoop')
}

// ── Public-text rules (mechanically enforced) ─────────────────────
// The composition guidance lives in the MCP instructions, but guidance can
// be forgotten by a compacted session or a future model. These rules are
// invariants, so the daemon enforces them in code on EVERY public write:
// titles and descriptions alike.

/** Never-public terms (his standing privacy rule: WHOOP physiology stays in
 *  the private channel; ride-file HR numbers are explicitly allowed, his
 *  ruling Aug 31 2026). Word-bounded and narrow on purpose: "recovery pace"
 *  is normal cycling prose, "recovery score" is not. */
const BANNED_PUBLIC = [
  /\bwhoop\b/i,
  /\bhrv\b/i,
  /\brecovery score\b/i,
  /\bstrain\b/i,
  /\breadiness\b/i,
  /\bsleep\b/i,
]

/** Throws when text carries a never-public term. Guards BOTH public fields:
 *  the ride.landed event itself hands the composer WHOOP strain numbers, so
 *  a title is exactly as leakable as a description. */
export function assertPublicText(text: string, field: string): void {
  for (const re of BANNED_PUBLIC) {
    if (re.test(text)) {
      throw new Error(
        `${field} rejected: it matches ${re} which is on the never-public list (WHOOP physiology and recovery context stay in the private channel)`,
      )
    }
  }
}

/** Validate + sign a public description. Throws on banned terms; appends the
 *  configured watermark when the composer forgot it (idempotent when it did
 *  not). An empty watermark (the shipped default: installers sign as
 *  themselves or not at all) appends nothing. */
export function prepareDescription(desc: string, watermark: string): string {
  assertPublicText(desc, 'description')
  const trimmed = desc.trim()
  const mark = watermark.trim()
  if (!mark) return trimmed
  return trimmed.endsWith(mark) ? trimmed : `${trimmed}\n\n${mark}`
}

/** The plan's ride block, as far as naming needs it. */
export interface PlanRide {
  title?: string
  duration_min?: number
}

export function fmtRideDuration(seconds: number): string {
  const totalMin = Math.round(seconds / 60)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m`
}

/**
 * The deterministic fallback title, used ONLY when no session composes one
 * within the window. Plan-anchored and data-verified: the plan title is
 * claimed only when the ride actually looks like the planned session
 * (>= 80% of planned duration); a bailed session gets an honest name, and an
 * unplanned ride gets a plain factual one. Claude's in-session title is the
 * real product; this exists so nothing stays "Morning Ride" overnight.
 */
export function fallbackTitle(a: StravaActivity, plan: PlanRide | null): string {
  const km = a.distance > 0 ? `${(a.distance / 1000).toFixed(1)}km` : null
  const dur = fmtRideDuration(a.moving_time)
  if (plan?.title && plan.duration_min && plan.duration_min > 0) {
    const ratio = a.moving_time / 60 / plan.duration_min
    if (ratio >= 0.8) return plan.title
    return `${plan.title}, cut short at ${dur}`
  }
  if (plan?.title) return plan.title
  return km ? `Ride: ${km} in ${dur}` : `Ride: ${dur}`
}
