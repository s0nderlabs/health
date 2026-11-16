# Money notifications: forward bank and wallet alerts to your daemon

When a payment app posts a notification on your iPhone, an iOS Shortcuts
personal automation forwards it to the health daemon on your Mac. The daemon
drops anything that looks like a one-time code, parses the amount, currency,
merchant and balance, stores the raw text locally, and raises a `money.notif`
channel event so your Claude session can run its budget flow.

Everything stays on your machines: the phone talks to your Mac over your
tailnet, and the notification text lands in `health.db` next to the rest of
the archive. Nothing goes to a third party.

## What gets parsed

| App | Recognised formats | Fields |
|---|---|---|
| SeaBank | QRIS payment ("Pembayaran QRIS untuk X sebesar 110.000"), Bayar Instan ("... sebesar Rp 57.800 pada 15 Nov 2026 18:05 WIB berhasil"), transfers | amount (IDR), merchant, time when the text carries one |
| Plasma One | "Paid 186,400 IDR ($10.43) at Tokopedia / Balance: $9.83", "Received $120.00 From: 0x... Balance: $414.31" | amount + currency, USD equivalent, merchant or sender, balance after |
| Tangem (and other self-custody wallets) | received / sent + amount + token + address prefix | incoming zero or dust-sized transfers, and unknown tokens, are flagged as possible **address poisoning** / spam, never counted as income |
| Tokopedia, Shopee (ShopeePay, SPayLater), Gojek (GoPay, GoPay Later), Grab, BCA mobile, Jenius, RedotPay, Pintu, anything else | generic rule: first Rp / IDR / $ amount, the money event (payment, refund, top-up, transfer, decline, bill due), "at / di / ke X" merchant | best effort, flagged `generic` so the session double-checks the raw text |

Kinds: `payment` (the only one that is spending), `refund`, `topup` (your own
money moving into a wallet), `incoming`, `transfer_out`, `trade` (an
exchange order), `declined` (nothing moved, but a dead card or low balance
matters), `bill` (a paylater or statement coming due).

**Marketplaces and super-apps are allowlisted.** Tokopedia, Shopee, Gojek,
Grab and similar apps send far more marketing than money ("Cara nikmatin
weekend... OTW pakai GoCar"). From those apps a notification is kept ONLY if
it is a money event (payment / order paid, refund, top-up, transfer, decline,
paylater bill); everything else is dropped without storing anything but a
per-app count, so you can wire them with an empty content filter.

Dropped before storage (no text, no hash; only a per-app count so a
withheld message is visible): anything in OTP language (OTP, verification
code, passcode, "do not share", "jangan berikan"), and a bare code word next
to a 4 to 8 digit number. A real payment that merely mentions a code (a PLN
token number, a reference) is kept with those digits replaced by
`[redacted]`. Ignored (not stored, no event): balance warnings and promos
with no transaction in them ("Your balance is running low").

## Two ways to send

**A. Through the HealthRelay app (recommended; HealthRelay 0.16.0 and
later).** The shortcut runs the app's "Log Money Notification" action.
The app sends it through its own tailnet tunnel, so it works with iCloud
Private Relay on, the token never sits inside a shortcut, and a send that
fails (Mac asleep, no signal) waits in the app's outbox and goes out on the
next connection.

**B. Direct POST (works today, no app update).** The shortcut calls the
daemon URL itself. Two limits: it does not work while iCloud Private Relay is
on (iOS then resolves your Mac's `ts.net` name to its public address, and the
request is refused with 403), and Shortcuts cannot retry, so a notification
that arrives while your Mac is unreachable is simply not recorded (see "Gaps"
below).

## Setup, once per app (iOS 27)

Do this for each app that touches your money, e.g. SeaBank, Plasma One,
Tangem, Tokopedia, Shopee, Gojek, Pintu, BCA mobile, Jenius, RedotPay.

1. Open **Shortcuts**, tab **Automation**, tap **+** (New Automation).
2. Choose the **Notification** trigger ("When I get a notification from...").
3. Pick the app (e.g. **SeaBank**). Leave the content filter empty so every
   notification from it is forwarded; the daemon decides what to keep.
4. Choose **Run Immediately** and turn **Notify When Run** off. (Without "Run
   Immediately" iOS asks for a tap every time, which defeats the point.)
5. Tap **Next**, then **New Blank Automation**, and add the actions below.

### Actions for path A (HealthRelay app)

1. Add action **Log Money Notification** (from HealthRelay).
2. Set **App** to the trigger's *App Name* variable (or type the app name).
3. Set **Title** to the trigger's *Notification Title* variable.
4. Set **Body** to the trigger's *Notification Body* variable.
5. Done. Nothing else: the app adds the time and the token itself.

### Actions for path B (direct POST)

1. Add action **Get Contents of URL**.
2. URL: `https://<your-mac>.<your-tailnet>.ts.net:8443/money-notif`
   (the same host and port the HealthRelay app uses for the daemon).
3. Tap the arrow to expand it:
   - **Method**: `POST`
   - **Headers**: add one header. Key `Authorization`, value
     `Bearer <your token>` (the word Bearer, one space, then the token).
   - **Request Body**: `JSON`, with four fields (all Text):
     - `app`  = the trigger's *App Name* variable (or type "SeaBank")
     - `title` = *Notification Title*
     - `body`  = *Notification Body*
     - `ts`    = **Current Date** (format: ISO 8601)
4. Done.

**Where the token comes from.** It is the daemon's live-feed token, the same
one the HealthRelay app already uses. On the Mac:

```bash
jq -r .live.token ~/.config/health/config.json
```

AirDrop or paste it to the phone once, into the header value. Treat the
shortcut as holding a secret: anyone with the shortcut and tailnet access can
post notifications. If you ever share the shortcut, delete the header first.

## Test it

1. Make a small payment (or send yourself a transfer) in one of the apps.
2. Within a few seconds your Claude session receives a `money.notif` event,
   e.g. `SeaBank at 18:05: paid Rp 110.000 at APOSTLE KOFFIE & EATERY.`
3. Path B only: a 401 means a wrong token, and a 403 or a connection error
   with Private Relay on means use path A (or turn Private Relay off for your
   home Wi-Fi under Settings > Wi-Fi > (i) > Limit IP Address Tracking).

From chat, `health__money` lists what arrived and when each app last
reported, which also shows any gaps.

## Gaps

Shortcuts automations fire once and do not retry. With path B, a
notification that arrives while the Mac is asleep, off the tailnet, or
restarting the daemon is lost to this pipeline (the shortcut shows an error,
the money still moved). Path A removes that gap: the app keeps the entry
until the daemon confirms it. Either way, `health__money` shows each app's
last report, so the session can ask about a stretch that went quiet, and the
bank app remains the source of truth for reconciliation.

Repeats are harmless: the daemon dedupes on the app's client id (path A) or on
app + title + body + the minute it was posted (path B). Two identical
payments to the same merchant inside the same minute would therefore count
once on path B.
