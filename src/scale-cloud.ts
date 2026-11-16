// Xiaomi cloud: QR-code login + signed device list, used ONCE to fetch the
// S400 scale's BLE bindkey (MiBeacon v5 AES-CCM key). A port of the
// QrCodeXiaomiCloudConnector + XiaomiCloudConnector helpers from
// PiotrMachowski/Xiaomi-cloud-tokens-extractor (c4db715).
//
// SECRET HYGIENE (hard rule): the Xiaomi session (serviceToken, ssecurity,
// passToken, userId, cookies) lives only in local variables of one login run.
// Nothing here prints, logs or persists it, and no error message carries a
// response body, a URL with query, or a header: errors name the step and an
// HTTP status / numeric code, nothing else. The bindkey is handed to the
// caller's keychainStore and never printed either. The one response-derived
// URL ever printed is the QR image URL (a short-lived login ticket, not the
// session), and only when Preview could not open the downloaded QR image.
//
// Like the reference, the home / device-count / per-home device calls are
// soft (a stale shared home must not cost a fresh QR scan); the run fails only
// when no device was found at all. The beaconkey call stays strict, and is
// only made for a BLE did ("blt" in it), as both references do.

import { createHash } from 'crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

export const SCALE_KEYCHAIN_SERVICE = 'dev.s400-bindkey'
export const XIAOMI_SERVERS = ['cn', 'de', 'us', 'ru', 'tw', 'sg', 'in', 'i2'] as const

// ---------------------------------------------------------------------------
// Crypto helpers (signature + RC4), faithful to the reference.

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64')
const unb64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64'))

/** RC4 with the first `drop` keystream bytes discarded (reference: ARC4 then
 *  encrypt(bytes(1024)) before the real payload). Symmetric. */
export function rc4Drop(key: Uint8Array, data: Uint8Array, drop = 1024): Uint8Array {
  const S = new Uint8Array(256)
  for (let i = 0; i < 256; i++) S[i] = i
  let j = 0
  for (let i = 0; i < 256; i++) {
    j = (j + S[i] + key[i % key.length]) & 0xff
    const t = S[i]; S[i] = S[j]; S[j] = t
  }
  let i = 0
  j = 0
  const next = (): number => {
    i = (i + 1) & 0xff
    j = (j + S[i]) & 0xff
    const t = S[i]; S[i] = S[j]; S[j] = t
    return S[(S[i] + S[j]) & 0xff]
  }
  for (let n = 0; n < drop; n++) next()
  const out = new Uint8Array(data.length)
  for (let n = 0; n < data.length; n++) out[n] = data[n] ^ next()
  return out
}

/** encrypt_rc4(password, payload): base64(RC4-drop1024(b64dec(password), utf8(payload))). */
export function encryptRc4(passwordB64: string, payload: string): string {
  return b64(rc4Drop(unb64(passwordB64), new TextEncoder().encode(payload)))
}

/** decrypt_rc4(password, payload) decoded as utf8. */
export function decryptRc4(passwordB64: string, payloadB64: string): string {
  return new TextDecoder().decode(rc4Drop(unb64(passwordB64), unb64(payloadB64)))
}

/** signed_nonce: base64(sha256(b64dec(ssecurity) + b64dec(nonce))). */
export function signedNonce(ssecurityB64: string, nonceB64: string): string {
  return createHash('sha256').update(unb64(ssecurityB64)).update(unb64(nonceB64)).digest('base64')
}

/** generate_nonce: base64(8 random bytes + floor(millis / 60000) as u32 big-endian). */
export function generateNonce(millis: number, rand8: Uint8Array): string {
  if (rand8.length !== 8) throw new Error('nonce needs 8 random bytes')
  const buf = new Uint8Array(12)
  buf.set(rand8, 0)
  new DataView(buf.buffer).setUint32(8, Math.floor(millis / 60000) >>> 0, false)
  return b64(buf)
}

/** Python's url.split("com")[1]: the text between the first and second "com". */
function pathAfterCom(url: string): string {
  const parts = url.split('com')
  if (parts.length < 2) throw new Error('API URL does not contain "com"')
  return parts[1]
}

