import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  CookieJar,
  apiUrl,
  decryptRc4,
  encParams,
  encSignature,
  encryptRc4,
  generateNonce,
  isBleDevice,
  isScaleDevice,
  normaliseMac,
  parseXiaomiJson,
  pickScale,
  rc4Drop,
  runBindkeyFlow,
  signedNonce,
  writeScaleConfig,
  type BindkeyDeps,
  type CloudDevice,
} from '../src/scale-cloud.ts'

// Cross-check vectors: computed by an independent stdlib-only Python
// re-implementation of the reference algorithm (Xiaomi-cloud-tokens-extractor
// c4db715: signed_nonce, generate_nonce, generate_enc_params, encrypt_rc4),
// on SYNTHETIC inputs (ssecurity = bytes 0..15, nonce random = deadbeef01020304).
const V = {
  ssecurity: 'AAECAwQFBgcICQoLDA0ODw==',
  rand8: new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03, 0x04]),
  millis: 1763270000000,
  nonce: '3q2+7wECAwQBwGw5',
  signedNonce: '5e/IRNvzPGS9eMUyLtCXrV9W9GMCBdm7tDhXNZN4CDw=',
  url: 'https://api.io.mi.com/app/v2/device/blt_get_beaconkey',
  data: '{"did":"blt.3.synthetic0000","pdid":1}',
  params: {
    data: '+ZJJ8DKBaibWw2VlbESCWqp9HO6Yl5UcUUAbpm0CYY5/UMDIXos=',
    rc4_hash__: 'sv8doWTqHFzx60gxahO/T6I4GszYtbtCC0EfuQ==',
    signature: 'cBpD7b4u8psyfsdixLXZyIvIlgg=',
    ssecurity: 'AAECAwQFBgcICQoLDA0ODw==',
    _nonce: '3q2+7wECAwQBwGw5',
  },
  plainRc4: '6tVB9TmDKG3VwHwi', // encrypt_rc4(signedNonce, "hello xiaomi")
  respPlain: '{"code":0,"message":"ok","result":{"beaconkey":"0123456789abcdef0123456789abcdef"}}',
  respEnc:
    '+ZJO9jLGcj6EgzMmOhmCQqNsVrHOkZ0OTVJZ4TJVfZ40DpnQDZOuWHvywyWe/jFnkfKhQBX/qvcK9qjuoFZGb/uaT/NGrLsA5jl6dWv8sfiAnEU=',
}

describe('crypto helpers match the reference algorithm', () => {
  test('plain RC4 (drop 0) matches the classic test vector', () => {
    const out = rc4Drop(new TextEncoder().encode('Key'), new TextEncoder().encode('Plaintext'), 0)
    expect(Buffer.from(out).toString('hex')).toBe('bbf316e8d940af0ad3')
  })

  test('generate_nonce + signed_nonce', () => {
    expect(generateNonce(V.millis, V.rand8)).toBe(V.nonce)
    expect(signedNonce(V.ssecurity, V.nonce)).toBe(V.signedNonce)
  })

  test('encrypt_rc4 / decrypt_rc4 round trip and match', () => {
    expect(encryptRc4(V.signedNonce, 'hello xiaomi')).toBe(V.plainRc4)
    expect(encryptRc4(V.signedNonce, V.respPlain)).toBe(V.respEnc)
    expect(decryptRc4(V.signedNonce, V.respEnc)).toBe(V.respPlain)
  })

  test('generate_enc_params: values and key order', () => {
    const p = encParams(V.url, 'POST', V.signedNonce, V.nonce, { data: V.data }, V.ssecurity)
    expect(p).toEqual(V.params)
    expect(Object.keys(p)).toEqual(['data', 'rc4_hash__', 'signature', 'ssecurity', '_nonce'])
  })

  test('api url per server', () => {
    expect(apiUrl('cn')).toBe('https://api.io.mi.com/app')
    expect(apiUrl('de')).toBe('https://de.api.io.mi.com/app')
  })

  test('to_json strips the prefix and keeps big ids exact', () => {
    const j = parseXiaomiJson('&&&START&&&{"id":123456789012345678,"n":5,"s":"x"}')
    expect(String(j.id)).toBe('123456789012345678')
    expect(j.n).toBe(5)
  })
})

