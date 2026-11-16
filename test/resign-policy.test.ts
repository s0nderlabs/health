import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  APP_BUNDLE_ID,
  DEFAULT_RESIGN,
  STOP_HOURS,
  WIDGET_BUNDLE_ID,
  buildAllowed,
  checkFreshPair,
  classifyBuild,
  classifyInstall,
  classifyLaunch,
  clockGate,
  compareVersion,
  escalatedClass,
  freshExpiryFloor,
  hourInBand,
  installAllowed,
  installBlocker,
  installConfirmed,
  isFreshProfile,
  isOurProfile,
  parseDevices,
  parseLockState,
  parseTeamId,
  reconcilePending,
  resolveResignConfig,
  sameVersion,
  snapshotGuard,
  stagedValid,
  windowOpen,
  type BlockerInput,
  type DecodedProfile,
  type FailClass,
} from '../src/resign/policy.js'
import { SIGNING_EXPIRED_NAG_DAYS } from '../src/signing.js'

const H = 3_600_000
const D = 24 * H
const FIX = join(import.meta.dir, 'fixtures', 'resign')
const fixture = (name: string) => JSON.parse(readFileSync(join(FIX, name), 'utf8'))

// Placeholders only: never a real device, team or Apple ID.
const UDID = '00000000-000A000000000001'
const TEAM = 'TEAM000000'
const now = Date.parse('2026-11-16T10:00:00Z')
const iso = (ms: number) => new Date(ms).toISOString()

describe('config', () => {
  test('defaults: disabled, no device, 72h window, bands per spec', () => {
    expect(DEFAULT_RESIGN).toEqual({
      enabled: false,
      device_udid: null,
      window_hours: 72,
      build_hours: [2, 5],
      install_hours: [7, 23],
      install_on_hello: true,
      critical_hours: 12,
    })
  })

  test('resolveResignConfig: partial patch merges, junk falls back, never throws', () => {
    expect(resolveResignConfig(undefined)).toEqual(DEFAULT_RESIGN)
    expect(resolveResignConfig('nope')).toEqual(DEFAULT_RESIGN)
    const r = resolveResignConfig({ enabled: true, window_hours: -3, build_hours: [1], install_hours: [8, 22], device_udid: '  X  ' })
    expect(r.enabled).toBe(true)
    expect(r.window_hours).toBe(72)
    expect(r.build_hours).toEqual([2, 5])
    expect(r.install_hours).toEqual([8, 22])
    expect(r.device_udid).toBe('X')
    // A patch over a non-default base keeps the base's other fields.
    expect(resolveResignConfig({ device_udid: null }, r).device_udid).toBeNull()
    expect(resolveResignConfig({}, r).install_hours).toEqual([8, 22])
    // The default object is never aliased.
    resolveResignConfig({}).build_hours[0] = 9
    expect(DEFAULT_RESIGN.build_hours).toEqual([2, 5])
  })

  test('parseTeamId reads one consistent DEVELOPMENT_TEAM, null otherwise', () => {
    expect(parseTeamId(`settings:\n  base:\n    DEVELOPMENT_TEAM: ${TEAM}\n  w:\n    DEVELOPMENT_TEAM: "${TEAM}"\n`)).toBe(TEAM)
    expect(parseTeamId('DEVELOPMENT_TEAM: TEAM000000\nDEVELOPMENT_TEAM: TEAM111111\n')).toBeNull()
    expect(parseTeamId('name: x\n')).toBeNull()
  })

  test('STOP_HOURS mirrors the legacy nag stop', () => {
    expect(STOP_HOURS).toBe(-SIGNING_EXPIRED_NAG_DAYS * 24)
  })
})

describe('bands and clock', () => {
  test('hourInBand: half-open, wraps midnight, empty band is empty', () => {
    expect(hourInBand(2, [2, 5])).toBe(true)
    expect(hourInBand(4, [2, 5])).toBe(true)
    expect(hourInBand(5, [2, 5])).toBe(false)
    expect(hourInBand(1, [2, 5])).toBe(false)
    expect(hourInBand(23, [22, 3])).toBe(true)
    expect(hourInBand(2, [22, 3])).toBe(true)
    expect(hourInBand(3, [22, 3])).toBe(false)
    expect(hourInBand(4, [4, 4])).toBe(false)
  })

  test('windowOpen across the 72/0/-168 edges', () => {
    expect(windowOpen(72.1)).toBe(false)
    expect(windowOpen(72)).toBe(true)
    expect(windowOpen(48)).toBe(true)
    expect(windowOpen(0)).toBe(true)
    expect(windowOpen(-167.9)).toBe(true)
    expect(windowOpen(-168)).toBe(false)
    expect(windowOpen(null)).toBe(false)
  })

  test('clockGate: null is unknown_expiry, outside window is noop unless forced, -168 stops even forced', () => {
    const cfg = DEFAULT_RESIGN
    expect(clockGate(null, cfg, true)).toEqual({ proceed: false, outcome: 'unknown_expiry' })
    expect(clockGate(100, cfg, false)).toEqual({ proceed: false, outcome: 'noop' })
    expect(clockGate(100, cfg, true)).toEqual({ proceed: true })
    expect(clockGate(72, cfg, false)).toEqual({ proceed: true })
    expect(clockGate(-3, cfg, false)).toEqual({ proceed: true })
    expect(clockGate(-168, cfg, true)).toEqual({ proceed: false, outcome: 'stopped' })
  })
})

