// S400 scale leg: CCM, MiBeacon frames, obj 0x6E16, the weigh-in collapse,
// the body-fat formula, the daemon ingest path, and the /scale-adv route.
// Every key, MAC, and body value here is synthetic, except the two S400
// frames under "reference captures", which are the public MIT test vectors
// (and public test key) shipped by the xiaomi-ble project, not his data.
import { describe, expect, test, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  ccmDecrypt,
  ccmEncrypt,
  decodeMiBeacon,
  encodeIdleFrame,
  encodeMiBeaconV5,
  encodeObj6e16,
  fatFraction,
  fatPercent,
  ageAt,
  parseMac,
  parseMiBeaconHeader,
  parseObj6e16,
  readBindkeyFromKeychain,
  readingUuid,
  receiveTime,
  firstFrameOutcome,
  plausibleScaleTs,
  ScaleService,
  WeighinAssembler,
  OBJ_S400,
  SETTLE_MS,
  type S400Obj,
  type ScaleDeps,
} from '../src/scale.js'
import { Store } from '../src/store.js'
import { FoodService } from '../src/food.js'
import { DEFAULT_CONFIG, type ScaleConfig } from '../src/types.js'
import { LiveListener } from '../src/live.js'
import { LiveState } from '../src/livestate.js'

const KEY = Buffer.from('0f1e2d3c4b5a69788796a5b4c3d2e1f0', 'hex') // made up
const MAC = 'A4:C1:38:00:11:22' // made up
const MAC_BE = parseMac(MAC)!
const PID = 0x30d9 // an S400 (MJTZC01YM) product id from the reference device table
const PROFILE = { height_cm: 170, birth_date: '1990-03-15', sex: 'male' as const } // made up