describe('device pick', () => {
  const scale: CloudDevice = { did: 'blt.3.aaa', name: 'Body Composition Scale S400', mac: 'AA:BB:CC:00:11:22', model: 'yunmai.scales.ms103' }
  const lamp: CloudDevice = { did: '111', name: 'Lamp', mac: '01:02:03:04:05:06', model: 'yeelink.light.x' }
  const other: CloudDevice = { did: 'blt.3.bbb', name: 'Scale 2', mac: '01:02:03:04:05:07', model: 'xiaomi.scales.other' }
  const byName: CloudDevice = { did: 'blt.3.ccc', name: 'MJTZC01YM', mac: '01:02:03:04:05:08', model: 'unknown.model' }
  const thermo: CloudDevice = { did: 'blt.3.ddd', name: 'Thermometer', mac: '01:02:03:04:05:09', model: 'miaomiaoce.sensor_ht.t2' }
  const wifiScale: CloudDevice = { did: '222', name: 'Wi-Fi Scale', mac: '01:02:03:04:05:0A', model: 'xiaomi.scales.wifi' }

  test('scale heuristics', () => {
    expect(isScaleDevice(scale)).toBe(true)
    expect(isScaleDevice(lamp)).toBe(false)
    expect(isScaleDevice(byName)).toBe(true)
  })

  test('single scale wins without asking', async () => {
    let asked = false
    const d = await pickScale([lamp, scale], { choose: async () => { asked = true; return 0 } })
    expect(d).toBe(scale)
    expect(asked).toBe(false)
  })

  test('--did wins', async () => {
    expect(await pickScale([lamp, scale, other], { did: 'blt.3.bbb' })).toBe(other)
    await expect(pickScale([lamp], { did: 'nope' })).rejects.toThrow('no device with did nope')
  })

  test('several scales: tty chooses among the scales only', async () => {
    let shown: CloudDevice[] = []
    const d = await pickScale([lamp, scale, other], { choose: async (l) => { shown = l; return 1 } })
    expect(shown).toEqual([scale, other])
    expect(d).toBe(other)
  })

  test('no scale: tty chooses from the BLE devices only (Wi-Fi ones have no bindkey)', async () => {
    let shown: CloudDevice[] = []
    const d = await pickScale([lamp, thermo], { choose: async (l) => { shown = l; return 0 } })
    expect(shown).toEqual([thermo])
    expect(d).toBe(thermo)
  })

  test('a scale-looking Wi-Fi device is never auto-picked; BLE did check', async () => {
    expect(isBleDevice(scale)).toBe(true)
    expect(isBleDevice(lamp)).toBe(false)
    expect(await pickScale([wifiScale, scale], {})).toBe(scale)
    await expect(pickScale([wifiScale, lamp], { choose: async () => 0 })).rejects.toThrow('no BLE devices')
  })

  test('ambiguous without a tty, or a bad pick, fails cleanly', async () => {
    await expect(pickScale([scale, other], {})).rejects.toThrow('--did')
    await expect(pickScale([thermo], {})).rejects.toThrow('--did')
    await expect(pickScale([lamp], {})).rejects.toThrow('no BLE devices')
    await expect(pickScale([], {})).rejects.toThrow('no devices')
    await expect(pickScale([scale, other], { choose: async () => 7 })).rejects.toThrow('no device picked')
    await expect(pickScale([scale, other], { choose: async () => null })).rejects.toThrow('no device picked')
  })

  test('mac normalisation', () => {
    expect(normaliseMac('aa:bb:cc:00:11:22')).toBe('AA:BB:CC:00:11:22')
    expect(normaliseMac('AABBCC001122')).toBe('AA:BB:CC:00:11:22')
    expect(normaliseMac('')).toBeNull()
  })
})

describe('cookie jar', () => {
  test('domain cookies reach subdomains, host-only do not; explicit wins', () => {
    const jar = new CookieJar()
    jar.store('https://account.xiaomi.com/x', ['a=1; Domain=.xiaomi.com; Path=/', 'b=2; Path=/'])
    expect(jar.header('https://app.account.xiaomi.com/lp')).toBe('a=1')
    expect(jar.header('https://account.xiaomi.com/y')).toBe('a=1; b=2')
    expect(jar.header('https://api.io.mi.com/app', { a: '9' })).toBe('a=9')
    expect(JSON.stringify({ jar })).not.toContain('a=1')
  })
})

