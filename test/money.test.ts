import { describe, expect, test } from 'bun:test'
import { Store } from '../src/store.js'
import { MoneyService, isNoise, looksLikeOtp, parseIdr, parseIndoDateTime, parseMoney, parseUsd } from '../src/money.js'

function harness(now = Date.parse('2026-11-16T03:00:00Z')) {
  const store = new Store(':memory:')
  const events: Array<{ key: string; content: string; meta: Record<string, string> }> = []
  const money = new MoneyService({
    db: store.db,
    emit: (key, p) => {
      events.push({ key, ...p })
      return true
    },
    now: () => now,
  })
  return { store, money, events, count: () => (store.db.query('SELECT COUNT(*) AS n FROM money_notifs').get() as { n: number }).n }
}

// The formats below are his real lock-screen notifications (amounts/merchants as sent).
describe('parsers: real formats', () => {
  test('SeaBank QRIS', () => {
    const p = parseMoney('SeaBank', 'Pembayaran QRIS berhasil', 'Pembayaran QRIS untuk APOSTLE KOFFIE & EATERY sebesar 110.000 telah berhasil.')
    expect(p).toMatchObject({ parser: 'seabank.qris', kind: 'payment', amount: 110000, currency: 'IDR', merchant: 'APOSTLE KOFFIE & EATERY' })
  })

  test('SeaBank Bayar Instan carries its own time', () => {
    const p = parseMoney('SeaBank', 'SeaBank', 'SeaBank Bayar Instan: Pembayaran QRIS ShopeePay kamu sebesar Rp 57.800 pada 15 Nov 2026 18:05 WIB berhasil. Cek detail di aplikasi.')
    expect(p).toMatchObject({ parser: 'seabank.bayar_instan', kind: 'payment', amount: 57800, currency: 'IDR', merchant: 'ShopeePay' })
    expect(p.occurred_at).toBe('2026-11-15T11:05:00.000Z')
  })

  test('Plasma paid in IDR with USD equivalent and balance after', () => {
    const p = parseMoney('Plasma One', 'Tokopedia', 'Paid 186,400 IDR ($10.43) at Tokopedia\nBalance: $9.83')
    expect(p).toMatchObject({
      parser: 'plasma.paid', kind: 'payment', amount: 186400, currency: 'IDR',
      amount_alt: 10.43, alt_currency: 'USD', merchant: 'Tokopedia', balance_after: 9.83, balance_currency: 'USD',
    })
  })

  test('Plasma received', () => {
    const p = parseMoney('Plasma One', 'Received', 'Received $120.00 From: 0x5e0...aCd1. Balance: $414.31')
    expect(p).toMatchObject({ parser: 'plasma.received', kind: 'incoming', amount: 120, currency: 'USD', counterparty: '0x5e0...aCd1', balance_after: 414.31 })
  })

  test('generic rule for unseen formats, flagged as generic', () => {
    expect(parseMoney('GoPay', 'Pembayaran berhasil', 'Pembayaran Rp25.000 ke Kopi Kenangan berhasil.')).toMatchObject({
      parser: 'generic.gopay', kind: 'payment', amount: 25000, currency: 'IDR', merchant: 'Kopi Kenangan',
    })
    // An exchange order is a trade, and the price is never taken as a merchant.
    expect(parseMoney('Pintu', 'Order filled', 'Your buy order of 0.001 BTC for Rp 1.500.000 has been filled')).toMatchObject({
      kind: 'trade', amount: 1500000, merchant: null,
    })
  })

  test('amount and date helpers', () => {
    expect(parseIdr('57.800,00')).toBe(57800)
    expect(parseIdr('Rp 1.500.000')).toBe(1500000)
    expect(parseIdr('186,400')).toBe(186400)
    expect(parseUsd('$1,234.56')).toBe(1234.56)
    expect(parseIndoDateTime('3 Des 2026 07:30 WITA')).toBe('2026-12-02T23:30:00.000Z')
  })
})