const local = (y: number, mo: number, d: number, h: number, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime()

/** obj 0x6E16 for: kg, 50 kHz-or-250 kHz impedance (ohm), hr (bpm). */
function obj(o: Partial<S400Obj>): S400Obj {
  return { profileId: 1, massRaw: 0, hrRaw: 0, impedanceRaw: 0, scaleTs: 0, ...o }
}
function frame(o: S400Obj, counter: number, opts: { key?: Buffer; includeMac?: boolean; pid?: number } = {}): Buffer {
  return encodeMiBeaconV5({
    productId: opts.pid ?? PID,
    counter,
    macBE: MAC_BE,
    bindkey: opts.key ?? KEY,
    objects: [{ type: OBJ_S400, data: encodeObj6e16(o) }],
    includeMac: opts.includeMac,
  })
}

describe('AES-128-CCM (built on ECB)', () => {
  test('RFC 3610 packet vector #1 (13-byte nonce, 8-byte tag)', () => {
    const key = Buffer.from([...Array(16)].map((_, i) => 0xc0 + i))
    const nonce = Buffer.from('00000003020100a0a1a2a3a4a5', 'hex')
    const aad = Buffer.from([...Array(8)].map((_, i) => i))
    const pt = Buffer.from([...Array(23)].map((_, i) => 8 + i))
    const sealed = ccmEncrypt(key, nonce, pt, aad, 8)
    expect(sealed.toString('hex')).toBe('588c979a61c663d2f066d0c2c0f989806d5f6b61dac38417e8d12cfdf926e0')
    expect(ccmDecrypt(key, nonce, sealed, aad, 8)!.equals(pt)).toBe(true)
  })

  test('MiBeacon shape (12-byte nonce, aad 0x11, 4-byte MIC) matches an independent implementation', () => {
    // Vector produced by the Python `cryptography` AESCCM(tag_length=4) on the same synthetic inputs.
    const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
    const nonce = Buffer.from('a1b2c3d4e5f6d930070a0b0c', 'hex')
    const pt = Buffer.from('166e0901deadbeef00000000', 'hex')
    const sealed = ccmEncrypt(key, nonce, pt, Buffer.from([0x11]), 4)
    expect(sealed.toString('hex')).toBe('353f21906648c7b92be018c928d8276f')
    expect(ccmDecrypt(key, nonce, sealed, Buffer.from([0x11]), 4)!.equals(pt)).toBe(true)
  })

  test('a flipped bit anywhere fails authentication', () => {
    const nonce = Buffer.alloc(12, 7)
    const sealed = ccmEncrypt(KEY, nonce, Buffer.from('hello scale'), Buffer.from([0x11]), 4)
    for (const i of [0, 5, sealed.length - 1]) {
      const bad = Buffer.from(sealed)
      bad[i] ^= 1
      expect(ccmDecrypt(KEY, nonce, bad, Buffer.from([0x11]), 4)).toBeNull()
    }
  })
})

describe('MiBeacon frames', () => {
  test('v5 encrypted round trip: header, 32-bit counter, object list', () => {
    const o = obj({ massRaw: 804, impedanceRaw: 4805, hrRaw: 22 })
    const f = frame(o, 0x0a0b0c42)
    const h = parseMiBeaconHeader(f)!
    expect(h.version).toBe(5)
    expect(h.encrypted).toBe(true)
    expect(h.objectIncluded).toBe(true)
    expect(h.macIncluded).toBe(false)
    expect(h.productId).toBe(PID)
    expect(h.frameCounter).toBe(0x42)
    // header 5 + payload (3 + 9) + ext counter 3 + MIC 4
    expect(f.length).toBe(5 + 12 + 3 + 4)
    const r = decodeMiBeacon(f, MAC_BE, KEY)
    expect(r.kind).toBe('objects')
    if (r.kind !== 'objects') return
    expect(r.counter).toBe(0x0a0b0c42)
    expect(r.objects).toHaveLength(1)
    expect(r.objects[0].type).toBe(OBJ_S400)
    expect(parseObj6e16(r.objects[0].data)).toEqual(o)
  })

  test('a frame carrying its own MAC decrypts without config, and must agree with config', () => {
    const f = frame(obj({ massRaw: 700 }), 9, { includeMac: true })
    expect(parseMiBeaconHeader(f)!.macIncluded).toBe(true)
    expect(decodeMiBeacon(f, null, KEY).kind).toBe('objects')
    expect(decodeMiBeacon(f, MAC_BE, KEY).kind).toBe('objects')
    expect(decodeMiBeacon(f, parseMac('A4:C1:38:00:11:23'), KEY)).toEqual({ kind: 'reject', reason: 'mac_mismatch' })
  })

  test('rejections: wrong key, wrong MAC in the nonce, no MAC, no key', () => {
    const f = frame(obj({ massRaw: 700 }), 1)
    expect(decodeMiBeacon(f, MAC_BE, Buffer.alloc(16, 1))).toEqual({ kind: 'reject', reason: 'decrypt_failed' })
    expect(decodeMiBeacon(f, parseMac('A4:C1:38:00:11:23'), KEY)).toEqual({ kind: 'reject', reason: 'decrypt_failed' })
    expect(decodeMiBeacon(f, null, KEY)).toEqual({ kind: 'reject', reason: 'no_mac' })
    expect(decodeMiBeacon(f, MAC_BE, null)).toEqual({ kind: 'reject', reason: 'no_key' })
    expect(decodeMiBeacon(Buffer.from([0x58, 0x58]), MAC_BE, KEY)).toEqual({ kind: 'reject', reason: 'malformed' })
  })

  test('no-object frame is the idle beacon; capability bytes shift the payload', () => {
    expect(decodeMiBeacon(encodeIdleFrame(PID, 3), MAC_BE, KEY).kind).toBe('idle')
    // frame control with capability (0x20) whose IO bit (0x20) is set: 2 extra bytes
    const h = parseMiBeaconHeader(Buffer.from([0x60, 0x58, 0xd9, 0x30, 0x01, 0x20, 0x00]))!
    expect(h.payloadOffset).toBe(7)
    expect(parseMiBeaconHeader(Buffer.from([0x60, 0x58, 0xd9, 0x30, 0x01, 0x20]))).toBeNull()
    // mesh and pre-v2 frames are refused
    expect(parseMiBeaconHeader(Buffer.from([0xc8, 0x58, 0xd9, 0x30, 1]))).toBeNull()
    expect(parseMiBeaconHeader(Buffer.from([0x48, 0x10, 0xd9, 0x30, 1]))).toBeNull()
  })

  test('parseMac accepts colons, dashes, bare hex', () => {
    expect(parseMac('a4-c1-38-00-11-22')!.equals(MAC_BE)).toBe(true)
    expect(parseMac('A4C138001122')!.equals(MAC_BE)).toBe(true)
    expect(parseMac('nope')).toBeNull()
  })
})

describe('obj 0x6E16', () => {
  test('bit packing: mass 11 bits, hr 7 bits, impedance 14 bits, then the scale ts u32', () => {
    // profile 1; 80.4 kg (804); hr raw 22 (72 bpm); impedance 480.5 ohm (4805)
    const v = (804 | (22 << 11) | (4805 << 18)) >>> 0
    const b = Buffer.alloc(9)
    b[0] = 1
    b.writeUInt32LE(v, 1)
    b.writeUInt32LE(0xdeadbeef, 5) // the reference discards it; read as the scale ts
    expect(parseObj6e16(b)).toEqual({ profileId: 1, massRaw: 804, hrRaw: 22, impedanceRaw: 4805, scaleTs: 0xdeadbeef })
  })

  test('all-ones mass means no weight; wrong length is refused', () => {
    const b = encodeObj6e16(obj({ massRaw: 0x7ff, impedanceRaw: 5000 }))
    expect(parseObj6e16(b)!.massRaw).toBe(0)
    expect(parseObj6e16(Buffer.alloc(8))).toBeNull()
    expect(parseObj6e16(Buffer.alloc(10))).toBeNull()
  })
})

describe('weigh-in collapse', () => {
  const T0 = local(2026, 11, 16, 6, 30)

  test('repeats + 50 kHz frames + the 250 kHz closing frame = ONE reading', () => {
    const a = new WeighinAssembler()
    const out = [
      ...a.feed(obj({ massRaw: 805, impedanceRaw: 4790 }), 100, T0),
      ...a.feed(obj({ massRaw: 805, impedanceRaw: 4790 }), 100, T0 + 300), // same counter: dropped
      ...a.feed(obj({ massRaw: 804, impedanceRaw: 4805, hrRaw: 22 }), 101, T0 + 1500),
    ]
    expect(out).toHaveLength(0)
    const r = a.feed(obj({ impedanceRaw: 4320 }), 102, T0 + 3000)
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ kg: 80.4, impedanceLow: 480.5, impedanceHigh: 432, heartRate: 72, counter: 101, measuredAt: T0 + 1500, complete: true })
    // the scale keeps re-broadcasting: new counters, same weight, then the closing frame again
    expect(a.feed(obj({ massRaw: 804, impedanceRaw: 4805 }), 103, T0 + 4000)).toHaveLength(0)
    expect(a.feed(obj({ impedanceRaw: 4320 }), 104, T0 + 5000)).toHaveLength(0)
    expect(a.tick(T0 + 5000 + SETTLE_MS + 1)).toHaveLength(0)
  })

  test('stepping off (idle) closes a weight-only (socks) weigh-in; then a re-weigh counts again', () => {
    const a = new WeighinAssembler()
    expect(a.feed(obj({ massRaw: 812 }), 1, T0)).toHaveLength(0)
    const r = a.feed(obj({}), 2, T0 + 4000) // all-zero object = idle
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ kg: 81.2, impedanceLow: null, complete: false })
    expect(a.feedIdle(T0 + 5000)).toHaveLength(0)
    expect(a.feed(obj({ massRaw: 811 }), 3, T0 + 20_000)).toHaveLength(0)
    expect(a.feedIdle(T0 + 25_000)).toHaveLength(1)
  })

  test('a weigh-in with no closing frame settles after SETTLE_MS of quiet', () => {
    const a = new WeighinAssembler()
    a.feed(obj({ massRaw: 790, impedanceRaw: 5010 }), 7, T0)
    expect(a.tick(T0 + SETTLE_MS - 1)).toHaveLength(0)
    const r = a.tick(T0 + SETTLE_MS)
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ kg: 79, impedanceLow: 501, complete: false })
  })

  test('no weight ever = nothing; a clearly different weight right after is a new weigh-in', () => {
    const a = new WeighinAssembler()
    a.feed(obj({ impedanceRaw: 4000 }), 1, T0) // closing frame alone
    expect(a.feedIdle(T0 + 1000)).toHaveLength(0)
    a.feed(obj({ massRaw: 804, impedanceRaw: 4805 }), 2, T0 + 2000)
    expect(a.feed(obj({ impedanceRaw: 4300 }), 3, T0 + 3000)).toHaveLength(1)
    // someone else steps on before an idle frame was heard
    a.feed(obj({ massRaw: 612, impedanceRaw: 5600 }), 4, T0 + 10_000)
    const r = a.feed(obj({ impedanceRaw: 5100 }), 5, T0 + 12_000)
    expect(r).toHaveLength(1)
    expect(r[0].kg).toBe(61.2)
  })

  test('a counter is only deduped inside the window (an 8-bit-wrapped counter later is new data)', () => {
    const a = new WeighinAssembler()
    a.feed(obj({ massRaw: 800 }), 5, T0)
    a.feedIdle(T0 + 1000)
    expect(a.feed(obj({ massRaw: 800 }), 5, T0 + 30_000)).toHaveLength(0) // still deduped
    expect(a.feed(obj({ massRaw: 800 }), 5, T0 + 2 * SETTLE_MS)).toHaveLength(0)
    expect(a.feedIdle(T0 + 2 * SETTLE_MS + 1000)).toHaveLength(1)
  })
})