describe('buildAllowed', () => {
  const base = { cfg: DEFAULT_RESIGN, accountBrokenAt: null, now, forced: false }

  test('build band [02,05) with more than 48h left', () => {
    expect(buildAllowed({ ...base, hoursLeft: 60, localHour: 2 }).allowed).toBe(true)
    expect(buildAllowed({ ...base, hoursLeft: 60, localHour: 4 }).allowed).toBe(true)
    expect(buildAllowed({ ...base, hoursLeft: 60, localHour: 5 })).toEqual({
      allowed: false,
      reason: 'outside_build_hours',
      clear_account_broken: false,
    })
    expect(buildAllowed({ ...base, hoursLeft: 72, localHour: 14 }).allowed).toBe(false)
  })

  test('at or under 48h any hour builds; forced always builds', () => {
    expect(buildAllowed({ ...base, hoursLeft: 48, localHour: 14 }).allowed).toBe(true)
    expect(buildAllowed({ ...base, hoursLeft: 48.1, localHour: 14 }).allowed).toBe(false)
    expect(buildAllowed({ ...base, hoursLeft: 8, localHour: 14 }).allowed).toBe(true)
    expect(buildAllowed({ ...base, hoursLeft: 70, localHour: 14, forced: true }).allowed).toBe(true)
  })

  test('account_broken cools off 20h unless forced, and forced clears it', () => {
    const brokenAt = iso(now - 19 * H)
    expect(buildAllowed({ ...base, hoursLeft: 30, localHour: 3, accountBrokenAt: brokenAt })).toEqual({
      allowed: false,
      reason: 'account_broken_cooloff',
      clear_account_broken: false,
    })
    expect(buildAllowed({ ...base, hoursLeft: 30, localHour: 3, accountBrokenAt: iso(now - 21 * H) }).allowed).toBe(true)
    expect(buildAllowed({ ...base, hoursLeft: 30, localHour: 3, accountBrokenAt: brokenAt, forced: true })).toEqual({
      allowed: true,
      clear_account_broken: true,
    })
  })

  test('a running Xcode defers only while more than 24h are left', () => {
    expect(buildAllowed({ ...base, hoursLeft: 30, localHour: 3, xcodeRunning: true })).toMatchObject({ allowed: false, reason: 'busy' })
    expect(buildAllowed({ ...base, hoursLeft: 24, localHour: 3, xcodeRunning: true }).allowed).toBe(true)
  })

  test('a forced run clears account_broken even when it ends busy (regression)', () => {
    const brokenAt = iso(now - H)
    expect(buildAllowed({ ...base, hoursLeft: 30, localHour: 14, xcodeRunning: true, forced: true, accountBrokenAt: brokenAt })).toEqual({
      allowed: false,
      reason: 'busy',
      clear_account_broken: true,
    })
    expect(buildAllowed({ ...base, hoursLeft: 30, localHour: 3, xcodeRunning: true, accountBrokenAt: null, forced: true })).toEqual({
      allowed: false,
      reason: 'busy',
      clear_account_broken: false,
    })
  })
})

