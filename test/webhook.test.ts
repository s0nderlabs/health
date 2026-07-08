import { describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { verifySignature } from '../src/webhook.js'

const SECRET = 'test-secret-abc'

function sign(ts: string, body: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(ts + body).digest('base64')
}

describe('webhook HMAC verification', () => {
  const body = JSON.stringify({ user_id: 1, id: 'abc', type: 'workout.updated', trace_id: 'x' })
  const ts = '1751980000000'

  test('accepts the documented recipe: base64(hmac-sha256(ts + raw body))', () => {
    expect(verifySignature(SECRET, sign(ts, body), ts, body)).toBe(true)
  })

  test('rejects a tampered body', () => {
    expect(verifySignature(SECRET, sign(ts, body), ts, body.replace('abc', 'abd'))).toBe(false)
  })

  test('rejects a wrong secret', () => {
    expect(verifySignature(SECRET, sign(ts, body, 'other'), ts, body)).toBe(false)
  })

  test('rejects a replayed signature with a different timestamp', () => {
    expect(verifySignature(SECRET, sign(ts, body), '1751980099999', body)).toBe(false)
  })

  test('rejects missing headers', () => {
    expect(verifySignature(SECRET, null, ts, body)).toBe(false)
    expect(verifySignature(SECRET, sign(ts, body), null, body)).toBe(false)
  })

  test('rejects garbage base64', () => {
    expect(verifySignature(SECRET, '!!!not-base64!!!', ts, body)).toBe(false)
  })
})