describe('config block', () => {
  test('merges into existing config, preserving other keys', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scale-cfg-'))
    try {
      const p = join(dir, 'config.json')
      writeFileSync(p, JSON.stringify({ whoop: { x: 1 }, scale: { old: true } }), { mode: 0o644 })
      writeFileSync(p + '.tmp', 'leftover from a crash', { mode: 0o644 })
      writeScaleConfig(p, { mac: 'AA:BB:CC:00:11:22', did: 'blt.3.aaa', model: 'm', keychain_service: 's', keychain_account: 'AA:BB:CC:00:11:22' })
      const j = JSON.parse(readFileSync(p, 'utf8'))
      expect(j.whoop).toEqual({ x: 1 })
      expect(j.scale).toEqual({ old: true, mac: 'AA:BB:CC:00:11:22', did: 'blt.3.aaa', model: 'm', keychain_service: 's', keychain_account: 'AA:BB:CC:00:11:22' })
      // the file carries live.token: owner-only, even when it was 0644 before
      expect(statSync(p).mode & 0o777).toBe(0o600)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('creates a missing file, refuses a malformed one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scale-cfg-'))
    try {
      const p = join(dir, 'sub', 'config.json')
      writeScaleConfig(p, { mac: 'M', did: 'D', model: 'X', keychain_service: 's', keychain_account: 'M' })
      expect(JSON.parse(readFileSync(p, 'utf8')).scale.did).toBe('D')
      expect(statSync(p).mode & 0o777).toBe(0o600)
      const bad = join(dir, 'bad.json')
      writeFileSync(bad, '{not json')
      expect(() => writeScaleConfig(bad, { mac: 'M', did: 'D', model: 'X', keychain_service: 's', keychain_account: 'M' })).toThrow('not a valid JSON')
      expect(readFileSync(bad, 'utf8')).toBe('{not json')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// Full flow against a fake Xiaomi (injected fetch). All values synthetic.

const SECRETS = {
  ssecurity: Buffer.from('synthetic-ssec!!').toString('base64'), // 16 bytes
  serviceToken: 'SYNTHserviceTOKENqwertyuiop1234567890',
  passToken: 'SYNTHpassTOKENasdfghjkl',
  cUserId: 'SYNTHcUserIdZXCV',
  userId: 987654321,
  bindkey: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
  homeCookie: 'SYNTHcookieVALUEmnbv',
}
const SCALE_DEV = { did: 'blt.3.synthscale01', name: 'Xiaomi Body Composition Scale S400', mac: 'c8:47:80:12:34:56', model: 'yunmai.scales.ms103' }

interface FakeOpts {
  apiCode?: number
  /** Per-API-path failure: a number = API error code, 'http' = HTTP 500. */
  failPaths?: Record<string, number | 'http'>
  homes?: object[]
  shareFamily?: object[]
  beaconkeyDid?: string
  bindkey?: string
  devices?: object[]
  lpTimeouts?: number
  lpNeverConfirms?: boolean
}

function fakeXiaomi(o: FakeOpts = {}) {
  const calls: string[] = []
  const apiCookies: string[] = []
  let lpLeft = o.lpTimeouts ?? 1
  const enc = (nonce: string, body: object): string => encryptRc4(signedNonce(SECRETS.ssecurity, nonce), JSON.stringify(body))

  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(url)
    calls.push(u.origin + u.pathname)
    if (u.pathname === '/longPolling/loginUrl') {
      expect(u.searchParams.get('sid')).toBe('xiaomiio')
      return new Response(
        '&&&START&&&' + JSON.stringify({ qr: 'https://account.xiaomi.com/qr/img?k=synthqr', lp: 'https://app.account.xiaomi.com/lp/synth', loginUrl: 'https://account.xiaomi.com/l/synth', timeout: 300 }),
        { status: 200, headers: [['set-cookie', `qrsess=${SECRETS.homeCookie}; Domain=.xiaomi.com; Path=/`]] },
      )
    }
    if (u.pathname === '/qr/img') return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { status: 200 })
    if (u.pathname === '/lp/synth') {
      expect(String((init?.headers as Record<string, string>)?.Cookie ?? '')).toContain('qrsess=')
      if (o.lpNeverConfirms) {
        const e = new Error('timed out')
        e.name = 'TimeoutError'
        throw e
      }
      if (lpLeft-- > 0) {
        const e = new Error('timed out')
        e.name = 'TimeoutError'
        throw e
      }
      return new Response(
        '&&&START&&&' + JSON.stringify({ code: 0, userId: SECRETS.userId, ssecurity: SECRETS.ssecurity, cUserId: SECRETS.cUserId, passToken: SECRETS.passToken, location: 'https://sts.api.io.mi.com/sts?d=synth&clientSign=x' }),
        { status: 200 },
      )
    }
    if (u.hostname === 'sts.api.io.mi.com') {
      return new Response(null, {
        status: 302,
        headers: [['location', 'https://sts.api.io.mi.com/done'], ['set-cookie', `serviceToken=${SECRETS.serviceToken}; Path=/`]],
      })
    }
    if (u.pathname === '/done') return new Response('ok', { status: 200 })
    if (u.hostname === 'api.io.mi.com') {
      expect(init?.method).toBe('POST')
      const cookie = String((init?.headers as Record<string, string>)?.Cookie ?? '')
      apiCookies.push(cookie)
      expect(cookie).toContain(`serviceToken=${SECRETS.serviceToken}`)
      expect(cookie).toContain(`userId=${SECRETS.userId}`)
      // Server side: check the signature + decrypt the request like Xiaomi would.
      const q = u.searchParams
      const nonce = q.get('_nonce')!
      expect(q.get('ssecurity')).toBe(SECRETS.ssecurity)
      const sn = signedNonce(SECRETS.ssecurity, nonce)
      const encrypted = { data: q.get('data')!, rc4_hash__: q.get('rc4_hash__')! }
      expect(q.get('signature')).toBe(encSignature(url.split('?')[0], 'POST', sn, encrypted))
      const data = decryptRc4(sn, encrypted.data)
      expect(decryptRc4(sn, encrypted.rc4_hash__)).toBe(encSignature(url.split('?')[0], 'POST', sn, { data }))
      const body = JSON.parse(data)
      if (o.apiCode) return new Response(enc(nonce, { code: o.apiCode, message: 'auth err' }), { status: 200 })
      const path = u.pathname
      const failKey = path === '/app/v2/home/home_device_list' ? `${path}#${body.home_id}` : path
      const fail = o.failPaths?.[failKey] ?? o.failPaths?.[path]
      if (fail === 'http') return new Response('upstream says no: ' + SECRETS.homeCookie, { status: 500 })
      if (typeof fail === 'number') return new Response(enc(nonce, { code: fail, message: 'no ' + SECRETS.homeCookie }), { status: 200 })
      if (path === '/app/v2/homeroom/gethome') return new Response(enc(nonce, { code: 0, result: { homelist: o.homes ?? [{ id: 112233445566 }] } }), { status: 200 })
      if (path === '/app/v2/user/get_device_cnt') return new Response(enc(nonce, { code: 0, result: { share: { share_family: o.shareFamily ?? [] } } }), { status: 200 })
      if (path === '/app/v2/home/home_device_list') {
        if (body.home_id !== 112233445566) return new Response(enc(nonce, { code: 0, result: { device_info: [] } }), { status: 200 })
        expect(body.home_owner).toBe(SECRETS.userId)
        return new Response(
          enc(nonce, { code: 0, result: { device_info: o.devices ?? [{ did: '9001', name: 'Lamp', mac: '01:02:03:04:05:06', model: 'yeelink.light.x' }, SCALE_DEV] } }),
          { status: 200 },
        )
      }
      if (path === '/app/v2/device/blt_get_beaconkey') {
        expect(body).toEqual({ did: o.beaconkeyDid ?? SCALE_DEV.did, pdid: 1 })
        return new Response(enc(nonce, { code: 0, result: { beaconkey: o.bindkey ?? SECRETS.bindkey } }), { status: 200 })
      }
    }
    return new Response('nope', { status: 404 })
  }
  return { fetch, calls, apiCookies }
}

function harness(o: FakeOpts = {}) {
  const fake = fakeXiaomi(o)
  const out: string[] = []
  const stored: { account: string; hex: string }[] = []
  const opened: string[] = []
  const dirs: string[] = []
  const removed: string[] = []
  let clock = 1_763_270_000_000
  let rnd = 0
  const deps: BindkeyDeps = {
    fetch: fake.fetch,
    say: (l) => out.push(l),
    openImage: (p) => { opened.push(p); expect(existsSync(p)).toBe(true) },
    makeTempDir: () => { const d = mkdtempSync(join(tmpdir(), 's400-qr-test-')); dirs.push(d); return d },
    removeDir: (d) => { removed.push(d); rmSync(d, { recursive: true, force: true }) },
    keychainStore: (account, hex) => stored.push({ account, hex }),
    now: () => (clock += 5_000),
    sleep: async () => {},
    randomBytes: (n) => new Uint8Array(n).map(() => (rnd = (rnd * 31 + 7) & 0xff)),
  }
  return { fake, out, stored, opened, dirs, removed, deps }
}

function assertNoSecrets(text: string): void {
  for (const [k, v] of Object.entries(SECRETS)) {
    expect({ k, leaked: text.includes(String(v)) }).toEqual({ k, leaked: false })
  }
  expect(text.toLowerCase()).not.toContain(SECRETS.bindkey.toLowerCase())
}

describe('runBindkeyFlow (injected fetch)', () => {
  test('happy path: QR, long-poll retry, redirect token, signed calls, keychain, config', async () => {
    const h = harness()
    const dir = mkdtempSync(join(tmpdir(), 'scale-flow-'))
    try {
      const cfg = join(dir, 'config.json')
      writeFileSync(cfg, JSON.stringify({ whoop: { client_id: 'keep-me' } }))
      const rec = await runBindkeyFlow({ server: 'cn', configPath: cfg }, h.deps)

      expect(rec).toEqual({ did: SCALE_DEV.did, mac: 'C8:47:80:12:34:56', model: 'yunmai.scales.ms103' })
      expect(h.stored).toEqual([{ account: 'C8:47:80:12:34:56', hex: SECRETS.bindkey }])
      expect(h.opened.length).toBe(1)
      expect(h.removed).toEqual(h.dirs)
      expect(existsSync(h.dirs[0])).toBe(false)

      const j = JSON.parse(readFileSync(cfg, 'utf8'))
      expect(j.whoop).toEqual({ client_id: 'keep-me' })
      expect(j.scale).toEqual({
        mac: 'C8:47:80:12:34:56', did: SCALE_DEV.did, model: 'yunmai.scales.ms103',
        keychain_service: 'dev.s400-bindkey', keychain_account: 'C8:47:80:12:34:56',
      })

      const printed = h.out.join('\n')
      expect(printed).toContain('model: yunmai.scales.ms103')
      expect(printed).toContain(`did: ${SCALE_DEV.did}`)
      expect(printed).toContain('mac: C8:47:80:12:34:56')
      expect(printed).toContain('bindkey stored in Keychain (32 hex chars)')
      // the QR URL (response-derived, with a query) stays off the terminal when Preview opens
      expect(printed).not.toContain('qr/img')
      expect(printed).not.toContain('synthqr')
      // HARD: nothing printed, and nothing in the config, carries a secret.
      assertNoSecrets(printed)
      assertNoSecrets(readFileSync(cfg, 'utf8'))
      // The beaconkey call happened, and only for the scale.
      expect(h.fake.calls.filter((c) => c.endsWith('blt_get_beaconkey')).length).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('API error: message is secret-free, nothing stored, temp QR removed', async () => {
    const h = harness({ apiCode: -8 })
    const dir = mkdtempSync(join(tmpdir(), 'scale-flow-'))
    try {
      const cfg = join(dir, 'config.json')
      let err: Error | null = null
      try { await runBindkeyFlow({ server: 'cn', configPath: cfg }, h.deps) } catch (e) { err = e as Error }
      expect(err?.message).toContain('API error code -8')
      expect(err?.message).toContain('no devices found; failed steps')
      assertNoSecrets(String(err?.message) + String(err?.stack) + h.out.join('\n'))
      expect(h.stored).toEqual([])
      expect(existsSync(cfg)).toBe(false)
      expect(existsSync(h.dirs[0])).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('malformed bindkey is refused and never printed', async () => {
    const h = harness({ bindkey: 'deadbeefCAFEBABE0011' })
    const dir = mkdtempSync(join(tmpdir(), 'scale-flow-'))
    try {
      let err: Error | null = null
      try { await runBindkeyFlow({ server: 'cn', configPath: join(dir, 'c.json') }, h.deps) } catch (e) { err = e as Error }
      expect(err?.message).toContain('expected 32 hex')
      expect(String(err?.message) + h.out.join('\n')).not.toContain('deadbeefCAFEBABE0011')
      expect(h.stored).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('QR never confirmed: times out after the deadline, cleans up', async () => {
    const h = harness({ lpNeverConfirms: true })
    let err: Error | null = null
    try {
      await runBindkeyFlow({ server: 'cn', configPath: '/nonexistent/never-written.json', qrTimeoutMs: 60_000 }, h.deps)
    } catch (e) { err = e as Error }
    expect(err?.message).toContain('timed out')
    expect(existsSync(h.dirs[0])).toBe(false)
    expect(h.fake.calls.some((c) => c.includes('api.io.mi.com'))).toBe(false)
  })

  test('two scales and no tty: fails asking for --did; --did picks', async () => {
    const twin = { ...SCALE_DEV, did: 'blt.3.synthscale02', mac: 'c8:47:80:00:00:01' }
    const h = harness({ devices: [SCALE_DEV, twin] })
    let err: Error | null = null
    try { await runBindkeyFlow({ server: 'cn', configPath: '/nonexistent/x.json' }, h.deps) } catch (e) { err = e as Error }
    expect(err?.name).toBe('PickError')

    const h2 = harness({ devices: [twin, SCALE_DEV] })
    const dir = mkdtempSync(join(tmpdir(), 'scale-flow-'))
    try {
      const rec = await runBindkeyFlow({ server: 'cn', configPath: join(dir, 'c.json'), did: SCALE_DEV.did }, h2.deps)
      expect(rec.did).toBe(SCALE_DEV.did)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('Preview cannot open the QR: only then is the QR image URL printed', async () => {
    const h = harness()
    h.deps.openImage = () => { throw new Error('open failed') }
    const dir = mkdtempSync(join(tmpdir(), 'scale-flow-'))
    try {
      await runBindkeyFlow({ server: 'cn', configPath: join(dir, 'c.json') }, h.deps)
      const printed = h.out.join('\n')
      expect(printed).toContain('Could not open Preview; open this QR image URL instead: https://account.xiaomi.com/qr/img?k=synthqr')
      assertNoSecrets(printed)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('soft lookups: a failing shared home and a failing device count still yield the scale (no re-scan)', async () => {
    const h = harness({
      shareFamily: [{ home_id: 555, home_owner: 444 }],
      failPaths: { '/app/v2/user/get_device_cnt': 'http' },
    })
    const h2 = harness({
      shareFamily: [{ home_id: 555, home_owner: 444 }],
      failPaths: { '/app/v2/home/home_device_list#555': -6 },
    })
    const dir = mkdtempSync(join(tmpdir(), 'scale-flow-'))
    try {
      const rec = await runBindkeyFlow({ server: 'cn', configPath: join(dir, 'a.json') }, h.deps)
      expect(rec.did).toBe(SCALE_DEV.did)
      expect(h.out.join('\n')).toContain('Skipped 1 failed lookup(s): /v2/user/get_device_cnt: HTTP 500')
      // h2: get_device_cnt works (shared home 555 listed) but that home's device list fails
      const rec2 = await runBindkeyFlow({ server: 'cn', configPath: join(dir, 'b.json') }, h2.deps)
      expect(rec2.did).toBe(SCALE_DEV.did)
      expect(h2.out.join('\n')).toContain('/v2/home/home_device_list: API error code -6')
      assertNoSecrets(h.out.join('\n') + h2.out.join('\n'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('every lookup failing: one secret-free error naming the steps, nothing stored', async () => {
    const h = harness({ failPaths: { '/app/v2/homeroom/gethome': -3, '/app/v2/user/get_device_cnt': 'http' } })
    let err: Error | null = null
    try { await runBindkeyFlow({ server: 'cn', configPath: '/nonexistent/x.json' }, h.deps) } catch (e) { err = e as Error }
    expect(err?.name).toBe('XiaomiFlowError')
    expect(err?.message).toBe('no devices found; failed steps: /v2/homeroom/gethome: API error code -3; /v2/user/get_device_cnt: HTTP 500')
    assertNoSecrets(String(err?.message) + String(err?.stack) + h.out.join('\n'))
    expect(h.stored).toEqual([])
  })

  test('the beaconkey call stays strict', async () => {
    const h = harness({ failPaths: { '/app/v2/device/blt_get_beaconkey': -2 } })
    let err: Error | null = null
    try { await runBindkeyFlow({ server: 'cn', configPath: '/nonexistent/x.json' }, h.deps) } catch (e) { err = e as Error }
    expect(err?.message).toBe('/v2/device/blt_get_beaconkey: API error code -2')
    expect(h.stored).toEqual([])
  })

  test('--did on a Wi-Fi device fails BEFORE the beaconkey call, with a clear message', async () => {
    const h = harness()
    let err: Error | null = null
    try { await runBindkeyFlow({ server: 'cn', configPath: '/nonexistent/x.json', did: '9001' }, h.deps) } catch (e) { err = e as Error }
    expect(err?.message).toBe('device 9001 is not a BLE device (no bindkey)')
    expect(h.fake.calls.some((c) => c.endsWith('blt_get_beaconkey'))).toBe(false)
    expect(h.stored).toEqual([])
  })
})
