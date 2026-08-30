// The sideload clock, daemon side. iOS kills a free-team sideload seven days
// after Xcode minted its profile, silently. The phone reports the date at
// hello (see live.ts parseSignedUntil); these pure helpers turn it into a
// countdown and a bounded daily nag so the session can plan the re-sign
// around training instead of discovering a dead relayer at the gym.

/** Nag from this many hours out. */
export const SIGNING_NAG_HOURS = 48
/** Stop nagging this many days after death: a phone that never hellos again
 *  (leg retired, weekend away) must not produce a system.health event every
 *  day forever, budget-exempt. A fresh hello resets the clock. */
export const SIGNING_EXPIRED_NAG_DAYS = 7

const REINSTALL =
  'Re-sign and reinstall from Xcode: cable in, then scripts/build-phone.sh install (delete the cached profiles under ~/Library/Developer/Xcode/UserData/Provisioning\\ Profiles/ first so a fresh 7-day one is minted).'

/** Hours until the signature dies (negative once dead), one decimal, or null
 *  when the value is missing or unparseable. */
export function signedHoursLeft(iso: string | null | undefined, now = Date.now()): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  return Math.round(((t - now) / 3_600_000) * 10) / 10
}

/** The daily nag, if one is due: a dedupe key scoped to the UTC day (so the
 *  engine emits at most one per day) and the problem text. null when the
 *  signature is healthy, unknown, or dead for longer than the nag window. */
export function signingNag(
  iso: string | null | undefined,
  now = Date.now(),
): { key: string; problem: string } | null {
  const left = signedHoursLeft(iso, now)
  if (left == null || left > SIGNING_NAG_HOURS) return null
  if (left <= -SIGNING_EXPIRED_NAG_DAYS * 24) return null
  const day = new Date(now).toISOString().slice(0, 10)
  if (left <= 0) {
    return {
      key: `phone-sign-expired:${day}`,
      problem: `Phone relayer: the HealthRelay app's sideload signature EXPIRED at ${iso} (${Math.abs(left)}h ago). iOS will not launch it, so the phone leg is dead until it is reinstalled. ${REINSTALL}`,
    }
  }
  return {
    key: `phone-sign-expiry:${day}`,
    problem: `Phone relayer: the HealthRelay app's sideload signature expires in ${left}h (at ${iso}). ${REINSTALL} Plan it around training: the phone leg is the only live HR away from the Mac.`,
  }
}