describe('body fat (Mi Scale formula port)', () => {
  // Expected values computed by hand from the published formula
  // (LBM = h*9.058/100*h/100 + w*0.32 + 12.226 - imp*0.0068 - age*0.0542;
  //  fat = (1 - (LBM - k) * coeff / w) * 100).
  test('male, female (>60 kg, >160 cm), light male', () => {
    expect(fatPercent(70, 170, 36, 'male', 500)).toBeCloseTo(21.9251, 3)
    expect(fatPercent(65, 165, 30, 'female', 550)).toBeCloseTo(34.48, 2)
    expect(fatPercent(58, 175, 20, 'male', 450)).toBeCloseTo(9.4647, 3)
  })

  test('caps and refusals mirror the reference', () => {
    expect(fatPercent(70, 170, 36, 'male', 0)).toBeNull()
    expect(fatPercent(70, 170, 36, 'male', 3001)).toBeNull()
    expect(fatPercent(250, 170, 36, 'male', 500)).toBeNull()
    expect(fatPercent(70, 230, 24, 'male', 500)).toBeNull()
    expect(fatPercent(70, 170, 100, 'male', 500)).toBeNull()
    expect(fatPercent(199, 120, 90, 'male', 2900)).toBe(75) // >63 jumps to 75
    expect(fatPercent(40, 200, 20, 'male', 100)).toBe(5) // floor (LBM exceeds weight)
  })

  test('age is whole years on the local calendar', () => {
    expect(ageAt('1990-03-15', local(2026, 3, 14, 12))).toBe(35)
    expect(ageAt('1990-03-15', local(2026, 3, 15, 0, 1))).toBe(36)
    expect(ageAt('15/03/1990', local(2026, 3, 15, 12))).toBeNull()
  })

  test('fraction like HealthKit, from the 50 kHz impedance only', () => {
    const at = local(2026, 11, 16, 6, 30)
    expect(fatFraction({ kg: 80.4, impedanceLow: 480.5, measuredAt: at }, PROFILE)).toBe(0.277) // 27.72 % at age 36
    expect(fatFraction({ kg: 80.4, impedanceLow: null, measuredAt: at }, PROFILE)).toBeNull()
    expect(fatFraction({ kg: 80.4, impedanceLow: 480.5, measuredAt: at }, undefined)).toBeNull()
    expect(fatFraction({ kg: 80.4, impedanceLow: 480.5, measuredAt: at }, { height_cm: 170 })).toBeNull()
  })
})

describe('bindkey from the Keychain (spawn injected, never the real Keychain)', () => {
  test('account-scoped first, then service-only; the value is validated', async () => {
    const calls: string[][] = []
    const spawn = (argv: string[]) => {
      calls.push(argv)
      const acct = argv.includes('-a') ? argv[argv.indexOf('-a') + 1] : null
      return acct === null
        ? { exitCode: 0, stdout: Buffer.from(KEY.toString('hex') + '\n') }
        : { exitCode: 44, stdout: Buffer.from('') }
    }
    const key = await readBindkeyFromKeychain({ did: 'blt.3.synthetic', mac: MAC }, spawn)
    expect(key!.equals(KEY)).toBe(true)
    expect(calls.map((c) => (c.includes('-a') ? c[c.indexOf('-a') + 1] : null))).toEqual(['blt.3.synthetic', MAC, null])
    for (const c of calls) expect(c.slice(0, 4)).toEqual(['/usr/bin/security', 'find-generic-password', '-s', 'dev.s400-bindkey'])
    expect(await readBindkeyFromKeychain(undefined, () => ({ exitCode: 0, stdout: Buffer.from('not-hex') }))).toBeNull()
    expect(await readBindkeyFromKeychain(undefined, () => ({ exitCode: 44, stdout: Buffer.from('') }))).toBeNull()
  })

  test('a locked keychain, a denied dialog, or a timeout stops the search (no more prompts)', async () => {
    for (const exitCode of [51, 128, null]) {
      const calls: string[][] = []
      const spawn = async (argv: string[]) => {
        calls.push(argv)
        return { exitCode, stdout: Buffer.from('') }
      }
      expect(await readBindkeyFromKeychain({ keychain_account: 'acct', did: 'blt.3.synthetic', mac: MAC }, spawn)).toBeNull()
      expect(calls).toHaveLength(1)
    }
    // a throwing spawn is a stop too, never an exception
    expect(await readBindkeyFromKeychain({ mac: MAC }, () => { throw new Error('boom') })).toBeNull()
  })
})

