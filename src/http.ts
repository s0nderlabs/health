// Shared helpers for the phone-facing HTTP routes (food log, money
// notifications, lift videos): one request-body parser, one text cleaner,
// one 400 type, one client-id idempotency gate, so their limits and messages
// cannot drift apart.

/** A client error: the route answers 400 with this message. */
export class BadRequest extends Error {}

/** Parse a JSON-object body, refusing anything over maxBytes up front. */
export async function jsonBody(req: Request, maxBytes: number): Promise<Record<string, unknown>> {
  const len = Number(req.headers.get('content-length') ?? 0)
  if (len > maxBytes) throw new BadRequest('body too large')
  let body: unknown
  try {
    body = await req.json()
  } catch {
    throw new BadRequest('body must be JSON')
  }
  if (typeof body !== 'object' || body == null || Array.isArray(body)) throw new BadRequest('body must be a JSON object')
  return body as Record<string, unknown>
}

/** Trimmed text capped at max chars, null when empty. Whitespace collapses
 *  to single spaces; keepNewlines preserves line breaks (notification bodies
 *  use them as field separators). */
export function cleanText(v: unknown, max: number, keepNewlines = false): string | null {
  if (typeof v !== 'string') return null
  const s = (keepNewlines ? v.replace(/[^\S\n]+/g, ' ').replace(/ *\n */g, '\n') : v.replace(/\s+/g, ' ')).trim().slice(0, max)
  return s || null
}

/** The phone's idempotency key (one per capture or add action, reused on retry). */
export function requireClientId(body: Record<string, unknown>): string {
  const id = typeof body.client_id === 'string' ? body.client_id.trim() : ''
  if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) throw new BadRequest('client_id (8-64 chars, UUID) is required')
  return id
}

/** Idempotent on a client id: a retry racing the first run waits for it (and
 *  shares its failure) and reports duplicate; one that comes after it gets
 *  the stored result (`done`); otherwise `run` once. */
export async function singleFlight<T extends { duplicate: boolean }>(
  inflight: Map<string, Promise<T>>,
  id: string,
  op: { done: (id: string) => T | null; run: (id: string) => Promise<T> },
): Promise<T> {
  const running = inflight.get(id)
  if (running) return running.then((r) => ({ ...r, duplicate: true }))
  const prior = op.done(id)
  if (prior) return prior
  const job = op.run(id)
  inflight.set(id, job)
  try {
    return await job
  } finally {
    inflight.delete(id)
  }
}
