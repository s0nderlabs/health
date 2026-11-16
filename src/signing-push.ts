// Delivery of the loud signing pushes (signing.ts loudSigningPush): the phone
// gets a local notification over the relayer socket, the Mac a native one via
// osascript. The ledgers live in store meta so a daemon restart neither
// re-posts on the Mac nor forgets an ack.
//
//   phone: resend on EVERY tick, and at every phone hello (a suspended
//          iPhone's socket rarely spans a 5-min tick), until the phone acks
//          the id. The phone posts with identifier = id, so a resend replaces
//          instead of stacking, and it acks every notify it receives.
//          shown=false with reason "add_failed" (transient) is NOT recorded,
//          so the next tick resends; any other shown=false (permission off)
//          ends the resends, retrying cannot grant a permission, and raises
//          one system.health notable a day through onPhoneNotShown.
//   Mac:   ONE notification per id. The id is marked posted BEFORE the
//          osascript call, so a timeout (which may well have posted) is never
//          retried into a pile of banners. A DEFINITE failure (spawn error,
//          a non-zero exit, a throw: nothing was shown) is unmarked and
//          retried on later ticks, up to MAC_MAX_ATTEMPTS per daemon run.
//          Exit 0 means "handed to Notification Center", not "shown":
//          osascript notifications are attributed to Script Editor, which
//          must be allowed once in System Settings > Notifications (run
//          osascript -e 'display notification "test" with title "health"'
//          from a terminal and allow it) or macOS drops the banner silently.
//
// Both ledgers are {id: ISO} JSON and drop entries older than 10 days (ids are
// signature- or episode-scoped and loudSigningPush stops 7 days after death),
// except an id still in the current pushes, which is never pruned.

import type { ExecFn } from './resign/exec.js'
import type { SigningPush } from './signing.js'

export const PUSH_ACKED_META = 'signing_push_acked'
export const PUSH_MAC_META = 'signing_push_mac'
export const PUSH_LEDGER_TTL_MS = 10 * 86_400_000
export const MAC_NOTIFY_TIMEOUT_MS = 10_000
/** Definite Mac post failures retried this many times per id (per run). */
export const MAC_MAX_ATTEMPTS = 3
/** The phone's reason for a transient shown=false: resend, do not record. */
export const ACK_REASON_ADD_FAILED = 'add_failed'
/** Hard cap on ledger size: an ack is attacker-free (token-gated) but a
 *  buggy client must still never grow meta without bound. */
const LEDGER_MAX = 200
const ID_MAX = 200

export type PushLedger = Record<string, string>

/** Tolerant parse of a ledger meta value: anything malformed is empty. */
export function parseLedger(raw: string | null | undefined): PushLedger {
  if (!raw) return {}
  try {
    const v = JSON.parse(raw) as unknown
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
    const out: PushLedger = {}
    for (const [k, at] of Object.entries(v as Record<string, unknown>)) {
      if (typeof at === 'string' && Number.isFinite(Date.parse(at))) out[k] = at
    }
    return out
  } catch {
    return {}
  }
}

/** Entries younger than the TTL (or still live: an id in `live` is never
 *  pruned, so a long-lived push can never come back), newest LEDGER_MAX kept. */
export function pruneLedger(
  l: PushLedger,
  now: number,
  ttlMs = PUSH_LEDGER_TTL_MS,
  live: ReadonlySet<string> = new Set(),
): PushLedger {
  const keep = Object.entries(l)
    .filter(([id, at]) => live.has(id) || now - Date.parse(at) < ttlMs)
    .sort((a, b) => Date.parse(b[1]) - Date.parse(a[1]))
    .slice(0, LEDGER_MAX)
  return Object.fromEntries(keep)
}

/** What this tick sends: phone = every push not yet acked, mac = every push
 *  never posted. Pure. */
export function planSigningDelivery(
  pushes: readonly SigningPush[],
  acked: PushLedger,
  macPosted: PushLedger,
): { phone: SigningPush[]; mac: SigningPush[] } {
  return {
    phone: pushes.filter((p) => !(p.id in acked)),
    mac: pushes.filter((p) => !(p.id in macPosted)),
  }
}

/** An AppleScript string literal: backslashes and quotes escaped, line
 *  breaks flattened (a raw newline would end the -e statement). */