/** generate_enc_signature: base64(sha1("METHOD&/path&k=v...&signed_nonce")). */
export function encSignature(
  url: string,
  method: string,
  signedNonceB64: string,
  params: Record<string, string>,
): string {
  const parts = [method.toUpperCase(), pathAfterCom(url).replace('/app/', '/')]
  for (const [k, v] of Object.entries(params)) parts.push(`${k}=${v}`)
  parts.push(signedNonceB64)
  return createHash('sha1').update(parts.join('&'), 'utf8').digest('base64')
}

/** generate_enc_params. Returns a NEW ordered object (the reference mutates
 *  its input); order is data..., rc4_hash__, signature, ssecurity, _nonce. */
export function encParams(
  url: string,
  method: string,
  signedNonceB64: string,
  nonceB64: string,
  params: Record<string, string>,
  ssecurityB64: string,
): Record<string, string> {
  const p: Record<string, string> = { ...params }
  p.rc4_hash__ = encSignature(url, method, signedNonceB64, p)
  for (const k of Object.keys(p)) p[k] = encryptRc4(signedNonceB64, p[k])
  p.signature = encSignature(url, method, signedNonceB64, p)
  p.ssecurity = ssecurityB64
  p._nonce = nonceB64
  return p
}

export function apiUrl(server: string): string {
  return 'https://' + (server === 'cn' ? '' : server + '.') + 'api.io.mi.com/app'
}

/** to_json, plus big-integer safety: JSON numbers of 16+ digits are quoted
 *  before parsing so ids above 2^53 keep every digit (String(id) is then exact). */
export function parseXiaomiJson(text: string): any {
  const stripped = text.replace('&&&START&&&', '')
  const safe = stripped.replace(/([:\[,]\s*)(-?\d{16,})(?=\s*[,}\]])/g, '$1"$2"')
  return JSON.parse(safe)
}

// ---------------------------------------------------------------------------
// Minimal in-memory cookie jar (requests.Session stand-in). Never serialised.

interface JarCookie { name: string; value: string; domain: string; hostOnly: boolean }

export class CookieJar {
  #cookies: JarCookie[] = []

  store(url: string, setCookies: string[]): void {
    const host = new URL(url).hostname.toLowerCase()
    for (const line of setCookies) {
      const [pair, ...attrs] = line.split(';')
      const eq = pair.indexOf('=')
      if (eq <= 0) continue
      const name = pair.slice(0, eq).trim()
      const value = pair.slice(eq + 1).trim()
      let domain = host
      let hostOnly = true
      let expired = false
      for (const a of attrs) {
        const [k, v = ''] = a.split('=')
        const key = k.trim().toLowerCase()
        if (key === 'domain' && v.trim()) {
          domain = v.trim().replace(/^\./, '').toLowerCase()
          hostOnly = false
        } else if (key === 'max-age' && Number(v.trim()) <= 0) {
          expired = true
        } else if (key === 'expires') {
          const t = Date.parse(v.trim())
          if (Number.isFinite(t) && t < Date.now()) expired = true
        }
      }
      this.#cookies = this.#cookies.filter((c) => !(c.name === name && c.domain === domain))
      if (!expired && value !== 'EXPIRED') this.#cookies.push({ name, value, domain, hostOnly })
    }
  }

