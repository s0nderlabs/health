// Bluetooth SIG Heart Rate Measurement (0x2A37) parser. Relayers ship the
// characteristic bytes raw (base64) so this is the ONE place the wire format
// is interpreted; semantics mirror the on-band-proven rr-byte-check.py probe.
//
// Layout: [flags u8][HR u8|u16 LE][energy u16 LE?][RR u16 LE...]
//   flags bit 0: HR is 16-bit
//   flags bits 1-2: sensor contact status (bit 2 = feature supported)
//   flags bit 3: energy expended field present
//   flags bit 4: RR intervals present (units of 1/1024 s)

export interface HrSample {
  bpm: number
  rr_ms: number[]
  /** null = sensor does not report contact; boolean = reported state */
  contact: boolean | null
}

export function parseHeartRateMeasurement(data: Uint8Array): HrSample | null {
  if (data.length < 2) return null
  const flags = data[0]

  let idx = 1
  let bpm: number
  if (flags & 0x01) {
    if (data.length < 3) return null
    bpm = data[1] | (data[2] << 8)
    idx = 3
  } else {
    bpm = data[1]
    idx = 2
  }

  const contact = flags & 0x04 ? (flags & 0x02) !== 0 : null

  if (flags & 0x08) idx += 2 // energy expended, not used

  const rr_ms: number[] = []
  if (flags & 0x10) {
    while (idx + 2 <= data.length) {
      const raw = data[idx] | (data[idx + 1] << 8)
      rr_ms.push(Math.round((raw / 1024) * 1000 * 10) / 10)
      idx += 2
    }
  }

  return { bpm, rr_ms, contact }
}

// Buffer.from(_, 'base64') never throws; it best-effort decodes garbage. Be strict.
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

export function parseBase64Frame(raw: string): HrSample | null {
  if (raw.length % 4 !== 0 || !BASE64.test(raw)) return null
  return parseHeartRateMeasurement(Uint8Array.from(Buffer.from(raw, 'base64')))
}
