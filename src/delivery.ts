// In-flight delivery tracking: which sessions has each undelivered event been
// pushed to, and when. Pure state, no I/O, so the redelivery policy is unit
// testable. The daemon consults it on every drain:
//
//   - a session is excluded from a push it already received (no duplicates)
//   - a latecomer session gets a targeted push of still-undelivered events
//   - when every recipient of an event drops, the event frees for redelivery
//   - when an event sits un-acked past the TTL (handler failed, session
//     suspended with a full socket buffer), it frees for redelivery too;
//     after 60s of silence a rare duplicate beats a lost event

export class InFlightTracker {
  private entries = new Map<number, { recipients: Set<number>; since: number }>()

  constructor(private ttlMs = 60_000) {}

  /**
   * Sessions to EXCLUDE from a push of this event right now. Expires the
   * entry first if the ack TTL has passed (so everything becomes eligible).
   */
  exclusions(eventId: number, now = Date.now()): Set<number> {
    const entry = this.entries.get(eventId)
    if (!entry) return EMPTY
    if (now - entry.since > this.ttlMs) {
      this.entries.delete(eventId)
      return EMPTY
    }
    return entry.recipients
  }

  /** Record that the event was just pushed to these sessions. */
  pushed(eventId: number, sessionIds: number[], now = Date.now()): void {
    if (sessionIds.length === 0) return
    const entry = this.entries.get(eventId)
    if (entry) {
      for (const id of sessionIds) entry.recipients.add(id)
    } else {
      this.entries.set(eventId, { recipients: new Set(sessionIds), since: now })
    }
  }

  /** The event was acked (delivered): stop tracking it. */
  acked(eventId: number): void {
    this.entries.delete(eventId)
  }

  /**
   * A session dropped: it can no longer ack anything it received. Events
   * whose entire recipient set is gone free up for redelivery.
   */
  sessionDropped(sessionId: number): void {
    for (const [eventId, entry] of this.entries) {
      entry.recipients.delete(sessionId)
      if (entry.recipients.size === 0) this.entries.delete(eventId)
    }
  }

  clear(): void {
    this.entries.clear()
  }

  get size(): number {
    return this.entries.size
  }
}

const EMPTY: Set<number> = new Set()
