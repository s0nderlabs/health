// Xiaomi S400 body-composition scale over passive BLE.
//
// relayer/scale-listen.swift is a dumb pipe: it hears the scale's MiBeacon
// advertisements (service data UUID 0xFE95), and POSTs each new frame RAW to
// the daemon's live listener at POST /scale-adv. Everything else lives here:
// MiBeacon header parse, v4/v5 AES-128-CCM decryption with the bindkey, the
// 0x6E16 weigh-in object, the per-weigh-in collapse, and the body-fat formula.
// A finished weigh-in lands through FoodService.ingestBodySamples with source
// 'S400 BLE', so the body.weighin event and every exclusion rule apply as-is.
//
// Frame layout and the 0x6E16 bit packing follow the open-source xiaomi-ble
// parser (MIT); the body-fat formula is the published Mi Scale one
// (xiaomi_mi_scale, Xiaomi_Scale_Body_Metrics.py). Neither is imported.
//
// SECRETS: the bindkey is read from the Keychain (async, with a timeout, so a
// locked keychain never stalls the daemon), cached in memory, re-read when
// frames keep failing to authenticate, and never logged, echoed, or put in an
// error message.
//
// AUTHENTICITY: only encrypted (bindkey-authenticated) weigh-in objects are
// accepted, and a persisted high-water mark on the 32-bit MiBeacon counter
// stops a sniffed advertisement from being replayed later as a new weigh-in.

import { createCipheriv, timingSafeEqual } from 'node:crypto'
import type { ScaleConfig } from './types.js'
import type { ScaleRaw } from './scalecal.js'

// ── constants ───────────────────────────────────────────────────────

/** MiBeacon product ids the reference maps to MJTZC01YM (Smart Scale S400). */
export const S400_PRODUCT_IDS: readonly number[] = [0x30d9, 0x3bd5, 0x48cf, 0x4fc2]
export const OBJ_S400 = 0x6e16
export const KEYCHAIN_SERVICE = 'dev.s400-bindkey'
export const SCALE_SOURCE = 'S400 BLE'
/** Collapse window: repeats of one weigh-in inside this window are one reading,
 *  and a weigh-in with no closing frame settles after this much quiet. */
export const SETTLE_MS = 60_000
/** Re-read the bindkey from the Keychain at most this often. */
const KEY_RETRY_MS = 60_000
/** Each reject reason is logged at most this often. */
const LOG_EVERY_MS = 10 * 60_000
/** Consecutive authentication failures that trigger a Keychain re-read (the
 *  reference's threshold for "the key is wrong"). */
const DECRYPT_FAILS_BEFORE_RELOAD = 2
/** One `security` lookup may take this long before it is killed. */
const KEYCHAIN_TIMEOUT_MS = 5_000
/** Counters this close below the high-water mark are in-order frames of the
 *  weigh-in in progress (the listener can reorder a few). */
const COUNTER_WINDOW = 16
/** A backwards counter jump is a scale reset (not a replay) only after this
 *  much quiet AND with a fresh scale timestamp inside the authenticated
 *  object: a replayed frame carries its original, old timestamp. */
const RESET_GAP_MS = 6 * 3_600_000
/** The obj 0x6E16 scale timestamp is an identity when within this of the
 *  receive time (UNVERIFIED on his unit: two reference captures only). */
const SCALE_TS_ID_SLACK_MS = 86_400_000
/** ...and the measured time only when within this (a scale clock stored as
 *  local-time-as-UTC would be hours off). */
const SCALE_TS_TIME_SLACK_MS = 15 * 60_000
/** A same-person re-weigh differs by less than this; more = someone else. */
const SAME_WEIGHIN_KG = 0.5

// ── AES-128-CCM (RFC 3610) over AES-ECB ─────────────────────────────
// Bun's node:crypto has no 'aes-128-ccm' (getCiphers() lists none, and
// createCipheriv throws "Unknown cipher"), so CCM is built from single-block
// AES-ECB: CBC-MAC for the tag, CTR for the payload.

function blockCipher(key: Buffer): (block: Buffer) => Buffer {
  if (key.length !== 16) throw new Error('CCM key must be 16 bytes')
  const c = createCipheriv('aes-128-ecb', key, null)
  c.setAutoPadding(false)
  return (block) => c.update(block)
}

function ccmCore(
  E: (b: Buffer) => Buffer,
  nonce: Buffer,
  plaintext: Buffer,
  aad: Buffer,
  tagLen: number,
): { tag: Buffer; keystream: (n: number) => Buffer } {
  const L = 15 - nonce.length
  if (L < 2 || L > 8) throw new Error('CCM nonce must be 7..13 bytes')
  if (tagLen < 4 || tagLen > 16 || tagLen % 2) throw new Error('CCM tag length must be 4..16, even')
  if (aad.length >= 0xff00) throw new Error('CCM aad too long')
  // B0: flags | nonce | message length (L bytes, big-endian)
  const b0 = Buffer.alloc(16)
  b0[0] = (aad.length > 0 ? 0x40 : 0) | (((tagLen - 2) / 2) << 3) | (L - 1)
  nonce.copy(b0, 1)
  let len = plaintext.length
  for (let i = 15; i > 15 - L; i--) {
    b0[i] = len & 0xff
    len = Math.floor(len / 256)
  }
  let x = E(b0)
  const mac = (data: Buffer) => {
    for (let off = 0; off < data.length; off += 16) {
      const blk = Buffer.alloc(16)
      data.copy(blk, 0, off, Math.min(off + 16, data.length))
      for (let i = 0; i < 16; i++) blk[i] ^= x[i]
      x = E(blk)
    }
  }
  if (aad.length > 0) {
    const a = Buffer.alloc(2 + aad.length)
    a.writeUInt16BE(aad.length, 0)
    aad.copy(a, 2)
    mac(a)
  }
  mac(plaintext)
  const ctr = (i: number) => {
    const a = Buffer.alloc(16)
    a[0] = L - 1
    nonce.copy(a, 1)
    let n = i
    for (let j = 15; j > 15 - L; j--) {
      a[j] = n & 0xff
      n = Math.floor(n / 256)
    }
    return E(a)
  }
  const s0 = ctr(0)
  const tag = Buffer.alloc(tagLen)
  for (let i = 0; i < tagLen; i++) tag[i] = x[i] ^ s0[i]
  const keystream = (n: number) => {
    const out = Buffer.alloc(n)
    for (let off = 0, i = 1; off < n; off += 16, i++) ctr(i).copy(out, off, 0, Math.min(16, n - off))
    return out
  }
  return { tag, keystream }
}

