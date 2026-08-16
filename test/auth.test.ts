// Token-rotator hardening tests. The Jul 22 2026 incident: a refresh request
// hung unanswered (Bun's 300s default idle timeout), WHOOP had processed the
// rotation, and the lost response burned the single-use refresh token; the
// in-loop retry then surfaced Ory's generic invalid_request. These tests lock
// the diagnosability of that failure: the thrown error must name the likely
// lost rotation whenever a 4xx follows an unanswered attempt in the same
// cycle, and must not cry wolf on a plain 4xx.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setSystemTime, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Env overrides must land before auth.js is imported (it reads them at load).
const SECRET_SERVICE = 'health-test-auth-secret'
const TOKEN_SERVICE = 'health-test-auth-tokens'
process.env.HEALTH_SECRET_SERVICE = SECRET_SERVICE
process.env.HEALTH_TOKEN_SERVICE = TOKEN_SERVICE

const configDir = mkdtempSync(join(tmpdir(), 'health-auth-test-'))
writeFileSync(
  join(configDir, 'config.json'),
  JSON.stringify({ whoop: { client_id: 'test-client-id' } }),
)
process.env.HEALTH_CONFIG_PATH = join(configDir, 'config.json')
// The in-flight rotation marker must land in the sandbox, not the real
// runtime dir.
process.env.HEALTH_RUNTIME_DIR = configDir

const {
  AuthBrokenError,
  _resetTokenCacheForTests,
  clearTokens,
  forceRefresh,
  getAccessToken,
  inRotationDangerWindow,
  keychainWrite,
  loadTokens,
} = await import('../src/auth.js')

const realFetch = globalThis.fetch

function tokenStore(refresh: string, over: Partial<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    access_token: 'at-old',
    refresh_token: refresh,
    expires_in: 3600,
    scope: 'offline',
    token_type: 'bearer',
    obtained_at: new Date(Date.now() - 3600_000).toISOString(), // stale
    ...over,
  })
}

function respond400(): Response {
  return new Response(JSON.stringify({ error: 'invalid_request' }), { status: 400 })
}

function respond200(access: string, refresh: string): Response {
  return new Response(
    JSON.stringify({
      access_token: access,
      refresh_token: refresh,
      expires_in: 3600,
      scope: 'offline',
      token_type: 'bearer',
    }),
    { status: 200 },
  )
}

/** Install a counting fetch stub; read `.calls` for how often it fired. */
function countingFetch(make: () => Response): { calls: number } {
  const state = { calls: 0 }
  globalThis.fetch = (async () => {
    state.calls++
    return make()
  }) as typeof fetch
  return state
}

beforeAll(() => {
  keychainWrite(SECRET_SERVICE, 'test-secret')
})

beforeEach(() => {
  // Pin every test to a mid-hour clock: rotation now REFUSES inside the
  // :58-:05 danger window, so an unpinned suite would flake whenever CI
  // happens to run in those seven minutes of real time.
  setSystemTime(new Date('2027-06-01T10:30:00Z'))
})

afterEach(() => {
  globalThis.fetch = realFetch
  setSystemTime() // restore the real clock
  // A faked-clock rotation leaves the module cache holding a token stamped
  // in the future, which reads as fresh forever under the real clock and
  // would short-circuit every later getAccessToken in this process.
  _resetTokenCacheForTests()
})

afterAll(() => {
  for (const s of [SECRET_SERVICE, TOKEN_SERVICE]) {
    Bun.spawnSync(['security', 'delete-generic-password', '-s', s])
  }
  rmSync(configDir, { recursive: true, force: true })
  // Env leaks into later-loaded test files in the same runner process.
  delete process.env.HEALTH_CONFIG_PATH
  delete process.env.HEALTH_SECRET_SERVICE
  delete process.env.HEALTH_TOKEN_SERVICE
  delete process.env.HEALTH_RUNTIME_DIR
})