describe('installAllowed', () => {
  const base = {
    cfg: DEFAULT_RESIGN,
    forced: false,
    daemonReachable: true,
    certChanged: false,
    pending: null,
    stagedRunId: 'R1',
    now,
  }

  test('install band [07,23) with critical bypass under 12h', () => {
    expect(installAllowed({ ...base, hoursLeft: 40, localHour: 7 })).toEqual({ action: 'install' })
    expect(installAllowed({ ...base, hoursLeft: 40, localHour: 22 })).toEqual({ action: 'install' })
    expect(installAllowed({ ...base, hoursLeft: 40, localHour: 23 })).toEqual({ action: 'skip', reason: 'night' })
    expect(installAllowed({ ...base, hoursLeft: 12, localHour: 3 })).toEqual({ action: 'skip', reason: 'night' })
    expect(installAllowed({ ...base, hoursLeft: 11.9, localHour: 3 })).toEqual({ action: 'install' })
    expect(installAllowed({ ...base, hoursLeft: 40, localHour: 3, forced: true })).toEqual({ action: 'install' })
  })

  test('the daemon must be reachable, even forced or critical', () => {
    expect(installAllowed({ ...base, hoursLeft: 2, localHour: 10, forced: true, daemonReachable: false })).toEqual({
      action: 'skip',
      reason: 'daemon_down',
    })
  })

  test('cert_changed: hard new_certificate above 12h unless forced', () => {
    expect(installAllowed({ ...base, hoursLeft: 30, localHour: 10, certChanged: true })).toEqual({ action: 'hard', class: 'new_certificate' })
    expect(installAllowed({ ...base, hoursLeft: 11, localHour: 10, certChanged: true })).toEqual({ action: 'install' })
    expect(installAllowed({ ...base, hoursLeft: 30, localHour: 10, certChanged: true, forced: true })).toEqual({ action: 'install' })
  })

  test('pending: no reinstall of the same staged build within 24h unless under 12h', () => {
    const pending = { staged_run_id: 'R1', first_installed_at: iso(now - 23 * H) }
    expect(installAllowed({ ...base, hoursLeft: 30, localHour: 10, pending })).toEqual({ action: 'relaunch_only' })
    expect(installAllowed({ ...base, hoursLeft: 11, localHour: 10, pending })).toEqual({ action: 'install' })
    expect(installAllowed({ ...base, hoursLeft: 30, localHour: 10, pending: { ...pending, first_installed_at: iso(now - 25 * H) } })).toEqual({
      action: 'install',
    })
    // A different staged build is a fresh install.
    expect(installAllowed({ ...base, hoursLeft: 30, localHour: 10, pending, stagedRunId: 'R2' })).toEqual({ action: 'install' })
  })

  test('critical keeps a 2h reinstall floor; after expiry a launched build is never reinstalled (regression)', () => {
    const recent = { staged_run_id: 'R1', first_installed_at: iso(now - 15 * 60_000) }
    expect(installAllowed({ ...base, hoursLeft: 6, localHour: 3, pending: recent })).toEqual({ action: 'relaunch_only' })
    expect(installAllowed({ ...base, hoursLeft: 6, localHour: 3, pending: { ...recent, first_installed_at: iso(now - 2 * H - 1) } })).toEqual({
      action: 'install',
    })
    const old = { staged_run_id: 'R1', first_installed_at: iso(now - 5 * H) }
    expect(installAllowed({ ...base, hoursLeft: -2, localHour: 3, pending: { ...old, launched: true } })).toEqual({ action: 'relaunch_only' })
    expect(installAllowed({ ...base, hoursLeft: -2, localHour: 3, pending: { ...old, launched: false } })).toEqual({ action: 'install' })
    expect(installAllowed({ ...base, hoursLeft: 6, localHour: 3, pending: { ...old, launched: true } })).toEqual({ action: 'install' })
  })
})

describe('stagedValid', () => {
  const ok = {
    appExpiry: iso(now + 6.9 * D),
    widgetExpiry: iso(now + 6.9 * D),
    stagedVersion: '0.17.4 (7)',
    sourceVersion: '0.17.4 (7)',
    signedUntil: iso(now + 2 * D),
    now,
  }
  test('valid when both live 5d+, app outlives signed_until by 24h+, versions match', () => {
    expect(stagedValid(ok)).toEqual({ valid: true })
  })
  test('each failure has its reason', () => {
    expect(stagedValid({ ...ok, appExpiry: null })).toEqual({ valid: false, reason: 'missing' })
    expect(stagedValid({ ...ok, appExpiry: iso(now + 5 * D - 1) })).toEqual({ valid: false, reason: 'app_short' })
    expect(stagedValid({ ...ok, widgetExpiry: iso(now + 4 * D) })).toEqual({ valid: false, reason: 'widget_short' })
    expect(stagedValid({ ...ok, signedUntil: iso(now + 6.5 * D) })).toEqual({ valid: false, reason: 'not_past_signed' })
    expect(stagedValid({ ...ok, sourceVersion: '0.17.4 (8)' })).toEqual({ valid: false, reason: 'version' })
  })
  test('the exact 5d edge is valid; unknown signed_until skips only that criterion', () => {
    expect(stagedValid({ ...ok, appExpiry: iso(now + 5 * D), widgetExpiry: iso(now + 5 * D), signedUntil: null }).valid).toBe(true)
  })
})