function xor(a: Buffer, b: Buffer): Buffer {
  const out = Buffer.alloc(a.length)
  for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i]
  return out
}

/** AES-128-CCM encrypt: returns ciphertext || tag. */
export function ccmEncrypt(key: Buffer, nonce: Buffer, plaintext: Buffer, aad: Buffer, tagLen: number): Buffer {
  const E = blockCipher(key)
  // Tag over the plaintext; keystream does not depend on it.
  const { tag, keystream } = ccmCore(E, nonce, plaintext, aad, tagLen)
  return Buffer.concat([xor(plaintext, keystream(plaintext.length)), tag])
}

/** AES-128-CCM decrypt of ciphertext || tag; null when the tag does not verify. */
export function ccmDecrypt(key: Buffer, nonce: Buffer, sealed: Buffer, aad: Buffer, tagLen: number): Buffer | null {
  if (sealed.length < tagLen) return null
  const ct = sealed.subarray(0, sealed.length - tagLen)
  const got = sealed.subarray(sealed.length - tagLen)
  const E = blockCipher(key)
  // CTR keystream first (it is plaintext-independent), then the tag over the
  // recovered plaintext. A throwaway core call yields the keystream.
  const ks = ccmCore(E, nonce, Buffer.alloc(ct.length), aad, tagLen).keystream(ct.length)
  const plaintext = xor(ct, ks)
  const { tag } = ccmCore(blockCipher(key), nonce, plaintext, aad, tagLen)
  return timingSafeEqual(tag, got) ? plaintext : null
}

// ── MiBeacon frame ──────────────────────────────────────────────────

export interface MiBeaconHeader {
  frameControl: number
  version: number
  encrypted: boolean
  macIncluded: boolean
  objectIncluded: boolean
  productId: number
  /** The 1-byte frame counter (data[4]). */
  frameCounter: number
  /** MAC carried in the frame, FRAME byte order (little-endian), or null. */
  frameMac: Buffer | null
  /** Offset where the (possibly encrypted) object payload starts. */
  payloadOffset: number
}

/** Header of a MiBeacon frame (the FE95 service-data value). Null = not a
 *  frame this module handles (too short, mesh, or pre-v2). */
export function parseMiBeaconHeader(d: Buffer): MiBeaconHeader | null {
  let i = 5
  if (d.length < i) return null
  const fc = d[0] | (d[1] << 8)
  const version = fc >> 12
  if ((fc >> 7) & 1) return null // mesh
  if (version < 2) return null
  const macIncluded = ((fc >> 4) & 1) === 1
  let frameMac: Buffer | null = null
  if (macIncluded) {
    i += 6
    if (d.length < i) return null
    frameMac = Buffer.from(d.subarray(5, 11))
  }
  if ((fc >> 5) & 1) {
    // capability byte, plus an IO byte when capability bit 0x20 is set
    i += 1
    if (d.length < i) return null
    if (d[i - 1] & 0x20) {
      i += 1
      if (d.length < i) return null
    }
  }
  return {
    frameControl: fc,
    version,
    encrypted: ((fc >> 3) & 1) === 1,
    macIncluded,
    objectIncluded: ((fc >> 6) & 1) === 1,
    productId: d[2] | (d[3] << 8),
    frameCounter: d[4],
    frameMac,
    payloadOffset: i,
  }
}

/** Readable MAC ("AA:BB:CC:DD:EE:FF", dashes or bare hex too) to big-endian bytes. */
export function parseMac(mac: string | undefined | null): Buffer | null {
  if (typeof mac !== 'string') return null
  const hex = mac.replace(/[:\-\s]/g, '')
  return /^[0-9a-fA-F]{12}$/.test(hex) ? Buffer.from(hex, 'hex') : null
}

/** v4/v5 nonce: MAC (frame byte order) | product id + frame counter | 3-byte ext counter. */
export function mibeaconNonce(frame: Buffer, macLE: Buffer): Buffer {
  return Buffer.concat([macLE, frame.subarray(2, 5), frame.subarray(frame.length - 7, frame.length - 4)])
}

const MIBEACON_AAD = Buffer.from([0x11])

export type DecodeResult =
  | { kind: 'objects'; header: MiBeaconHeader; counter: number; objects: Array<{ type: number; data: Buffer }> }
  | { kind: 'idle'; header: MiBeaconHeader }
  | { kind: 'reject'; reason: 'malformed' | 'unencrypted' | 'unsupported' | 'no_mac' | 'mac_mismatch' | 'no_key' | 'decrypt_failed' }

/** Decode a frame down to its object list. macBE = the scale's MAC in readable
 *  (big-endian) order; the frame's own MAC wins when it carries one, but must
 *  agree with a configured one. */
