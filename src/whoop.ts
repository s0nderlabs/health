// Typed WHOOP v2 API client. Read-only, daemon-side.

import { getAccessToken, forceRefresh } from './auth.js'
import type {
  WhoopBodyMeasurement,
  WhoopCollection,
  WhoopCycle,
  WhoopProfile,
  WhoopRecovery,
  WhoopSleep,
  WhoopWorkout,
} from './types.js'

const API_BASE = 'https://api.prod.whoop.com/developer'

export class NotFoundError extends Error {
  constructor(path: string) {
    super(`WHOOP resource not found: ${path}`)
    this.name = 'NotFoundError'
  }
}

export interface RangeParams {
  start?: string // ISO datetime
  end?: string
  limit?: number // max 25
  nextToken?: string
}

function query(params: RangeParams): string {
  const q = new URLSearchParams()
  if (params.start) q.set('start', params.start)
  if (params.end) q.set('end', params.end)
  q.set('limit', String(Math.min(params.limit ?? 25, 25)))
  if (params.nextToken) q.set('nextToken', params.nextToken)
  return `?${q}`
}

async function request<T>(path: string, retried = false): Promise<T> {
  const token = await getAccessToken()
  // Timeout so a hung request cannot stall the poll chain for Bun's 300s
  // default idle window; GETs are idempotent and retried at the poll level.
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(60_000),
  })

  if (res.ok) return (await res.json()) as T
  if (res.status === 404) throw new NotFoundError(path)

  if (res.status === 401 && !retried) {
    await forceRefresh()
    return request<T>(path, true)
  }

  if (res.status === 429 && !retried) {
    // No Retry-After on WHOOP; X-RateLimit-Reset is seconds until the window resets.
    const resetSec = Number(res.headers.get('X-RateLimit-Reset') ?? 60)
    await Bun.sleep(Math.min(resetSec, 90) * 1000 + 500)
    return request<T>(path, true)
  }

  throw new Error(`WHOOP GET ${path} -> ${res.status}: ${await res.text()}`)
}

// ── Single resources ──────────────────────────────────────────────

export const getProfile = () => request<WhoopProfile>('/v2/user/profile/basic')
export const getBodyMeasurement = () => request<WhoopBodyMeasurement>('/v2/user/measurement/body')
export const getCycle = (id: number) => request<WhoopCycle>(`/v2/cycle/${id}`)
export const getSleep = (id: string) => request<WhoopSleep>(`/v2/activity/sleep/${id}`)
export const getWorkout = (id: string) => request<WhoopWorkout>(`/v2/activity/workout/${id}`)
export const getRecoveryForCycle = (cycleId: number) =>
  request<WhoopRecovery>(`/v2/cycle/${cycleId}/recovery`)
export const getSleepForCycle = (cycleId: number) =>
  request<WhoopSleep>(`/v2/cycle/${cycleId}/sleep`)

// ── Collections ───────────────────────────────────────────────────

export const getCycles = (p: RangeParams = {}) =>
  request<WhoopCollection<WhoopCycle>>(`/v2/cycle${query(p)}`)
export const getRecoveries = (p: RangeParams = {}) =>
  request<WhoopCollection<WhoopRecovery>>(`/v2/recovery${query(p)}`)
export const getSleeps = (p: RangeParams = {}) =>
  request<WhoopCollection<WhoopSleep>>(`/v2/activity/sleep${query(p)}`)
export const getWorkouts = (p: RangeParams = {}) =>
  request<WhoopCollection<WhoopWorkout>>(`/v2/activity/workout${query(p)}`)

/**
 * Iterate a collection endpoint to exhaustion (cursor pagination).
 * start/end are resent on every page, as the API requires.
 */
export async function* paginate<T>(
  fetcher: (p: RangeParams) => Promise<WhoopCollection<T>>,
  p: RangeParams = {},
): AsyncGenerator<T> {
  let nextToken: string | undefined
  do {
    const page = await fetcher({ ...p, nextToken })
    for (const record of page.records) yield record
    nextToken = page.next_token ?? undefined
  } while (nextToken)
}
