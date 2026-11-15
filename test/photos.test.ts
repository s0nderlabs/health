import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { exifOrientation, hasPersonalMetadata, ingestPhoto, sniffImage, stripJpegMetadata } from '../src/photos.js'
import { exifApp1, makeJpeg, makePng, pixelSize, withExif } from './fixtures/images.js'

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'health-photos-'))
})
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('jpeg metadata', () => {
  test('reads orientation and strips EXIF incl. the GPS IFD', async () => {
    const jpeg = await makeJpeg(dir, 40, 20, 6)
    expect(exifOrientation(jpeg)).toBe(6)
    expect(hasPersonalMetadata(jpeg)).toBe(true)
    const clean = stripJpegMetadata(jpeg)
    expect(hasPersonalMetadata(clean)).toBe(false)
    expect(exifOrientation(clean)).toBe(1)
    // The 'S' GPS latitude ref byte sequence is gone with the segment.
    expect(Buffer.from(clean).includes(Buffer.from('Exif\0\0'))).toBe(false)
    // Image data intact: still decodes to the same size.
    const p = join(dir, 'clean.jpg')
    writeFileSync(p, clean)
    expect(await pixelSize(p)).toEqual({ w: 40, h: 20 })
  })

  test('little-endian EXIF orientation is read too', () => {
    const app1 = exifApp1(8)
    // Flip the TIFF header to II and byte-swap the two fields the reader uses.
    const le = new Uint8Array(app1)
    const t = 4 + 6
    le.set([0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0], t)
    le.set([2, 0], t + 8) // count
    le.set([0x12, 0x01, 3, 0, 1, 0, 0, 0, 8, 0], t + 10) // orientation 8
    const jpeg = withExif(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0x00, 0xff, 0xd9]), le)
    expect(exifOrientation(jpeg)).toBe(8)
  })

  test('garbage is refused, not passed through', () => {
    expect(() => stripJpegMetadata(new Uint8Array([1, 2, 3, 4]))).toThrow()
    expect(exifOrientation(new Uint8Array([1, 2, 3]))).toBe(1)
  })

  test('sniffs containers by bytes, not extension', () => {
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg')
    expect(sniffImage(makePng(2, 2).subarray(0, 16))).toBe('png')
    const heic = new Uint8Array(16)
    heic.set(Buffer.from('ftypheic'), 4)
    expect(sniffImage(heic)).toBe('heic')
    expect(sniffImage(Buffer.from('hello world, not an image'))).toBeNull()
  })
})

describe('ingestPhoto', () => {
  test('bakes orientation 6 into pixels, strips metadata, cuts a thumbnail', async () => {
    const jpeg = await makeJpeg(dir, 400, 200, 6)
    const src = join(dir, 'rot6.jpg')
    writeFileSync(src, jpeg)
    const before = readFileSync(src)
    const out = join(dir, 'out', 'r6.jpg')
    const thumb = join(dir, 'out', 'r6.thumb.jpg')
    await ingestPhoto(src, out, thumb)
    expect(await pixelSize(out)).toEqual({ w: 200, h: 400 }) // portrait now
    const outBytes = new Uint8Array(readFileSync(out))
    expect(hasPersonalMetadata(outBytes)).toBe(false)
    expect(hasPersonalMetadata(new Uint8Array(readFileSync(thumb)))).toBe(false)
    const t = await pixelSize(thumb)
    expect(Math.max(t.w, t.h)).toBe(360)
    // The original is read-only to the pipeline.
    expect(readFileSync(src).equals(before)).toBe(true)
    // No work files left behind.
    expect(existsSync(`${out}.work.jpg`)).toBe(false)
  })

  test('caps the long edge at 1568 and never upscales', async () => {
    const big = join(dir, 'big.png')
    writeFileSync(big, makePng(2000, 1000))
    await ingestPhoto(big, join(dir, 'out', 'big.jpg'), join(dir, 'out', 'big.thumb.jpg'))
    expect(await pixelSize(join(dir, 'out', 'big.jpg'))).toEqual({ w: 1568, h: 784 })
    const small = await makeJpeg(dir, 64, 32)
    await ingestPhoto(small, join(dir, 'out', 'small.jpg'), join(dir, 'out', 'small.thumb.jpg'))
    expect(await pixelSize(join(dir, 'out', 'small.jpg'))).toEqual({ w: 64, h: 32 })
  })

  test('uploaded bytes work the same as a path', async () => {
    const jpeg = await makeJpeg(dir, 300, 100, 8)
    const out = join(dir, 'out', 'up.jpg')
    await ingestPhoto(jpeg, out, join(dir, 'out', 'up.thumb.jpg'))
    expect(await pixelSize(out)).toEqual({ w: 100, h: 300 })
    expect(existsSync(`${out}.upload`)).toBe(false)
    expect(statSync(out).size).toBeGreaterThan(100)
  })

  test('non-images are rejected', async () => {
    const txt = join(dir, 'note.jpg')
    writeFileSync(txt, 'definitely not a jpeg, just text pretending')
    await expect(ingestPhoto(txt, join(dir, 'out', 'x.jpg'), join(dir, 'out', 'x.t.jpg'))).rejects.toThrow()
    await expect(ingestPhoto(join(dir, 'missing.heic'), join(dir, 'out', 'y.jpg'), join(dir, 'out', 'y.t.jpg'))).rejects.toThrow()
  })
})