// ── daemon path: frames -> ScaleService -> FoodService ──────────────

function harness(scaleCfg: ScaleConfig | undefined, keyed = true, extra: Partial<ScaleDeps> = {}, startAt = local(2026, 11, 16, 6, 30)) {
  const dir = mkdtempSync(join(tmpdir(), 'health-scale-'))
  const store = new Store(':memory:')
  const events: Array<{ cls: string; key: string; content: string; meta: Record<string, string> }> = []
  const meta = new Map<string, string>()
  const logs: string[] = []
  let now = startAt
  const food = new FoodService({
    db: store.db,
    photosDir: join(dir, 'meals'),
    getConfig: () => DEFAULT_CONFIG.food,
    getMeta: (k) => meta.get(k) ?? null,
    setMeta: (k, v) => void meta.set(k, v),
    emit: (cls, key, p) => {
      events.push({ cls, key, ...p })
      return true
    },
    broadcast: () => {},
    now: () => now,
  })
  let keyReads = 0
  const scale = new ScaleService({
    getConfig: () => scaleCfg,
    ingest: (samples, raw) => food.ingestBodySamples(samples, [], raw),
    readBindkey: () => {
      keyReads++
      return keyed ? KEY : null
    },
    now: () => now,
    log: (m) => void logs.push(m),
    ...extra,
  })
  return {
    store,
    food,
    scale,
    events,
    logs,
    keyReads: () => keyReads,
    advance: (ms: number) => (now += ms),
    /** A second service on the same store: a daemon restart. */
    restart: (more: Partial<ScaleDeps> = {}) =>
      new ScaleService({
        getConfig: () => scaleCfg,
        ingest: (samples, raw) => food.ingestBodySamples(samples, [], raw),
        readBindkey: () => (keyed ? KEY : null),
        now: () => now,
        log: (m) => void logs.push(m),
        ...extra,
        ...more,
      }),
    now: () => now,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

const hex = (b: Buffer) => b.toString('hex')

describe('ScaleService -> ingestBodySamples', () => {
  const cleanup: Array<() => void> = []
  afterEach(() => {
    while (cleanup.length) cleanup.pop()!()
  })

  test('one weigh-in lands once as mass + fat, source S400 BLE, and fires body.weighin', () => {
    const h = harness({ mac: MAC, profile: PROFILE })
    cleanup.push(h.cleanup)
    const t = h.now()
    expect(h.scale.ingestFrame(hex(frame(obj({ massRaw: 804, impedanceRaw: 4805 }), 0x100)))).toEqual({ accepted: true, readings: 0 })
    h.scale.ingestFrame(hex(frame(obj({ massRaw: 804, impedanceRaw: 4805 }), 0x100))) // repeat
    h.advance(2000)
    expect(h.scale.ingestFrame(hex(frame(obj({ impedanceRaw: 4320 }), 0x101))).readings).toBe(1)
    h.advance(1000)
    h.scale.ingestFrame(hex(frame(obj({ impedanceRaw: 4320 }), 0x102)))
    h.scale.ingestFrame(hex(encodeIdleFrame(PID, 0x03)))
    h.advance(SETTLE_MS * 2)
    expect(h.scale.tick()).toBe(0)

    const rows = h.food.weighins(2)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kg: 80.4, fat_pct: 27.7, source: 'S400 BLE', measured_at: new Date(t).toISOString() })
    expect(rows[0].uuids).toEqual([
      readingUuid({ counter: 0x100, measuredAt: t }, 'mass'),
      readingUuid({ counter: 0x100, measuredAt: t }, 'fat'),
    ])
    const w = h.events.filter((e) => e.cls === 'body.weighin')
    expect(w).toHaveLength(1)
    expect(w[0].key).toBe(`body.weighin:S400 BLE:${new Date(t).toISOString()}`)
    // the log says THAT it landed, never the body numbers
    expect(h.logs.join('\n')).not.toMatch(/80\.4|27\.|480/)
  })

  test('the scanner ts is the measured time when sane', () => {
    const h = harness({ mac: MAC })
    cleanup.push(h.cleanup)
    const scannerTs = h.now() - 90_000
    h.scale.ingestFrame(hex(frame(obj({ massRaw: 799 }), 7)), scannerTs)
    h.scale.ingestFrame(hex(encodeIdleFrame(PID, 8)), scannerTs + 5000)
    expect(h.food.weighins(2)[0]).toMatchObject({ kg: 79.9, fat_pct: null, measured_at: new Date(scannerTs).toISOString() })
    expect(receiveTime(h.now() - 11 * 60_000, h.now())).toBe(h.now())
    expect(receiveTime('garbage', h.now())).toBe(h.now())
  })

  test('foreign product ids, wrong keys, and a missing key never ingest', () => {
    const h = harness({ mac: MAC })
    cleanup.push(h.cleanup)
    expect(h.scale.ingestFrame(hex(frame(obj({ massRaw: 804 }), 1, { pid: 0x0123 })))).toEqual({ accepted: false, reason: 'not_s400', readings: 0 })
    expect(h.scale.ingestFrame(hex(frame(obj({ massRaw: 804 }), 2, { key: Buffer.alloc(16, 9) }))).reason).toBe('decrypt_failed')
    expect(h.food.weighins(2)).toHaveLength(0)

    const nk = harness({ mac: MAC }, false)
    cleanup.push(nk.cleanup)
    expect(nk.scale.ingestFrame(hex(frame(obj({ massRaw: 804 }), 1))).reason).toBe('no_key')
    nk.scale.ingestFrame(hex(frame(obj({ massRaw: 804 }), 2)))
    expect(nk.keyReads()).toBe(1) // retried at most every 10 min, not per frame
    expect(nk.logs.some((l) => /no bindkey/.test(l))).toBe(true)
  })

  test('a configured product id override is accepted', () => {
    const h = harness({ mac: MAC, product_id: '0x0123' })
    cleanup.push(h.cleanup)
    expect(h.scale.ingestFrame(hex(frame(obj({ massRaw: 804 }), 1, { pid: 0x0123 }))).accepted).toBe(true)
  })
})

