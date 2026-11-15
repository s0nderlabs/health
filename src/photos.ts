// Meal photo pipeline: any HEIC / JPEG / PNG in, one privacy-clean JPEG out.
//
// Every meal photo (phone upload or a path dropped in chat) goes through the
// same steps, so the archive holds one shape only:
//   1. sips converts to JPEG and caps the long edge at 1568 px (never upscales)
//   2. the EXIF orientation is read and BAKED into the pixels (sips keeps the
//      camera's unrotated pixels plus an orientation tag; stripping the tag
//      without rotating would leave portrait plates lying on their side)
//   3. every metadata segment except JFIF / ICC / Adobe is dropped: EXIF (GPS,
//      device, timestamps), XMP, IPTC, comments. Verified necessary: sips
//      carries the iPhone's GPS block straight through a HEIC->JPEG convert.
//   4. a small thumbnail is cut for the phone's meal list
// Originals are only ever READ: never moved, never modified, never deleted.
//
// sips ships with macOS; this daemon is macOS-only already (launchd, Keychain).

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { dirname } from 'path'

export const PHOTO_MAX_EDGE = 1568
export const THUMB_MAX_EDGE = 360
export const PHOTO_MAX_INPUT_BYTES = 40 * 1024 * 1024
export const PHOTO_MAX_PER_MEAL = 6
/** Whole-meal budget for chat photos crossing IPC, matching the phone door's
 *  body cap (six phone-sized photos, base64, plus slack). */
export const PHOTO_MAX_TOTAL_BYTES = 54 * 1024 * 1024
const JPEG_QUALITY = '70'
const SIPS = '/usr/bin/sips'

// ── JPEG metadata (pure, unit tested) ─────────────────────────────

/** Segments that carry no personal data and matter for rendering. */
function keepSegment(marker: number, body: Uint8Array): boolean {
  if (marker === 0xe0) return true // APP0 JFIF
  if (marker === 0xee) return true // APP14 Adobe (color transform)
  if (marker === 0xe2) {
    // APP2 is ICC_PROFILE (keep: color) or FlashPix / MPF (drop)
    return ascii(body, 0, 12) === 'ICC_PROFILE\0'
  }
  return false
}

function ascii(b: Uint8Array, off: number, len: number): string {
  let s = ''
  for (let i = off; i < off + len && i < b.length; i++) s += String.fromCharCode(b[i])
  return s
}

interface Segment {
  marker: number
  start: number // offset of the 0xFF
  end: number // offset just past the segment
  body: Uint8Array // payload after the length field
}

/** Walk the header segments up to SOS. Null when the bytes are not a JPEG. */
function headerSegments(buf: Uint8Array): { segments: Segment[]; sosAt: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null
  const segments: Segment[] = []
  let i = 2
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) return null
    let marker = buf[i + 1]
    // Fill bytes: any number of 0xFF may precede a marker.
    while (marker === 0xff && i + 2 < buf.length) {
      i++
      marker = buf[i + 1]
    }
    if (marker === 0xda) return { segments, sosAt: i } // start of scan: the rest is image data
    if (marker === 0xd9) return null // EOI before any scan: not an image
    const len = (buf[i + 2] << 8) | buf[i + 3]
    if (len < 2 || i + 2 + len > buf.length) return null
    segments.push({ marker, start: i, end: i + 2 + len, body: buf.subarray(i + 4, i + 2 + len) })
    i += 2 + len
  }
  return null
}

/** EXIF orientation (1-8) from a JPEG's APP1, or 1 when absent / unreadable. */
export function exifOrientation(buf: Uint8Array): number {
  const parsed = headerSegments(buf)
  if (!parsed) return 1
  for (const seg of parsed.segments) {
    if (seg.marker !== 0xe1 || ascii(seg.body, 0, 6) !== 'Exif\0\0') continue
    const t = seg.body.subarray(6)
    if (t.length < 8) return 1
    const le = t[0] === 0x49 && t[1] === 0x49
    const be = t[0] === 0x4d && t[1] === 0x4d
    if (!le && !be) return 1
    const u16 = (o: number) => (le ? t[o] | (t[o + 1] << 8) : (t[o] << 8) | t[o + 1])
    const u32 = (o: number) =>
      le
        ? (t[o] | (t[o + 1] << 8) | (t[o + 2] << 16) | (t[o + 3] << 24)) >>> 0
        : ((t[o] << 24) | (t[o + 1] << 16) | (t[o + 2] << 8) | t[o + 3]) >>> 0
    const ifd = u32(4)
    if (ifd + 2 > t.length) return 1
    const n = u16(ifd)
    for (let k = 0; k < n; k++) {
      const e = ifd + 2 + k * 12
      if (e + 12 > t.length) break
      if (u16(e) === 0x0112) {
        const v = u16(e + 8)
        return v >= 1 && v <= 8 ? v : 1
      }
    }
    return 1
  }
  return 1
}