export function decodeMiBeacon(frame: Buffer, macBE: Buffer | null, bindkey: Buffer | null): DecodeResult {
  const h = parseMiBeaconHeader(frame)
  if (!h) return { kind: 'reject', reason: 'malformed' }
  // No object = the scale's idle beacon (reference: "reset stabilized").
  if (!h.objectIncluded) return { kind: 'idle', header: h }
  // An object without encryption is unauthenticated: anyone in radio range
  // could forge it. The S400 always encrypts its weigh-in objects.
  if (!h.encrypted) return { kind: 'reject', reason: 'unencrypted' }
  if (h.version < 4) return { kind: 'reject', reason: 'unsupported' } // legacy v2/v3 crypto: not the S400
  if (frame.length < h.payloadOffset + 9) return { kind: 'reject', reason: 'malformed' }
  const cfgLE = macBE ? Buffer.from(macBE).reverse() : null
  if (h.frameMac && cfgLE && !h.frameMac.equals(cfgLE)) return { kind: 'reject', reason: 'mac_mismatch' }
  const macLE = h.frameMac ?? cfgLE
  if (!macLE) return { kind: 'reject', reason: 'no_mac' }
  if (!bindkey) return { kind: 'reject', reason: 'no_key' }
  const ext = frame.subarray(frame.length - 7, frame.length - 4)
  // Full 32-bit counter: the 1-byte frame counter is the low byte.
  const counter = (h.frameCounter | (ext[0] << 8) | (ext[1] << 16) | (ext[2] << 24)) >>> 0
  const sealed = Buffer.concat([frame.subarray(h.payloadOffset, frame.length - 7), frame.subarray(frame.length - 4)])
  const payload = ccmDecrypt(bindkey, mibeaconNonce(frame, macLE), sealed, MIBEACON_AAD, 4)
  if (!payload) return { kind: 'reject', reason: 'decrypt_failed' }
  const objects: Array<{ type: number; data: Buffer }> = []
  let p = 0
  while (payload.length >= p + 3) {
    const type = payload[p] | (payload[p + 1] << 8)
    const len = payload[p + 2]
    const next = p + 3 + len
    if (payload.length < next) break
    objects.push({ type, data: Buffer.from(payload.subarray(p + 3, next)) })
    p = next
  }
  return { kind: 'objects', header: h, counter, objects }
}

/** Build an encrypted v5 frame (tests and fixtures; the scale does this for real). */
export function encodeMiBeaconV5(p: {
  productId: number
  counter: number // 32-bit: low byte -> frame counter, upper 3 -> ext counter
  macBE: Buffer
  bindkey: Buffer
  objects: Array<{ type: number; data: Buffer }>
  includeMac?: boolean
}): Buffer {
  const fc = 0x5000 | 0x0800 | 0x40 | 0x08 | (p.includeMac ? 0x10 : 0)
  const head = Buffer.alloc(5)
  head.writeUInt16LE(fc, 0)
  head.writeUInt16LE(p.productId, 2)
  head[4] = p.counter & 0xff
  const macLE = Buffer.from(p.macBE).reverse()
  const ext = Buffer.from([(p.counter >>> 8) & 0xff, (p.counter >>> 16) & 0xff, (p.counter >>> 24) & 0xff])
  const plain = Buffer.concat(
    p.objects.map((o) => Buffer.concat([Buffer.from([o.type & 0xff, (o.type >> 8) & 0xff, o.data.length]), o.data])),
  )
  const nonce = Buffer.concat([macLE, head.subarray(2, 5), ext])
  const sealed = ccmEncrypt(p.bindkey, nonce, plain, MIBEACON_AAD, 4)
  const ct = sealed.subarray(0, sealed.length - 4)
  const mic = sealed.subarray(sealed.length - 4)
  return Buffer.concat([head, p.includeMac ? macLE : Buffer.alloc(0), ct, ext, mic])
}

/** Unencrypted no-object frame: the scale's idle beacon. */
export function encodeIdleFrame(productId: number, frameCounter: number): Buffer {
  const b = Buffer.alloc(5)
  b.writeUInt16LE(0x5000 | 0x0800, 0)
  b.writeUInt16LE(productId, 2)
  b[4] = frameCounter & 0xff
  return b
}

// ── object 0x6E16 (S400 weigh-in) ───────────────────────────────────

export interface S400Obj {
  profileId: number
  /** Raw 11-bit mass field (kg x 10); 0 = no weight in this frame. */
  massRaw: number
  /** Raw 7-bit heart-rate field; bpm = raw + 50 when 0 < raw < 127. */
  hrRaw: number
  /** Raw 14-bit impedance field (ohm x 10). */
  impedanceRaw: number
  /** Second u32 (the reference discards it). In both reference captures it is
   *  identical across the packets of one weigh-in and decodes to a plausible
   *  Unix time, so it is read as the scale's own measurement timestamp
   *  (seconds). UNVERIFIED on his unit; only used when plausible. */
  scaleTs: number
}

/** Unpack obj 0x6E16 like the reference: '<BII' (9 bytes), the first u32
 *  packs mass:11 | hr:7 | impedance:14; the second u32 is the scale ts. */
export function parseObj6e16(data: Buffer): S400Obj | null {
  if (data.length !== 9) return null
  const profileId = data[0]
  const v = data.readUInt32LE(1)
  let massRaw = v & 0x7ff
  if (massRaw === 0x7ff) massRaw = 0 // all-ones = "no weight" (S400 Pro marks it so)
  return { profileId, massRaw, hrRaw: (v >>> 11) & 0x7f, impedanceRaw: v >>> 18, scaleTs: data.readUInt32LE(5) }
}