export function appleScriptString(s: string): string {
  return `"${s.replace(/[\r\n]+/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** The osascript argv for one native notification. */
export function macNotifyArgv(p: Pick<SigningPush, 'title' | 'body'>): string[] {
  return [
    '/usr/bin/osascript',
    '-e',
    `display notification ${appleScriptString(p.body)} with title ${appleScriptString(p.title)} sound name "Glass"`,
  ]
}

/** The wire message for the phone legs. */
export function notifyMessage(p: SigningPush): Record<string, unknown> {
  return { type: 'notify', id: p.id, title: p.title, body: p.body, level: p.level }
}

export interface SigningPushDeps {
  getMeta: (k: string) => string | null
  setMeta: (k: string, v: string) => void
  /** Push to connected PHONE legs only; returns how many got it. */
  pushPhone: (obj: Record<string, unknown>) => number
  exec: ExecFn
  log: (msg: string) => void
  /** The phone acked shown=false for a non-transient reason (notification
   *  permission off): the phone surface is dead until he fixes it. */
  onPhoneNotShown?: (id: string, reason: string | null) => void
  now?: () => number
}

export class SigningPushDelivery {
  /** Definite Mac failures per id, this run (bounds the retries). */
  private macFailures = new Map<string, number>()

  constructor(private deps: SigningPushDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private load(key: string): PushLedger {
    return parseLedger(this.deps.getMeta(key))
  }

  private save(key: string, before: PushLedger, after: PushLedger): void {
    if (JSON.stringify(before) !== JSON.stringify(after)) this.deps.setMeta(key, JSON.stringify(after))
  }

  /** One watchdog tick. Never throws; resolves once any Mac post settled.
   *  phoneOnly (the hello resend): only the unacked phone pushes go out, the
   *  Mac keeps its tick cadence. */
  async tick(
    pushes: readonly SigningPush[],
    opts: { phoneOnly?: boolean } = {},
  ): Promise<{ phoneSent: number; macPosted: string[] }> {
    const now = this.now()
    const nowIso = new Date(now).toISOString()
    const live = new Set(pushes.map((p) => p.id))
    let acked: PushLedger = {}
    let posted: PushLedger = {}
    try {
      const rawAcked = this.load(PUSH_ACKED_META)
      acked = pruneLedger(rawAcked, now, PUSH_LEDGER_TTL_MS, live)
      this.save(PUSH_ACKED_META, rawAcked, acked)
      const rawPosted = this.load(PUSH_MAC_META)
      posted = pruneLedger(rawPosted, now, PUSH_LEDGER_TTL_MS, live)
      this.save(PUSH_MAC_META, rawPosted, posted)
    } catch (err) {
      this.deps.log(`signing push: ledger read failed: ${err}`)
      return { phoneSent: 0, macPosted: [] }
    }
    const plan = planSigningDelivery(pushes, acked, posted)

    let phoneSent = 0
    for (const p of plan.phone) {
      try {
        const n = this.deps.pushPhone(notifyMessage(p))
        phoneSent += n
        if (n > 0) this.deps.log(`signing push: ${p.id} -> ${n} phone leg(s), awaiting ack`)
      } catch (err) {
        this.deps.log(`signing push: phone push of ${p.id} failed: ${err}`)
      }
    }

    if (opts.phoneOnly || plan.mac.length === 0) return { phoneSent, macPosted: [] }
    // Mark first: once per id even if the post times out or the daemon dies mid-call.
    const next = { ...posted }
    for (const p of plan.mac) next[p.id] = nowIso
    try {
      this.deps.setMeta(PUSH_MAC_META, JSON.stringify(next))
    } catch (err) {
      // Without the mark a post would repeat every tick: skip the Mac this tick.
      this.deps.log(`signing push: mac ledger write failed, not posting: ${err}`)
      return { phoneSent, macPosted: [] }
    }
    const done: string[] = []
    for (const p of plan.mac) {
      try {
        const r = await this.deps.exec(macNotifyArgv(p), { timeoutMs: MAC_NOTIFY_TIMEOUT_MS })
        if (r.code === 0 && !r.spawnError) {
          done.push(p.id)
          this.macFailures.delete(p.id)
          this.deps.log(`signing push: ${p.id} handed to Notification Center on the Mac`)
        } else if (r.timedOut && !r.spawnError) {
          // It may well have posted: never retried.
          this.deps.log(`signing push: mac notification for ${p.id} timed out, not retried`)
        } else {
          this.macDefiniteFailure(p.id, r.spawnError ?? `exit ${r.code}: ${r.stderrTail.trim().slice(0, 200)}`)
        }
      } catch (err) {
        this.macDefiniteFailure(p.id, String(err))
      }
    }
    return { phoneSent, macPosted: done }
  }

  /** Nothing was shown: unmark the id so a later tick retries, bounded. */
  private macDefiniteFailure(id: string, why: string): void {
    const n = (this.macFailures.get(id) ?? 0) + 1
    this.macFailures.set(id, n)
    if (n >= MAC_MAX_ATTEMPTS) {
      this.deps.log(`signing push: mac notification for ${id} failed (${why}), attempt ${n}/${MAC_MAX_ATTEMPTS}, giving up`)
      return
    }
    try {
      const ledger = this.load(PUSH_MAC_META)
      if (id in ledger) {
        delete ledger[id]
        this.deps.setMeta(PUSH_MAC_META, JSON.stringify(ledger))
      }
      this.deps.log(`signing push: mac notification for ${id} failed (${why}), attempt ${n}/${MAC_MAX_ATTEMPTS}, retried next tick`)
    } catch (err) {
      this.deps.log(`signing push: mac notification for ${id} failed (${why}), unmark failed (${err}), not retried`)
    }
  }

  /** The phone's {type:'notify_ack', id, shown, reason?}: the resends for id
   *  stop, except a transient add failure, which the next tick resends. */
  onAck(id: string, shown: boolean, reason: string | null = null): void {
    if (!id || id.length > ID_MAX) return
    if (!shown && reason === ACK_REASON_ADD_FAILED) {
      this.deps.log(`signing push: ${id} not shown on the phone (add failed), resent next tick`)
      return
    }
    try {
      const now = this.now()
      const before = this.load(PUSH_ACKED_META)
      if (id in before) return
      const after = pruneLedger({ ...before, [id]: new Date(now).toISOString() }, now)
      this.deps.setMeta(PUSH_ACKED_META, JSON.stringify(after))
      this.deps.log(
        `signing push: ${id} acked by the phone${shown ? '' : ` (NOT shown: ${reason ?? 'notification permission is off'}, the Mac banner is the only one)`}`,
      )
    } catch (err) {
      this.deps.log(`signing push: ack of ${id} not recorded: ${err}`)
      return
    }
    if (!shown) {
      try {
        this.deps.onPhoneNotShown?.(id, reason)
      } catch (err) {
        this.deps.log(`signing push: not-shown hook failed: ${err}`)
      }
    }
  }
}