/** The JPEG with every metadata segment but JFIF / ICC / Adobe removed. */
export function stripJpegMetadata(buf: Uint8Array): Uint8Array {
  const parsed = headerSegments(buf)
  if (!parsed) throw new Error('not a JPEG')
  const parts: Uint8Array[] = [buf.subarray(0, 2)]
  for (const seg of parsed.segments) {
    const isApp = seg.marker >= 0xe0 && seg.marker <= 0xef
    const isComment = seg.marker === 0xfe
    if ((isApp || isComment) && !keepSegment(seg.marker, seg.body)) continue
    parts.push(buf.subarray(seg.start, seg.end))
  }
  parts.push(buf.subarray(parsed.sosAt))
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

/** True when any segment that can carry personal metadata survived. */
export function hasPersonalMetadata(buf: Uint8Array): boolean {
  const parsed = headerSegments(buf)
  if (!parsed) return false
  return parsed.segments.some(
    (s) => (s.marker >= 0xe0 && s.marker <= 0xef && !keepSegment(s.marker, s.body)) || s.marker === 0xfe,
  )
}

/** Sniff the container: what the bytes are, regardless of file extension. */
export function sniffImage(head: Uint8Array): 'jpeg' | 'png' | 'heic' | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg'
  if (head.length >= 8 && ascii(head, 0, 8) === '\x89PNG\r\n\x1a\n') return 'png'
  if (head.length >= 12 && ascii(head, 4, 4) === 'ftyp') {
    const brand = ascii(head, 8, 4)
    if (/^(heic|heix|hevc|hevx|heim|heis|mif1|msf1|avif)$/.test(brand)) return 'heic'
  }
  return null
}

// ── reading photo files (the user's own session, never the daemon) ──

/**
 * Read chat photo paths into base64, every check BEFORE any byte is read:
 * count, absolute path, regular file, per-file and whole-meal size. Runs in
 * the MCP server, inside the user's session, because the launchd daemon
 * opening ~/Downloads hangs on an unseen macOS privacy prompt.
 */
export async function readPhotoFiles(paths: unknown): Promise<string[]> {
  const list = Array.isArray(paths) ? paths : [paths]
  if (list.length > PHOTO_MAX_PER_MEAL) throw new Error(`at most ${PHOTO_MAX_PER_MEAL} photos per meal`)
  let total = 0
  const checked = list.map((x) => {
    if (typeof x !== 'string' || !x.startsWith('/')) throw new Error('photos must be absolute file paths')
    let st
    try {
      st = statSync(x)
    } catch {
      throw new Error(`photo not found: ${x}`)
    }
    if (!st.isFile()) throw new Error(`not a file: ${x}`)
    if (st.size > PHOTO_MAX_INPUT_BYTES) throw new Error(`photo too large: ${x}`)
    total += st.size
    return x
  })
  if (total > PHOTO_MAX_TOTAL_BYTES) throw new Error(`photos too large together (${Math.round(total / 1048576)} MB, max ${PHOTO_MAX_TOTAL_BYTES / 1048576} MB)`)
  return Promise.all(checked.map(async (x) => Buffer.from(await Bun.file(x).arrayBuffer()).toString('base64')))
}

// ── sips (I/O) ────────────────────────────────────────────────────

async function sips(args: string[], timeoutMs = 30_000): Promise<string> {
  const proc = Bun.spawn([SIPS, ...args], { stdout: 'pipe', stderr: 'pipe' })
  const timer = setTimeout(() => proc.kill(), timeoutMs)
  try {
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (code !== 0) throw new Error(`sips failed (${code}): ${err.trim() || out.trim()}`)
    return out
  } finally {
    clearTimeout(timer)
  }
}