describe('privacy gate', () => {
  test('OTP / verification codes are recognised in both languages', () => {
    expect(looksLikeOtp('Kode OTP', 'Kode OTP SeaBank kamu 482913. JANGAN berikan kode ini ke siapapun.')).toBe(true)
    expect(looksLikeOtp('GoPay', 'Kode verifikasi GoPay: 1234. Berlaku 5 menit.')).toBe(true)
    expect(looksLikeOtp('Pintu', 'Your verification code is 991234')).toBe(true)
    expect(looksLikeOtp('Pintu', 'Use 447120 as your login code')).toBe(true)
    expect(looksLikeOtp('SeaBank', 'Pembayaran QRIS untuk X sebesar 110.000 telah berhasil.')).toBe(false)
  })

  test('an OTP notification stores NOTHING and raises nothing', () => {
    const { money, events, count } = harness()
    const r = money.ingest({ app: 'SeaBank', title: 'Kode OTP', body: 'Kode OTP kamu 482913. Jangan berikan ke siapapun.' }, 'shortcut')
    expect(r).toEqual({ status: 'dropped', reason: 'otp' })
    expect(count()).toBe(0)
    expect(events).toHaveLength(0)
  })

  test('balance warnings are ignored, not stored', () => {
    const { money, count } = harness()
    expect(isNoise('Plasma', 'Your balance is running low')).toBe(true)
    expect(money.ingest({ app: 'Plasma One', title: 'Plasma', body: 'Your balance is running low' }, 'shortcut').status).toBe('ignored')
    expect(count()).toBe(0)
  })
})

describe('ingest', () => {
  const qris = { app: 'SeaBank', title: 'Pembayaran QRIS berhasil', body: 'Pembayaran QRIS untuk APOSTLE KOFFIE & EATERY sebesar 110.000 telah berhasil.' }

  test('stores raw + parsed, raises one money.notif', () => {
    const { money, events, store } = harness()
    const r = money.ingest({ ...qris, ts: '2026-11-16T03:00:10Z' }, 'shortcut')
    expect(r).toMatchObject({ status: 'stored', kind: 'payment', amount: 110000, currency: 'IDR' })
    const row = store.db.query('SELECT * FROM money_notifs').get() as Record<string, unknown>
    expect(row).toMatchObject({ app: 'SeaBank', body: qris.body, merchant: 'APOSTLE KOFFIE & EATERY', via: 'shortcut' })
    expect(events).toHaveLength(1)
    expect(events[0].meta).toMatchObject({ class: 'money.notif', kind: 'payment', amount: '110000', currency: 'IDR', merchant: 'APOSTLE KOFFIE & EATERY' })
    expect(events[0].content).toContain('paid Rp 110.000 at APOSTLE KOFFIE & EATERY')
    expect(events[0].content).toContain('/budget')
  })

  test('a repeated shortcut run in the same minute is one record', () => {
    const { money, events, count } = harness()
    money.ingest({ ...qris, ts: '2026-11-16T03:00:10Z' }, 'shortcut')
    expect(money.ingest({ ...qris, ts: '2026-11-16T03:00:40Z' }, 'shortcut').status).toBe('duplicate')
    expect(count()).toBe(1)
    expect(events).toHaveLength(1)
    // The same text a minute later is a new payment.
    expect(money.ingest({ ...qris, ts: '2026-11-16T03:01:05Z' }, 'shortcut').status).toBe('stored')
  })

  test('the app path dedupes on its client id across retries', () => {
    const { money, count } = harness()
    money.ingest({ ...qris, client_id: 'cid-1234-5678', ts: '2026-11-16T03:00:10Z' }, 'app')
    expect(money.ingest({ ...qris, client_id: 'cid-1234-5678', ts: '2026-11-16T03:09:00Z' }, 'app').status).toBe('duplicate')
    expect(count()).toBe(1)
  })

  test('generic parses say so in the event', () => {
    const { money, events } = harness()
    money.ingest({ app: 'ShopeePay', title: 'Transaksi Berhasil', body: 'Pembayaran sebesar Rp57.800 di Indomaret berhasil' }, 'shortcut')
    expect(events[0].content).toContain('generic rule')
    expect(events[0].meta.parser).toBe('generic.shopeepay')
  })

  test('recent + last-by-app', () => {
    const { money } = harness()
    money.ingest({ ...qris }, 'shortcut')
    money.ingest({ app: 'Plasma One', title: 'Tokopedia', body: 'Paid 186,400 IDR ($10.43) at Tokopedia\nBalance: $9.83' }, 'shortcut')
    const r = money.recent(7)
    expect(r.notifs).toHaveLength(2)
    expect(r.last_by_app.map((a) => a.app).sort()).toEqual(['Plasma One', 'SeaBank'])
  })
})

