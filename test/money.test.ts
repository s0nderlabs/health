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