/** Inverse of parseObj6e16 (tests and fixtures). */
export function encodeObj6e16(o: Omit<S400Obj, 'scaleTs'> & { scaleTs?: number }): Buffer {
  const b = Buffer.alloc(9)
  b[0] = o.profileId
  b.writeUInt32LE(((o.massRaw & 0x7ff) | ((o.hrRaw & 0x7f) << 11) | ((o.impedanceRaw & 0x3fff) << 18)) >>> 0, 1)
  b.writeUInt32LE((o.scaleTs ?? 0) >>> 0, 5)
  return b
}

/** The scale timestamp (seconds) when it is plausible as this weigh-in's
 *  identity: non-zero and within a day of the receive time. Else null. */
export function plausibleScaleTs(scaleTs: number, at: number): number | null {
  return scaleTs > 0 && Math.abs(scaleTs * 1000 - at) <= SCALE_TS_ID_SLACK_MS ? scaleTs : null
}

// ── weigh-in assembly ───────────────────────────────────────────────

export interface ScaleReading {
  /** Receive time (epoch ms) of the frame that carried the final weight. */
  measuredAt: number
  /** 32-bit MiBeacon counter of that frame (with measuredAt, the dedupe id). */
  counter: number
  kg: number
  /** 50 kHz impedance (ohm) from the weight frames; feeds the fat formula. */
  impedanceLow: number | null
  /** 250 kHz impedance (ohm) from the closing frame. */
  impedanceHigh: number | null
  heartRate: number | null
  profileId: number
  /** True when the closing high-frequency frame arrived (a full measurement). */
  complete: boolean
  /** The scale's own measurement timestamp (seconds) when plausible: the
   *  weigh-in's identity across scanner retries and daemon restarts. */
  scaleTs: number | null
}

interface Session {
  lastAt: number
  kg: number | null
  kgAt: number
  counter: number
  impedanceLow: number | null
  impedanceHigh: number | null
  heartRate: number | null
  profileId: number
  scaleTs: number | null
}

/**
 * Collapses the scale's repeated frames into ONE reading per weigh-in.
 *  - frames are deduped by their 32-bit counter for SETTLE_MS;
 *  - a weigh-in closes on the 250 kHz impedance frame (mass 0, hr 0,
 *    impedance set: the reference's "last packet"), on the idle frame
 *    (stepped off), or after SETTLE_MS of quiet;
 *  - after it closes, further frames of the same weight are swallowed until
 *    an idle frame or SETTLE_MS of quiet (the scale keeps re-broadcasting).
 */
export class WeighinAssembler {
  private seen = new Map<number, number>()
  private session: Session | null = null
  private done: { kg: number; lastAt: number; scaleTs: number | null } | null = null

  feedIdle(at: number): ScaleReading[] {
    const out = this.finalize()
    this.done = null
    return out
  }

  feed(o: S400Obj, counter: number, at: number): ScaleReading[] {
    this.prune(at)
    if (this.seen.has(counter)) return []
    this.seen.set(counter, at)
    if (o.massRaw === 0 && o.hrRaw === 0 && o.impedanceRaw === 0) return this.feedIdle(at)
    const kg = o.massRaw ? o.massRaw / 10 : null
    const ts = plausibleScaleTs(o.scaleTs, at)
    if (this.done) {
      const sameMeasurement = ts != null && ts === this.done.scaleTs
      if (sameMeasurement || (at - this.done.lastAt <= SETTLE_MS && (kg == null || Math.abs(kg - this.done.kg) <= SAME_WEIGHIN_KG))) {
        this.done.lastAt = at
        return []
      }
      this.done = null
    }
    const s = (this.session ??= {
      lastAt: at,
      kg: null,
      kgAt: at,
      counter,
      impedanceLow: null,
      impedanceHigh: null,
      heartRate: null,
      profileId: o.profileId,
      scaleTs: null,
    })
    s.lastAt = at
    s.profileId = o.profileId
    if (ts != null) s.scaleTs ??= ts
    if (kg != null) {
      s.kg = kg
      s.kgAt = at
      s.counter = counter
    }
    if (o.hrRaw > 0 && o.hrRaw < 127) s.heartRate = o.hrRaw + 50
    // Same order as the reference: mass 0 + hr 0 (+ impedance, the all-zero
    // case is idle above) = the closing 250 kHz frame; any other frame with
    // impedance is 50 kHz, with or without mass in it.
    if (o.massRaw === 0 && o.hrRaw === 0) {
      s.impedanceHigh = o.impedanceRaw / 10 // closing frame: 250 kHz, stable
      return this.finalize(true)
    } else if (o.impedanceRaw !== 0) {
      s.impedanceLow = o.impedanceRaw / 10 // weight frame: 50 kHz, not yet stable
    }
    // mass with no impedance = stable weight-only (socks); it closes on idle
    // or quiet, so a later impedance frame can still join it.
    return []
  }

  /** Close a weigh-in that went quiet; call periodically. */
  tick(now: number): ScaleReading[] {
    this.prune(now)
    let out: ScaleReading[] = []
    if (this.session && now - this.session.lastAt >= SETTLE_MS) out = this.finalize()
    if (this.done && now - this.done.lastAt > SETTLE_MS) this.done = null
    return out
  }

  private finalize(complete = false): ScaleReading[] {
    const s = this.session
    this.session = null
    if (!s || s.kg == null) return []
    this.done = { kg: s.kg, lastAt: s.lastAt, scaleTs: s.scaleTs }
    const scaleMs = s.scaleTs != null ? s.scaleTs * 1000 : null
    return [
      {
        measuredAt: scaleMs != null && Math.abs(scaleMs - s.kgAt) <= SCALE_TS_TIME_SLACK_MS ? scaleMs : s.kgAt,
        counter: s.counter,
        kg: s.kg,
        impedanceLow: s.impedanceLow,
        impedanceHigh: s.impedanceHigh,
        heartRate: s.heartRate,
        profileId: s.profileId,
        complete,
        scaleTs: s.scaleTs,
      },
    ]
  }