  get(name: string): string | undefined {
    for (let i = this.#cookies.length - 1; i >= 0; i--) {
      if (this.#cookies[i].name === name) return this.#cookies[i].value
    }
    return undefined
  }

  header(url: string, extra: Record<string, string> = {}): string {
    const host = new URL(url).hostname.toLowerCase()
    const out = new Map<string, string>()
    for (const c of this.#cookies) {
      const match = c.hostOnly ? host === c.domain : host === c.domain || host.endsWith('.' + c.domain)
      if (match) out.set(c.name, c.value)
    }
    for (const [k, v] of Object.entries(extra)) out.set(k, v) // explicit cookies win
    return [...out].map(([k, v]) => `${k}=${v}`).join('; ')
  }

  // Never let a jar leak through console.log / JSON.stringify.
  toJSON(): string { return '[cookie jar]' }
  [Symbol.for('nodejs.util.inspect.custom')](): string { return '[cookie jar]' }
}

function setCookiesOf(res: Response): string[] {
  const h = res.headers as Headers & { getSetCookie?: () => string[] }
  if (typeof h.getSetCookie === 'function') return h.getSetCookie()
  const one = res.headers.get('set-cookie')
  return one ? [one] : []
}

// ---------------------------------------------------------------------------
// Device model + pick logic.

export interface CloudDevice {
  did: string
  name: string
  mac: string
  model: string
}

export interface ScaleRecord {
  did: string
  mac: string
  model: string
}

/** Only BLE devices have a beaconkey (both references gate on "blt" in did). */
export function isBleDevice(d: Pick<CloudDevice, 'did'>): boolean {
  return d.did.includes('blt')
}

export function isScaleDevice(d: CloudDevice): boolean {
  const model = d.model.toLowerCase()
  return model.includes('scales') || model.includes('yunmai') || /mjtzc0/i.test(d.model) || /mjtzc0/i.test(d.name)
}

export class PickError extends Error {
  constructor(msg: string) {
    super(msg)
    this.name = 'PickError'
  }
}

/** Which device is the scale. --did wins; else a single scale-looking BLE
 *  device; else ask (tty) from the BLE scale candidates, or from every BLE
 *  device if none look like a scale. No tty and ambiguous = PickError (re-run
 *  with --did). Wi-Fi devices are never offered: they have no bindkey. */
export async function pickScale(
  devices: CloudDevice[],
  opts: { did?: string; choose?: (list: CloudDevice[]) => Promise<number | null> },
): Promise<CloudDevice> {
  if (opts.did) {
    const hit = devices.find((d) => d.did === opts.did)
    if (!hit) throw new PickError(`no device with did ${opts.did} on this account`)
    return hit
  }
  const ble = devices.filter(isBleDevice)
  const scales = ble.filter(isScaleDevice)
  if (scales.length === 1) return scales[0]
  const list = scales.length > 1 ? scales : ble
  if (devices.length === 0) throw new PickError('no devices found on this account and server')
  if (list.length === 0) throw new PickError('no BLE devices on this account and server (a scale has a did starting "blt.")')
  if (!opts.choose) {
    throw new PickError(
      scales.length > 1
        ? `${scales.length} scales found; re-run with --did <did> to pick one`
        : 'no device looks like a scale; re-run with --did <did> to pick one',
    )
  }
  const idx = await opts.choose(list)
  if (idx == null || !Number.isInteger(idx) || idx < 0 || idx >= list.length) {
    throw new PickError('no device picked')
  }
  return list[idx]
}

export function describeDevice(d: CloudDevice): string {
  return `${d.name || '(unnamed)'}  model=${d.model || '?'}  did=${d.did}  mac=${d.mac || '?'}`
}

export function normaliseMac(mac: string): string | null {
  const hex = mac.replace(/[^0-9a-fA-F]/g, '').toUpperCase()
  if (hex.length !== 12) return null
  return hex.match(/../g)!.join(':')
}

export function isValidBindkey(hex: string): boolean {
  return /^[0-9a-fA-F]{32}$/.test(hex)
}

// ---------------------------------------------------------------------------
// Config: merge a `scale` block into the JSON config, preserving every other key.

export interface ScaleConfigBlock extends ScaleRecord {
  keychain_service: string
  keychain_account: string
}

export function writeScaleConfig(path: string, block: ScaleConfigBlock): void {
  let parsed: Record<string, unknown> = {}
  if (existsSync(path)) {
    const raw = readFileSync(path, 'utf8')
    try {
      const v = JSON.parse(raw)
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object')
      parsed = v
    } catch {
      throw new Error(`config at ${path} is not a valid JSON object; fix it first (left untouched)`)
    }
  }
  const prev = (parsed.scale && typeof parsed.scale === 'object' ? parsed.scale : {}) as Record<string, unknown>
  const next = { ...parsed, scale: { ...prev, ...block } }
  mkdirSync(dirname(path), { recursive: true })
  // Owner-only: the same file carries live.token (the live-route bearer).
  writeFileSync(path + '.tmp', JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
  chmodSync(path + '.tmp', 0o600)
  renameSync(path + '.tmp', path)
}

// ---------------------------------------------------------------------------
// The login + fetch flow.

export interface BindkeyDeps {
  fetch: FetchFn
  say: (line: string) => void
  /** Show the QR PNG on screen (default: open -a Preview). */
  openImage: (pngPath: string) => void
  /** A fresh private temp dir for the QR PNG; deleted by the caller of runBindkeyFlow. */
  makeTempDir: () => string
  removeDir: (dir: string) => void
  keychainStore: (account: string, hex: string) => void
  choose?: (list: CloudDevice[]) => Promise<number | null>
  now: () => number
  sleep: (ms: number) => Promise<void>
  randomBytes: (n: number) => Uint8Array
}

export interface BindkeyOptions {
  server: string
  configPath: string
  did?: string
  /** Overall QR wait (default 3 min). */
  qrTimeoutMs?: number
  /** Per long-poll request timeout (reference: 10 s). */
  pollRequestMs?: number
}

export class XiaomiFlowError extends Error {
  constructor(msg: string) {
    super(msg)
    this.name = 'XiaomiFlowError'
  }
}

const LOGIN_URL = 'https://account.xiaomi.com/longPolling/loginUrl'

function randomAgent(rand: (n: number) => Uint8Array): string {
  const r = rand(31)
  const agentId = Array.from(r.slice(0, 13), (b) => String.fromCharCode(65 + (b % 5))).join('')
  const text = Array.from(r.slice(13), (b) => String.fromCharCode(97 + (b % 26))).join('')
  return `${text}-${agentId} APP/com.xiaomi.mihome APPV/10.5.201`
}

function isAbort(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name
  return name === 'TimeoutError' || name === 'AbortError'
}

/** Run the whole thing: QR login, device list, pick, bindkey, Keychain, config.
 *  Returns the non-secret scale record. */
export async function runBindkeyFlow(opts: BindkeyOptions, deps: BindkeyDeps): Promise<ScaleRecord> {
  const jar = new CookieJar()
  const qrTimeoutMs = opts.qrTimeoutMs ?? 180_000
  const pollRequestMs = opts.pollRequestMs ?? 10_000

  // Session fetch: jar in, jar out, no automatic redirects (we follow by hand
  // so Set-Cookie on every hop is captured). Errors never carry the URL.
  const get = async (url: string, step: string, headers: Record<string, string> = {}, signal?: AbortSignal) => {
    let res: Response
    try {
      const cookie = jar.header(url)
      res = await deps.fetch(url, {
        method: 'GET',
        headers: { ...headers, ...(cookie ? { Cookie: cookie } : {}) },
        redirect: 'manual',
        signal,
      })
    } catch (err) {
      if (isAbort(err)) throw err
      throw new XiaomiFlowError(`${step}: network error`)
    }
    jar.store(url, setCookiesOf(res))
    return res
  }

  // ---- step 1: ask for a QR login
  const dc = String(deps.now())
  const q = new URLSearchParams({
    _qrsize: '480',
    qs: '%3Fsid%3Dxiaomiio%26_json%3Dtrue',
    callback: 'https://sts.api.io.mi.com/sts',
    _hasLogo: 'false',
    sid: 'xiaomiio',
    serviceParam: '',
    _locale: 'en_GB',
    _dc: dc,
  })
  const r1 = await get(`${LOGIN_URL}?${q}`, 'QR login request')
  if (r1.status !== 200) throw new XiaomiFlowError(`QR login request: HTTP ${r1.status}`)
  let s1: any
  try {
    s1 = parseXiaomiJson(await r1.text())
  } catch {
    throw new XiaomiFlowError('QR login request: unreadable response')
  }
  if (!s1 || typeof s1.qr !== 'string' || typeof s1.lp !== 'string') {
    throw new XiaomiFlowError('QR login request: no QR in response')
  }
  const qrUrl: string = s1.qr
  const lpUrl: string = s1.lp
  const serverTimeoutMs = Number(s1.timeout) > 0 ? Number(s1.timeout) * 1000 : Infinity
  const deadline = deps.now() + Math.min(qrTimeoutMs, serverTimeoutMs)

  // ---- step 2: fetch + show the QR image
  const r2 = await get(qrUrl, 'QR image')
  if (r2.status !== 200) throw new XiaomiFlowError(`QR image: HTTP ${r2.status}`)
  const png = new Uint8Array(await r2.arrayBuffer())
  const dir = deps.makeTempDir()
  try {
    const pngPath = `${dir}/xiaomi-qr.png`
    writeFileSync(pngPath, png, { mode: 0o600 })
    deps.say('Scan this QR code with the Xiaomi Home app (Profile, scan icon), then confirm the login on the phone.')
    deps.say('Opening it in Preview...')
    try {
      deps.openImage(pngPath)
    } catch {
      // Fallback only: a short-lived login ticket, never the session.
      deps.say(`Could not open Preview; open this QR image URL instead: ${qrUrl}`)
    }
    deps.say(`Waiting up to ${Math.round((deadline - deps.now()) / 1000)} s for the scan...`)

    // ---- step 3: long-poll until scanned + confirmed
    let lpRes: Response | null = null
    while (deps.now() < deadline) {
      try {
        const res = await get(lpUrl, 'QR wait', {}, AbortSignal.timeout(pollRequestMs))
        if (res.status === 200) {
          lpRes = res
          break
        }
        await res.body?.cancel().catch(() => {})
        await deps.sleep(1000)
      } catch (err) {
        if (isAbort(err)) continue // nobody scanned yet: poll again
        throw err
      }
    }
    if (!lpRes) throw new XiaomiFlowError('QR wait: timed out, nobody confirmed the login (run it again)')

    let s3: any
    try {
      s3 = parseXiaomiJson(await lpRes.text())
    } catch {
      throw new XiaomiFlowError('QR wait: unreadable response')
    }
    if (!s3 || typeof s3.ssecurity !== 'string' || typeof s3.location !== 'string' || s3.userId == null) {
      const code = s3 && typeof s3.code === 'number' ? ` (code ${s3.code})` : ''
      throw new XiaomiFlowError(`QR wait: login not confirmed${code}`)
    }
    const ssecurity: string = s3.ssecurity
    const userId = String(s3.userId)
    let location: string = s3.location
    // s3.passToken / s3.cUserId are part of the session too; we never need them.

    // ---- step 4: follow the location to obtain serviceToken
    let serviceToken: string | undefined
    for (let hop = 0; hop < 10; hop++) {
      const res = await get(location, 'service token', { 'content-type': 'application/x-www-form-urlencoded' })
      for (const sc of setCookiesOf(res)) {
        const m = /^\s*serviceToken=([^;]*)/.exec(sc)
        if (m && m[1] && m[1] !== 'EXPIRED') serviceToken = m[1]
      }
      const next = res.headers.get('location')
      if (res.status >= 300 && res.status < 400 && next) {
        await res.body?.cancel().catch(() => {})
        location = new URL(next, location).toString()
        continue
      }
      await res.body?.cancel().catch(() => {})
      if (res.status !== 200) throw new XiaomiFlowError(`service token: HTTP ${res.status}`)
      break
    }
    serviceToken ??= jar.get('serviceToken')
    if (!serviceToken) throw new XiaomiFlowError('service token: none issued')
    deps.say('Logged in.')

    // ---- signed, RC4-encrypted API calls
    const agent = randomAgent(deps.randomBytes)
    const call = async (path: string, data: string): Promise<any> => {
      const url = apiUrl(opts.server) + path
      const nonce = generateNonce(deps.now(), deps.randomBytes(8))
      const sn = signedNonce(ssecurity, nonce)
      const fields = encParams(url, 'POST', sn, nonce, { data }, ssecurity)
      const cookie = jar.header(url, {
        userId,
        yetAnotherServiceToken: serviceToken!,
        serviceToken: serviceToken!,
        locale: 'en_GB',
        timezone: 'GMT+02:00',
        is_daylight: '1',
        dst_offset: '3600000',
        channel: 'MI_APP_STORE',
      })
      let res: Response
      try {
        res = await deps.fetch(`${url}?${new URLSearchParams(fields)}`, {
          method: 'POST',
          headers: {
            'Accept-Encoding': 'identity',
            'User-Agent': agent,
            'Content-Type': 'application/x-www-form-urlencoded',
            'x-xiaomi-protocal-flag-cli': 'PROTOCAL-HTTP2',
            'MIOT-ENCRYPT-ALGORITHM': 'ENCRYPT-RC4',
            Cookie: cookie,
          },
          redirect: 'manual',
        })
      } catch {
        throw new XiaomiFlowError(`${path}: network error`)
      }
      if (res.status !== 200) throw new XiaomiFlowError(`${path}: HTTP ${res.status}`)
      let out: any
      try {
        out = parseXiaomiJson(decryptRc4(signedNonce(ssecurity, nonce), (await res.text()).trim()))
      } catch {
        throw new XiaomiFlowError(`${path}: could not decrypt the response`)
      }
      if (!out || (typeof out.code === 'number' && out.code !== 0)) {
        throw new XiaomiFlowError(`${path}: API error code ${out?.code ?? '?'}`)
      }
      return out
    }

    // homes (own + shared), then devices per home: as the reference main(),
    // which skips a failed call (None) instead of aborting the whole run.
    const failed: string[] = []
    const soft = async (path: string, data: string): Promise<any> => {
      try {
        return await call(path, data)
      } catch (err) {
        if (!(err instanceof XiaomiFlowError)) throw err
        failed.push(err.message) // step + status / code only, never a body
        return null
      }
    }
    const homes: { id: string; owner: string }[] = []
    const h = await soft('/v2/homeroom/gethome', '{"fg": true, "fetch_share": true, "fetch_share_dev": true, "limit": 300, "app_ver": 7}')
    for (const home of h?.result?.homelist ?? []) {
      if (home?.id != null) homes.push({ id: String(home.id), owner: userId })
    }
    const cnt = await soft('/v2/user/get_device_cnt', '{ "fetch_own": true, "fetch_share": true}')
    for (const fam of cnt?.result?.share?.share_family ?? []) {
      if (fam?.home_id != null) homes.push({ id: String(fam.home_id), owner: String(fam.home_owner) })
    }
    const devices: CloudDevice[] = []
    const seen = new Set<string>()
    for (const home of homes) {
      const d = await soft(
        '/v2/home/home_device_list',
        '{"home_owner": ' + home.owner + ',"home_id": ' + home.id + ',  "limit": 200,  "get_split_device": true, "support_smart_home": true}',
      )
      for (const dev of d?.result?.device_info ?? []) {
        if (!dev || dev.did == null) continue
        const did = String(dev.did)
        if (seen.has(did)) continue
        seen.add(did)
        devices.push({ did, name: String(dev.name ?? ''), mac: String(dev.mac ?? ''), model: String(dev.model ?? '') })
      }
    }
    if (devices.length === 0 && failed.length > 0) {
      throw new XiaomiFlowError(`no devices found; failed steps: ${failed.join('; ')}`)
    }
    if (failed.length > 0) deps.say(`Skipped ${failed.length} failed lookup(s): ${failed.join('; ')}`)
    deps.say(`Found ${devices.length} device(s) in ${homes.length} home(s) on server "${opts.server}".`)

    const picked = await pickScale(devices, { did: opts.did, choose: deps.choose })
    if (!isBleDevice(picked)) throw new XiaomiFlowError(`device ${picked.did} is not a BLE device (no bindkey)`)
    const mac = normaliseMac(picked.mac)
    if (!mac) throw new XiaomiFlowError(`device ${picked.did} has no usable MAC in the cloud record`)

    const bk = await call('/v2/device/blt_get_beaconkey', '{"did":"' + picked.did + '","pdid":1}')
    const key = bk?.result?.beaconkey
    if (typeof key !== 'string' || !key) throw new XiaomiFlowError(`device ${picked.did}: the cloud returned no bindkey`)
    if (!isValidBindkey(key)) {
      throw new XiaomiFlowError(`device ${picked.did}: bindkey is ${key.length} chars, expected 32 hex (not stored)`)
    }

    deps.keychainStore(mac, key.toLowerCase())
    writeScaleConfig(opts.configPath, {
      mac,
      did: picked.did,
      model: picked.model,
      keychain_service: SCALE_KEYCHAIN_SERVICE,
      keychain_account: mac,
    })

    deps.say(`model: ${picked.model}`)
    deps.say(`did: ${picked.did}`)
    deps.say(`mac: ${mac}`)
    deps.say(`bindkey stored in Keychain (32 hex chars) as service ${SCALE_KEYCHAIN_SERVICE}, account ${mac}`)
    deps.say(`scale block written to ${opts.configPath}`)
    return { did: picked.did, mac, model: picked.model }
  } finally {
    deps.removeDir(dir)
  }
}
