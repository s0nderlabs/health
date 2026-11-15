// Test images built at runtime: no binary fixtures in the repo, no personal
// photos anywhere near the suite. A tiny PNG encoder makes an asymmetric
// image, sips turns it into a JPEG, and an EXIF block (orientation + a GPS
// IFD) is spliced in so the strip/rotate pipeline has something real to chew.

import { deflateSync } from 'node:zlib'
import { writeFileSync, readFileSync } from 'fs'

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(b: Uint8Array): number {
  let c = 0xffffffff
  for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, data.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

/** w x h RGB PNG: left half red, right half blue (so rotation is detectable). */
export function makePng(w: number, h: number): Uint8Array {
  const raw = new Uint8Array(h * (1 + w * 3))
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 3)] = 0
    for (let x = 0; x < w; x++) {
      const o = y * (1 + w * 3) + 1 + x * 3
      if (x < w / 2) raw[o] = 255
      else raw[o + 2] = 255
    }
  }
  const ihdr = new Uint8Array(13)
  const dv = new DataView(ihdr.buffer)
  dv.setUint32(0, w)
  dv.setUint32(4, h)
  ihdr.set([8, 2, 0, 0, 0], 8)
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflateSync(raw))),
    chunk('IEND', new Uint8Array()),
  ]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

/** APP1 Exif segment (big-endian TIFF): Orientation + a GPS IFD with a latitude ref. */
export function exifApp1(orientation: number): Uint8Array {
  // TIFF: header(8) + IFD0 (2 + 2*12 + 4) + GPS IFD (2 + 12 + 4)
  const tiff = new Uint8Array(8 + 30 + 18)
  const dv = new DataView(tiff.buffer)
  tiff.set([0x4d, 0x4d, 0x00, 0x2a])
  dv.setUint32(4, 8)
  dv.setUint16(8, 2) // two entries
  // 0x0112 Orientation SHORT 1
  dv.setUint16(10, 0x0112)
  dv.setUint16(12, 3)
  dv.setUint32(14, 1)
  dv.setUint16(18, orientation)
  // 0x8825 GPS IFD pointer LONG 1 -> offset 38
  dv.setUint16(22, 0x8825)
  dv.setUint16(24, 4)
  dv.setUint32(26, 1)
  dv.setUint32(30, 38)
  dv.setUint32(34, 0) // next IFD
  // GPS IFD: GPSLatitudeRef ASCII 2 "S\0"
  dv.setUint16(38, 1)
  dv.setUint16(40, 0x0001)
  dv.setUint16(42, 2)
  dv.setUint32(44, 2)
  tiff[48] = 0x53
  dv.setUint32(52, 0)
  const body = new Uint8Array(6 + tiff.length)
  body.set([0x45, 0x78, 0x69, 0x66, 0, 0])
  body.set(tiff, 6)
  const seg = new Uint8Array(4 + body.length)
  seg.set([0xff, 0xe1, ((body.length + 2) >> 8) & 0xff, (body.length + 2) & 0xff])
  seg.set(body, 4)
  return seg
}

/** Splice an APP1 right after SOI. */
export function withExif(jpeg: Uint8Array, app1: Uint8Array): Uint8Array {
  const out = new Uint8Array(jpeg.length + app1.length)
  out.set(jpeg.subarray(0, 2))
  out.set(app1, 2)
  out.set(jpeg.subarray(2), 2 + app1.length)
  return out
}

/** A real JPEG (via sips) of a w x h asymmetric image, EXIF orientation spliced in. */
export async function makeJpeg(dir: string, w: number, h: number, orientation = 1): Promise<Uint8Array> {
  const png = `${dir}/src-${w}x${h}.png`
  const jpg = `${dir}/src-${w}x${h}.jpg`
  writeFileSync(png, makePng(w, h))
  const p = Bun.spawn(['/usr/bin/sips', '-s', 'format', 'jpeg', png, '--out', jpg], { stdout: 'ignore', stderr: 'ignore' })
  if ((await p.exited) !== 0) throw new Error('sips failed building the fixture')
  const base = new Uint8Array(readFileSync(jpg))
  return orientation === 1 ? base : withExif(base, exifApp1(orientation))
}

export async function pixelSize(path: string): Promise<{ w: number; h: number }> {
  const p = Bun.spawn(['/usr/bin/sips', '-g', 'pixelWidth', '-g', 'pixelHeight', path], { stdout: 'pipe' })
  const out = await new Response(p.stdout).text()
  return { w: Number(/pixelWidth:\s*(\d+)/.exec(out)?.[1]), h: Number(/pixelHeight:\s*(\d+)/.exec(out)?.[1]) }
}
