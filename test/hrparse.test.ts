import { describe, expect, test } from 'bun:test'
import { parseHeartRateMeasurement, parseBase64Frame } from '../src/hrparse.js'

function bytes(...b: number[]): Uint8Array {
  return Uint8Array.from(b)
}

// RR raw values: ms = raw / 1024 * 1000, so raw 1024 = 1000ms, raw 900 = 878.9ms
describe('parseHeartRateMeasurement', () => {
  test('8-bit HR, no extras (flags 0x00)', () => {
    const s = parseHeartRateMeasurement(bytes(0x00, 72))
    expect(s).toEqual({ bpm: 72, rr_ms: [], contact: null })
  })

  test('8-bit HR with one RR (flags 0x10, the WHOOP 5.0 shape)', () => {
    const s = parseHeartRateMeasurement(bytes(0x10, 65, 0x00, 0x04)) // rr raw 1024
    expect(s!.bpm).toBe(65)
    expect(s!.rr_ms).toEqual([1000])
  })

  test('multiple RR intervals in one packet', () => {
    // raw 900 -> 878.9ms, raw 1100 -> 1074.2ms
    const s = parseHeartRateMeasurement(bytes(0x10, 68, 0x84, 0x03, 0x4c, 0x04))
    expect(s!.rr_ms).toEqual([878.9, 1074.2])
  })

  test('16-bit HR (flags 0x01)', () => {
    const s = parseHeartRateMeasurement(bytes(0x01, 0x2c, 0x01)) // 300 bpm, hypothetical
    expect(s!.bpm).toBe(300)
  })

  test('energy expended field is skipped before RR (flags 0x18)', () => {
    // [flags][hr][energy lo][energy hi][rr lo][rr hi]
    const s = parseHeartRateMeasurement(bytes(0x18, 70, 0xff, 0xff, 0x00, 0x04))
    expect(s!.bpm).toBe(70)
    expect(s!.rr_ms).toEqual([1000])
  })

  test('16-bit HR + energy + two RRs together (flags 0x19)', () => {
    const s = parseHeartRateMeasurement(
      bytes(0x19, 0x48, 0x00, 0x01, 0x00, 0x00, 0x04, 0x84, 0x03),
    )
    expect(s!.bpm).toBe(72)
    expect(s!.rr_ms).toEqual([1000, 878.9])
  })

  test('sensor contact: supported + detected (flags 0x06)', () => {
    expect(parseHeartRateMeasurement(bytes(0x06, 60))!.contact).toBe(true)
  })

  test('sensor contact: supported + not detected (flags 0x04)', () => {
    expect(parseHeartRateMeasurement(bytes(0x04, 60))!.contact).toBe(false)
  })

  test('trailing odd byte after RRs is ignored, not misread', () => {
    const s = parseHeartRateMeasurement(bytes(0x10, 65, 0x00, 0x04, 0x99))
    expect(s!.rr_ms).toEqual([1000])
  })

  test('empty and 1-byte buffers return null', () => {
    expect(parseHeartRateMeasurement(bytes())).toBeNull()
    expect(parseHeartRateMeasurement(bytes(0x10))).toBeNull()
  })

  test('16-bit flag with only 2 bytes returns null', () => {
    expect(parseHeartRateMeasurement(bytes(0x01, 70))).toBeNull()
  })

  test('RR flag set but no RR bytes yields empty rr_ms', () => {
    expect(parseHeartRateMeasurement(bytes(0x10, 65))!.rr_ms).toEqual([])
  })
})

describe('parseBase64Frame', () => {
  test('round-trips a real-shaped frame', () => {
    const raw = Buffer.from([0x10, 64, 0x00, 0x04]).toString('base64')
    const s = parseBase64Frame(raw)
    expect(s).toEqual({ bpm: 64, rr_ms: [1000], contact: null })
  })

  test('garbage base64 returns null', () => {
    expect(parseBase64Frame('%%%not-base64%%%')).toBeNull()
  })
})
