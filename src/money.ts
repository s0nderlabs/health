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
CREATE TABLE IF NOT EXISTS money_noise (
  app TEXT PRIMARY KEY,
  n INTEGER NOT NULL,
  last_at TEXT NOT NULL
);
`

// trade    = a buy/sell on an exchange (Pintu): money changed form, it was not spent.
// refund   = money back from a merchant.   topup = moving money INTO a wallet.
// declined = an attempt that failed: no money moved, but it matters (dead card, low balance).
// bill     = a paylater / statement reminder: a liability coming due, not spending today.
export type MoneyKind =
  | 'payment' | 'incoming' | 'transfer_out' | 'trade' | 'refund' | 'topup' | 'declined' | 'bill' | 'unknown'

/** How strict the noise rule is for an app. Marketplaces and super-apps send
 *  far more marketing than money, so they are allowlisted: only a money event
 *  survives. Crypto wallets get the wallet parser. Everything else (banks,
 *  e-money) keeps the lenient rule. */
export type AppClass = 'marketplace' | 'crypto' | 'bank'

export function appClass(app: string): AppClass {
  const a = app.toLowerCase()
  if (/tokopedia|shopee|spaylater|gojek|gopay|grab|ovo|traveloka|lazada|blibli|tiktok|bukalapak/.test(a)) return 'marketplace'
  if (/tangem|metamask|trust ?wallet|phantom|rabby|ledger|trezor|okx wallet|bitget wallet|coinbase wallet/.test(a)) return 'crypto'
  return 'bank'
}

/** Suspicion flags on an incoming crypto transfer (never counted as income). */
export type MoneyFlag = 'address_poisoning' | 'unknown_token'

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
  flag: MoneyFlag | null
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

/** A currency amount: "Rp 50.000", "IDR 50.000", "$5", "50.000 IDR", "10 USDT".
 *  Indonesian shorthand ("50RB", "1JT", "10K") is not a ticker. */
export function hasAmount(t: string): boolean {
  if (/(?:rp\.?|idr|usd[ct]?|\$)\s*\d/i.test(t) || /\d[\d.,]*\s*(?:idr|rupiah|usd[ct]?)\b/i.test(t)) return true
  const m = /\d[\d.,]*\s*([A-Z]{2,6})\b/.exec(t)
  return !!m && !/^(RB|JT|K|M|WIB|WITA|WIT|PM|AM)$/.test(m[1])
}

/** A transaction signal: a currency amount AND a money verb, anywhere in the text. */
export function hasTransaction(text: string): boolean {
  // Currency amounts only (never a bare ticker): this feeds the OTP gate, and
  // "123456 GOPAY" must not pass for money.
  const amount = /(?:rp\.?|idr|usd[ct]?|\$)\s*\d|\d[\d.,]*\s*(?:idr|rupiah|usd[ct]?)\b/i.test(text)
  const verb = /\b(paid|pay(?:ment)?|received|purchase|bought|pembayaran|bayar|dibayar|membayar|pembelian|beli|transfer|diterima|masuk|terima|berhasil|order)\b/i.test(text)
  return amount && verb
}

/**
 * The privacy gate. 'drop': store nothing (an OTP). 'redact': a real
 * transaction that mentions a code; store it with those digits masked.
 * 'clean': nothing code-like. Errs toward dropping a bare code.
 */
export function otpVerdict(...texts: Array<string | null | undefined>): 'drop' | 'redact' | 'clean' {
  return otpVerdictFor('bank', ...texts)
}

/** Same gate, app-aware: in a crypto wallet "token" next to a number is the
 *  normal shape of a transfer ("received 5000 TOKEN"), so only the strong
 *  OTP language applies there. */
export function otpVerdictFor(cls: AppClass, ...texts: Array<string | null | undefined>): 'drop' | 'redact' | 'clean' {
  const t = texts.filter(Boolean).join('\n')
  if (OTP_WORDS.test(t)) return 'drop'
  if (cls !== 'crypto' && CODE_NEAR_DIGITS.test(t)) return hasTransaction(t) ? 'redact' : 'drop'
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

// A money EVENT: something happened to his money (or failed to). The
// marketplace allowlist keeps a notification only if one of these matches.
// ORDER MATTERS: a failure beats everything; a paid bill is a payment, so
// payment is checked before the bill REMINDER pattern.
const MONEY_EVENT: Array<[MoneyKind, RegExp]> = [
  ['declined', /\b(declined|ditolak)\b|\b(transaksi|pembayaran|payment|transaction|top[\s-]?up|transfer|purchase|pembelian)\b(?:[^\n.]|\.(?=\d)){0,40}\b(gagal|failed|tidak berhasil|unsuccessful)\b|\binsufficient (balance|funds)\b|\bsaldo (tidak|nggak|gak) cukup\b/i],
  ['refund', /\b(refund(ed)?|pengembalian dana|dana (telah |sudah )?(dikembalikan|kembali))\b/i],
  ['topup', /\btop[\s-]?up\b|\bisi saldo\b/i],
  ['payment', /\b(pembayaran|payment|pembelian|purchase|transaksi|transaction)\b[^\n]{0,80}\b(berhasil|sukses|successful|confirmed|selesai|diterima|completed)\b|\bberhasil\s+(dibayar|membayar|bayar)\b|\b(kamu|anda)\s+(telah\s+|sudah\s+)?(bayar|membayar)\b|\b(sudah|telah)\s+(dibayar|lunas)\b|\bpaid\b|\bpesanan\b[^\n]{0,60}\b(dibayar|lunas)\b|\border\b[^\n]{0,60}\bpaid\b/i],
  ['bill', /\b(jatuh tempo|due date|due on|due in|pengingat tagihan|reminder)\b|\btagihan\b[^\n]{0,60}\b(akan|sebesar|bulan ini|belum dibayar)\b|\bcicilan (ke|bulan)\b/i],
  ['incoming', /\b(received|diterima|saldo masuk|uang masuk|menerima (uang|saldo|transfer|dana))\b|\b(transfer|dana|kiriman|uang)\s+masuk\b|\bmasuk\s+(ke|dari)\b/i],
  ['transfer_out', /\b(transfer(red)?|kirim (uang|saldo)|withdraw(al)?|tarik tunai)\b/i],
]

// Conditional clauses ("Jika transaksi gagal, dana dikembalikan otomatis")
// describe what WOULD happen, not what did: removed before classifying.
const CONDITIONAL = /\b(jika|apabila|bila|kalau|if)\b[^.\n]*[.\n]?/gi

// A completed money event, as opposed to an invitation to make one.
const COMPLETED = /\b(berhasil|sukses|successful|paid|dibayar|lunas|diterima|received|masuk|refund(ed)?|dikembalikan|ditolak|declined|gagal|failed|jatuh tempo|due|completed|selesai|confirmed)\b/i

// Marketing tells. A money event that ALSO reads like marketing and carries no
// amount ("Top up sekarang, cashback 50%!") is still marketing.
const PROMO = /\b(promo|diskon|discount|voucher|cashback|gratis|free|hemat|flash sale|kejar|yuk|ayo|cek sekarang|jangan lewatkan|nikmatin|nikmati|spesial|special offer|limited|kesempatan|undian|menangkan|selamat! kamu|hingga \d+%)\b|%/i

/** Which money event a text describes, or null when it describes none. */
export function moneyEvent(text: string): MoneyKind | null {
  const t = text.replace(CONDITIONAL, ' ')
  for (const [kind, re] of MONEY_EVENT) if (re.test(t)) return kind
  return null
}

/** A generic-rule parse with no amount whose text describes no actual money
 *  event: its kind came only from a loose word like "bayar" in marketing copy.
 *  A real transfer / refund / bill with an amount the generic rule could not
 *  read is NOT this (moneyEvent names it), and neither is a decline. */
export function amountlessGuess(p: MoneyParse, text: string): boolean {
  return p.parser.startsWith('generic') && p.amount == null && p.kind !== 'declined' && moneyEvent(text) == null
}

/**
 * Notifications that carry no money event. Marketplace / super-app class:
 * ALLOWLIST (only a money event survives, and not one dressed as a promo
 * with no amount). Other apps: the lenient rule (only obvious balance
 * warnings and promos are noise).
 */
export function isNoise(title: string | null, body: string, cls: AppClass = 'bank'): boolean {
  const t = `${title ?? ''}\n${body}`
  if (cls === 'marketplace') {
    if (!moneyEvent(t)) return true
    // Marketing that names a money word and even an amount ("Top up sekarang,
    // cashback Rp5.000!") is still marketing unless something HAPPENED.
    return PROMO.test(t) && !COMPLETED.test(t.replace(CONDITIONAL, ' '))
  }
  return /running low|saldo (kamu |anda )?(menipis|rendah)|promo|cashback (hingga|up to)|diskon|voucher|undian|selamat! kamu|menangkan|kesempatan|hadiah|makin rajin/i.test(t) &&
    !hasTransaction(t) &&
    // "Hadiah referral 10.000 sudah masuk": something HAPPENED, keep it.
    !(moneyEvent(t) && COMPLETED.test(t.replace(CONDITIONAL, ' ')))
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
    flag: null,
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
  // A deposit whose amount lives in the TITLE (body: "From: 0x5e0...aCd1. Balance: $414.31.").
  // The body's dollar figure is the balance AFTER, never the amount. With no
  // amount in the title it stays unknown: honest null beats a wrong number.
  // The sender address is truncated, so it is information only (no
  // address-poisoning comparison is possible on it).
  m = /^\s*from:?\s*(\S+?)\.?\s+balance:/i.exec(body)
  if (m) {
    // Direction comes from the title when it says so ("Sent $50.00"); a
    // "From:" body with no outward word is a deposit.
    const outward = !!title && /\b(sent|paid|withdraw(n|al)?|outgoing|transfer(red)? out)\b/i.test(title)
    // The amount: "$120.00" or "25 USDT" in the title; otherwise unknown.
    const usd = title ? /\$\s*(\d(?:[\d.,]*\d)?)/.exec(title) : null
    const tok = !usd && title ? /(\d(?:[\d.,]*\d)?)\s*([A-Z]{2,6})\b/.exec(title) : null
    const amount = usd ? parseUsd(usd[1]) : tok ? parseCryptoAmount(tok[1]) : null
    return {
      ...blank('plasma.deposit'), ...bal, kind: outward ? 'transfer_out' : 'incoming',
      amount, currency: usd ? 'USD' : tok ? tok[2] : null, counterparty: tidy(m[1]),
    }
  }
  return null
}

const AMT = String.raw`(?:rp\.?|idr|usd[ct]?|\$)?\s*\d(?:[\d.,]*\d)?`
// Only a LABELLED running balance is stripped: "Saldo: Rp X", "Balance $X"
// right after a label word, "saldo akhir / sisa saldo / available balance X",
// "you have $X available", and the balance quoted inside an insufficient-
// funds line. A bare "saldo Rp X" is often the thing being MOVED ("menerima
// saldo Rp50.000", "isi saldo Rp 100.000") and must survive.
const LABELLED_BALANCE = new RegExp(
  String.raw`\b(?:balance|saldo)\s*(?:akhir|after|now|kamu|anda)?\s*[:=]\s*${AMT}` +
    String.raw`|\b(?:sisa saldo|saldo akhir|saldo tersisa|remaining balance|available balance|current balance)\s*[:=]?\s*${AMT}` +
    String.raw`|\byou have\s+${AMT}\s*(?:usd[ct]?)?\s*available\b` +
    String.raw`|\binsufficient (?:balance|funds)\s*[:(]?\s*${AMT}` +
    String.raw`|\bsaldo\s+${AMT}\s+(?:tidak|nggak|gak) cukup`,
  'gi',
)

/** A running balance is never the transaction amount: strip labelled
 *  balances before looking for an amount (kind is classified on the
 *  UNSTRIPPED text, so "insufficient" / "tidak cukup" still read as declined). */
function withoutBalances(t: string): string {
  return t.replace(LABELLED_BALANCE, ' ')
}

/** Best effort for apps whose formats we have not seen yet (GoPay, ShopeePay, Pintu). */
function generic(app: string, title: string | null, body: string): MoneyParse {
  const full = `${title ?? ''}\n${body}`
  const t = withoutBalances(full) // amounts only; kind reads `full`
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
  if (/\b(buy|sell|beli|jual)\b.*\b(order|filled|terisi|berhasil)\b|\border\b.*\b(filled|terisi)\b/i.test(full)) p.kind = 'trade'
  else p.kind = moneyEvent(full) ?? (/\b(bayar|pembayaran|payment|beli|buy)\b/i.test(full) ? 'payment' : 'unknown')
  const merchant = /\b(?:di|ke|at|to|untuk|for)\s+([A-Z0-9][\w&'.\- ]{1,60}?)(?:\s+(?:sebesar|senilai|berhasil|was|has|is)\b|[.,\n]|$)/.exec(body)
  // An amount is never a merchant ("for Rp 1.500.000" is the price).
  if (merchant && !/^(rp|idr|usd[ct]?|\$|\d)/i.test(merchant[1].trim())) p.merchant = tidy(merchant[1])
  return p
}

// ── crypto wallets (Tangem and friends) ───────────────────────────

const STABLES = new Set(['USDT', 'USDC', 'DAI', 'FDUSD', 'USDE', 'PYUSD', 'BUSD', 'TUSD', 'USDS', 'USD1', 'EURC'])
/** Native / major tokens and the transfer size below which an INCOMING
 *  transfer is dust: the shape of address poisoning (a look-alike sender
 *  plants itself in your history hoping you copy it next time). */
const DUST: Record<string, number> = {
  ETH: 0.0005, WETH: 0.0005, BTC: 0.00002, WBTC: 0.00002, SOL: 0.005, BNB: 0.001, TRX: 1, POL: 0.5, MATIC: 0.5,
  AVAX: 0.01, ARB: 0.5, OP: 0.5, XRP: 1, TON: 0.05, DOGE: 5, LTC: 0.005, ADA: 1, DOT: 0.1, LINK: 0.02, XLM: 2,
}

/** Crypto amounts: "1,250.5", "0.0001", and the Indonesian "0,5". */
export function parseCryptoAmount(raw: string): number | null {
  // The sign is direction, carried separately: the amount is a magnitude.
  let s = raw.replace(/[\s+-]/g, '')
  if (s.includes(',') && s.includes('.')) {
    // Both separators: the LAST one is the decimal ("1,250.5" / "1.250,5").
    s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '')
  } else if (s.includes(',')) {
    const tail = s.split(',').at(-1) ?? ''
    s = tail.length === 3 && !/^0,/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.')
  }
  const n = Number(s)
  return Number.isFinite(n) && n >= 0 ? n : null
}

const ADDRESS = /\b(0x[0-9a-fA-F]{2,}(?:\.{2,3}|\u2026)[0-9a-fA-F]{2,}|0x[0-9a-fA-F]{8,40}|T[1-9A-HJ-NP-Za-km-z]{25,33}|bc1[0-9a-z]{8,}|[13][a-km-zA-HJ-NP-Z1-9]{25,34}|[1-9A-HJ-NP-Za-km-z]{4,}(?:\.{2,3}|\u2026)[1-9A-HJ-NP-Za-km-z]{4,})\b/

export function crypto(app: string, title: string | null, body: string): MoneyParse | null {
  const t = `${title ?? ''}\n${body}`
  // "+0.5 ETH", "100 USDT", "0,25 SOL". The ticker is matched case-SENSITIVELY
  // (tickers are upper case; "received 5 from" must not read "from" as one).
  // Every number+ticker run that is NOT inside an address or a timestamp;
  // a known token wins, else the first plausible one.
  const NOT_TICKER = /^(WIB|WITA|WIT|UTC|GMT|AM|PM|ID|TX|TXID|RB|JT)$/
  const runs = [...t.matchAll(/(?<![0-9A-Za-z.])([+-]?\s?\d(?:[\d.,]*\d)?)\s*([A-Z][A-Z0-9]{1,9})\b/g)]
    .filter((r) => !NOT_TICKER.test(r[2]))
  const m = runs.find((r) => STABLES.has(r[2]) || r[2] in DUST) ?? runs[0]
  if (!m) return null
  const amount = parseCryptoAmount(m[1])
  const token = m[2]
  const p = blank(`crypto.${app.toLowerCase().replace(/[^a-z0-9]+/g, '') || 'wallet'}`)
  p.amount = amount
  p.currency = token
  p.counterparty = ADDRESS.exec(t)?.[1] ?? null
  // Direction: an explicit sign wins; else whichever direction word comes
  // FIRST ("Sent 1 ETH. It will be received shortly" is outgoing).
  const inAt = t.search(/\b(received|incoming|deposit(ed)?|diterima|masuk|menerima)\b/i)
  const outAt = t.search(/\b(sent|outgoing|withdraw(n|al)?|dikirim|terkirim|mengirim|kirim)\b/i)
  if (/^\s*\+/.test(m[1])) p.kind = 'incoming'
  else if (/^\s*-/.test(m[1])) p.kind = 'transfer_out'
  else if (inAt >= 0 && (outAt < 0 || inAt < outAt)) p.kind = 'incoming'
  else if (outAt >= 0) p.kind = 'transfer_out'
  else if (/\b(swap(ped)?|exchanged)\b/i.test(t)) p.kind = 'trade'
  else return null
  if (p.kind === 'incoming') {
    const known = STABLES.has(token) || token in DUST
    if (amount === 0 || (STABLES.has(token) && amount != null && amount < 1) || (token in DUST && amount != null && amount < DUST[token])) {
      p.flag = 'address_poisoning'
    } else if (!known) {
      p.flag = 'unknown_token'
    }
  }
  return p
}

export function parseMoney(app: string, title: string | null, body: string): MoneyParse {
  const a = app.toLowerCase()
  const specific = a.includes('seabank') || a.includes('sea bank')
    ? seabank(title, body)
    : a.includes('plasma')
      ? plasma(title, body)
      : appClass(app) === 'crypto'
        ? crypto(app, title, body)
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
    // v0.17.0: the suspicion flag. Additive and idempotent on old archives.
    const cols = new Set((db.query('PRAGMA table_info(money_notifs)').all() as Array<{ name: string }>).map((c) => c.name))
    if (!cols.has('flag')) db.run('ALTER TABLE money_notifs ADD COLUMN flag TEXT')
  }

  /** Insert unless the dedupe key exists. Returns the row and whether it was new. */
  insert(r: Omit<MoneyRow, 'id'> & { dedupe: string }): { row: MoneyRow; isNew: boolean } {
    const existing = this.db.query('SELECT * FROM money_notifs WHERE dedupe = ?').get(r.dedupe) as MoneyRow | null
    if (existing) return { row: existing, isNew: false }
    this.db.run(
      `INSERT INTO money_notifs (dedupe, app, title, body, posted_at, received_at, via, kind, amount, currency,
         amount_alt, alt_currency, merchant, counterparty, balance_after, balance_currency, occurred_at, parser, flag)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        r.dedupe, r.app, r.title, r.body, r.posted_at, r.received_at, r.via, r.kind, r.amount, r.currency,
        r.amount_alt, r.alt_currency, r.merchant, r.counterparty, r.balance_after, r.balance_currency, r.occurred_at, r.parser,
        r.flag,
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

  /** Marketing / non-money notifications: per-app count + last time, never text. */
  countNoise(app: string, at: string): void {
    this.db.run(
      `INSERT INTO money_noise (app, n, last_at) VALUES (?, 1, ?)
       ON CONFLICT(app) DO UPDATE SET n = n + 1, last_at = excluded.last_at`,
      [app, at],
    )
  }

  noise(): Array<{ app: string; n: number; last_at: string }> {
    return this.db.query('SELECT app, n, last_at FROM money_noise ORDER BY last_at DESC').all() as Array<{
      app: string
      n: number
      last_at: string
    }>
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
  | { status: 'ignored'; reason: 'no transaction' | 'no amount' }

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

    const cls = appClass(app)
    const verdict = otpVerdictFor(cls, title, text)
    const now = this.now()
    if (verdict === 'drop') {
      // A count, never the text: lets health__money show that something
      // arrived and was withheld, without keeping any of it.
      this.book.countDrop(app, new Date(now).toISOString())
      this.log(`money notif from ${app} dropped (verification code)`)
      return { status: 'dropped', reason: 'otp' }
    }
    if (isNoise(title, text, cls)) {
      // Like an OTP drop: a count, never the text, so a real payment the
      // allowlist misjudged is at least visible as a number.
      this.book.countNoise(app, new Date(now).toISOString())
      return { status: 'ignored', reason: 'no transaction' }
    }
    if (verdict === 'redact') {
      title = title && redactCodes(title)
      text = redactCodes(text)
    }

    const postedMs = parseTs(body.ts, now) ?? now
    const clientId = typeof body.client_id === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(body.client_id) ? body.client_id : null
    const dedupe = clientId ? `cid:${clientId}` : dedupeKey(app, title, text, postedMs)
    const parsed = parseMoney(app, title, text)
    if (amountlessGuess(parsed, `${title ?? ''}\n${text}`)) {
      // A real payment always carries an amount. A guess by the generic rule
      // with none is marketing ("makin rajin bayar pakai Jenius..."): noise,
      // counted like any other. Declines are kept: "card declined" matters
      // even without a number.
      this.book.countNoise(app, new Date(now).toISOString())
      return { status: 'ignored', reason: 'no amount' }
    }
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
              : r.kind === 'refund'
                ? `refund of ${fmtAmount(r.amount, r.currency)}${r.merchant ? ` from ${r.merchant}` : ''} (money back, not income)`
                : r.kind === 'topup'
                  ? `topped up ${fmtAmount(r.amount, r.currency)} (moving his own money into a wallet, not spending)`
                  : r.kind === 'declined'
                    ? `DECLINED ${fmtAmount(r.amount, r.currency)}${r.merchant ? ` at ${r.merchant}` : ''} (no money moved)`
                    : r.kind === 'bill'
                      ? `bill / paylater due: ${fmtAmount(r.amount, r.currency)} (a liability coming due, not spending today)`
                      : `a money notification${r.amount != null ? ` mentioning ${fmtAmount(r.amount, r.currency)}` : ''}`
    const balance = r.balance_after != null ? ` Balance after: ${fmtAmount(r.balance_after, r.balance_currency)}.` : ''
    const trust = r.parser.startsWith('generic') ? ' Parsed by the generic rule (format not seen before): check the raw text.' : ''
    const flag =
      r.flag === 'address_poisoning'
        ? ' SUSPECT: zero or dust-sized incoming transfer, the shape of ADDRESS POISONING. Not income. Never copy the sender address from history; always use the saved contact.'
        : r.flag === 'unknown_token'
          ? ' SUSPECT: incoming token not on the known list (likely a spam / scam airdrop). Not income. Do not interact with it or visit links it carries.'
          : ''
    return {
      content:
        `${r.app} at ${when}: ${what}.${balance}${flag}${trust} Raw: "${r.title ? `${r.title}: ` : ''}${r.body.replace(/\s+/g, ' ')}". ` +
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
        ...(r.flag ? { flag: r.flag } : {}),
      },
    }
  }

  recent(days: unknown) {
    const n = Number(days)
    const d = Number.isFinite(n) ? Math.min(Math.max(Math.round(n), 1), 90) : 7
    const since = new Date(this.now() - d * 86_400_000).toISOString()
    return {
      notifs: this.book.recent(since),
      last_by_app: this.book.lastByApp(),
      withheld_codes: this.book.drops(),
      ignored_noise: this.book.noise(),
    }
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