describe('POST /scale-adv over the live listener', () => {
  const TOKEN = 'synthetic-token-5678'
  const cleanup: Array<() => void> = []
  afterEach(() => {
    while (cleanup.length) cleanup.pop()!()
  })

  function listen(scale: ScaleService) {
    const state = new LiveState({ getMaxHr: () => 190, getRestHr: () => 56, getHotBpm: () => null, emit: () => {} })
    const listener = new LiveListener(state, () => TOKEN, { scaleHttp: (req, url) => scale.handleHttp(req, url) })
    listener.start(0, '127.0.0.1')
    // @ts-expect-error reach into the private server for the assigned port
    const port = listener.server.port as number
    cleanup.push(() => listener.stop())
    return `http://127.0.0.1:${port}/scale-adv`
  }

  test('requires the token, validates the body, and reaches the decoder', async () => {
    const h = harness({ mac: MAC })
    cleanup.push(h.cleanup)
    const url = listen(h.scale)
    const body = JSON.stringify({ frame_hex: hex(frame(obj({ massRaw: 804 }), 1)), rssi: -60, ts: h.now() })
    expect((await fetch(url, { method: 'POST', body })).status).toBe(401)
    expect((await fetch(`${url}?token=wrong`, { method: 'POST', body })).status).toBe(401)
    expect(h.scale.stats.frames).toBe(0)
    const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
    const ok = await fetch(url, { method: 'POST', body, headers: auth })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ ok: true, accepted: true, readings: 0 })
    expect((await fetch(url, { method: 'POST', body: JSON.stringify({ frame_hex: 'zz' }), headers: auth })).status).toBe(400)
    expect((await fetch(url, { method: 'POST', body: 'not json', headers: auth })).status).toBe(400)
    expect((await fetch(url, { method: 'GET', headers: auth })).status).toBe(405)
  })
})

// ── review fixes ────────────────────────────────────────────────────

/** An UNENCRYPTED v5 frame carrying objects (what a spoofer would send). */
function plainFrame(o: S400Obj, frameCounter: number, pid = PID): Buffer {
  const head = Buffer.alloc(5)
  head.writeUInt16LE(0x5000 | 0x0800 | 0x40, 0) // object included, NOT encrypted
  head.writeUInt16LE(pid, 2)
  head[4] = frameCounter & 0xff
  const data = encodeObj6e16(o)
  return Buffer.concat([head, Buffer.from([OBJ_S400 & 0xff, OBJ_S400 >> 8, data.length]), data])
}

describe('unencrypted objects are refused (no bindkey bypass)', () => {
  const cleanup: Array<() => void> = []
  afterEach(() => {
    while (cleanup.length) cleanup.pop()!()
  })

  test('decode: an unencrypted 0x6E16 object is rejected; the unencrypted idle frame is still idle', () => {
    const f = plainFrame(obj({ massRaw: 1234 }), 1)
    expect(parseMiBeaconHeader(f)!.encrypted).toBe(false)
    expect(decodeMiBeacon(f, MAC_BE, KEY)).toEqual({ kind: 'reject', reason: 'unencrypted' })
    expect(decodeMiBeacon(f, MAC_BE, null)).toEqual({ kind: 'reject', reason: 'unencrypted' })
    expect(decodeMiBeacon(encodeIdleFrame(PID, 2), MAC_BE, null).kind).toBe('idle')
  })

  test('service: a spoofed plaintext weigh-in plus idle ingests nothing, with or without a key', () => {
    for (const keyed of [false, true]) {
      const h = harness({ mac: MAC }, keyed)
      cleanup.push(h.cleanup)
      expect(h.scale.ingestFrame(hex(plainFrame(obj({ massRaw: 1234 }), 1)))).toEqual({ accepted: false, reason: 'unencrypted', readings: 0 })
      h.scale.ingestFrame(hex(encodeIdleFrame(PID, 2)))
      expect(h.keyReads()).toBe(0) // the frames never even reached the key
      h.advance(SETTLE_MS * 2)
      h.scale.tick() // (the timer's own missing-key retry may read it here)
      expect(h.food.weighins(2)).toHaveLength(0)
      expect(h.events.filter((e) => e.cls === 'body.weighin')).toHaveLength(0)
    }
  })
})