  private prune(now: number): void {
    for (const [k, t] of this.seen) if (now - t > SETTLE_MS) this.seen.delete(k)
  }
}

// ── body fat (Mi Scale formula) ─────────────────────────────────────

export interface BodyProfile {
  height_cm: number
  birth_date: string
  sex: 'male' | 'female'
}

/** Whole years between a YYYY-MM-DD birth date and `at` (local calendar). */
export function ageAt(birthDate: string, at: number): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthDate)
  if (!m) return null
  const d = new Date(at)
  let age = d.getFullYear() - Number(m[1])
  const mo = d.getMonth() + 1
  if (mo < Number(m[2]) || (mo === Number(m[2]) && d.getDate() < Number(m[3]))) age--
  return age >= 0 ? age : null
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

/** Body fat PERCENT, a port of bodyMetrics.getFatPercentage (with its
 *  getLBMCoefficient). Null where the reference refuses the inputs (it
 *  exits; here the reading just carries no fat). */
export function fatPercent(weight: number, height: number, age: number, sex: 'male' | 'female', impedance: number): number | null {
  if (!(height > 0 && height <= 220) || !(weight >= 10 && weight <= 200) || !(age >= 0 && age <= 99)) return null
  if (!(impedance > 0 && impedance <= 3000)) return null
  let lbm = (height * 9.058 / 100) * (height / 100)
  lbm += weight * 0.32 + 12.226
  lbm -= impedance * 0.0068
  lbm -= age * 0.0542
  let k: number
  if (sex === 'female' && age <= 49) k = 9.25
  else if (sex === 'female') k = 7.25
  else k = 0.8
  let coefficient = 1.0
  if (sex === 'male' && weight < 61) coefficient = 0.98
  else if (sex === 'female' && weight > 60) coefficient = 0.96 * (height > 160 ? 1.03 : 1)
  else if (sex === 'female' && weight < 50) coefficient = 1.02 * (height > 160 ? 1.03 : 1)
  let fat = (1.0 - ((lbm - k) * coefficient) / weight) * 100
  if (fat > 63) fat = 75
  return clamp(fat, 5, 75)
}

/** Open-formula body fat PERCENT, unrounded; null when the profile or the
 *  50 kHz impedance is missing. */
export function readingFatPercent(reading: Pick<ScaleReading, 'kg' | 'impedanceLow' | 'measuredAt'>, profile: Partial<BodyProfile> | undefined): number | null {
  if (!profile || reading.impedanceLow == null) return null
  const { height_cm, birth_date, sex } = profile
  if (typeof height_cm !== 'number' || typeof birth_date !== 'string' || (sex !== 'male' && sex !== 'female')) return null
  const age = ageAt(birth_date, reading.measuredAt)
  if (age == null) return null
  return fatPercent(reading.kg, height_cm, age, sex, reading.impedanceLow)
}

/** Body fat as a HealthKit-style fraction (0.236), 3 decimals; null when
 *  the profile or the 50 kHz impedance is missing. */
export function fatFraction(reading: Pick<ScaleReading, 'kg' | 'impedanceLow' | 'measuredAt'>, profile: Partial<BodyProfile> | undefined): number | null {
  const pct = readingFatPercent(reading, profile)
  return pct == null ? null : Math.round(pct * 10) / 1000
}

// ── bindkey (Keychain) ──────────────────────────────────────────────

/** exitCode null = killed (timed out). */
export interface SpawnResult {
  exitCode: number | null
  stdout: { toString(): string }
}
export type KeychainSpawn = (argv: string[]) => SpawnResult | Promise<SpawnResult>

/** `security` exits with the low byte of the OSStatus: errSecItemNotFound
 *  (-25300) = 44. Anything else non-zero (locked keychain, denied ACL, user
 *  cancel) or a timeout ends the search instead of prompting again. */
const SEC_ITEM_NOT_FOUND = 44

