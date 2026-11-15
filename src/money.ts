// Money notifications: the phone forwards a bank / wallet notification the
// moment it lands (iOS Shortcuts "notification received" automation, through
// the HealthRelay app intent or a direct POST), the daemon parses it into
// structured fields, stores it locally, and raises money.notif so the user's
// session can run its budget alert.
//
// Finance privacy: the raw text and the parsed fields live in health.db on
// this machine only. OTP / verification-code notifications are dropped BEFORE
// anything is stored: not the text, not a hash, nothing.
//
// Idempotency: the app intent sends a client_id (its outbox retries reuse it);
// a direct Shortcuts POST has none, so the key falls back to a hash of
// app + title + body + the minute it was posted. Two genuinely identical
// payments to the same merchant inside the same minute would collapse into
// one; that is the accepted cost of a retry-safe key with no client id.

import type { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { BadRequest, cleanText, jsonBody } from './http.js'

export const MONEY_SCHEMA = `
CREATE TABLE IF NOT EXISTS money_notifs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe TEXT NOT NULL UNIQUE,
  app TEXT NOT NULL,
  title TEXT,
  body TEXT NOT NULL,
  posted_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  via TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount REAL,
  currency TEXT,
  amount_alt REAL,
  alt_currency TEXT,
  merchant TEXT,
  counterparty TEXT,
  balance_after REAL,
  balance_currency TEXT,
  occurred_at TEXT,
  parser TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_money_posted ON money_notifs (posted_at);
CREATE TABLE IF NOT EXISTS money_drops (
  app TEXT PRIMARY KEY,
  n INTEGER NOT NULL,
  last_at TEXT NOT NULL
);
`

// trade = a buy/sell on an exchange (Pintu): money changed form, it was not spent.
export type MoneyKind = 'payment' | 'incoming' | 'transfer_out' | 'trade' | 'unknown'

export interface MoneyParse {
  kind: MoneyKind
  amount: number | null
  currency: string | null
  amount_alt: number | null
  alt_currency: string | null
  merchant: string | null
  counterparty: string | null
  balance_after: number | null
  balance_currency: string | null
  occurred_at: string | null // ISO, when the text itself carries a time
  parser: string // which rule matched (debuggable, and 'generic' flags low trust)
}

// ── privacy gate ──────────────────────────────────────────────────

// STRONG: language that only verification messages use. Always dropped.
const OTP_WORDS =
  /\b(otp|one[- ]?time (?:password|code|pin)|verification|verifikasi|kode\s+(rahasia|aktivasi|masuk|keamanan|unik)|security code|passcode|login code|sign[- ]?in code|auth(entication)? code|jangan\s+(berikan|bagikan|sebarkan)|do not share|don'?t share|never share|rahasiakan)\b/i
// WEAK: a code word next to a short number. Alone it reads like an OTP; on a
// real transaction it is a PLN token, a reference, a year. So: weak + no
// transaction = drop; weak + transaction = keep, with those digits redacted.
const CODE_NEAR_DIGITS = /\b(kode|code|pin|token)\b[^\n]{0,40}\b\d{4,8}\b|\b\d{4,8}\b[^\n]{0,40}\b(kode|code|pin|token)\b/i
const CODE_DIGITS = /\b(kode|code|pin|token|ref(?:erence)?)\b(\s*[:#]?\s*)([\d][\d\s-]{3,}\d)/gi

/** A transaction signal: a currency amount AND a money verb, anywhere in the text. */
export function hasTransaction(text: string): boolean {
  const amount = /(?:rp\.?|idr|\$|usd[ct]?)\s*\d|\d[\d.,]*\s*(?:idr|rupiah|usd[ct]?)\b/i.test(text)
  const verb = /\b(paid|pay(?:ment)?|received|purchase|bought|pembayaran|bayar|dibayar|membayar|pembelian|beli|transfer|diterima|masuk|terima|berhasil|order)\b/i.test(text)
  return amount && verb
}

/**
 * The privacy gate. 'drop': store nothing (an OTP). 'redact': a real
 * transaction that mentions a code; store it with those digits masked.
 * 'clean': nothing code-like. Errs toward dropping a bare code.
 */
export function otpVerdict(...texts: Array<string | null | undefined>): 'drop' | 'redact' | 'clean' {
  const t = texts.filter(Boolean).join('\n')
  if (OTP_WORDS.test(t)) return 'drop'
  if (CODE_NEAR_DIGITS.test(t)) return hasTransaction(t) ? 'redact' : 'drop'
  return 'clean'
}

/** True for anything that looks like an OTP / verification code. */
export function looksLikeOtp(...texts: Array<string | null | undefined>): boolean {
  return otpVerdict(...texts) === 'drop'
}

/** Mask digit runs that follow a code word ("Token: 1234 5678" -> "Token: [redacted]"). */
export function redactCodes(s: string): string {
  return s.replace(CODE_DIGITS, (_m, word, sep) => `${word}${sep}[redacted]`)
}

/** Notifications that carry no transaction (balance warnings, promos). */
export function isNoise(title: string | null, body: string): boolean {
  const t = `${title ?? ''}\n${body}`
  return /running low|saldo (kamu |anda )?(menipis|rendah)|promo|cashback (hingga|up to)|diskon|voucher|undian|selamat! kamu/i.test(t) &&
    !hasTransaction(t)
}

// ── amounts ───────────────────────────────────────────────────────

/** Indonesian-or-English rupiah text -> integer rupiah. "110.000", "57.800,00", "186,400". */
export function parseIdr(raw: string): number | null {
  let s = raw.replace(/rp\.?|idr|\s/gi, '')
  // A 2-digit tail after the last separator is cents ("57.800,00", "57,800.00").
  s = s.replace(/[.,](\d{2})$/, (_m, cents) => (cents === '00' ? '' : `.${cents}`))
  const [int, frac] = s.split(/(?=\.\d{2}$)/)
  const n = Number(int.replace(/[.,]/g, '') + (frac ?? ''))
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null
}

/** "$1,234.56" -> 1234.56 */
export function parseUsd(raw: string): number | null {
  const n = Number(raw.replace(/[$\s,]/g, ''))
  return Number.isFinite(n) && n >= 0 ? n : null
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, mei: 4, may: 4, jun: 5, jul: 6, agu: 7, agt: 7, aug: 7, sep: 8, okt: 9, oct: 9, nov: 10, des: 11, dec: 11,
}

/** "15 Nov 2026 18:05 WIB" -> ISO (WIB = UTC+7, WITA +8, WIT +9). */
export function parseIndoDateTime(s: string): string | null {
  const m = /(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})[,\s]+(\d{1,2})[:.](\d{2})(?:\s*(WIB|WITA|WIT))?/i.exec(s)
  if (!m) return null
  const mon = MONTHS[m[2].toLowerCase()]
  if (mon == null) return null
  const offset = { WIB: 7, WITA: 8, WIT: 9 }[(m[6] ?? 'WIB').toUpperCase() as 'WIB' | 'WITA' | 'WIT']
  const t = Date.UTC(Number(m[3]), mon, Number(m[1]), Number(m[4]) - offset, Number(m[5]))
  return Number.isFinite(t) ? new Date(t).toISOString() : null
}

/** Cut a captured name at the next sentence (". Cek ..."), case-SENSITIVELY,
 *  so an abbreviation like "PT. ABC" survives. */
const cutSentence = (s: string) => s.split(/\.\s+(?=[A-Z][a-z])/)[0]

const tidy = (s: string | null | undefined) => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim().replace(/[.,;:]+$/, '')
  return t ? t.slice(0, 120) : null
}

// ── parsers ───────────────────────────────────────────────────────

function blank(parser: string): MoneyParse {
  return {
    kind: 'unknown', amount: null, currency: null, amount_alt: null, alt_currency: null,
    merchant: null, counterparty: null, balance_after: null, balance_currency: null, occurred_at: null, parser,
  }
}

function seabank(title: string | null, body: string): MoneyParse | null {
  // "Pembayaran QRIS untuk APOSTLE KOFFIE & EATERY sebesar 110.000 telah berhasil."
  let m = /pembayaran\s+qris\s+untuk\s+(.+?)\s+sebesar\s+(?:rp\.?\s*)?(\d(?:[\d.,]*\d)?)/i.exec(body)
  if (m) return { ...blank('seabank.qris'), kind: 'payment', amount: parseIdr(m[2]), currency: 'IDR', merchant: tidy(m[1]) }
  // "SeaBank Bayar Instan: Pembayaran QRIS ShopeePay kamu sebesar Rp 57.800 pada 15 Nov 2026 18:05 WIB berhasil."
  m = /pembayaran\s+(?:qris\s+)?(.+?)\s+(?:kamu|anda)\s+sebesar\s+(?:rp\.?\s*)?(\d(?:[\d.,]*\d)?)(?:\s+pada\s+(.+?)\s+berhasil)?/i.exec(body)
  if (m) {
    return {
      ...blank('seabank.bayar_instan'), kind: 'payment', amount: parseIdr(m[2]), currency: 'IDR',
      merchant: tidy(m[1]), occurred_at: m[3] ? parseIndoDateTime(m[3]) : null,
    }
  }
  // Outgoing / incoming transfers (format seen in the wild, not yet from his phone).
  m = /transfer\s+(?:ke|kepada)\s+(.+?)\s+sebesar\s+(?:rp\.?\s*)?(\d(?:[\d.,]*\d)?)/i.exec(body)
  if (m) return { ...blank('seabank.transfer_out'), kind: 'transfer_out', amount: parseIdr(m[2]), currency: 'IDR', counterparty: tidy(m[1]) }
  m = /(?:menerima|terima|masuk)\s+.*?(?:rp\.?\s*)?(\d[\d.,]{2,}\d)(?:\s+dari\s+([^\n]+?))?(?:\s+pada\s+([^\n]+?))?\s*(?:\n|$)/i.exec(body)
  if (m) {
    return {
      ...blank('seabank.incoming'), kind: 'incoming', amount: parseIdr(m[1]), currency: 'IDR',
      counterparty: m[2] ? tidy(cutSentence(m[2])) : null,
      occurred_at: m[3] ? parseIndoDateTime(m[3]) : null,
    }
  }
  void title
  return null
}

function plasma(title: string | null, body: string): MoneyParse | null {
  const balance = /balance:\s*\$\s*([\d,]+(?:\.\d+)?)/i.exec(body)
  const bal = balance ? { balance_after: parseUsd(balance[1]), balance_currency: 'USD' } : {}
  // "Paid 186,400 IDR ($10.43) at Tokopedia"
  let m = /paid\s+(\d(?:[\d.,]*\d)?)\s*([A-Z]{3})\s*(?:\(\s*\$\s*(\d(?:[\d.,]*\d)?)\s*\))?\s*at\s+(.+?)(?=\.\s|\.$|\s+balance\b|\n|$)/i.exec(body)
  if (m) {
    const cur = m[2].toUpperCase()
    return {
      ...blank('plasma.paid'), ...bal, kind: 'payment',
      amount: cur === 'IDR' ? parseIdr(m[1]) : parseUsd(m[1]), currency: cur,
      amount_alt: m[3] ? parseUsd(m[3]) : null, alt_currency: m[3] ? 'USD' : null,
      merchant: tidy(m[4]) ?? tidy(title),
    }
  }
  // "Paid $10.43 at Tokopedia"
  m = /paid\s+\$\s*(\d(?:[\d.,]*\d)?)\s*at\s+(.+?)(?=\.\s|\.$|\s+balance\b|\n|$)/i.exec(body)
  if (m) return { ...blank('plasma.paid_usd'), ...bal, kind: 'payment', amount: parseUsd(m[1]), currency: 'USD', merchant: tidy(m[2]) ?? tidy(title) }
  // "Received $120.00 From: 0x5e0...aCd1. Balance: $414.31"
  m = /received\s+\$\s*(\d(?:[\d.,]*\d)?)\s*(?:from:?\s*(\S+?))?\.?(?:\s|$)/i.exec(body)
  if (m) return { ...blank('plasma.received'), ...bal, kind: 'incoming', amount: parseUsd(m[1]), currency: 'USD', counterparty: tidy(m[2]) }
  return null
}

/** Best effort for apps whose formats we have not seen yet (GoPay, ShopeePay, Pintu). */
function generic(app: string, title: string | null, body: string): MoneyParse {
  const t = `${title ?? ''}\n${body}`
  const p = blank(`generic.${app.toLowerCase().replace(/[^a-z0-9]+/g, '') || 'app'}`)
  const idr = /(?:rp\.?|idr)\s*(\d(?:[\d.,]*\d)?)|(\d[\d.,]{2,}\d)\s*(?:idr|rupiah)/i.exec(t)
  const usd = /\$\s*(\d(?:[\d.,]*\d)?)|(\d(?:[\d.,]*\d)?)\s*usd[ct]?\b/i.exec(t)
  if (idr) {
    p.amount = parseIdr(idr[1] ?? idr[2])
    p.currency = 'IDR'
  } else if (usd) {
    p.amount = parseUsd(usd[1] ?? usd[2])
    p.currency = /usdt/i.test(t) ? 'USDT' : /usdc/i.test(t) ? 'USDC' : 'USD'
  }
  if (/\b(buy|sell|beli|jual)\b.*\b(order|filled|terisi|berhasil)\b|\border\b.*\b(filled|terisi)\b/i.test(t)) p.kind = 'trade'
  else if (/\b(received|diterima|masuk|terima|top ?up berhasil|deposit)\b/i.test(t)) p.kind = 'incoming'
  else if (/\b(transfer(red)?|kirim|withdraw|tarik)\b/i.test(t)) p.kind = 'transfer_out'
  else if (/\b(paid|bayar|pembayaran|payment|purchase|beli|buy|sold|jual)\b/i.test(t)) p.kind = 'payment'
  const merchant = /\b(?:di|ke|at|to|untuk|for)\s+([A-Z0-9][\w&'.\- ]{1,60}?)(?:\s+(?:sebesar|senilai|berhasil|was|has|is)\b|[.,\n]|$)/.exec(body)
  // An amount is never a merchant ("for Rp 1.500.000" is the price).
  if (merchant && !/^(rp|idr|usd[ct]?|\$|\d)/i.test(merchant[1].trim())) p.merchant = tidy(merchant[1])
  return p
}

export function parseMoney(app: string, title: string | null, body: string): MoneyParse {
  const a = app.toLowerCase()
  const specific = a.includes('seabank') || a.includes('sea bank')
    ? seabank(title, body)
    : a.includes('plasma')
      ? plasma(title, body)
      : null
  return specific ?? generic(app, title, body)
}

export function dedupeKey(app: string, title: string | null, body: string, postedAtMs: number): string {
  const minute = Math.floor(postedAtMs / 60_000)
  return createHash('sha256').update(`${app}\u0000${title ?? ''}\u0000${body}\u0000${minute}`).digest('hex')
}

// ── storage ───────────────────────────────────────────────────────

export interface MoneyRow extends MoneyParse {
  id: number
  app: string
  title: string | null
  body: string
  posted_at: string
  received_at: string
  via: string
}

export class MoneyBook {
  constructor(private db: Database) {}

  static ensureSchema(db: Database): void {
    db.run(MONEY_SCHEMA)
  }

  /** Insert unless the dedupe key exists. Returns the row and whether it was new. */
  insert(r: Omit<MoneyRow, 'id'> & { dedupe: string }): { row: MoneyRow; isNew: boolean } {
    const existing = this.db.query('SELECT * FROM money_notifs WHERE dedupe = ?').get(r.dedupe) as MoneyRow | null
    if (existing) return { row: existing, isNew: false }
    this.db.run(
      `INSERT INTO money_notifs (dedupe, app, title, body, posted_at, received_at, via, kind, amount, currency,
         amount_alt, alt_currency, merchant, counterparty, balance_after, balance_currency, occurred_at, parser)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        r.dedupe, r.app, r.title, r.body, r.posted_at, r.received_at, r.via, r.kind, r.amount, r.currency,
        r.amount_alt, r.alt_currency, r.merchant, r.counterparty, r.balance_after, r.balance_currency, r.occurred_at, r.parser,
      ],
    )
    const row = this.db.query('SELECT * FROM money_notifs WHERE dedupe = ?').get(r.dedupe) as MoneyRow
    return { row, isNew: true }
  }

  recent(sinceIso: string): MoneyRow[] {
    return this.db
      .query('SELECT * FROM money_notifs WHERE posted_at >= ? ORDER BY posted_at DESC')
      .all(sinceIso) as MoneyRow[]
  }

  /** Withheld OTPs: per-app count + last time. Never any text. */
  countDrop(app: string, at: string): void {
    this.db.run(
      `INSERT INTO money_drops (app, n, last_at) VALUES (?, 1, ?)
       ON CONFLICT(app) DO UPDATE SET n = n + 1, last_at = excluded.last_at`,
      [app, at],
    )
  }

  drops(): Array<{ app: string; n: number; last_at: string }> {
    return this.db.query('SELECT app, n, last_at FROM money_drops ORDER BY last_at DESC').all() as Array<{
      app: string
      n: number
      last_at: string
    }>
  }

  lastByApp(): Array<{ app: string; last: string; n: number }> {
    return this.db
      .query('SELECT app, MAX(posted_at) AS last, COUNT(*) AS n FROM money_notifs GROUP BY app ORDER BY last DESC')
      .all() as Array<{ app: string; last: string; n: number }>
  }
}

// ── service ───────────────────────────────────────────────────────

export interface MoneyDeps {
  db: Database
  emit: (key: string, payload: { content: string; meta: Record<string, string> }) => boolean
  now?: () => number
  log?: (msg: string) => void
}

export type IngestResult =
  | { status: 'stored' | 'duplicate'; id: number; kind: MoneyKind; amount: number | null; currency: string | null }
  | { status: 'dropped'; reason: 'otp' }
  | { status: 'ignored'; reason: 'no transaction' }

const fmtAmount = (n: number | null, cur: string | null) => {
  if (n == null) return 'an unparsed amount'
  if (cur === 'IDR') return `Rp ${Math.round(n).toLocaleString('id-ID')}`
  if (cur === 'USD') return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  return `${n.toLocaleString('en-US')} ${cur ?? ''}`.trim()
}

export class MoneyService {
  readonly book: MoneyBook
  private now: () => number
  private log: (msg: string) => void

  constructor(private deps: MoneyDeps) {
    this.book = new MoneyBook(deps.db)
    this.now = deps.now ?? Date.now
    this.log = deps.log ?? (() => {})
  }

  /**
   * One forwarded notification. Order matters: the OTP gate runs FIRST, on
   * the raw text, before anything (even a hash) is persisted or logged.
   */
  ingest(body: Record<string, unknown>, via: 'app' | 'shortcut'): IngestResult {
    const app = cleanText(body.app, 60)
    let title = cleanText(body.title, 200)
    let text = cleanText(body.body, 2000, true)
    if (!app) throw new BadRequest('app is required (the notifying app name)')
    if (!text) throw new BadRequest('body is required (the notification text)')

    const verdict = otpVerdict(title, text)
    const now = this.now()
    if (verdict === 'drop') {
      // A count, never the text: lets health__money show that something
      // arrived and was withheld, without keeping any of it.
      this.book.countDrop(app, new Date(now).toISOString())
      this.log(`money notif from ${app} dropped (verification code)`)
      return { status: 'dropped', reason: 'otp' }
    }
    if (isNoise(title, text)) return { status: 'ignored', reason: 'no transaction' }
    if (verdict === 'redact') {
      title = title && redactCodes(title)
      text = redactCodes(text)
    }

    const postedMs = parseTs(body.ts, now) ?? now
    const clientId = typeof body.client_id === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(body.client_id) ? body.client_id : null
    const dedupe = clientId ? `cid:${clientId}` : dedupeKey(app, title, text, postedMs)
    const parsed = parseMoney(app, title, text)
    const { row, isNew } = this.book.insert({
      dedupe, app, title, body: text,
      posted_at: new Date(postedMs).toISOString(),
      received_at: new Date(now).toISOString(),
      via, ...parsed,
    })
    if (isNew) this.deps.emit(`money.notif:${row.id}`, this.event(row))
    return { status: isNew ? 'stored' : 'duplicate', id: row.id, kind: row.kind, amount: row.amount, currency: row.currency }
  }

  event(r: MoneyRow): { content: string; meta: Record<string, string> } {
    const when = new Date(r.occurred_at ?? r.posted_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    const what =
      r.kind === 'payment'
        ? `paid ${fmtAmount(r.amount, r.currency)}${r.amount_alt != null ? ` (${fmtAmount(r.amount_alt, r.alt_currency)})` : ''}${r.merchant ? ` at ${r.merchant}` : ''}`
        : r.kind === 'incoming'
          ? `received ${fmtAmount(r.amount, r.currency)}${r.counterparty ? ` from ${r.counterparty}` : ''}`
          : r.kind === 'transfer_out'
            ? `sent ${fmtAmount(r.amount, r.currency)}${r.counterparty ? ` to ${r.counterparty}` : ''}`
            : r.kind === 'trade'
              ? `traded ${fmtAmount(r.amount, r.currency)} (exchange order, not spending)`
              : `a money notification${r.amount != null ? ` mentioning ${fmtAmount(r.amount, r.currency)}` : ''}`
    const balance = r.balance_after != null ? ` Balance after: ${fmtAmount(r.balance_after, r.balance_currency)}.` : ''
    const trust = r.parser.startsWith('generic') ? ' Parsed by the generic rule (format not seen before): check the raw text.' : ''
    return {
      content:
        `${r.app} at ${when}: ${what}.${balance}${trust} Raw: "${r.title ? `${r.title}: ` : ''}${r.body.replace(/\s+/g, ' ')}". ` +
        `Run the /budget alert flow for this transaction (money notif #${r.id}).`,
      meta: {
        class: 'money.notif',
        notif_id: String(r.id),
        app: r.app,
        kind: r.kind,
        ...(r.amount != null ? { amount: String(r.amount) } : {}),
        ...(r.currency ? { currency: r.currency } : {}),
        ...(r.merchant ? { merchant: r.merchant } : {}),
        ...(r.balance_after != null ? { balance_after: String(r.balance_after), balance_currency: r.balance_currency ?? '' } : {}),
        parser: r.parser,
      },
    }
  }

  recent(days: unknown) {
    const n = Number(days)
    const d = Number.isFinite(n) ? Math.min(Math.max(Math.round(n), 1), 90) : 7
    const since = new Date(this.now() - d * 86_400_000).toISOString()
    return { notifs: this.book.recent(since), last_by_app: this.book.lastByApp(), withheld_codes: this.book.drops() }
  }

  async handleHttp(req: Request, url: URL): Promise<Response | null> {
    if (url.pathname !== '/money-notif') return null
    if (req.method !== 'POST') return Response.json({ error: 'POST only' }, { status: 405 })
    try {
      const body = await jsonBody(req, 64 * 1024)
      return Response.json(this.ingest(body, body.via === 'app' ? 'app' : 'shortcut'))
    } catch (err) {
      if (err instanceof BadRequest) return Response.json({ error: err.message }, { status: 400 })
      this.log(`money notif failed: ${err}`)
      return Response.json({ error: 'internal error' }, { status: 500 })
    }
  }
}


/** Shortcuts' "Current Date" arrives as ISO, epoch seconds/ms, or a locale
 *  string. Anything more than 7 days from `now` is a broken clock: ignored. */
function parseTs(v: unknown, now: number): number | null {
  let t: number
  if (typeof v === 'number' && Number.isFinite(v)) t = v > 1e12 ? v : v * 1000
  else if (typeof v === 'string' && /^\d{9,13}$/.test(v.trim())) return parseTs(Number(v.trim()), now)
  else if (typeof v === 'string' && v.trim()) t = Date.parse(v)
  else return null
  return Number.isFinite(t) && Math.abs(t - now) < 7 * 86_400_000 ? t : null
}