describe('reference captures (xiaomi-ble public S400 test vectors)', () => {
  // xiaomi-ble tests/test_parser.py test_Xiaomi_Scale_S400_MJTZC01YM (+ _packet_2):
  // public MIT fixtures with a public test bindkey. Real S400 frames carry no
  // MAC, so the configured one is mandatory.
  const REF_KEY = Buffer.from('0728974d657a4b60964c1b1677f35f7c', 'hex')
  const REF_MAC = '8C:D0:B2:F6:BE:EF'
  const P1 = Buffer.from('4859d53b0abc078ff2348c844138e930220000009e538599', 'hex')
  const P2 = Buffer.from('4859d53b0bd6ef0b25db72785e7e2f46d6000000d8642df6', 'hex')
  const REF_TS = 0x67f726ed // 2025-04-10T02:03:25Z, shared by both packets

  test('both decrypt and authenticate: v5 nonce, aad 0x11, 4-byte MIC, 0x6E16 layout', () => {
    const r1 = decodeMiBeacon(P1, parseMac(REF_MAC), REF_KEY)
    const r2 = decodeMiBeacon(P2, parseMac(REF_MAC), REF_KEY)
    if (r1.kind !== 'objects' || r2.kind !== 'objects') throw new Error('reference capture did not decode')
    expect(r1.header).toMatchObject({ version: 5, productId: 0x3bd5, macIncluded: false, encrypted: true })
    expect(r1.counter).toBe(10)
    expect(r2.counter).toBe(11)
    expect(r1.objects.map((o) => o.type)).toEqual([OBJ_S400])
    expect(parseObj6e16(r1.objects[0].data)).toEqual({ profileId: 1, massRaw: 699, hrRaw: 42, impedanceRaw: 5432, scaleTs: REF_TS })
    expect(parseObj6e16(r2.objects[0].data)).toEqual({ profileId: 1, massRaw: 0, hrRaw: 0, impedanceRaw: 4976, scaleTs: REF_TS })
    expect(decodeMiBeacon(P1, null, REF_KEY)).toEqual({ kind: 'reject', reason: 'no_mac' })
    expect(decodeMiBeacon(P1, parseMac(REF_MAC), KEY)).toEqual({ kind: 'reject', reason: 'decrypt_failed' })
  })

  test('the assembler collapses them into exactly one complete reading (69.9 kg, HR 92, 543.2 / 497.6 ohm)', () => {
    const a = new WeighinAssembler()
    const at = REF_TS * 1000 + 2000
    const out: ReturnType<WeighinAssembler['feed']> = []
    for (const [f, dt] of [[P1, 0], [P1, 300], [P2, 1500], [P2, 1800]] as const) {
      const r = decodeMiBeacon(f, parseMac(REF_MAC), REF_KEY)
      if (r.kind !== 'objects') throw new Error('decode')
      out.push(...a.feed(parseObj6e16(r.objects[0].data)!, r.counter, at + dt))
    }
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ kg: 69.9, impedanceLow: 543.2, impedanceHigh: 497.6, heartRate: 92, complete: true, scaleTs: REF_TS, measuredAt: REF_TS * 1000 })
  })

  test('end to end through ScaleService: one S400 BLE row stamped with the scale ts', () => {
    const h = harness({ mac: REF_MAC }, true, { readBindkey: () => REF_KEY }, REF_TS * 1000 + 3000)
    try {
      h.scale.ingestFrame(hex(P1))
      expect(h.scale.ingestFrame(hex(P2)).readings).toBe(1)
      h.scale.ingestFrame(hex(P2))
      const rows = h.food.weighins(1000)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ kg: 69.9, source: 'S400 BLE', measured_at: new Date(REF_TS * 1000).toISOString() })
      expect(rows[0].uuids[0]).toBe(readingUuid({ counter: 10, measuredAt: 0, scaleTs: REF_TS }, 'mass'))
    } finally {
      h.cleanup()
    }
  })
})

describe('impedance classification follows the reference order', () => {
  test('mass 0 + hr set + impedance = 50 kHz (not dropped); mass 0 + hr 0 + impedance = closing', () => {
    const T = local(2026, 11, 16, 6, 30)
    const a = new WeighinAssembler()
    a.feed(obj({ massRaw: 804 }), 1, T)
    expect(a.feed(obj({ hrRaw: 22, impedanceRaw: 4805 }), 2, T + 500)).toHaveLength(0)
    const r = a.feed(obj({ impedanceRaw: 4320 }), 3, T + 1500)
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ kg: 80.4, impedanceLow: 480.5, impedanceHigh: 432, heartRate: 72, complete: true })
  })
})

describe('scale timestamp (obj 0x6E16 second u32)', () => {
  test('plausibility window: a day for identity', () => {
    const at = local(2026, 11, 16, 6, 30)
    const ts = Math.floor(at / 1000)
    expect(plausibleScaleTs(ts, at)).toBe(ts)
    expect(plausibleScaleTs(ts - 23 * 3600, at)).toBe(ts - 23 * 3600)
    expect(plausibleScaleTs(ts - 25 * 3600, at)).toBeNull()
    expect(plausibleScaleTs(0, at)).toBeNull()
  })

  test('identity in the uuid; measured time only when close to the receive time', () => {
    const T = local(2026, 11, 16, 6, 30)
    const near = Math.floor(T / 1000) - 30
    const a = new WeighinAssembler()
    a.feed(obj({ massRaw: 804, impedanceRaw: 4805, scaleTs: near }), 1, T)
    const [r] = a.feed(obj({ impedanceRaw: 4320, scaleTs: near }), 2, T + 1000)
    expect(r).toMatchObject({ scaleTs: near, measuredAt: near * 1000 })
    expect(readingUuid(r, 'mass')).toBe(`s400-t${near.toString(16).padStart(8, '0')}-m`)
    // 7 h off (a local-time-as-UTC clock): still the identity, not the time
    const off = Math.floor(T / 1000) - 7 * 3600
    const b = new WeighinAssembler()
    b.feed(obj({ massRaw: 804, scaleTs: off }), 1, T)
    const [r2] = b.feedIdle(T + 1000)
    expect(r2).toMatchObject({ scaleTs: off, measuredAt: T })
  })

  test('a re-broadcast of the same measurement long after is swallowed by its ts', () => {
    const T = local(2026, 11, 16, 6, 30)
    const ts = Math.floor(T / 1000)
    const a = new WeighinAssembler()
    a.feed(obj({ massRaw: 804, scaleTs: ts }), 1, T)
    expect(a.feed(obj({ impedanceRaw: 4320, scaleTs: ts }), 2, T + 1000)).toHaveLength(1)
    expect(a.feed(obj({ massRaw: 804, scaleTs: ts }), 3, T + 5 * SETTLE_MS)).toHaveLength(0)
  })

  test('a daemon restart mid weigh-in lands ONE row (same scale-ts uuid)', () => {
    let hwm: number | null = null
    const persist = { loadHighWater: () => hwm, saveHighWater: (n: number | null) => void (hwm = n) }
    const h = harness({ mac: MAC }, true, persist)
    try {
      const ts = Math.floor(h.now() / 1000)
      h.scale.ingestFrame(hex(frame(obj({ massRaw: 804, impedanceRaw: 4805, scaleTs: ts }), 0x200)))
      h.advance(SETTLE_MS) // daemon restarts; the old session settles as partial
      h.scale.tick()
      const fresh = h.restart()
      fresh.ingestFrame(hex(frame(obj({ massRaw: 804, impedanceRaw: 4805, scaleTs: ts }), 0x201)))
      fresh.ingestFrame(hex(frame(obj({ impedanceRaw: 4320, scaleTs: ts }), 0x202)))
      expect(h.food.weighins(2)).toHaveLength(1)
      expect(h.events.filter((e) => e.cls === 'body.weighin')).toHaveLength(1)
    } finally {
      h.cleanup()
    }
  })
})