async function keychainSpawn(argv: string[]): Promise<SpawnResult> {
  const p = Bun.spawn(argv, { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore', timeout: KEYCHAIN_TIMEOUT_MS })
  const stdout = await new Response(p.stdout).text()
  const code = await p.exited
  return { exitCode: p.signalCode ? null : code, stdout }
}

/** Read the 16-byte bindkey: account-scoped lookups first (keychain_account,
 *  did, mac), then any item under the service. Async with a per-lookup
 *  timeout, so a locked keychain or an ACL dialog never blocks the daemon's
 *  event loop. Never logs the value. */
export async function readBindkeyFromKeychain(cfg: ScaleConfig | undefined, spawn?: KeychainSpawn): Promise<Buffer | null> {
  const run: KeychainSpawn = spawn ?? keychainSpawn
  const accounts = [cfg?.keychain_account, cfg?.did, cfg?.mac].filter((a): a is string => typeof a === 'string' && a.length > 0)
  const tries: Array<string | null> = [...new Set(accounts), null]
  const service = typeof cfg?.keychain_service === 'string' && cfg.keychain_service ? cfg.keychain_service : KEYCHAIN_SERVICE
  for (const acct of tries) {
    const argv = ['/usr/bin/security', 'find-generic-password', '-s', service, ...(acct ? ['-a', acct] : []), '-w']
    let r: SpawnResult
    try {
      r = await run(argv)
    } catch {
      return null // nothing about the attempt is logged
    }
    if (r.exitCode === 0) {
      const hex = r.stdout.toString().trim()
      if (/^[0-9a-fA-F]{32}$/.test(hex)) return Buffer.from(hex, 'hex')
      continue
    }
    if (r.exitCode !== SEC_ITEM_NOT_FOUND) return null // locked, denied, timed out: stop here
  }
  return null
}

// ── service (daemon side) ───────────────────────────────────────────

export interface BodySampleIn {
  uuid: string
  ts: string
  kind: 'mass' | 'fat'
  value: number
  source: string
}

export interface ScaleDeps {
  getConfig: () => ScaleConfig | undefined
  /** Ingest path (FoodService.ingestBodySamples in the daemon). `raw` is the
   *  reading itself (impedances, open-formula fat %) for scale_readings and
   *  the Xiaomi calibration; the fat SAMPLE is rewritten there when a
   *  calibration model exists. */
  ingest: (samples: BodySampleIn[], raw: ScaleRaw) => { received: number; added: number; deleted: number } | null
  /** Bindkey source (default: the Keychain). May be sync or async. */
  readBindkey?: (cfg: ScaleConfig | undefined) => Buffer | null | Promise<Buffer | null>
  /** Persisted MiBeacon counter high-water mark (replay guard across restarts). */
  loadHighWater?: () => number | null
  saveHighWater?: (counter: number | null) => void
  now?: () => number
  log: (msg: string) => void
}

/** Product ids accepted: the known S400 ids, plus a configured override. */
export function allowedProductIds(cfg: ScaleConfig | undefined): Set<number> {
  const ids = new Set(S400_PRODUCT_IDS)
  const p = cfg?.product_id
  const n = typeof p === 'number' ? p : typeof p === 'string' ? Number(p.trim()) : NaN
  if (Number.isInteger(n) && n > 0 && n <= 0xffff) ids.add(n)
  return ids
}

/** Deterministic sample uuid (+ kind): the scale's own measurement timestamp
 *  when plausible (stable across scanner retries and daemon restarts), else
 *  counter + measured time. */
export function readingUuid(r: Pick<ScaleReading, 'counter' | 'measuredAt'> & { scaleTs?: number | null }, kind: 'mass' | 'fat'): string {
  return `${readingStem(r)}-${kind === 'mass' ? 'm' : 'f'}`
}

/** The id a reading's samples share (scale_readings.uuid). */
export function readingStem(r: Pick<ScaleReading, 'counter' | 'measuredAt'> & { scaleTs?: number | null }): string {
  if (r.scaleTs != null) return `s400-t${r.scaleTs.toString(16).padStart(8, '0')}`
  return `s400-${r.counter.toString(16).padStart(8, '0')}-${r.measuredAt}`
}

/** The raw reading for scale_readings: impedances, hr, scale ts, and the open
 *  formula's fat % at full precision (the calibration input; one rounding
 *  step to the 0.1-point sample, exactly as fatFraction rounds). */
export function readingRaw(r: ScaleReading, profile: ScaleConfig['profile']): ScaleRaw {
  const pct = readingFatPercent(r, profile)
  return {
    uuid: readingStem(r),
    measured_at: new Date(r.measuredAt).toISOString(),
    kg: r.kg,
    impedance_low: r.impedanceLow,
    impedance_high: r.impedanceHigh,
    hr: r.heartRate,
    scale_ts: r.scaleTs,
    fat_raw_pct: pct,
  }
}

/** The ONE reject reason the listener retries: the bindkey is still loading
 *  (daemon boot), so the same frame decodes once the key lands. Every other
 *  reject (mac_mismatch, decrypt_failed, replay, unencrypted, malformed,
 *  unsupported, not_s400, no_mac) is permanent for that frame. */
export const LISTENER_RETRY_REASON = 'no_key'

/** The listener's dedupe contract, line for line the same rule as `classify`
 *  in relayer/scale-listen.swift (keep the two identical; a test pins the
 *  reason string in the Swift source). A frame is FORGOTTEN (re-posted on its
 *  next advertisement) ONLY when the daemon answered 2xx with accepted:false
 *  and reason LISTENER_RETRY_REASON. Everything else stays remembered
 *  (suppressed for 60 s): an accepted frame; every other reject, which would
 *  otherwise be re-posted on each advertisement (several a second); a 4xx
 *  (a malformed post never improves); a 401 (re-posting never fixes a token
 *  mismatch); a transport failure (status 0) or 5xx, whose frame already
 *  sits once in the retry buffer. */
export function listenerRemembers(status: number, body: unknown): boolean {
  if (status === 0 || status >= 500) return true // .failed
  if (status === 401) return true // .unauthorized
  if (status >= 200 && status < 300) {
    const b = typeof body === 'object' && body != null ? (body as { accepted?: unknown; reason?: unknown }) : {}
    return !(b.accepted === false && b.reason === LISTENER_RETRY_REASON) // .keyPending forgets
  }
  return true // .refused
}

export function readingSamples(r: ScaleReading, profile: ScaleConfig['profile']): BodySampleIn[] {
  const ts = new Date(r.measuredAt).toISOString()
  const out: BodySampleIn[] = [{ uuid: readingUuid(r, 'mass'), ts, kind: 'mass', value: r.kg, source: SCALE_SOURCE }]
  const fat = fatFraction(r, profile)
  if (fat != null) out.push({ uuid: readingUuid(r, 'fat'), ts, kind: 'fat', value: fat, source: SCALE_SOURCE })
  return out
}

const MAX_FRAME_HEX = 128 // a BLE advertisement cannot carry more service data

export class ScaleService {
  private assembler = new WeighinAssembler()
  private key: Buffer | null = null
  private keyTriedAt = -Infinity
  private keyLoading: Promise<void> | null = null
  private decryptFails = 0
  private hwm: number | null | undefined = undefined // undefined = not loaded yet
  private lastAcceptedAt = -Infinity
  private timer: ReturnType<typeof setInterval> | null = null
  private now: () => number
  private lastRejectLog = new Map<string, number>()
  readonly stats = { frames: 0, decoded: 0, rejected: 0, readings: 0 }

  constructor(private deps: ScaleDeps) {
    this.now = deps.now ?? Date.now
  }

  /** Start loading the bindkey (in the background) and the settle timer. */
  start(tickMs = 5_000): void {
    this.loadKey()
    this.timer = setInterval(() => {
      try {
        this.tick()
      } catch (err) {
        this.deps.log(`scale tick failed: ${err instanceof Error ? err.name : 'error'}`)
      }
    }, tickMs)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  hasKey(): boolean {
    return this.key != null
  }

  /** Resolves when an in-flight Keychain read has settled (tests, boot). */
  keySettled(): Promise<void> {
    return this.keyLoading ?? Promise.resolve()
  }

  /** Kick off a Keychain read, rate-limited, never blocking the caller. A
   *  sync reader (tests) settles before this returns. The cached key stays
   *  in use until a read returns a DIFFERENT key, so a re-read never drops
   *  frames of the right scale. */
  private loadKey(): void {
    if (this.keyLoading) return
    const now = this.now()
    if (now - this.keyTriedAt < KEY_RETRY_MS) return
    this.keyTriedAt = now
    const read = this.deps.readBindkey ?? readBindkeyFromKeychain
    let r: Buffer | null | Promise<Buffer | null>
    try {
      r = read(this.deps.getConfig())
    } catch {
      r = null
    }
    if (r instanceof Promise) {
      this.keyLoading = r
        .then(
          (k) => this.onKeyRead(k),
          () => this.onKeyRead(null),
        )
        .finally(() => {
          this.keyLoading = null
        })
    } else {
      this.onKeyRead(r)
    }
  }

  private onKeyRead(k: Buffer | null): void {
    const prev = this.key
    if (k && prev && k.equals(prev)) {
      this.deps.log('scale: bindkey re-read from Keychain, unchanged (if frames keep failing: wrong scale MAC in config, a re-paired scale needing scale-bindkey again, or a foreign S400 nearby)')
      return
    }
    if (k) {
      this.key = k
      this.decryptFails = 0
      if (prev) {
        // A new key = a new pairing epoch; its counter may restart, and frames
        // under the old key can no longer authenticate, so the mark resets.
        this.setHighWater(null)
        this.deps.log('scale: bindkey changed in Keychain, now using the new one')
      } else {
        this.deps.log('scale: bindkey loaded from Keychain')
      }
      return
    }
    if (!prev) {
      // Retried every minute: say so once per LOG_EVERY_MS, not per retry.
      const now = this.now()
      if (now - this.noKeyLoggedAt > LOG_EVERY_MS) {
        this.noKeyLoggedAt = now
        this.deps.log(`scale: no bindkey in Keychain (service ${KEYCHAIN_SERVICE}); frames are dropped until it exists`)
      }
    }
  }

  private noKeyLoggedAt = -Infinity

  private highWater(): number | null {
    if (this.hwm === undefined) {
      let v: number | null = null
      try {
        v = this.deps.loadHighWater?.() ?? null
      } catch {
        v = null
      }
      this.hwm = typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null
    }
    return this.hwm
  }

  private setHighWater(v: number | null): void {
    this.hwm = v
    try {
      this.deps.saveHighWater?.(v)
    } catch {
      // in-memory mark still guards this run
    }
  }

  /** Replay guard on the authenticated 32-bit counter. */
  private counterGate(counter: number, freshScaleTs: boolean, now: number): 'new' | 'window' | 'duplicate' | 'replay' {
    const hwm = this.highWater()
    if (hwm == null || counter > hwm) {
      this.setHighWater(counter)
      this.lastAcceptedAt = now
      return 'new'
    }
    // At or just below the mark: the scale's own re-broadcasts (and a few
    // reordered frames) of the weigh-in in progress. Outside it, repeats only.
    if (hwm - counter < COUNTER_WINDOW) return now - this.lastAcceptedAt <= SETTLE_MS ? 'window' : 'duplicate'
    if (now - this.lastAcceptedAt >= RESET_GAP_MS && freshScaleTs) {
      this.setHighWater(counter)
      this.lastAcceptedAt = now
      this.deps.log('scale: frame counter went backwards with a fresh scale timestamp; treating it as a scale counter reset')
      return 'new'
    }
    return 'replay'
  }

  tick(): number {
    // A key missing at boot (Keychain locked, not stored yet) is retried on
    // the timer (loadKey rate-limits to once a minute), not only when a frame
    // arrives: frames of a weigh-in must find the key already loaded.
    if (!this.key) this.loadKey()
    return this.emit(this.assembler.tick(this.now()))
  }

  /** One raw FE95 service-data frame. Returns what happened to it. */
  ingestFrame(frameHex: string, ts?: unknown): { accepted: boolean; reason?: string; readings: number } {
    this.stats.frames++
    const now = this.now()
    const at = receiveTime(ts, now)
    const cfg = this.deps.getConfig()
    const frame = Buffer.from(frameHex, 'hex')
    const h = parseMiBeaconHeader(frame)
    if (!h) return this.reject('malformed')
    if (!allowedProductIds(cfg).has(h.productId)) {
      this.lastProductId = `0x${h.productId.toString(16).padStart(4, '0')}`
      return this.reject('not_s400')
    }
    if (h.objectIncluded && !h.encrypted) return this.reject('unencrypted')
    if (h.objectIncluded && !this.key) this.loadKey()
    const res = decodeMiBeacon(frame, parseMac(cfg?.mac), h.objectIncluded ? this.key : null)
    if (res.kind === 'reject') {
      // Repeated authentication failures = maybe a stale key (scale re-paired,
      // scale-bindkey re-run): re-read the Keychain, rate-limited.
      if (res.reason === 'decrypt_failed' && ++this.decryptFails >= DECRYPT_FAILS_BEFORE_RELOAD) this.loadKey()
      return this.reject(res.reason)
    }
    this.stats.decoded++
    if (res.kind === 'idle') return { accepted: true, readings: this.emit(this.assembler.feedIdle(at)) }
    this.decryptFails = 0
    const objs: S400Obj[] = []
    for (const o of res.objects) {
      if (o.type !== OBJ_S400) continue
      const obj = parseObj6e16(o.data)
      if (obj) objs.push(obj)
    }
    if (objs.length === 0) return { accepted: true, reason: 'no_weigh_in_object', readings: 0 }
    const gate = this.counterGate(res.counter, objs.some((o) => plausibleScaleTs(o.scaleTs, at) != null), now)
    if (gate === 'replay') return this.reject('replay')
    if (gate === 'duplicate') return { accepted: true, reason: 'duplicate', readings: 0 }
    let readings = 0
    for (const obj of objs) readings += this.emit(this.assembler.feed(obj, res.counter, at))
    return { accepted: true, readings }
  }

  private emit(readings: ScaleReading[]): number {
    let n = 0
    for (const r of readings) {
      const profile = this.deps.getConfig()?.profile
      const samples = readingSamples(r, profile)
      const res = this.deps.ingest(samples, readingRaw(r, profile))
      if (res) {
        n++
        this.stats.readings++
        // No body numbers in the log: it says THAT a weigh-in landed.
        this.deps.log(`scale: weigh-in ingested (${samples.map((s) => s.kind).join('+')}, added ${res.added}${r.complete ? '' : ', partial'})`)
      }
    }
    return n
  }

  private lastProductId: string | null = null
  private loggedFrames = new Map<string, number>()

  /** Diagnostics: one line per distinct outcome of a weigh-in frame
   *  (MiBeacon frame counter) that carries an object, within SETTLE_MS.
   *  Never a value: the counter, the outcome and the readings count only.
   *  Idle beacons (no object) are not logged. A refused (no_key) post and
   *  its accepted re-post are two outcomes, so both are logged. */
  private logFrameOutcome(hex: string, res: { accepted: boolean; reason?: string; readings?: number }): void {
    const b = Buffer.from(hex, 'hex')
    if (b.length < 5 || !(b[0] & 0x40)) return
    const counter = b[4]
    const verdict = res.accepted ? `accepted${res.reason ? ` (${res.reason})` : ''}` : `refused (${res.reason ?? 'unknown'})`
    if (!firstFrameOutcome(this.loggedFrames, counter, verdict, this.now())) return
    this.deps.log(`scale: frame #${counter} with object -> ${verdict}, readings ${res.readings ?? 0}`)
  }

  private reject(reason: string): { accepted: false; reason: string; readings: 0 } {
    this.stats.rejected++
    const now = this.now()
    // The listener only forwards known S400 ids or the pinned peripheral, so a
    // not_s400 here is a PINNED unit with an unknown product id: say so (rate
    // limited) so scale.product_id can be set.
    if (now - (this.lastRejectLog.get(reason) ?? -Infinity) > LOG_EVERY_MS) {
      this.lastRejectLog.set(reason, now)
      this.deps.log(
        reason === 'replay'
          ? 'scale: dropped a frame (replay: its counter is below the last accepted one)'
          : reason === 'not_s400'
            ? `scale: dropped a frame from the pinned peripheral (product id ${this.lastProductId ?? '?'} is not a known S400 id; set scale.product_id to it if this is your scale)`
            : `scale: dropped a frame (${reason})`,
      )
    }
    return { accepted: false, reason, readings: 0 }
  }

  /** POST /scale-adv {frame_hex, rssi?, ts?}. Auth is the listener's job. */
  async handleHttp(req: Request, url: URL): Promise<Response | null> {
    if (url.pathname !== '/scale-adv') return null
    if (req.method !== 'POST') return new Response('method not allowed', { status: 405 })
    let body: unknown
    try {
      body = await req.json()
    } catch {
      return new Response('bad json', { status: 400 })
    }
    const hex = (body as { frame_hex?: unknown } | null)?.frame_hex
    if (typeof hex !== 'string' || hex.length < 10 || hex.length > MAX_FRAME_HEX || hex.length % 2 || !/^[0-9a-fA-F]+$/.test(hex)) {
      return new Response('frame_hex must be an even-length hex string', { status: 400 })
    }
    const res = this.ingestFrame(hex, (body as { ts?: unknown }).ts)
    this.logFrameOutcome(hex, res)
    return Response.json({ ok: true, ...res })
  }
}

/** The frame-log dedupe: true the first time this (counter, verdict) is
 *  seen within SETTLE_MS (and remembers it), false for a repeat. Entries
 *  older than SETTLE_MS are dropped on every call. */
export function firstFrameOutcome(seen: Map<string, number>, counter: number, verdict: string, now: number): boolean {
  for (const [k, t] of seen) if (now - t > SETTLE_MS) seen.delete(k)
  const key = `${counter}\n${verdict}`
  if (seen.has(key)) return false
  seen.set(key, now)
  return true
}

/** The scanner's receive time when sane (it may retry a frame for a few
 *  minutes while the daemon restarts), else now. */
export function receiveTime(ts: unknown, now: number): number {
  const t = typeof ts === 'number' ? ts : typeof ts === 'string' ? Date.parse(ts) : NaN
  return Number.isFinite(t) && t <= now + 60_000 && t >= now - 10 * 60_000 ? t : now
}