describe('installBlocker', () => {
  const quiet: BlockerInput = {
    now,
    hoursLeft: 40,
    liveSessionOpen: false,
    lastIntentAt: null,
    lastScoredWorkoutAt: null,
    lastRestAt: null,
    yieldActive: false,
    activeSource: 'mac',
    phoneBandSeenAgoS: null,
  }

  test('nothing going on: no blocker', () => {
    expect(installBlocker(quiet)).toBeNull()
  })

  test('dual hold with the MAC writing does NOT block, even with fresh phone frames', () => {
    expect(installBlocker({ ...quiet, activeSource: 'mac', phoneBandSeenAgoS: 1 })).toBeNull()
  })

  test('the phone as writer with fresh frames blocks above 12h only', () => {
    expect(installBlocker({ ...quiet, activeSource: 'phone', phoneBandSeenAgoS: 30 })).toEqual({ reason: 'phone_writer', overridable: true })
    expect(installBlocker({ ...quiet, activeSource: 'phone', phoneBandSeenAgoS: 120 })).toBeNull()
    expect(installBlocker({ ...quiet, activeSource: 'phone', phoneBandSeenAgoS: null })).toBeNull()
    expect(installBlocker({ ...quiet, hoursLeft: 12, activeSource: 'phone', phoneBandSeenAgoS: 30 })?.reason).toBe('phone_writer')
    expect(installBlocker({ ...quiet, hoursLeft: 11.9, activeSource: 'phone', phoneBandSeenAgoS: 30 })).toBeNull()
  })

  test('yield blocks above 12h only', () => {
    expect(installBlocker({ ...quiet, yieldActive: true })).toEqual({ reason: 'yield', overridable: true })
    expect(installBlocker({ ...quiet, yieldActive: true, hoursLeft: 8 })).toBeNull()
    // Unknown clock is never treated as critical.
    expect(installBlocker({ ...quiet, yieldActive: true, hoursLeft: null })?.reason).toBe('yield')
  })

  test('always-blockers ignore the tier, even at 0h', () => {
    expect(installBlocker({ ...quiet, hoursLeft: 0, liveSessionOpen: true })).toEqual({ reason: 'live_session', overridable: false })
    expect(installBlocker({ ...quiet, hoursLeft: 0, lastIntentAt: iso(now - 2.9 * H) })).toEqual({ reason: 'recent_intent', overridable: false })
    expect(installBlocker({ ...quiet, hoursLeft: 0, lastRestAt: iso(now - 59 * 60_000) })).toEqual({ reason: 'recent_rest', overridable: false })
  })

  test('intent: 3h window, cleared by a scored workout at or after it', () => {
    expect(installBlocker({ ...quiet, lastIntentAt: iso(now - 3 * H) })).toBeNull()
    expect(installBlocker({ ...quiet, lastIntentAt: iso(now - H), lastScoredWorkoutAt: iso(now - 0.5 * H) })).toBeNull()
    expect(installBlocker({ ...quiet, lastIntentAt: iso(now - H), lastScoredWorkoutAt: iso(now - 2 * H) })?.reason).toBe('recent_intent')
  })

  test('rest: 60 min window', () => {
    expect(installBlocker({ ...quiet, lastRestAt: iso(now - 60 * 60_000) })).toBeNull()
  })

  test('order: the live session wins over everything', () => {
    const all = { ...quiet, liveSessionOpen: true, lastRestAt: iso(now), yieldActive: true }
    expect(installBlocker(all)?.reason).toBe('live_session')
  })
})