describe('replay guard (32-bit counter high-water mark)', () => {
  const cleanup: Array<() => void> = []
  afterEach(() => {
    while (cleanup.length) cleanup.pop()!()
  })

  function persisted() {
    const box = { hwm: null as number | null }
    return { box, deps: { loadHighWater: () => box.hwm, saveHighWater: (n: number | null) => void (box.hwm = n) } }
  }

  test('a sniffed weigh-in re-broadcast later never lands as a new row, even across a restart', () => {
    const p = persisted()
    const h = harness({ mac: MAC }, true, p.deps)
    cleanup.push(h.cleanup)
    const captured = [frame(obj({ massRaw: 804, impedanceRaw: 4805 }), 0x300), frame(obj({ impedanceRaw: 4320 }), 0x301)]
    for (const f of captured) h.scale.ingestFrame(hex(f))
    expect(h.food.weighins(2)).toHaveLength(1)
    expect(p.box.hwm).toBe(0x301)

    // the scale moves on
    h.advance(3_600_000)
    h.scale.ingestFrame(hex(frame(obj({ massRaw: 801, impedanceRaw: 4810 }), 0x340)))
    h.scale.ingestFrame(hex(frame(obj({ impedanceRaw: 4330 }), 0x341)))
    expect(h.food.weighins(2)).toHaveLength(2)

    // an hour later the attacker replays the old capture: below the mark, refused
    h.advance(3_600_000)
    expect(h.scale.ingestFrame(hex(captured[0]))).toEqual({ accepted: false, reason: 'replay', readings: 0 })
    h.scale.ingestFrame(hex(captured[1]))
    h.advance(SETTLE_MS * 2)
    h.scale.tick()
    expect(h.food.weighins(2)).toHaveLength(2)

    // a restart reloads the mark: still refused
    const fresh = h.restart()
    expect(fresh.ingestFrame(hex(captured[0])).reason).toBe('replay')
    expect(h.food.weighins(2)).toHaveLength(2)
    expect(h.logs.some((l) => /replay/.test(l))).toBe(true)
  })

  test('the newest frame re-broadcast after its weigh-in is a quiet duplicate, not a second reading', () => {
    const h = harness({ mac: MAC })
    cleanup.push(h.cleanup)
    h.scale.ingestFrame(hex(frame(obj({ massRaw: 804 }), 0x400)))
    h.advance(SETTLE_MS * 3)
    expect(h.scale.tick()).toBe(1) // settled (weight only)
    expect(h.scale.ingestFrame(hex(frame(obj({ massRaw: 804 }), 0x400)))).toEqual({ accepted: true, reason: 'duplicate', readings: 0 })
    h.advance(SETTLE_MS * 3)
    h.scale.tick()
    expect(h.food.weighins(2)).toHaveLength(1)
  })

  test('slightly reordered frames inside a live weigh-in still count', () => {
    const h = harness({ mac: MAC })
    cleanup.push(h.cleanup)
    h.scale.ingestFrame(hex(frame(obj({ massRaw: 804 }), 0x502)))
    h.scale.ingestFrame(hex(frame(obj({ massRaw: 804, impedanceRaw: 4805, hrRaw: 22 }), 0x501))) // arrived late
    expect(h.scale.ingestFrame(hex(frame(obj({ impedanceRaw: 4320 }), 0x503))).readings).toBe(1)
    expect(h.food.weighins(2)[0]).toMatchObject({ kg: 80.4, fat_pct: null })
  })

  test('a counter reset is accepted only after a long gap AND with a fresh scale timestamp', () => {
    const p = persisted()
    p.box.hwm = 0x00ff_0000
    const h = harness({ mac: MAC }, true, p.deps)
    cleanup.push(h.cleanup)
    const nowTs = () => Math.floor(h.now() / 1000)
    // stale scale ts (a replay of an old frame): refused
    expect(h.scale.ingestFrame(hex(frame(obj({ massRaw: 804, scaleTs: nowTs() - 30 * 86_400 }), 5))).reason).toBe('replay')
    // fresh ts but no long gap since an accepted frame: refused
    h.scale.ingestFrame(hex(frame(obj({ massRaw: 804 }), 0x00ff_0001)))
    h.advance(3_600_000)
    expect(h.scale.ingestFrame(hex(frame(obj({ massRaw: 804, scaleTs: nowTs() }), 6))).reason).toBe('replay')
    // 6 h of quiet + fresh ts: a real reset, accepted, mark follows it
    h.advance(6 * 3_600_000)
    expect(h.scale.ingestFrame(hex(frame(obj({ massRaw: 805, scaleTs: nowTs() }), 7))).accepted).toBe(true)
    expect(p.box.hwm).toBe(7)
    expect(h.logs.some((l) => /counter reset/.test(l))).toBe(true)
  })
})