describe('tokenRequest lost-rotation diagnosability', () => {
  test('a 4xx after an unanswered attempt names the likely lost rotation', async () => {
    keychainWrite(TOKEN_SERVICE, tokenStore('rt-single-use'))
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      if (calls === 1) throw new Error('simulated timeout')
      return respond400()
    }) as typeof fetch
    await expect(forceRefresh()).rejects.toThrow(/re-consent is required/)
  })

  test('a body that dies mid-read is a transport failure, not a loop escape', async () => {
    // The abort signal stays armed through the body read: a 200 whose body
    // stalls past the bound rejects at res.text(), and that must feed the
    // retry loop and the lost-rotation hint exactly like a failed fetch.
    keychainWrite(TOKEN_SERVICE, tokenStore('rt-single-use'))
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      if (calls === 1) {
        return {
          ok: true,
          status: 200,
          text: async () => {
            throw new Error('The operation timed out')
          },
        } as unknown as Response
      }
      return respond400()
    }) as typeof fetch
    await expect(forceRefresh()).rejects.toThrow(/re-consent is required/)
  })

  test('a plain 4xx does not cry lost-rotation', async () => {
    keychainWrite(TOKEN_SERVICE, tokenStore('rt-single-use'))
    globalThis.fetch = (async () => respond400()) as typeof fetch
    let err: unknown
    try {
      await forceRefresh()
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(AuthBrokenError)
    expect(String(err)).not.toContain('re-consent is required')
  })

  test('inRotationDangerWindow covers :58:00 through :05:00 exactly', () => {
    const hour = Date.parse('2027-01-01T05:00:00Z')
    expect(inRotationDangerWindow(hour)).toBe(true) // :00:00
    expect(inRotationDangerWindow(hour + 299_000)).toBe(true) // :04:59
    expect(inRotationDangerWindow(hour + 300_000)).toBe(false) // :05:00
    expect(inRotationDangerWindow(hour - 120_000)).toBe(true) // :58:00
    expect(inRotationDangerWindow(hour - 121_000)).toBe(false) // :57:59
    expect(inRotationDangerWindow(hour + 1_800_000)).toBe(false) // :30:00
  })

  test('a due rotation is deferred inside the danger window and fires after it', async () => {
    // Token 35 minutes old: stale by half-life, plenty of life left.
    keychainWrite(
      TOKEN_SERVICE,
      tokenStore('rt-current', {
        access_token: 'at-current',
        obtained_at: '2027-02-01T23:26:00.000Z',
      }),
    )
    const f = countingFetch(() => respond200('at-rotated', 'rt-rotated'))

    // :01:00 after the hour: inside the window -> serve the old token, no
    // network call, nothing rotated.
    setSystemTime(new Date('2027-02-02T00:01:00Z'))
    expect(await getAccessToken()).toBe('at-current')
    expect(f.calls).toBe(0)
    expect(loadTokens()?.refresh_token).toBe('rt-current')

    // :10:00: window passed -> the deferred rotation fires.
    setSystemTime(new Date('2027-02-02T00:10:00Z'))
    expect(await getAccessToken()).toBe('at-rotated')
    expect(f.calls).toBe(1)
    expect(loadTokens()?.refresh_token).toBe('rt-rotated')
  })

  test('clearTokens removes the stored pair (setup dead-pair path)', () => {
    keychainWrite(TOKEN_SERVICE, tokenStore('rt-dead'))
    expect(loadTokens()).not.toBeNull()
    clearTokens()
    expect(loadTokens()).toBeNull()
  })

  test('a hard-expired token never rotates in-window: the caller fails, then rotates after', async () => {
    // 71 minutes old with a 60-minute life, daemon waking up at :01. The
    // ONLY safe move is to fail the call (a failed poll retries after :05);
    // rotating here is how a post-sleep daemon burns its token at :00.
    keychainWrite(
      TOKEN_SERVICE,
      tokenStore('rt-dead', {
        access_token: 'at-dead',
        obtained_at: '2027-03-01T22:50:00.000Z',
      }),
    )
    const f = countingFetch(() => respond200('at-after', 'rt-after'))
    setSystemTime(new Date('2027-03-02T00:01:00Z')) // inside the window
    await expect(getAccessToken()).rejects.toThrow(/rotation deferred/)
    expect(f.calls).toBe(0)

    // Window passed: the rotation fires normally.
    setSystemTime(new Date('2027-03-02T00:10:00Z'))
    expect(await getAccessToken()).toBe('at-after')
    expect(f.calls).toBe(1)
    expect(loadTokens()?.refresh_token).toBe('rt-after')
  })

  test('forceRefresh refuses in-window unless setup forces through', async () => {
    // The 401-recovery path (plain forceRefresh) must obey the window: it is
    // the route a mid-window token death would otherwise burn through. Setup
    // passes evenInDangerWindow: validation never silently no-ops.
    keychainWrite(
      TOKEN_SERVICE,
      tokenStore('rt-valid', {
        access_token: 'at-valid',
        obtained_at: '2027-04-01T23:26:00.000Z',
      }),
    )
    const f = countingFetch(() => respond200('at-forced', 'rt-forced'))
    setSystemTime(new Date('2027-04-02T00:01:00Z')) // inside the window
    await expect(forceRefresh()).rejects.toThrow(/rotation deferred/)
    expect(f.calls).toBe(0)
    const rotated = await forceRefresh(true) // the setup path
    expect(rotated.refresh_token).toBe('rt-forced')
    expect(f.calls).toBe(1)
  })

  test('a 4xx after a gateway 5xx names the burn signature', async () => {
    // The real fingerprint of every observed burn: Cloudflare 502 on the
    // rotation (Hydra already committed it), then invalid_request on the
    // replay of the consumed token.
    keychainWrite(TOKEN_SERVICE, tokenStore('rt-single-use'))
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      if (calls === 1) return new Response('<html>502 Bad gateway</html>', { status: 502 })
      return respond400()
    }) as typeof fetch
    await expect(forceRefresh()).rejects.toThrow(/gateway 5xx.*re-consent is required/)
  })

  test('a successful refresh persists the rotated pair before returning', async () => {
    keychainWrite(TOKEN_SERVICE, tokenStore('rt-old'))
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          access_token: 'at-new',
          refresh_token: 'rt-new',
          expires_in: 3600,
          scope: 'offline',
          token_type: 'bearer',
        }),
        { status: 200 },
      )) as typeof fetch
    const rotated = await forceRefresh()
    expect(rotated.refresh_token).toBe('rt-new')
    const persisted = loadTokens()
    expect(persisted?.refresh_token).toBe('rt-new')
    expect(persisted?.obtained_at).toBeDefined()
  })
})