describe('freshness (step 11d)', () => {
  const runStart = now - 10 * 60_000
  const certNotAfter = iso(now + 365 * D)
  const good = (bundle: string): DecodedProfile => ({
    uuid: bundle === APP_BUNDLE_ID ? 'NEW-APP-UUID' : 'NEW-WIDGET-UUID',
    creation_date: iso(runStart + 60_000),
    expiration_date: iso(now + 7 * D),
    team_ids: [TEAM],
    application_identifier: `${TEAM}.${bundle}`,
    provisioned_devices: [UDID],
  })
  const ctx = { runStart, now, movedUuids: ['OLD-APP-UUID', 'OLD-WIDGET-UUID'], certNotAfter, teamId: TEAM, deviceUdid: UDID }

  test('a fresh pair passes', () => {
    expect(isFreshProfile(good(APP_BUNDLE_ID), { ...ctx, bundleId: APP_BUNDLE_ID })).toEqual({ fresh: true })
    expect(checkFreshPair({ app: good(APP_BUNDLE_ID), widget: good(WIDGET_BUNDLE_ID) }, ctx)).toEqual({ fresh: true })
  })

  test('reused UUID (Xcode re-downloaded the quarantined profile)', () => {
    const p = { ...good(APP_BUNDLE_ID), uuid: 'old-app-uuid' }
    expect(isFreshProfile(p, { ...ctx, bundleId: APP_BUNDLE_ID })).toMatchObject({ fresh: false, reasons: ['reused_uuid'], class: 'profile_not_fresh' })
  })

  test('old CreationDate, with the 5 min slack', () => {
    const edge = { ...good(APP_BUNDLE_ID), creation_date: iso(runStart - 5 * 60_000) }
    expect(isFreshProfile(edge, { ...ctx, bundleId: APP_BUNDLE_ID }).fresh).toBe(true)
    const old = { ...good(APP_BUNDLE_ID), creation_date: iso(runStart - 5 * 60_000 - 1) }
    expect(isFreshProfile(old, { ...ctx, bundleId: APP_BUNDLE_ID })).toMatchObject({ reasons: ['old_creation'] })
  })

  test('expiry floor is min(now+6.9d, cert notAfter-1h)', () => {
    expect(freshExpiryFloor(now, null)).toBe(now + 6.9 * D)
    const certSoon = iso(now + 3 * D)
    expect(freshExpiryFloor(now, certSoon)).toBe(now + 3 * D - H)
    // A profile capped by a cert that dies in 3 days is still fresh.
    const capped = { ...good(APP_BUNDLE_ID), expiration_date: iso(now + 3 * D - H) }
    expect(isFreshProfile(capped, { ...ctx, certNotAfter: certSoon, bundleId: APP_BUNDLE_ID }).fresh).toBe(true)
    // Without the cap the same profile is short.
    expect(isFreshProfile(capped, { ...ctx, bundleId: APP_BUNDLE_ID })).toMatchObject({ reasons: ['short_expiry'] })
  })

  test('team and app-id mismatches', () => {
    const p = { ...good(APP_BUNDLE_ID), team_ids: ['TEAM999999'], application_identifier: `TEAM999999.${APP_BUNDLE_ID}` }
    expect(isFreshProfile(p, { ...ctx, bundleId: APP_BUNDLE_ID })).toMatchObject({ reasons: ['team_mismatch', 'app_id_mismatch'] })
    // The widget profile checked against the app bundle id is a mismatch.
    expect(isFreshProfile(good(WIDGET_BUNDLE_ID), { ...ctx, bundleId: APP_BUNDLE_ID })).toMatchObject({ reasons: ['app_id_mismatch'] })
  })

  test('missing device UDID is device_not_in_profile', () => {
    const p = { ...good(APP_BUNDLE_ID), provisioned_devices: ['00000000-000A000000000009'] }
    expect(isFreshProfile(p, { ...ctx, bundleId: APP_BUNDLE_ID })).toMatchObject({ class: 'device_not_in_profile', reasons: ['device_missing'] })
    // UDID compare is case-insensitive.
    const lower = { ...good(APP_BUNDLE_ID), provisioned_devices: [UDID.toLowerCase()] }
    expect(isFreshProfile(lower, { ...ctx, bundleId: APP_BUNDLE_ID }).fresh).toBe(true)
  })

  test('unreadable profile is never fresh', () => {
    const p = { ...good(APP_BUNDLE_ID), uuid: null, expiration_date: null }
    expect(isFreshProfile(p, { ...ctx, bundleId: APP_BUNDLE_ID })).toMatchObject({ fresh: false })
  })

  test('widget-only stale: a fresh app with a stale widget fails the pair', () => {
    const staleWidget = { ...good(WIDGET_BUNDLE_ID), uuid: 'OLD-WIDGET-UUID', creation_date: iso(now - 3 * D) }
    const v = checkFreshPair({ app: good(APP_BUNDLE_ID), widget: staleWidget }, ctx)
    expect(v).toEqual({
      fresh: false,
      class: 'profile_not_fresh',
      failures: [{ bundle: 'widget', reasons: ['reused_uuid', 'old_creation'] }],
    })
  })

  test('a device miss on either bundle makes the pair device_not_in_profile', () => {
    const w = { ...good(WIDGET_BUNDLE_ID), provisioned_devices: [] }
    const stale = { ...good(APP_BUNDLE_ID), uuid: 'OLD-APP-UUID' }
    expect(checkFreshPair({ app: stale, widget: w }, ctx)).toMatchObject({ fresh: false, class: 'device_not_in_profile' })
  })

  test('isOurProfile matches exactly the two HealthRelay ids', () => {
    expect(isOurProfile(`${TEAM}.${APP_BUNDLE_ID}`, TEAM)).toBe(true)
    expect(isOurProfile(`${TEAM}.${WIDGET_BUNDLE_ID}`, TEAM)).toBe(true)
    expect(isOurProfile(`${TEAM}.com.s0nderlabs.Other`, TEAM)).toBe(false)
    expect(isOurProfile(`${TEAM}.*`, TEAM)).toBe(false)
    expect(isOurProfile(`TEAM999999.${APP_BUNDLE_ID}`, TEAM)).toBe(false)
    expect(isOurProfile(null, TEAM)).toBe(false)
  })
})

