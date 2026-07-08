// WHOOP webhook receiver (daemon-side). Listens on localhost behind a
// Tailscale Funnel; verifies HMAC before trusting a byte; payload is a
// pointer, so it fetches the real resource and upserts it, which routes the
// change through the same fact path the poller uses (idempotent by design).

import { createHmac, timingSafeEqual } from 'node:crypto'
import { readClientSecret } from './auth.js'
import * as whoop from './whoop.js'
import type { Store } from './store.js'
import type { FactHandler } from './poller.js'
import type { WhoopWebhookPayload } from './types.js'

function log(msg: string): void {
  process.stderr.write(`healthd webhook: ${msg}\n`)
}

export function verifySignature(
  clientSecret: string,
  sigHeader: string | null,
  tsHeader: string | null,
  rawBody: string,
): boolean {
  if (!sigHeader || !tsHeader) return false
  const expected = createHmac('sha256', clientSecret).update(tsHeader + rawBody).digest()
  let given: Buffer
  try {
    given = Buffer.from(sigHeader, 'base64')
  } catch {
    return false
  }
  return expected.length === given.length && timingSafeEqual(expected, given)
}

export async function handleWebhookEvent(
  store: Store,
  payload: WhoopWebhookPayload,
  onFact: FactHandler,
): Promise<void> {
  const id = String(payload.id)

  switch (payload.type) {
    case 'workout.updated': {
      const w = await whoop.getWorkout(id)
      const r = store.upsertWorkout(w)
      if (r.changed) onFact({ kind: 'workout', isNew: r.isNew, record: w })
      break
    }
    case 'sleep.updated': {
      const s = await whoop.getSleep(id)
      const r = store.upsertSleep(s)
      if (r.changed) onFact({ kind: 'sleep', isNew: r.isNew, record: s })
      break
    }
    case 'recovery.updated': {
      // Recovery events carry the SLEEP uuid. Fetch the sleep too so the
      // brief can fold it in even if the poller has not seen it yet.
      try {
        const s = await whoop.getSleep(id)
        const rs = store.upsertSleep(s)
        if (rs.changed) onFact({ kind: 'sleep', isNew: rs.isNew, record: s })
      } catch (err) {
        if (!(err instanceof whoop.NotFoundError)) throw err
      }
      // No direct recovery-by-sleep-id endpoint: sweep the recent collection.
      for await (const rec of whoop.paginate(whoop.getRecoveries, {
        start: new Date(Date.now() - 7 * 86_400_000).toISOString(),
        limit: 25,
      })) {
        if (rec.sleep_id === id) {
          const rr = store.upsertRecovery(rec)
          if (rr.changed) onFact({ kind: 'recovery', isNew: rr.isNew, record: rec })
          break
        }
      }
      break
    }
    case 'workout.deleted':
      if (store.deleteRecord('workout', id)) log(`workout ${id} deleted`)
      break
    case 'sleep.deleted':
      if (store.deleteRecord('sleep', id)) log(`sleep ${id} deleted`)
      break
    case 'recovery.deleted':
      if (store.deleteRecord('recovery', id)) log(`recovery for sleep ${id} deleted`)
      break
    default:
      log(`unknown event type ${payload.type}, ignoring`)
  }
}

export function startWebhookReceiver(
  store: Store,
  port: number,
  path: string,
  onFact: FactHandler,
): ReturnType<typeof Bun.serve> {
  const clientSecret = readClientSecret()

  const server = Bun.serve({
    port,
    hostname: '127.0.0.1', // public exposure is the Funnel's job, never ours
    async fetch(req) {
      const url = new URL(req.url)
      if (req.method === 'GET' && url.pathname === '/healthz') {
        return new Response('ok', { status: 200 })
      }
      if (req.method !== 'POST' || url.pathname !== path) {
        return new Response('not found', { status: 404 })
      }

      const rawBody = await req.text()
      const sig = req.headers.get('X-WHOOP-Signature')
      const ts = req.headers.get('X-WHOOP-Signature-Timestamp')
      if (!verifySignature(clientSecret, sig, ts, rawBody)) {
        log(`rejected POST with bad signature (ts header: ${ts})`)
        return new Response('unauthorized', { status: 401 })
      }

      store.setMeta('webhook_last_rx', new Date().toISOString())

      let payload: WhoopWebhookPayload
      try {
        payload = JSON.parse(rawBody) as WhoopWebhookPayload
      } catch {
        return new Response('bad payload', { status: 400 })
      }

      // Ack fast; process async. WHOOP retries on slow responses and
      // duplicates are already harmless (idempotent upserts).
      queueMicrotask(() => {
        handleWebhookEvent(store, payload, onFact).catch((err) =>
          log(`event ${payload.type} ${payload.id} failed: ${err}`),
        )
      })
      log(`accepted ${payload.type} ${payload.id}`)
      return new Response('ok', { status: 200 })
    },
  })

  log(`listening on 127.0.0.1:${port}${path}`)
  return server
}