describe('HTTP', () => {
  const post = (money: MoneyService, body: unknown) =>
    money.handleHttp(
      new Request('http://x/money-notif', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
      new URL('http://x/money-notif'),
    )

  test('valid, invalid, and other paths', async () => {
    const { money } = harness()
    const ok = await post(money, { app: 'SeaBank', title: 't', body: 'Pembayaran QRIS untuk X sebesar 10.000 telah berhasil.' })
    expect(ok!.status).toBe(200)
    expect(((await ok!.json()) as { status: string }).status).toBe('stored')
    expect((await post(money, { title: 'no app or body' }))!.status).toBe(400)
    expect((await post(money, [1, 2]))!.status).toBe(400)
    expect(await money.handleHttp(new Request('http://x/other'), new URL('http://x/other'))).toBeNull()
    const get = await money.handleHttp(new Request('http://x/money-notif'), new URL('http://x/money-notif'))
    expect(get!.status).toBe(405)
  })
})

describe('review regressions (v0.15.0)', () => {
  test('a sentence-final period never eats the amount', () => {
    expect(parseMoney('Plasma One', 'Received', 'Received $120.00. Balance: $414.31')).toMatchObject({ amount: 120, balance_after: 414.31 })
    expect(parseMoney('GoPay', 'GoPay', 'Kamu membayar $5.00.')).toMatchObject({ amount: 5, currency: 'USD' })
    expect(parseMoney('SeaBank', 't', 'Pembayaran QRIS untuk X sebesar 110.000.')).toMatchObject({ amount: 110000 })
  })

  test('a same-line Balance is not part of the merchant', () => {
    expect(parseMoney('Plasma One', 'Tokopedia', 'Paid $10.43 at Tokopedia. Balance: $9.83')).toMatchObject({ merchant: 'Tokopedia', balance_after: 9.83 })
    expect(parseMoney('Plasma One', 'Tokopedia', 'Paid 186,400 IDR ($10.43) at Tokopedia Balance: $9.83').merchant).toBe('Tokopedia')
  })

  test('incoming transfer: counterparty stops at "pada", the date is parsed', () => {
    expect(parseMoney('SeaBank', 'Saldo masuk', 'Saldo masuk Rp 250.000 dari JOHN pada 15 Nov 2026 18:05 WIB.')).toMatchObject({
      kind: 'incoming', amount: 250000, counterparty: 'JOHN', occurred_at: '2026-11-15T11:05:00.000Z',
    })
    expect(parseMoney('SeaBank', 'Saldo masuk', 'Saldo masuk Rp 1.000.000 dari PT. ABC JAYA. Cek aplikasi.').counterparty).toBe('PT. ABC JAYA')
  })

  test('real payments mentioning a code are kept with the code redacted; bare codes still drop', () => {
    const { money, store, events } = harness()
    const pln = money.ingest({ app: 'SeaBank', title: 'Pembelian berhasil', body: 'Pembelian Token Listrik PLN Rp 50.000 berhasil. Token: 1234 5678 9012 3456 7890' }, 'shortcut')
    expect(pln).toMatchObject({ status: 'stored', amount: 50000 })
    const row = store.db.query('SELECT body FROM money_notifs').get() as { body: string }
    expect(row.body).toContain('Token: [redacted]')
    expect(row.body).not.toContain('1234')
    expect(events[0].content).not.toContain('1234')
    expect(money.ingest({ app: 'SeaBank', title: 'Transfer', body: 'Pembayaran Rp 75.000 pada 15 Nov 2026 berhasil. Kode ref 88812345' }, 'shortcut').status).toBe('stored')
    expect(money.ingest({ app: 'X', title: 'Pembayaran', body: 'Pembayaran one-time kamu Rp 50.000 berhasil' }, 'shortcut').status).toBe('stored')
    // Bare codes and strong OTP language still never land.
    expect(money.ingest({ app: 'GoPay', title: 'GoPay', body: 'Kode kamu 4821. Berlaku 5 menit.' }, 'shortcut').status).toBe('dropped')
    expect(money.ingest({ app: 'SeaBank', title: 'OTP', body: 'OTP Rp 50.000 transfer: 482913. Jangan berikan ke siapapun.' }, 'shortcut').status).toBe('dropped')
    // Drops are visible as a count, with no text.
    const r = money.recent(7)
    expect(r.withheld_codes.map((d) => `${d.app}:${d.n}`).sort()).toEqual(['GoPay:1', 'SeaBank:1'])
  })

  test('a promo word does not hide a real payment across the title/body break', () => {
    expect(isNoise('Pembayaran berhasil', 'Pakai promo! Rp 25.000 dibayar di X')).toBe(false)
    expect(isNoise('Promo', 'Diskon 50% untuk kamu! Pakai voucher sekarang')).toBe(true)
  })

  test('recent() survives a non-numeric days value', () => {
    const { money } = harness()
    expect(() => money.recent('week')).not.toThrow()
    expect(money.recent(undefined).notifs).toEqual([])
  })

  test('ts window is judged against the injected clock, not the wall clock', () => {
    const { money, store } = harness(Date.parse('2030-01-01T00:00:00Z'))
    money.ingest({ app: 'SeaBank', title: 't', body: 'Pembayaran QRIS untuk X sebesar 10.000 telah berhasil.', ts: '2030-01-01T00:00:30Z' }, 'shortcut')
    const row = store.db.query('SELECT posted_at FROM money_notifs').get() as { posted_at: string }
    expect(row.posted_at).toBe('2030-01-01T00:00:30.000Z')
  })
})

describe('v0.17.0: every money app', () => {
  const { appClass, moneyEvent, crypto, parseCryptoAmount } = require('../src/money.js') as typeof import('../src/money.js')

  test('app classes', () => {
    expect(['Tokopedia', 'Shopee', 'Gojek', 'GoPay', 'Grab'].map(appClass)).toEqual(Array(5).fill('marketplace'))
    expect(appClass('Tangem')).toBe('crypto')
    expect(['SeaBank', 'BCA mobile', 'Jenius', 'Plasma One', 'RedotPay', 'Pintu'].map(appClass)).toEqual(Array(6).fill('bank'))
  })

  test('marketplace marketing is dropped, counted, never stored', () => {
    const { money, events, count } = harness()
    const promos = [
      { app: 'Gojek', title: 'Cara nikmatin weekend', body: 'Cara nikmatin weekend tanpa macet? OTW pakai GoCar, diskon 30% buat kamu!' },
      { app: 'Shopee', title: 'Flash Sale 11.11', body: 'Kejar Flash Sale jam 12! Gratis ongkir + cashback hingga 50%' },
      { app: 'Tokopedia', title: 'Barang di keranjangmu', body: 'Barang di keranjangmu hampir habis, checkout sekarang yuk' },
      { app: 'Shopee', title: 'SPayLater', body: 'Aktifkan SPayLater dan nikmati cicilan 0%! Top up sekarang, cashback 50%' },
    ]
    for (const p of promos) expect(money.ingest(p, 'app').status).toBe('ignored')
    expect(count()).toBe(0)
    expect(events).toHaveLength(0)
    expect(money.recent(7).ignored_noise.map((n) => `${n.app}:${n.n}`).sort()).toEqual(['Gojek:1', 'Shopee:2', 'Tokopedia:1'])
  })

  test('marketplace money events survive, with the right kind', () => {
    const { money } = harness()
    const keep: Array<[Record<string, string>, string]> = [
      [{ app: 'GoPay', title: 'Pembayaran berhasil', body: 'Pembayaran Rp25.000 ke Kopi Kenangan berhasil.' }, 'payment'],
      [{ app: 'Tokopedia', title: 'Pembayaran berhasil', body: 'Pembayaran untuk pesanan INV/20261116/MPL/123 sebesar Rp 1.250.000 berhasil diverifikasi.' }, 'payment'],
      [{ app: 'Shopee', title: 'Pengembalian Dana', body: 'Pengembalian dana Rp89.000 untuk pesanan 2611ABC sudah masuk ke ShopeePay.' }, 'refund'],
      [{ app: 'Gojek', title: 'Top up berhasil', body: 'Top up GoPay Rp200.000 berhasil.' }, 'topup'],
      [{ app: 'Shopee', title: 'Tagihan SPayLater', body: 'Tagihan SPayLater kamu Rp 1.250.000 jatuh tempo 25 Nov 2026.' }, 'bill'],
      [{ app: 'Tokopedia', title: 'Pembayaran tagihan', body: 'Pembayaran tagihan PLN Rp 150.000 berhasil.' }, 'payment'],
      [{ app: 'GoPay', title: 'Transfer', body: 'Kamu menerima uang Rp50.000 dari BUDI.' }, 'incoming'],
    ]
    for (const [n, kind] of keep) {
      const r = money.ingest(n, 'app')
      expect(r.status).toBe('stored')
      expect((r as { kind: string }).kind).toBe(kind)
    }
  })

  test('decline alerts (dead card) are kept as declined', () => {
    const { money, events } = harness()
    const r = money.ingest({ app: 'RedotPay', title: 'Transaction declined', body: 'Your card transaction of $12.50 at NETFLIX.COM was declined: insufficient balance.' }, 'app')
    expect(r).toMatchObject({ status: 'stored', kind: 'declined', amount: 12.5, currency: 'USD' })
    expect(events[0].content).toContain('DECLINED')
    expect(moneyEvent('Pembayaran gagal, saldo tidak cukup')).toBe('declined')
  })

  test('crypto amounts in both notations', () => {
    expect(parseCryptoAmount('0.0001')).toBe(0.0001)
    expect(parseCryptoAmount('0,25')).toBe(0.25)
    expect(parseCryptoAmount('1,250.5')).toBe(1250.5)
    expect(parseCryptoAmount('1,000')).toBe(1000)
    expect(parseCryptoAmount('+5')).toBe(5)
  })

  test('Tangem: real income, sends, and address poisoning', () => {
    expect(crypto('Tangem', 'Incoming transaction', 'You received 120 USDT from 0x5e0...aCd1')).toMatchObject({
      kind: 'incoming', amount: 120, currency: 'USDT', counterparty: '0x5e0...aCd1', flag: null,
    })
    expect(crypto('Tangem', 'Outgoing transaction', 'Sent 0.5 SOL to 7xKX...gAsU')).toMatchObject({ kind: 'transfer_out', amount: 0.5, currency: 'SOL', counterparty: '7xKX...gAsU' })
    expect(crypto('Tangem', 'Incoming transaction', 'You received 0 USDT from 0x5e0...aCd2')!.flag).toBe('address_poisoning')
    expect(crypto('Tangem', 'Incoming transaction', 'You received 0.01 USDC from 0x5e0...aCd2')!.flag).toBe('address_poisoning')
    expect(crypto('Tangem', 'Incoming', '+0.00001 ETH received from 0xA1b2...c3D4')!.flag).toBe('address_poisoning')
    expect(crypto('Tangem', 'Incoming', 'You received 5000 ELONAI from 0xdead...beef')!.flag).toBe('unknown_token')
    expect(crypto('Tangem', 'Incoming', 'You received 0.2 ETH from 0xA1b2...c3D4')!.flag).toBe(null)
  })

  test('poisoning is stored + flagged, and the event says not income', () => {
    const { money, events, store } = harness()
    const r = money.ingest({ app: 'Tangem', title: 'Incoming transaction', body: 'You received 0 USDT from 0x5e0...aCd2' }, 'app')
    expect(r).toMatchObject({ status: 'stored', kind: 'incoming' })
    expect((store.db.query('SELECT flag FROM money_notifs').get() as { flag: string }).flag).toBe('address_poisoning')
    expect(events[0].meta.flag).toBe('address_poisoning')
    expect(events[0].content).toContain('ADDRESS POISONING')
    expect(events[0].content).toContain('Not income')
  })

  test('a crypto "token" amount is not mistaken for an OTP code', () => {
    const { money } = harness()
    expect(money.ingest({ app: 'Tangem', title: 'Incoming', body: 'You received 5000 TOKEN from 0xdead...beef' }, 'app').status).toBe('stored')
    // ...while real OTP language still drops in a wallet too.
    expect(money.ingest({ app: 'Tangem', title: 'Verification', body: 'Your verification code is 123456' }, 'app').status).toBe('dropped')
  })

  test('the flag column migrates onto an archive that predates it', () => {
    const { Database } = require('bun:sqlite')
    const db = new Database(':memory:')
    db.run(`CREATE TABLE money_notifs (id INTEGER PRIMARY KEY AUTOINCREMENT, dedupe TEXT NOT NULL UNIQUE, app TEXT NOT NULL,
      title TEXT, body TEXT NOT NULL, posted_at TEXT NOT NULL, received_at TEXT NOT NULL, via TEXT NOT NULL, kind TEXT NOT NULL,
      amount REAL, currency TEXT, amount_alt REAL, alt_currency TEXT, merchant TEXT, counterparty TEXT, balance_after REAL,
      balance_currency TEXT, occurred_at TEXT, parser TEXT NOT NULL)`)
    const { MoneyBook } = require('../src/money.js')
    MoneyBook.ensureSchema(db)
    MoneyBook.ensureSchema(db) // idempotent
    const cols = (db.query('PRAGMA table_info(money_notifs)').all() as Array<{ name: string }>).map((c) => c.name)
    expect(cols).toContain('flag')
  })
})

describe('review regressions (v0.17.0)', () => {
  const { crypto, moneyEvent, parseCryptoAmount, hasAmount } = require('../src/money.js') as typeof import('../src/money.js')

  test('"Transfer masuk" is incoming, not outgoing', () => {
    expect(parseMoney('myBCA', 'Transfer Masuk', 'Transfer masuk Rp 500.000 dari BUDI').kind).toBe('incoming')
    expect(parseMoney('Jago', 'Dana masuk', 'Dana masuk ke Kantong Utama Rp 1.000.000').kind).toBe('incoming')
  })

  test('upper-case currency prefixes count as amounts; RB/JT shorthand is not a ticker', () => {
    expect(hasAmount('Pembayaran IDR 50.000 berhasil')).toBe(true)
    expect(isNoise('Shopee', 'Pembayaran IDR 50.000 berhasil, cashback 5%', 'marketplace')).toBe(false)
    expect(hasAmount('Top up min 50RB')).toBe(false)
  })

  test('a promo that names an amount is still a promo unless something happened', () => {
    expect(isNoise('GoPay', 'Top up saldo GoPay sekarang dan dapatkan cashback Rp5.000!', 'marketplace')).toBe(true)
    expect(isNoise('GoPay', 'Top up min 50RB, cashback 10RB', 'marketplace')).toBe(true)
    expect(isNoise('GoPay', 'Top up GoPay Rp200.000 berhasil. Ada promo cashback buat kamu!', 'marketplace')).toBe(false)
  })

  test('"Transaksi ... berhasil" with words in between is a payment', () => {
    expect(isNoise('GoPay', 'Transaksi GoPay kamu di Kopi Kenangan sebesar Rp25.000 berhasil', 'marketplace')).toBe(false)
    expect(moneyEvent('Transaksi GoPay kamu di Kopi Kenangan sebesar Rp25.000 berhasil')).toBe('payment')
  })

  test('a failure DISCLAIMER does not make a payment declined; change is not a refund', () => {
    expect(moneyEvent('Pembayaran Rp25.000 berhasil. Jika transaksi gagal, dana dikembalikan otomatis.')).toBe('payment')
    expect(moneyEvent('Pembayaran Rp30.000 berhasil. Uang kembali Rp 5.000')).toBe('payment')
    expect(moneyEvent('Pembayaran Rp30.000 gagal')).toBe('declined')
  })

  test('crypto: addresses and timestamps are not amounts', () => {
    expect(crypto('Tangem', 'Incoming', 'Incoming from 0x9F3E...1a2b: +100 USDT')).toMatchObject({ amount: 100, currency: 'USDT', flag: null, kind: 'incoming' })
    expect(crypto('Tangem', 'Incoming', '16 Nov 2026 18:05 WIB received 100 USDT')).toMatchObject({ amount: 100, currency: 'USDT', flag: null })
  })

  test('crypto: first direction word wins; signs and both separator styles', () => {
    expect(crypto('Tangem', 'Sent', 'Sent 1 ETH. It will be received shortly')!.kind).toBe('transfer_out')
    expect(crypto('Tangem', 'Outgoing', '-0.5 SOL to 7xKX...gAsU')).toMatchObject({ kind: 'transfer_out', amount: 0.5 })
    expect(parseCryptoAmount('1.250,5')).toBe(1250.5)
    expect(parseCryptoAmount('1,250.5')).toBe(1250.5)
  })
})

// Transcribed from his iPhone Notification Center, Nov 16 2026 (Plasma One stack).
describe('real Plasma One samples', () => {
  test('card payments, comma thousands, 7 digits', () => {
    expect(parseMoney('Plasma One', 'Tokopedia', 'Paid 7,176,600 IDR ($401.97) at Tokopedia\nBalance: $12.34')).toMatchObject({
      parser: 'plasma.paid', kind: 'payment', amount: 7176600, currency: 'IDR', amount_alt: 401.97, merchant: 'Tokopedia', balance_after: 12.34,
    })
    expect(parseMoney('Plasma One', 'Gojek', 'Paid 20,000 IDR ($1.11) at Gojek\nBalance: $11.23')).toMatchObject({
      amount: 20000, amount_alt: 1.11, merchant: 'Gojek', balance_after: 11.23,
    })
  })

  test('the low-balance warning is never a second payment', () => {
    const { money, events, count } = harness()
    const r = money.ingest({ app: 'Plasma One', title: '⚠️ Your balance is running low', body: 'You have $9.83 available. Add funds if you plan to keep spending.' }, 'app')
    expect(r.status).toBe('ignored')
    expect(count()).toBe(0)
    expect(events).toHaveLength(0)
  })

  test('a deposit with the title hidden: the balance is NOT the amount', () => {
    for (const title of [null, 'Received', 'Deposit']) {
      expect(parseMoney('Plasma One', title, 'From: 0x5e0...aCd1. Balance: $414.31.')).toMatchObject({
        parser: 'plasma.deposit', kind: 'incoming', amount: null, currency: null, counterparty: '0x5e0...aCd1', balance_after: 414.31,
      })
    }
    expect(parseMoney('Plasma One', 'Received $120.00', 'From: 0x5e0...aCd1. Balance: $414.31.').amount).toBe(120)
  })

  test('any app: a "Balance:" / "Saldo:" figure is never taken as the amount', () => {
    expect(parseMoney('Jago', 'Info', 'Pembayaran berhasil. Saldo: Rp 1.250.000').amount).toBeNull()
    expect(parseMoney('Jago', 'Info', 'Pembayaran Rp 50.000 berhasil. Saldo: Rp 1.250.000').amount).toBe(50000)
  })
})

describe('review regressions (v0.17.2)', () => {
  test('insufficient-funds lines stay declined, with the payment amount, not the balance', () => {
    expect(parseMoney('GoPay', null, 'Insufficient balance $3.20 for your $15.99 Netflix payment')).toMatchObject({ kind: 'declined', amount: 15.99 })
    expect(parseMoney('Jago', null, 'Saldo Rp 3.000 tidak cukup untuk pembayaran Rp 15.000')).toMatchObject({ amount: 15000 })
  })

  test('a bare "saldo Rp X" that is being MOVED keeps its amount and kind', () => {
    expect(parseMoney('DANA', null, 'Kamu menerima saldo Rp50.000 dari Budi')).toMatchObject({ kind: 'incoming', amount: 50000 })
    expect(parseMoney('GoPay', 'Top up berhasil', 'Isi saldo Rp 100.000 berhasil')).toMatchObject({ kind: 'topup', amount: 100000 })
    expect(parseMoney('GoPay', 'Top up', 'Top up saldo Rp 50.000 berhasil. Saldo: Rp 150.000')).toMatchObject({ kind: 'topup', amount: 50000 })
  })

  test('Plasma "From: X. Balance:" reads a token amount and the title direction', () => {
    expect(parseMoney('Plasma One', 'Received 25 USDT', 'From: 0xabc...def. Balance: $414.31.')).toMatchObject({ kind: 'incoming', amount: 25, currency: 'USDT' })
    expect(parseMoney('Plasma One', 'Sent $50.00', 'From: Card. Balance: $10.00.')).toMatchObject({ kind: 'transfer_out', amount: 50 })
    expect(parseMoney('Plasma One', null, 'From: 0x5e0...aCd1. Balance: $414.31.')).toMatchObject({ amount: null, currency: null, balance_after: 414.31 })
  })
})

describe('amountless generic guesses (v0.17.3)', () => {
  // Real notif #3, Nov 16 2026: a Jenius promo that the lenient bank rule let through as a payment.
  const TITLE = 'Bayar Apa Lagi, ya? 🤔'
  const BODY = 'Makin rajin bayar pakai Jenius, makin besar kesempatan menangkan 10 iPhone Duo & 100 emas 👉'

  test('the Jenius promo is noise, never a payment', () => {
    expect(isNoise(TITLE, BODY, 'bank')).toBe(true)
    const { money, events, count } = harness()
    expect(money.ingest({ app: 'Jenius', title: TITLE, body: BODY }, 'app').status).toBe('ignored')
    expect(count()).toBe(0)
    expect(events).toHaveLength(0)
  })

  test('a generic parse with no amount is noise even without promo words; declines are kept', () => {
    const { money, count } = harness()
    expect(money.ingest({ app: 'Jago', title: 'Info', body: 'Pembayaran kamu sedang diproses' }, 'app')).toMatchObject({ status: 'ignored', reason: 'no amount' })
    expect(count()).toBe(0)
    expect(money.ingest({ app: 'Jago', title: 'Transaksi ditolak', body: 'Transaksi kartu debit kamu ditolak' }, 'app').status).toBe('stored')
    expect(money.ingest({ app: 'Jago', title: 'Pembayaran', body: 'Pembayaran Rp 25.000 berhasil' }, 'app').status).toBe('stored')
    expect(count()).toBe(2)
  })
})

describe('review regressions (v0.17.3)', () => {
  test('real money events without a readable amount are still stored', () => {
    const { money, count } = harness()
    const keep: Array<[string, string]> = [
      ['Flip', 'Transfer kamu ke BUDI sebesar 150.000 berhasil'],
      ['myBCA', 'Anda menerima transfer 50.000 dari ANDI'],
      ['Tokopedia', 'Pesanan kamu sudah dibayar'],
      ['Shopee', 'Refund kamu sudah dikembalikan ke ShopeePay'],
      ['Kredivo', 'Tagihan kamu akan jatuh tempo 3 hari lagi'],
      ['Jago', 'Hadiah referral 10.000 sudah masuk ke saldo kamu'],
    ]
    for (const [app, body] of keep) expect(money.ingest({ app, title: null, body }, 'app').status).toBe('stored')
    expect(count()).toBe(keep.length)
  })
})

describe('loan / credit marketing (v0.18.2, Jago Dana Cepat)', () => {
  test('a loan push with an amount is noise; a real bill reminder that says cicilan survives', () => {
    expect(isNoise('Rp7.000.000 lgsg cair, cicilan cuma 1 jt-an/bln! 😍', 'Cek Jago Dana Cepat-mu sekarang ✨', 'bank')).toBe(true)
    expect(isNoise('Pinjaman hingga Rp50 juta', 'Ajukan sekarang, langsung cair!', 'bank')).toBe(true)
    expect(isNoise('Tagihan', 'Tagihan cicilan Rp 1.000.000 jatuh tempo 3 hari lagi', 'bank')).toBe(false)
    expect(isNoise('Pembayaran berhasil', 'Pembayaran cicilan Rp 1.000.000 berhasil', 'bank')).toBe(false)
  })
})

describe('contest / giveaway marketing (v0.18.2, Pintu BTC Game)', () => {
  test('a contest push with a token amount is noise; a real trade or deposit is not', () => {
    expect(isNoise('Win Your Share of 500 USDT in BTC Game! 🎮', 'Join the BTC Game on Pintu and grab your share of the 500 USDT prize pool 🏆 See how 👉 T&C apply.', 'bank')).toBe(true)
    expect(isNoise('Giveaway', 'Ikuti giveaway dan menangkan hadiah 1 BTC', 'bank')).toBe(true)
    expect(isNoise('Order filled', 'Your buy order for 0.001 BTC has been filled', 'bank')).toBe(false)
    expect(isNoise('Deposit berhasil', 'Deposit Rp 500.000 berhasil masuk ke akun Pintu kamu', 'bank')).toBe(false)
  })
})

describe('review regressions + new formats (energy release)', () => {
  test('marketing rules never drop something that HAPPENED (review finding)', () => {
    for (const [t, b] of [
      ['Tagihan', 'Pembayaran cicilan Rp1.500.000 telah didebit dari rekening kamu'],
      ['Pinjaman', 'Pinjaman Rp5.000.000 sudah cair ke rekening kamu'],
      ['Cashback', 'Cashback promo Rp10.000 berhasil ditambahkan ke saldo kamu'],
      ['Hadiah', 'Hadiah Rp25.000 dari undian bulan ini berhasil dikirim ke rekeningmu'],
    ]) expect(isNoise(t, b, 'bank')).toBe(false)
    // ...while the pitches still go.
    expect(isNoise('Rp7.000.000 lgsg cair, cicilan cuma 1 jt-an/bln! 😍', 'Cek Jago Dana Cepat-mu sekarang ✨', 'bank')).toBe(true)
  })

  test('amountless ad naming a transaction word is noise; a real withdrawal is not', () => {
    expect(isNoise('GRATIS tarik tunai di 🏧 terdekat!', 'Pakai Kartu Jago, bebas tarik tunai di ATM mana aja.', 'bank')).toBe(true)
    expect(isNoise('Tarik tunai', 'Tarik tunai Rp500.000 berhasil di ATM terdekat', 'bank')).toBe(false)
  })

  test('Jago pocket move = internal, never spending', () => {
    const p = parseMoney('Jago', 'Jago', 'Jago: Rp50.000 has been moved from your Main Pocket Pocket to your Test Card Pocket.')
    expect(p).toMatchObject({ parser: 'jago.pocket_move', kind: 'internal', amount: 50000, currency: 'IDR', counterparty: 'Main Pocket -> Test Card Pocket' })
  })

  test('Jago incoming: own name = internal, anyone else = incoming', () => {
    const body = 'Jago: BUDI SANTOSO TESTER has sent Rp100.000 to you. Need help? Contact Tanya Jago at 1500 746.'
    expect(parseMoney('Jago', 'Jago', body, { ownNames: ['Budi Santoso Tester'] })).toMatchObject({
      parser: 'jago.incoming', kind: 'internal', amount: 100000, counterparty: 'BUDI SANTOSO TESTER',
    })
    expect(parseMoney('Jago', 'Jago', body, { ownNames: ['Someone Else'] })).toMatchObject({ kind: 'incoming', amount: 100000 })
  })

  test('Jago card authorization request = auth_request, survives the OTP gate', () => {
    const h = harness()
    const body = 'Jago: SHOPEE.CO.ID is requesting IDR 1,000. Please confirm or reject if you didn’t do this transaction. Need help? Contact Tanya Jago at 1500 746.'
    const r = h.money.ingest({ app: 'Jago', title: 'Jago', body }, 'shortcut')
    expect(r).toMatchObject({ status: 'stored', kind: 'auth_request', amount: 1000 })
    expect(h.events.at(-1)!.content).toContain('pending, not spending')
  })

  test('SeaBank realtime transfer = transfer_out with its own timestamp', () => {
    const p = parseMoney('SeaBank', 'Realtime Transfer', 'Realtime Transfer: Kamu baru melakukan transfer real-time senilai Rp100.000 pada 16 Nov 2026 15:16. Jika kamu tidak melakukan ini, segera hubungi 1500130.')
    expect(p).toMatchObject({ parser: 'seabank.realtime_transfer', kind: 'transfer_out', amount: 100000 })
    expect(p.occurred_at).toBe(parseIndoDateTime('16 Nov 2026 15:16'))
  })
})