describe('pending reconciliation and the snapshot guard', () => {
  const pending = {
    staged_run_id: 'R1',
    first_installed_at: iso(now - 2 * H),
    expected_until: iso(now + 7 * D),
    version: '0.17.4 (7)',
  }
  const old = iso(now + 2 * D)

  test('confirmed at expected minus 15 min', () => {
    expect(reconcilePending({ pending, signedUntil: iso(now + 7 * D - 15 * 60_000), oldSignedUntil: old, lastHelloAt: null })).toEqual({ verdict: 'confirmed' })
    expect(reconcilePending({ pending, signedUntil: iso(now + 7 * D - 16 * 60_000), oldSignedUntil: old, lastHelloAt: null }).verdict).not.toBe('confirmed')
  })

  test('some other newer date is a manual install (superseded)', () => {
    expect(reconcilePending({ pending, signedUntil: iso(now + 5 * D), oldSignedUntil: old, lastHelloAt: iso(now - H) })).toEqual({ verdict: 'superseded' })
  })

  test('a hello after the install with the OLD date did not take; no hello yet is waiting', () => {
    expect(reconcilePending({ pending, signedUntil: old, oldSignedUntil: old, lastHelloAt: iso(now - H) })).toEqual({ verdict: 'did_not_take' })
    expect(reconcilePending({ pending, signedUntil: old, oldSignedUntil: old, lastHelloAt: iso(now - 3 * H) })).toEqual({ verdict: 'waiting' })
    expect(reconcilePending({ pending: null, signedUntil: old, lastHelloAt: null })).toEqual({ verdict: 'none' })
  })

  test('snapshotGuard: match, young mismatch is awaiting_hello, old mismatch or missing is hard', () => {
    const source = { version: '0.17.4 (7)', captured_at: iso(now - 2 * H) }
    expect(snapshotGuard({ source, phoneVersion: '0.17.4 (7)', now })).toEqual({ ok: true })
    expect(snapshotGuard({ source, phoneVersion: '0.17.0 (5)', now })).toEqual({ ok: false, class: 'awaiting_hello', hard: false })
    expect(snapshotGuard({ source: { ...source, captured_at: iso(now - 25 * H) }, phoneVersion: '0.17.0 (5)', now })).toMatchObject({
      class: 'snapshot_mismatch',
      hard: true,
      why: 'version',
    })
    expect(snapshotGuard({ source: null, phoneVersion: '0.17.0 (5)', now })).toMatchObject({ class: 'snapshot_mismatch', why: 'missing' })
    // An unknown phone version is never a match.
    expect(snapshotGuard({ source: { ...source, captured_at: iso(now - 25 * H) }, phoneVersion: null, now }).ok).toBe(false)
  })
})

describe('compareVersion', () => {
  test('marketing then build; unparseable is null, never equal', () => {
    expect(compareVersion('0.17.4 (7)', '0.17.4 (7)')).toBe(0)
    expect(compareVersion('0.17.4(7)', '0.17.4 (7)')).toBe(0)
    expect(compareVersion('0.17 (7)', '0.17.0 (7)')).toBe(0)
    expect(compareVersion('0.17.0 (5)', '0.17.4 (7)')).toBe(-1)
    expect(compareVersion('0.17.10 (1)', '0.17.9 (9)')).toBe(1)
    expect(compareVersion('0.17.4 (6)', '0.17.4 (7)')).toBe(-1)
    expect(compareVersion('0.17.4', '0.17.4 (7)')).toBe(-1)
    expect(compareVersion('0.17.4', '0.17.4')).toBe(0)
    expect(compareVersion('garbage', '0.17.4 (7)')).toBeNull()
    expect(compareVersion(null, '0.17.4 (7)')).toBeNull()
    expect(sameVersion(null, null)).toBe(false)
  })
})