async function pixelSize(path: string): Promise<{ w: number; h: number }> {
  const out = await sips(['-g', 'pixelWidth', '-g', 'pixelHeight', path])
  const w = Number(/pixelWidth:\s*(\d+)/.exec(out)?.[1])
  const h = Number(/pixelHeight:\s*(\d+)/.exec(out)?.[1])
  if (!w || !h) throw new Error('could not read image size')
  return { w, h }
}

const ROTATION: Record<number, number> = { 3: 180, 6: 90, 8: 270 }
const FLIP: Record<number, { rotate?: number; flip: 'horizontal' | 'vertical' }> = {
  2: { flip: 'horizontal' },
  4: { flip: 'vertical' },
  5: { rotate: 90, flip: 'horizontal' },
  7: { rotate: 270, flip: 'horizontal' },
}

/** One sips encode. `longEdge` is the source's longer side, probed once by
 *  the caller (rotation never changes it), so no encode re-probes. */
async function toJpeg(
  src: string,
  dest: string,
  maxEdge: number,
  longEdge: number,
  orient: { rotate?: number; flip?: 'horizontal' | 'vertical' } = {},
): Promise<void> {
  const args = ['-s', 'format', 'jpeg', '-s', 'formatOptions', JPEG_QUALITY]
  if (orient.rotate) args.push('-r', String(orient.rotate))
  if (orient.flip) args.push('-f', orient.flip)
  if (longEdge > maxEdge) args.push('-Z', String(maxEdge))
  await sips([...args, src, '--out', dest])
}

/**
 * Normalise one image into `destPath` (+ a thumbnail at `thumbPath`).
 * `src` is a file path (read-only) or raw uploaded bytes.
 */
export async function ingestPhoto(
  src: string | Uint8Array,
  destPath: string,
  thumbPath: string,
): Promise<void> {
  mkdirSync(dirname(destPath), { recursive: true })
  const work = `${destPath}.work.jpg`
  let upload: string | null = null
  try {
    let input: string
    if (typeof src === 'string') {
      const st = statSync(src)
      if (!st.isFile()) throw new Error(`not a file: ${src}`)
      if (st.size > PHOTO_MAX_INPUT_BYTES) throw new Error(`photo too large (${st.size} bytes)`)
      const fd = Bun.file(src)
      if (!sniffImage(new Uint8Array(await fd.slice(0, 16).arrayBuffer()))) {
        throw new Error(`not a HEIC/JPEG/PNG image: ${src}`)
      }
      input = src
    } else {
      if (src.length > PHOTO_MAX_INPUT_BYTES) throw new Error('photo too large')
      if (!sniffImage(src.subarray(0, 16))) throw new Error('upload is not a HEIC/JPEG/PNG image')
      upload = `${destPath}.upload`
      writeFileSync(upload, src)
      input = upload
    }

    // First pass learns the orientation (sips cannot read it off a HEIC
    // directly but carries the tag into its JPEG output). When the pixels need
    // turning, re-encode ONCE from the source with the rotation applied, so
    // the stored file is a single quality-70 encode, not a re-compressed one.
    const { w, h } = await pixelSize(input)
    const longEdge = Math.max(w, h)
    await toJpeg(input, work, PHOTO_MAX_EDGE, longEdge)
    const orientation = exifOrientation(readFileSync(work))
    const fix = ROTATION[orientation] ? { rotate: ROTATION[orientation] } : FLIP[orientation]
    if (fix) await toJpeg(input, work, PHOTO_MAX_EDGE, longEdge, fix)
    const clean = stripJpegMetadata(readFileSync(work))
    writeFileSync(work, clean)
    renameSync(work, destPath)

    const thumbWork = `${thumbPath}.work.jpg`
    // The stored photo's long edge is min(source, cap): no probe needed.
    await toJpeg(destPath, thumbWork, THUMB_MAX_EDGE, Math.min(longEdge, PHOTO_MAX_EDGE))
    writeFileSync(thumbWork, stripJpegMetadata(readFileSync(thumbWork)))
    renameSync(thumbWork, thumbPath)
  } finally {
    for (const p of [work, upload, `${thumbPath}.work.jpg`]) {
      if (p && existsSync(p)) {
        try {
          unlinkSync(p)
        } catch {}
      }
    }
  }
}
