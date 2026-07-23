// Token-rotator hardening tests. The Jul 22 2026 incident: a refresh request
// hung unanswered (Bun's 300s default idle timeout), WHOOP had processed the
// rotation, and the lost response burned the single-use refresh token; the
// in-loop retry then surfaced Ory's generic invalid_request. These tests lock
// the diagnosability of that failure: the thrown error must name the likely
// lost rotation whenever a 4xx follows an unanswered attempt in the same
// cycle, and must not cry wolf on a plain 4xx.

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
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

const { AuthBrokenError, forceRefresh, keychainWrite, loadTokens } = await import('../src/auth.js')

const realFetch = globalThis.fetch

function tokenStore(refresh: string): string {
  return JSON.stringify({
    access_token: 'at-old',
    refresh_token: refresh,
    expires_in: 3600,
    scope: 'offline',
    token_type: 'bearer',
    obtained_at: new Date(Date.now() - 3600_000).toISOString(), // stale
  })
}

function respond400(): Response {
  return new Response(JSON.stringify({ error: 'invalid_request' }), { status: 400 })
}

beforeAll(() => {
  keychainWrite(SECRET_SERVICE, 'test-secret')
})

afterEach(() => {
  globalThis.fetch = realFetch
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