describe('classifiers (synthetic fixtures)', () => {
  const errors = fixture('errors.json') as Record<'build' | 'install' | 'launch', Array<{ name: string; text: string; class: string; hard: boolean }>>

  for (const c of errors.build) {
    test(`build: ${c.name} -> ${c.class}`, () => {
      expect(classifyBuild(c.text)).toMatchObject({ class: c.class, hard: c.hard })
    })
  }
  for (const c of errors.install) {
    test(`install: ${c.name} -> ${c.class}`, () => {
      expect(classifyInstall(c.text)).toMatchObject({ class: c.class, hard: c.hard })
    })
  }
  for (const c of errors.launch) {
    test(`launch: ${c.name} -> ${c.class}`, () => {
      expect(classifyLaunch(c.text)).toMatchObject({ class: c.class, hard: c.hard })
    })
  }

  test('build timeouts: silent idle or wall is prompt_hang, text beats timing', () => {
    expect(classifyBuild('CompileSwift normal arm64 ...', { idledOut: true })).toMatchObject({ class: 'prompt_hang', hard: true, why: 'idle timeout' })
    expect(classifyBuild('', { timedOut: true })).toMatchObject({ class: 'prompt_hang', why: 'wall timeout' })
    expect(classifyBuild('error: No Accounts: Add a new account', { idledOut: true }).class).toBe('account_broken')
    expect(classifyBuild('** BUILD SUCCEEDED **', { productMissing: true })).toMatchObject({ class: 'other', why: 'product missing' })
  })

  test('install and launch timeouts without text are soft unreachable', () => {
    expect(classifyInstall('', { timedOut: true })).toMatchObject({ class: 'unreachable', hard: false })
    expect(classifyLaunch('', { timedOut: true })).toMatchObject({ class: 'unreachable', hard: false })
  })

  test('streak escalation: profile_not_fresh hard on 2nd, install_failed on 3rd, run_timeout on 2nd, lockstate_unknown becomes lockstate_unparsed on 3rd', () => {
    expect(escalatedClass('profile_not_fresh', 1)).toEqual({ class: 'profile_not_fresh', hard: false })
    expect(escalatedClass('profile_not_fresh', 2)).toEqual({ class: 'profile_not_fresh', hard: true })
    expect(escalatedClass('install_failed', 2)).toEqual({ class: 'install_failed', hard: false })
    expect(escalatedClass('install_failed', 3)).toEqual({ class: 'install_failed', hard: true })
    expect(escalatedClass('run_timeout', 1).hard).toBe(false)
    expect(escalatedClass('run_timeout', 2).hard).toBe(true)
    expect(escalatedClass('lockstate_unknown', 2)).toEqual({ class: 'lockstate_unknown', hard: false })
    expect(escalatedClass('lockstate_unknown', 3)).toEqual({ class: 'lockstate_unparsed', hard: true })
    // Non-streak classes keep their intrinsic severity.
    expect(escalatedClass('account_broken', 1)).toEqual({ class: 'account_broken', hard: true })
    expect(escalatedClass('locked', 99)).toEqual({ class: 'locked', hard: false })
  })

  test('every soft class the spec lists is soft', () => {
    const soft: FailClass[] = ['locked', 'unreachable', 'night', 'blocked', 'busy', 'battery', 'apple_unreachable', 'awaiting_hello']
    for (const c of soft) expect(escalatedClass(c, 1).hard).toBe(false)
  })

  test('installConfirmed needs BOTH the text and the bundle in the JSON', () => {
    const json = fixture('install-ok.json')
    expect(installConfirmed('App installed:\n  bundleID: com.s0nderlabs.HealthRelay', json)).toBe(true)
    expect(installConfirmed('Install started...', json)).toBe(false)
    expect(installConfirmed('App installed', { result: { installedApplications: [] } })).toBe(false)
    expect(installConfirmed('App installed', { result: { installedApplications: [{ bundleID: 'com.other.App' }] } })).toBe(false)
    expect(installConfirmed('App installed', null)).toBe(false)
  })
})