describe('bindkey lifecycle', () => {
  test('a stale cached key is re-read after repeated decrypt failures (no daemon restart needed)', () => {
    const OLD = Buffer.alloc(16, 0x33)
    let current = OLD
    let reads = 0
    let hwm: number | null = 0x10
    const h = harness({ mac: MAC }, true, {
      readBindkey: () => {
        reads++
        return current
      },
      loadHighWater: () => hwm,
      saveHighWater: (n) => void (hwm = n),
    })
    try {
      // daemon booted with the old key; the scale was re-paired and scale-bindkey re-run
      expect(h.scale.ingestFrame(hex(frame(obj({ massRaw: 804 }), 1))).reason).toBe('decrypt_failed')
      expect(reads).toBe(1)
      current = KEY
      h.advance(61_000)
      expect(h.scale.ingestFrame(hex(frame(obj({ massRaw: 804 }), 2))).reason).toBe('decrypt_failed') // 2nd: re-read fires
      expect(reads).toBe(2)
      expect(hwm).toBeNull() // new pairing epoch: the mark resets
      expect(h.scale.ingestFrame(hex(frame(obj({ massRaw: 804 }), 3))).accepted).toBe(true)
      expect(h.logs.some((l) => /bindkey changed/.test(l))).toBe(true)
      // re-reads are rate-limited to one a minute
      h.scale.ingestFrame(hex(frame(obj({ massRaw: 804 }), 4)))
      for (let i = 0; i < 5; i++) h.scale.ingestFrame(hex(frame(obj({ massRaw: 804 }), 10 + i, { key: Buffer.alloc(16, 9) })))
      expect(reads).toBe(2)
      expect(h.logs.join('\n')).not.toContain(KEY.toString('hex'))
    } finally {
      h.cleanup()
    }
  })

  test('a key stored after boot is picked up within a minute, not ten', () => {
    let stored: Buffer | null = null
    const h = harness({ mac: MAC }, true, { readBindkey: () => stored })
    try {
      expect(h.scale.ingestFrame(hex(frame(obj({ massRaw: 804 }), 1))).reason).toBe('no_key')
      stored = KEY
      h.advance(30_000)
      expect(h.scale.ingestFrame(hex(frame(obj({ massRaw: 804 }), 2))).reason).toBe('no_key')
      h.advance(31_000)
      expect(h.scale.ingestFrame(hex(frame(obj({ massRaw: 804 }), 3))).accepted).toBe(true)
    } finally {
      h.cleanup()
    }
  })

  test('an async (slow) Keychain read never blocks a frame; frames decode once it settles', async () => {
    let release: (k: Buffer | null) => void = () => {}
    const h = harness({ mac: MAC }, true, { readBindkey: () => new Promise<Buffer | null>((r) => (release = r)) })
    try {
      h.scale.start(60_000)
      expect(h.scale.ingestFrame(hex(frame(obj({ massRaw: 804 }), 1))).reason).toBe('no_key') // returns at once
      release(KEY)
      await h.scale.keySettled()
      expect(h.scale.hasKey()).toBe(true)
      expect(h.scale.ingestFrame(hex(frame(obj({ massRaw: 804 }), 2))).accepted).toBe(true)
    } finally {
      h.scale.stop()
      h.cleanup()
    }
  })
})

describe('frame outcome log', () => {
  const post = (scale: ScaleService, frameHex: string) =>
    scale.handleHttp(
      new Request('http://127.0.0.1/scale-adv', { method: 'POST', body: JSON.stringify({ frame_hex: frameHex }) }),
      new URL('http://127.0.0.1/scale-adv'),
    )

  test('a refused (no_key) post and its accepted re-post are both logged; a repeat outcome is not', async () => {
    let release: (k: Buffer | null) => void = () => {}
    const h = harness({ mac: MAC }, true, { readBindkey: () => new Promise<Buffer | null>((r) => (release = r)) })
    try {
      const f = hex(frame(obj({ massRaw: 804 }), 0x2a))
      await post(h.scale, f) // boot: the Keychain read is still in flight
      await post(h.scale, f) // the listener re-posts: same outcome, no new line
      release(KEY)
      await h.scale.keySettled()
      h.advance(2_000) // well inside SETTLE_MS
      const res = await (await post(h.scale, f))!.json()
      expect(res).toMatchObject({ accepted: true })
      const lines = h.logs.filter((l) => l.startsWith('scale: frame #42 '))
      expect(lines).toEqual(['scale: frame #42 with object -> refused (no_key), readings 0', 'scale: frame #42 with object -> accepted, readings 0'])
    } finally {
      h.cleanup()
    }
  })

  test('firstFrameOutcome: one per (counter, verdict) within SETTLE_MS', () => {
    const seen = new Map<string, number>()
    expect(firstFrameOutcome(seen, 7, 'refused (no_key)', 0)).toBe(true)
    expect(firstFrameOutcome(seen, 7, 'refused (no_key)', 1_000)).toBe(false)
    expect(firstFrameOutcome(seen, 7, 'accepted', 1_000)).toBe(true)
    expect(firstFrameOutcome(seen, 8, 'refused (no_key)', 1_000)).toBe(true)
    expect(firstFrameOutcome(seen, 7, 'accepted', 2_000)).toBe(false)
    // Past SETTLE_MS the counter (one byte, it wraps) may log again.
    expect(firstFrameOutcome(seen, 7, 'refused (no_key)', SETTLE_MS + 1)).toBe(true)
  })
})
