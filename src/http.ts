// Shared helpers for the phone-facing HTTP routes (food log, money
// notifications): one request-body parser, one text cleaner, one 400 type,
// so their limits and messages cannot drift apart.

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