describe('parseDevices', () => {
  const json = fixture('devices.json')

  test('matches the physical paired phone by hardware udid', () => {
    const r = parseDevices(json, UDID)
    expect(r.reason).toBeNull()
    expect(r.device).toMatchObject({ udid: UDID, reality: 'physical', pairing_state: 'paired', transport_type: 'localNetwork', tunnel_state: 'disconnected' })
    expect(r.devices).toHaveLength(3)
  })

  test('accepts the raw JSON string and a lower-case udid', () => {
    expect(parseDevices(JSON.stringify(json), UDID.toLowerCase()).device?.udid).toBe(UDID)
  })

  test('never matches a simulator, nor the CoreDevice identifier', () => {
    expect(parseDevices(json, '00000000-000A000000000002')).toMatchObject({ device: null, reason: 'not_physical' })
    expect(parseDevices(json, 'AAAAAAAA-0000-0000-0000-000000000001')).toMatchObject({ device: null, reason: 'not_found' })
  })

  test('an unpaired physical device is not a match', () => {
    expect(parseDevices(json, '00000000-000A000000000003')).toMatchObject({ device: null, reason: 'not_paired' })
  })

  test('reads the properties dictionary once the deprecated fields are gone', () => {
    const r = parseDevices(fixture('devices-properties-only.json'), UDID)
    expect(r.device).toMatchObject({ udid: UDID, pairing_state: 'paired', transport_type: 'wired', tunnel_state: 'connected' })
  })

  test('no udid configured, unknown udid, garbage', () => {
    expect(parseDevices(json, null).reason).toBe('no_udid_configured')
    expect(parseDevices(json, '00000000-000A00000000000F').reason).toBe('not_found')
    expect(parseDevices('not json', UDID)).toEqual({ device: null, reason: 'unreadable', devices: [] })
    expect(parseDevices({ result: {} }, UDID).reason).toBe('unreadable')
  })
})

describe('parseLockState', () => {
  const cases = fixture('lockstate-cases.json')

  test('explicit locked and unlocked fields', () => {
    // The REAL shape (iPhone 12, iOS 27.2, devicectl 651.32, Nov 16 2026):
    // passcodeRequired read true for 10 minutes straight, so it is not a lock
    // signal. Only unlockedSinceBoot=false is unambiguous.
    expect(parseLockState(cases.observed_real)).toMatchObject({ state: 'unverified', why: 'observed_shape' })
    expect(parseLockState(cases.passcode_required_false)).toMatchObject({ state: 'unverified' })
    expect(parseLockState(cases.before_first_unlock)).toMatchObject({ state: 'locked', field: 'result.unlockedSinceBoot' })
    expect(parseLockState(cases.is_locked_true)).toMatchObject({ state: 'locked', field: 'result.isLocked' })
    expect(parseLockState(cases.nested_string_unlocked)).toMatchObject({ state: 'unlocked', field: 'result.lockState.state' })
    expect(parseLockState(JSON.stringify(cases.is_locked_true)).state).toBe('locked')
  })

  test('unknown is its own outcome: never guessed', () => {
    // Unlocked once since boot is NOT unlocked now.
    expect(parseLockState(cases.unlocked_since_boot_only)).toMatchObject({ state: 'unverified', keys: ['unlockedSinceBoot'] })
    expect(parseLockState(cases.conflict)).toMatchObject({ state: 'unknown', why: 'conflict' })
    expect(parseLockState(cases.failed_outcome)).toMatchObject({ state: 'unknown', why: 'outcome:failed' })
    expect(parseLockState(cases.unrelated_fields)).toMatchObject({ state: 'unknown', why: 'no_known_field' })
    expect(parseLockState(cases.string_state_weird).state).toBe('unknown')
    expect(parseLockState('')).toMatchObject({ state: 'unknown', why: 'unreadable' })
    expect(parseLockState('{"info":{"outcome":"success"}}')).toMatchObject({ state: 'unknown', why: 'no_result' })
    expect(parseLockState(null).state).toBe('unknown')
  })
})

test('no emdash in the policy source or fixtures', () => {
  const files = [
    join(import.meta.dir, '..', 'src', 'resign', 'policy.ts'),
    join(import.meta.dir, '..', 'src', 'resign', 'state.ts'),
    join(FIX, 'errors.json'),
    join(FIX, 'devices.json'),
    join(FIX, 'lockstate-cases.json'),
  ]
  for (const f of files) expect(readFileSync(f, 'utf8').includes('\u2014')).toBe(false)
})

describe('classifyInstall: the real locked answer (Nov 16 2026)', () => {
  test('CoreDevice 4016 usage assertion = locked, soft', () => {
    const c = classifyInstall('ERROR: The device is not able to fulfill the requested usage assertion requirements. (com.apple.dt.CoreDeviceError error 4016 (0xFB0))')
    expect(c).toMatchObject({ class: 'locked', hard: false })
  })
})
