import { afterEach, describe, expect, test } from 'bun:test'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import type { ExecFn, ExecResult } from '../src/resign/exec.js'
import { BUILD_FLAGS, runResign, type RunnerDeps, type RunOptions } from '../src/resign/runner.js'
import { DEFAULT_RESIGN, type ResignConfig } from '../src/resign/policy.js'
import { emptyState, paths, readState, writeState, type ResignPaths, type ResignState } from '../src/resign/state.js'
import type { ResignPreflight } from '../src/resign/hooks.js'

// The runner against a FAKE world: every external command is answered by
// the fake exec below, every path lives in a temp home. Placeholder ids only.

const H = 3_600_000
const D = 24 * H
const T0 = Date.parse('2026-11-20T03:00:00Z')
const TEAM = 'TEAM000000'
const UDID = '00000000-000A000000000001'
const APP = 'com.s0nderlabs.HealthRelay'
const WIDGET = 'com.s0nderlabs.HealthRelay.widgets'
const VERSION = '0.17.4 (7)'
const iso = (ms: number) => new Date(ms).toISOString()

interface Profile {
  UUID: string
  Name?: string
  CreationDate: string
  ExpirationDate: string
  TeamIdentifier: string[]
  Entitlements: { 'application-identifier': string }
  ProvisionedDevices: string[]
}

function profile(uuid: string, bundle: string, created: number, expires: number, devices = [UDID]): Profile {
  return {
    UUID: uuid,
    Name: `iOS Team Provisioning Profile: ${bundle}`,
    CreationDate: iso(created),
    ExpirationDate: iso(expires),
    TeamIdentifier: [TEAM],
    Entitlements: { 'application-identifier': `${TEAM}.${bundle}` },
    ProvisionedDevices: devices,
  }
}

type BuildMode = 'ok' | 'stale' | 'nodevice' | 'noproduct' | 'timeout' | { fail: string }
type InstallMode = 'ok' | 'locked' | 'exit0_no_text' | 'unknown_error'

interface World {
  clock: number
  hour: number
  cfg: ResignConfig
  pf: ResignPreflight | null
  /** Successive preflight answers override pf (consumed in order). */
  pfQueue: Array<ResignPreflight | null>
  build: BuildMode
  install: InstallMode
  lock: 'unlocked' | 'locked' | 'weird'
  devices: 'ok' | 'none'
  launch: 'ok' | 'untrusted'
  /** Does the build write Metadata.appintents? (the snapshot always imports AppIntents) */
  intentsMetadata: boolean
  account: boolean
  /** After an install, does the phone hello with the new date? */
  phoneConfirms: boolean
  installedExpiry: string | null
  calls: string[][]
  mintCount: number
}

let homes: string[] = []
afterEach(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true })
  homes = []
})

function basePf(w: Partial<ResignPreflight> = {}): ResignPreflight {
  return {
    signed_until: iso(T0 + 40 * H),
    hours_left: 40,
    phone_app_version: VERSION,
    phone_last_seen: iso(T0 - H),
    phone_hello_at: iso(T0 - H),
    blocker: null,
    system_health_enabled: true,
    resign_enabled: true,
    ...w,
  }
}

function setup(over: Partial<World> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'health-resign-runner-'))
  homes.push(home)
  const P: ResignPaths = paths(home)
  const w: World = {
    clock: T0,
    hour: 10,
    cfg: { ...DEFAULT_RESIGN, enabled: true, device_udid: UDID },
    pf: basePf(),
    pfQueue: [],
    build: 'ok',
    install: 'ok',
    lock: 'unlocked',
    devices: 'ok',
    launch: 'ok',
    intentsMetadata: true,
    account: true,
    phoneConfirms: true,
    installedExpiry: null,
    calls: [],
    mintCount: 0,
    ...over,
  }
  // The snapshot (source/relayer-ios with a project.yml) and source.json.
  mkdirSync(P.sourceDir, { recursive: true })
  // Like the real app: one source file uses App Intents (the Money shortcut).
  mkdirSync(join(P.sourceDir, 'HealthRelay', 'Money'), { recursive: true })
  writeFileSync(join(P.sourceDir, 'HealthRelay', 'Money', 'MoneyNotify.swift'), 'import Foundation\nimport AppIntents\n')
  writeFileSync(join(P.sourceDir, 'project.yml'), `targets:\n  HealthRelay:\n    settings:\n      DEVELOPMENT_TEAM: ${TEAM}\n`)
  writeFileSync(P.sourceJson, JSON.stringify({ version: VERSION, git_commit: 'abc', dirty: false, content_sha256: null, captured_at: iso(T0 - 3 * D) }))
  // Xcode's cache: our two old profiles + another app's.
  const cache = P.profileDirs[0]
  mkdirSync(cache, { recursive: true })
  writeFileSync(join(cache, 'OLD-APP.mobileprovision'), JSON.stringify(profile('OLD-APP', APP, T0 - 128 * H, T0 + 40 * H)))
  writeFileSync(join(cache, 'OLD-WID.mobileprovision'), JSON.stringify(profile('OLD-WID', WIDGET, T0 - 128 * H, T0 + 40 * H)))
  writeFileSync(join(cache, 'OTHER.mobileprovision'), JSON.stringify(profile('OTHER', 'com.example.Other', T0 - D, T0 + 5 * D)))
  mkdirSync(join(home, 'tmp'), { recursive: true })

  const ok = (stdout = '', extra: Partial<ExecResult> = {}): ExecResult => ({
    code: 0,
    stdout,
    stderrTail: '',
    tail: stdout,
    timedOut: false,
    idledOut: false,
    ...extra,
  })
  const failR = (text: string, code: number | null = 1, extra: Partial<ExecResult> = {}): ExecResult => ({
    code,
    stdout: '',
    stderrTail: text,
    tail: text,
    timedOut: false,
    idledOut: false,
    ...extra,
  })
  const jsonOut = (argv: string[], value: unknown) => {
    const i = argv.indexOf('--json-output')
    if (i >= 0) writeFileSync(argv[i + 1], JSON.stringify(value))
  }
  const get = (obj: unknown, key: string): unknown => {
    let cur: unknown = obj
    for (const part of key.split('.')) {
      if (cur == null || typeof cur !== 'object') return undefined
      cur = Array.isArray(cur) ? cur[Number(part)] : (cur as Record<string, unknown>)[part]
    }
    return cur
  }
  const writeProduct = (mode: BuildMode) => {
    const app = join(P.derivedData, 'Build', 'Products', 'Debug-iphoneos', 'HealthRelay.app')
    const wid = join(app, 'PlugIns', 'HealthRelayWidgets.appex')
    mkdirSync(wid, { recursive: true })
    w.mintCount++
    const n = w.mintCount
    let appP = profile(`NEW-APP-${n}`, APP, w.clock, w.clock + 7 * D)
    let widP = profile(`NEW-WID-${n}`, WIDGET, w.clock, w.clock + 7 * D)
    if (mode === 'stale') {
      appP = profile('OLD-APP', APP, T0 - 128 * H, T0 + 40 * H)
    }
    if (mode === 'nodevice') {
      appP = profile(`NEW-APP-${n}`, APP, w.clock, w.clock + 7 * D, ['00000000-0000000000000099'])
    }
    writeFileSync(join(app, 'embedded.mobileprovision'), JSON.stringify(appP))
    writeFileSync(join(wid, 'embedded.mobileprovision'), JSON.stringify(widP))
    writeFileSync(join(app, 'Info.plist'), JSON.stringify({ CFBundleShortVersionString: '0.17.4', CFBundleVersion: '7' }))
    if (w.intentsMetadata) {
      mkdirSync(join(app, 'Metadata.appintents'), { recursive: true })
      writeFileSync(join(app, 'Metadata.appintents', 'extract.actionsdata'), '{"actions":{"LogMoneyNotificationIntent":{}}}')
    }
    // Xcode drops the freshly minted profiles into its cache too.
    writeFileSync(join(cache, `${appP.UUID}.mobileprovision`), JSON.stringify(appP))
  }

  const exec: ExecFn = async (argv) => {
    w.calls.push(argv)
    const [bin, ...a] = argv
    if (bin === '/usr/bin/security' && a[0] === 'cms') {
      const src = a[a.indexOf('-i') + 1]
      const out = a[a.indexOf('-o') + 1]
      try {
        JSON.parse(readFileSync(src, 'utf8'))
        cpSync(src, out)
        return ok()
      } catch {
        return failR('security: cms decode failed')
      }
    }
    if (bin === '/usr/bin/security' && a[0] === 'find-identity') {
      return ok(`  1) ${'A'.repeat(40)} "Apple Development: Placeholder (${TEAM})"\n     1 valid identities found\n`)
    }
    if (bin === '/usr/bin/plutil') {
      const key = a[1]
      const fmt = a[2]
      const file = a[a.length - 1]
      let doc: unknown
      try {
        doc = JSON.parse(readFileSync(file, 'utf8'))
      } catch {
        return failR('plutil: unreadable')
      }
      const v = get(doc, key)
      if (v === undefined) return failR(`No value at that key path`)
      if (fmt === 'xml1') {
        const items = (v as string[]).map((s) => `<string>${s}</string>`).join('')
        return ok(`<?xml version="1.0"?><plist><array>${items}</array></plist>\n`)
      }
      return ok(`${Array.isArray(v) ? v.length : String(v)}\n`)
    }
    if (bin === '/usr/bin/pgrep') return failR('', 1)
    if (bin === '/usr/bin/xcrun' && a[0] === '--find') return ok('/fake/xcodebuild\n')
    if (bin === '/fake/xcodebuild' && a[0] === '-version') return ok('Xcode 27.0\nBuild version 27A100\n')
    if (bin === '/fake/xcodebuild') {
      const m = w.build
      if (m === 'timeout') return failR('', null, { timedOut: true })
      if (typeof m === 'object') return failR(m.fail, 65)
      if (m === 'noproduct') return ok('** BUILD SUCCEEDED **\n')
      writeProduct(m)
      return ok('** BUILD SUCCEEDED **\n')
    }
    if (bin === '/usr/bin/defaults') {
      return w.account
        ? ok('{\n    "IDE.Identifiers.Prod" =     (\n                {\n            identifier = placeholder;\n        }\n    );\n}\n')
        : ok('{\n    "IDE.Prod" =     (\n    );\n}\n')
    }
    if (bin === '/usr/bin/pmset') return ok("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t80%; charged\n")
    if (bin === '/usr/bin/codesign' && a[0] === '-d') {
      const prefix = a[1].slice('--extract-certificates='.length)
      writeFileSync(`${prefix}0`, 'fake-cert-der')
      return ok()
    }
    if (bin === '/usr/bin/codesign' && a[0] === '--verify') return ok()
    if (bin === '/usr/bin/openssl') return ok('notAfter=Nov 16 03:29:47 2027 GMT\n')
    if (bin === '/usr/bin/ditto') {
      mkdirSync(dirname(a[1]), { recursive: true })
      cpSync(a[0], a[1], { recursive: true })
      return ok()
    }
    if (bin === '/usr/bin/xcrun' && a[0] === 'devicectl') {
      const sub = a.slice(1, 4).join(' ')
      if (sub.startsWith('list devices')) {
        if (w.devices === 'none') {
          jsonOut(argv, { info: { outcome: 'success' }, result: { devices: [] } })
          return ok()
        }
        jsonOut(argv, {
          info: { outcome: 'success' },
          result: {
            devices: [
              {
                identifier: 'AAAAAAAA-0000-0000-0000-000000000001',
                hardwareProperties: { udid: UDID, reality: 'physical', platform: 'iOS' },
                connectionProperties: { pairingState: 'paired', transportType: 'localNetwork', tunnelState: 'disconnected' },
              },
            ],
          },
        })
        return ok()
      }
      if (sub.startsWith('device info lockState')) {
        const result =
          w.lock === 'weird'
            ? { mystery: 1 }
            : w.lock === 'locked'
              ? { passcodeRequired: true, unlockedSinceBoot: false } // before first unlock: unambiguous
              : { deviceIdentifier: 'AAAAAAAA-0000-0000-0000-000000000009', passcodeRequired: true, unlockedSinceBoot: true } // the real observed shape
        jsonOut(argv, { info: { outcome: 'success' }, result })
        return ok()
      }
      if (sub.startsWith('device install app')) {
        if (w.install === 'locked') return failR('ERROR: The device is locked. Unlock the device and try again.')
        if (w.install === 'exit0_no_text') return ok('nothing useful\n')
        if (w.install === 'unknown_error') return failR('ERROR: Something odd (error 99999)')
        jsonOut(argv, { info: { outcome: 'success' }, result: { installedApplications: [{ bundleID: APP }] } })
        const app = argv[argv.length - 1]
        w.installedExpiry = JSON.parse(readFileSync(join(app, 'embedded.mobileprovision'), 'utf8')).ExpirationDate
        return ok(`App installed:\n• bundleID: ${APP}\n`)
      }
      if (sub.startsWith('device info apps')) {
        jsonOut(argv, { info: { outcome: 'success' }, result: { apps: [] } })
        return ok()
      }
      if (sub.startsWith('device process launch')) {
        if (w.launch === 'untrusted') {
          return failR(`ERROR: Unable to launch ${APP} because it has an invalid code signature, inadequate entitlements or its profile has not been explicitly trusted by the user.`)
        }
        jsonOut(argv, { info: { outcome: 'success' }, result: {} })
        return ok()
      }
    }
    return failR(`unexpected command: ${argv.join(' ')}`, 127)
  }

  const deps: RunnerDeps = {
    paths: P,
    exec,
    now: () => w.clock,
    localHour: () => w.hour,
    sleep: async (ms) => {
      w.clock += ms
    },
    preflight: async () => {
      if (w.pfQueue.length) return w.pfQueue.shift()!
      if (!w.pf) return null
      if (w.phoneConfirms && w.installedExpiry) {
        const t = Date.parse(w.installedExpiry)
        return { ...w.pf, signed_until: w.installedExpiry, hours_left: Math.round(((t - w.clock) / H) * 10) / 10, phone_hello_at: iso(w.clock) }
      }
      return w.pf
    },
    loadConfig: () => w.cfg,
    readDbClock: () => null,
    keepAwake: () => () => {},
    liveChildren: () => [],
    killTree: async () => {},
    tmpDir: join(home, 'tmp'),
  }
  const run = (opts: RunOptions = {}) => runResign({ ignoreFlags: false, ...opts }, deps)
  const state = () => readState(P.stateFile)!
  const cached = () => readdirSync(cache).sort()
  const ran = (pred: (argv: string[]) => boolean) => w.calls.filter(pred)
  const isBuild = (argv: string[]) => argv[0] === '/fake/xcodebuild' && argv.includes('build')
  const isInstall = (argv: string[]) => argv[1] === 'devicectl' && argv[2] === 'device' && argv[3] === 'install'
  const isLaunch = (argv: string[]) => argv[1] === 'devicectl' && argv[3] === 'process'
  return { home, P, w, deps, run, state, cached, ran, isBuild, isInstall, isLaunch }
}

describe('runner: bundle completeness (Nov 16 2026: Money shortcut lost)', () => {
  test('a build without Metadata.appintents is never installed: hard build_incomplete, profiles restored', async () => {
    const t = setup({ intentsMetadata: false })
    const r = await t.run()
    expect(r.class).toBe('build_incomplete')
    expect(r.hard).toBe(true)
    expect(t.ran(t.isInstall)).toHaveLength(0)
    // The originals are back in Xcode's cache.
    expect(t.cached()).toContain('OLD-APP.mobileprovision')
    expect(t.cached()).toContain('OLD-WID.mobileprovision')
  })

  test('every build is clean: the whole DerivedData is wiped first, not just Products', async () => {
    const t = setup()
    const sentinel = join(t.P.derivedData, 'Build', 'Intermediates.noindex', 'stale-link-info.dat')
    mkdirSync(join(t.P.derivedData, 'Build', 'Intermediates.noindex'), { recursive: true })
    writeFileSync(sentinel, 'x')
    const r = await t.run()
    expect(r.outcome).toBe('confirmed')
    expect(existsSync(sentinel)).toBe(false)
  })

  test('a staged build without intents metadata is not reused: it rebuilds', async () => {
    const t = setup()
    expect((await t.run({ buildOnly: true, forced: true })).outcome).toBe('staged')
    const cur = JSON.parse(readFileSync(t.P.stagingCurrent, 'utf8'))
    rmSync(join(t.P.staging, cur.run_id, 'HealthRelay.app', 'Metadata.appintents'), { recursive: true, force: true })
    t.w.clock += 60_000
    const r = await t.run()
    expect(r.notes.some((n) => n.includes('no Metadata.appintents'))).toBe(true)
    expect(t.ran(t.isBuild)).toHaveLength(2)
    expect(r.outcome).toBe('confirmed')
  })
})

describe('runner: staged build vs a replaced snapshot (review v0.18.0)', () => {
  test('a manual install that swaps the snapshot (same version) makes the old staged build unusable', async () => {
    const t = setup()
    expect((await t.run({ buildOnly: true, forced: true })).outcome).toBe('staged')
    // build-phone.sh install replaced the snapshot: same "0.17.4 (7)", new content.
    const src = JSON.parse(readFileSync(t.P.sourceJson, 'utf8'))
    writeFileSync(t.P.sourceJson, JSON.stringify({ ...src, content_sha256: 'f'.repeat(64), captured_at: iso(t.w.clock) }))
    t.w.clock += 60_000
    const r = await t.run()
    expect(r.notes.some((n) => n.includes('built from another source snapshot'))).toBe(true)
    expect(t.ran(t.isBuild)).toHaveLength(2)
  })
})

describe('runner: happy path', () => {
  test('build, verify, stage, install, launch, confirm', async () => {
    const t = setup()
    const r = await t.run()
    expect(r.outcome).toBe('confirmed')
    // The xcodebuild argv: shared flags, pinned DerivedData, the snapshot project.
    const build = t.ran(t.isBuild)[0]
    for (const f of BUILD_FLAGS) expect(build).toContain(f)
    expect(build).toContain('-derivedDataPath')
    expect(build[build.indexOf('-derivedDataPath') + 1]).toBe(t.P.derivedData)
    expect(build[build.indexOf('-project') + 1]).toBe(t.P.sourceProject)
    expect(build).not.toContain('-quiet')
    // Old profiles stay in the backup (mint verified), other apps untouched.
    expect(t.cached()).toContain('OTHER.mobileprovision')
    expect(t.cached()).not.toContain('OLD-APP.mobileprovision')
    expect(t.cached()).not.toContain('OLD-WID.mobileprovision')
    const s = t.state()
    expect(s.last_success?.expiry).toBe(iso(T0 + 7 * D))
    expect(s.pending_confirm).toBeNull()
    expect(s.staged).toBeNull()
    expect(s.profiles_moved).toBeNull()
    expect(s.episode).toBeNull()
    expect(s.last_outcome).toBe('confirmed')
    expect(s.counters.attempts).toBe(0) // reset on success
    // Facts written, lock released.
    expect(readFileSync(t.P.logFile, 'utf8')).toContain('outcome=confirmed')
    expect(readFileSync(t.P.jsonlFile, 'utf8')).toContain('"outcome":"confirmed"')
    expect(existsSync(t.P.lockDir)).toBe(false)
    // The install went to the STAGED copy, by udid.
    const inst = t.ran(t.isInstall)[0]
    expect(inst).toContain(UDID)
    expect(inst[inst.length - 1].startsWith(t.P.staging)).toBe(true)
  })

  test('--build-only stops after staging; a later run installs the staged build without rebuilding', async () => {
    const t = setup()
    const r1 = await t.run({ buildOnly: true, forced: true })
    expect(r1.outcome).toBe('staged')
    expect(t.state().staged?.version).toBe(VERSION)
    expect(t.ran(t.isInstall)).toHaveLength(0)
    t.w.clock += H
    const r2 = await t.run()
    expect(r2.outcome).toBe('confirmed')
    expect(t.ran(t.isBuild)).toHaveLength(1)
  })

  test('disabled: heartbeat only, no external command', async () => {
    const t = setup()
    t.w.cfg = { ...t.w.cfg, enabled: false }
    const r = await t.run()
    expect(r.outcome).toBe('disabled')
    expect(t.w.calls).toHaveLength(0)
    const s = t.state()
    expect(s.enabled).toBe(false)
    expect(s.last_run_at).toBe(iso(T0))
  })

  test('a stale lock is taken over; only recorded xcodebuild/devicectl children are reaped', async () => {
    const t = setup({ pf: basePf({ hours_left: 100, signed_until: iso(T0 + 100 * H) }) })
    mkdirSync(t.P.lockDir, { recursive: true })
    const spawned = Date.parse('2026-11-19T01:00:00Z')
    writeFileSync(
      join(t.P.lockDir, 'owner.json'),
      JSON.stringify({
        pid: 999_999,
        started_at: iso(T0 - 2 * H),
        child_pids: [111, 222, 333, 444, 555],
        children: [111, 222, 333, 444].map((pid) => ({ pid, started_at: iso(spawned) })),
      }),
    )
    const comms: Record<number, { comm: string; command: string }> = {
      111: { comm: '/Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild', command: 'xcodebuild -project x build' },
      222: { comm: 'Safari', command: 'Safari' },
      333: { comm: '/usr/bin/xcrun', command: '/usr/bin/xcrun devicectl device install app' },
      444: { comm: '/Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild', command: 'xcodebuild (his own, later)' },
      555: { comm: '/Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild', command: 'xcodebuild (no recorded start)' },
    }
    t.deps.isAlive = (pid) => pid !== 999_999
    t.deps.commOf = async (pid) => comms[pid] ?? null
    // 444 is a pid that was REUSED by a later process (e.g. after a reboot).
    t.deps.processStart = (pid) => (pid === 444 ? spawned + 3 * H : spawned + 500)
    const killed: number[] = []
    t.deps.killTree = async (pid) => {
      killed.push(pid)
    }
    const r = await t.run()
    expect(r.outcome).toBe('noop')
    // Regression: never a reused pid (444), never one without a recorded start (555).
    expect(killed.sort()).toEqual([111, 333])
    expect(r.notes.join('\n')).toContain('pid 444 was reused')
    expect(r.notes.join('\n')).toContain('pid 555 has no recorded start time')
    expect(existsSync(t.P.lockDir)).toBe(false)
  })

  test('a LIVE owner is never displaced by age (regression: two minters at once)', async () => {
    const t = setup({ pf: basePf({ hours_left: 100, signed_until: iso(T0 + 100 * H) }) })
    mkdirSync(t.P.lockDir, { recursive: true })
    // build-phone.sh, alive and 3h old (e.g. parked on a keychain prompt).
    writeFileSync(join(t.P.lockDir, 'owner.json'), JSON.stringify({ pid: 4321, started_at: iso(T0 - 3 * H), child_pids: [], holder: 'build-phone' }))
    t.deps.isAlive = () => true
    t.deps.processStart = () => T0 - 3 * H - 5_000
    const r = await t.run()
    expect(r.outcome).toBe('busy')
    expect(t.w.calls).toHaveLength(0)
    expect(JSON.parse(readFileSync(join(t.P.lockDir, 'owner.json'), 'utf8')).pid).toBe(4321)
    // The same pid reused by a process that started after the lock: stale.
    t.deps.processStart = () => T0 - H
    expect((await t.run()).outcome).toBe('noop')
  })

  test('outside the window: noop', async () => {
    const t = setup({ pf: basePf({ hours_left: 100, signed_until: iso(T0 + 100 * H) }) })
    expect((await t.run()).outcome).toBe('noop')
    expect(t.ran(t.isBuild)).toHaveLength(0)
  })

  test('a held lock: busy, nothing runs, the holder keeps it', async () => {
    const t = setup()
    mkdirSync(t.P.lockDir, { recursive: true })
    writeFileSync(join(t.P.lockDir, 'owner.json'), JSON.stringify({ pid: process.pid, started_at: iso(T0 - 60_000), child_pids: [] }))
    // The holder started before its lock (injected: the real ps start time of
    // this test process is after the fixed T0, which read as pid reuse once
    // the wall clock passed Nov 20 2026).
    t.deps.processStart = () => T0 - H
    const r = await t.run()
    expect(r.outcome).toBe('busy')
    expect(t.w.calls).toHaveLength(0)
    expect(existsSync(join(t.P.lockDir, 'owner.json'))).toBe(true)
  })
})

describe('runner: restore on every failure path', () => {
  test('xcodebuild failure (account) restores the profiles and opens the breaker', async () => {
    const t = setup({ build: { fail: 'error: No Accounts: Add a new account in Accounts settings.\n** BUILD FAILED **' } })
    const r = await t.run()
    expect(r.outcome).toBe('failed')
    expect(r.class).toBe('account_broken')
    expect(t.cached()).toEqual(['OLD-APP.mobileprovision', 'OLD-WID.mobileprovision', 'OTHER.mobileprovision'])
    const s = t.state()
    expect(s.profiles_moved).toBeNull()
    expect(s.account_broken_at).toBe(iso(T0))
    expect(s.episode?.class).toBe('account_broken')
  })

  test('the account breaker: unforced runs skip for 20h, a forced run clears it', async () => {
    const t = setup({ build: { fail: 'error: No Accounts: Add a new account' } })
    await t.run()
    t.w.build = 'ok'
    t.w.clock += 2 * H
    const r2 = await t.run()
    expect(r2.reason).toBe('account_broken_cooloff')
    expect(t.ran(t.isBuild)).toHaveLength(1)
    t.w.clock += H
    const r3 = await t.run({ forced: true })
    expect(r3.outcome).toBe('confirmed')
    expect(t.state().account_broken_at).toBeNull()
  })

  test('no Xcode account at preflight: hard account_broken before any quarantine', async () => {
    const t = setup({ account: false })
    const r = await t.run()
    expect(r.class).toBe('account_broken')
    expect(t.cached()).toContain('OLD-APP.mobileprovision')
    expect(t.ran(t.isBuild)).toHaveLength(0)
  })

  test('verify failure (a reused cached profile): restore; soft once, hard on the 2nd in a row', async () => {
    const t = setup({ build: 'stale' })
    const r1 = await t.run()
    expect(r1.outcome).toBe('skipped')
    expect(r1.class).toBe('profile_not_fresh')
    expect(t.cached()).toContain('OLD-APP.mobileprovision')
    expect(t.cached()).toContain('OLD-WID.mobileprovision')
    expect(t.state().episode).toBeNull()
    t.w.clock += H
    const r2 = await t.run()
    expect(r2.outcome).toBe('failed')
    expect(r2.hard).toBe(true)
    expect(t.state().episode?.class).toBe('profile_not_fresh')
    expect(t.state().profiles_moved).toBeNull()
  })

  test('device missing from the minted profile: hard device_not_in_profile, restored', async () => {
    const t = setup({ build: 'nodevice' })
    const r = await t.run()
    expect(r.class).toBe('device_not_in_profile')
    expect(r.hard).toBe(true)
    expect(t.cached()).toContain('OLD-APP.mobileprovision')
  })

  test('build timeout: restore, wipe our DerivedData, prompt_hang', async () => {
    const t = setup({ build: 'timeout' })
    mkdirSync(join(t.P.derivedData, 'Logs'), { recursive: true })
    const r = await t.run()
    expect(r.class).toBe('prompt_hang')
    expect(existsSync(t.P.derivedData)).toBe(false)
    expect(t.cached()).toContain('OLD-APP.mobileprovision')
  })

  test('exit 0 with no product: restore, classified', async () => {
    const t = setup({ build: 'noproduct' })
    const r = await t.run()
    expect(r.outcome).toBe('failed')
    expect(r.class).toBe('other')
    expect(t.cached()).toContain('OLD-WID.mobileprovision')
  })
})

describe('runner: install phase', () => {
  test('locked and unreachable stay silent (soft, counted, no episode)', async () => {
    const t = setup({ lock: 'locked' })
    const r = await t.run()
    expect(r.outcome).toBe('skipped')
    expect(r.class).toBe('locked')
    expect(t.state().counters.locked).toBe(1)
    expect(t.state().episode).toBeNull()
    expect(t.ran(t.isInstall)).toHaveLength(0)

    t.w.lock = 'unlocked'
    t.w.devices = 'none'
    t.w.clock += 15 * 60_000
    const r2 = await t.run()
    expect(r2.class).toBe('unreachable')
    expect(t.state().counters.unreachable).toBe(1)
    expect(t.state().episode).toBeNull()
    // The staged build was reused, not rebuilt.
    expect(t.ran(t.isBuild)).toHaveLength(1)
  })

  test('the real lockState shape is unverified: the install is attempted, a locked phone fails it softly', async () => {
    const t = setup({ lock: 'unlocked', install: 'locked' })
    const r = await t.run()
    expect(r.outcome).toBe('skipped')
    expect(r.class).toBe('locked')
    expect(t.ran(t.isInstall)).toHaveLength(1)
    expect(t.state().episode).toBeNull()
    expect(r.notes.some((n) => n.includes('lockState unverified'))).toBe(true)
  })

  test('an unknown lockState shape is soft twice, lockstate_unparsed on the 3rd', async () => {
    const t = setup({ lock: 'weird' })
    expect((await t.run()).class).toBe('lockstate_unknown')
    t.w.clock += 15 * 60_000
    expect((await t.run()).class).toBe('lockstate_unknown')
    t.w.clock += 15 * 60_000
    const r = await t.run()
    expect(r.class).toBe('lockstate_unparsed')
    expect(r.hard).toBe(true)
    expect(existsSync(join(r.run_dir, 'lock.raw.txt'))).toBe(true)
  })

  test('a live session appearing at the second preflight blocks the install (TOCTOU)', async () => {
    const t = setup()
    t.w.pfQueue = [basePf(), basePf({ blocker: { reason: 'live_session', overridable: false } })]
    const r = await t.run()
    expect(r.outcome).toBe('skipped')
    expect(r.reason).toBe('blocked: live_session')
    expect(t.ran(t.isInstall)).toHaveLength(0)
    expect(t.state().counters.blocked.live_session).toBe(1)
  })

  test('a blocker at the first preflight skips before any device probe', async () => {
    const t = setup({ pf: basePf({ blocker: { reason: 'yield', overridable: true } }) })
    const r = await t.run()
    expect(r.reason).toBe('blocked: yield')
    expect(t.w.calls.some((a) => a[1] === 'devicectl')).toBe(false)
  })

  test('outside install hours: night (soft), the build still staged', async () => {
    const t = setup({ hour: 3 })
    const r = await t.run()
    expect(r.class).toBe('night')
    expect(t.state().staged).not.toBeNull()
    expect(t.state().counters.night).toBe(1)
  })

  test('exit 0 without App installed is install_failed, hard on the 3rd in a row', async () => {
    const t = setup({ install: 'exit0_no_text' })
    for (let i = 1; i <= 3; i++) {
      const r = await t.run()
      expect(r.class).toBe('install_failed')
      expect(r.hard).toBe(i === 3)
      t.w.clock += 15 * 60_000
    }
    expect(t.state().pending_confirm).toBeNull()
  })

  test('an install refused for a locked phone is soft locked', async () => {
    const t = setup({ install: 'locked' })
    const r = await t.run()
    expect(r.class).toBe('locked')
    expect(r.hard).toBe(false)
  })

  test('a failed launch is retried (relaunch only, never a reinstall) on the next run', async () => {
    const t = setup({ phoneConfirms: false })
    // First run: the launch fails softly (locked again after the install).
    const origExec = t.deps.exec!
    let failLaunch = true
    t.deps.exec = async (argv, o) => {
      if (failLaunch && t.isLaunch(argv)) {
        failLaunch = false
        t.w.calls.push(argv)
        return { code: 1, stdout: '', stderrTail: 'ERROR: The device is locked.', tail: 'ERROR: The device is locked.', timedOut: false, idledOut: false }
      }
      return origExec(argv, o)
    }
    const r1 = await t.run()
    expect(r1.class).toBe('locked')
    expect(t.state().pending_confirm?.launched).toBe(false)
    t.w.clock += 30 * 60_000
    const r2 = await t.run()
    expect(r2.outcome).toBe('installed_unconfirmed')
    expect(t.ran(t.isInstall)).toHaveLength(1)
    expect(t.ran(t.isLaunch)).toHaveLength(2)
    expect(t.state().pending_confirm?.launched).toBe(true)
  })

  test('confirm timeout leaves pending; no reinstall within 24h, no relaunch loop', async () => {
    const t = setup({ phoneConfirms: false })
    const r1 = await t.run()
    expect(r1.outcome).toBe('installed_unconfirmed')
    const p = t.state().pending_confirm!
    expect(p.expected_until).toBe(iso(T0 + 7 * D))
    expect(p.old_signed_until).toBe(iso(T0 + 40 * H))
    expect(p.launched).toBe(true)
    expect(t.ran(t.isInstall)).toHaveLength(1)

    t.w.clock += 2 * H
    const r2 = await t.run()
    expect(r2.outcome).toBe('installed_unconfirmed')
    expect(t.ran(t.isInstall)).toHaveLength(1) // NOT reinstalled
    expect(t.ran(t.isLaunch)).toHaveLength(1) // launched once already: wait for the hello
    expect(t.state().pending_confirm!.first_installed_at).toBe(p.first_installed_at)

    // The phone finally hellos with the new date: the next run confirms.
    t.w.phoneConfirms = true
    t.w.clock += H
    const r3 = await t.run()
    expect(['confirmed', 'noop']).toContain(r3.outcome)
    expect(t.state().pending_confirm).toBeNull()
    expect(t.state().last_success).not.toBeNull()
  })

  test('a hello after the install still reporting the old date: install_did_not_take', async () => {
    const t = setup({ phoneConfirms: false })
    await t.run()
    const first = Date.parse(t.state().pending_confirm!.first_installed_at)
    t.w.clock += H
    t.w.pf = basePf({ phone_hello_at: iso(first + 10 * 60_000), hours_left: 39 })
    await t.run()
    const s = t.state()
    expect(s.episode?.class).toBe('install_did_not_take')
    expect(s.last_hard_class).toBe('install_did_not_take')
  })

  test('an untrusted developer at launch is hard, the pending install stays', async () => {
    const t = setup({ launch: 'untrusted', phoneConfirms: false })
    const r = await t.run()
    expect(r.class).toBe('untrusted_developer')
    expect(r.hard).toBe(true)
    expect(t.state().pending_confirm?.launched).toBe(false)
  })

  test('daemon down: build phase only, install skipped as daemon_down', async () => {
    const t = setup({ pf: null })
    t.deps.readDbClock = () => ({ signed_until: iso(T0 + 40 * H), phone_app_version: VERSION, phone_hello_at: null })
    const r = await t.run()
    expect(r.class).toBe('daemon_down')
    expect(t.state().daemon_down).toBe(true)
    expect(t.state().staged).not.toBeNull()
    expect(t.ran(t.isInstall)).toHaveLength(0)
  })

  test('snapshot mismatch is hard; a fresh snapshot awaiting the hello is soft', async () => {
    const t = setup({ pf: basePf({ phone_app_version: '0.17.0 (5)' }) })
    const r = await t.run()
    expect(r.class).toBe('snapshot_mismatch')
    expect(r.hard).toBe(true)
    writeFileSync(t.P.sourceJson, JSON.stringify({ version: VERSION, captured_at: iso(t.w.clock - H) }))
    t.w.clock += 15 * 60_000
    const r2 = await t.run()
    expect(r2.class).toBe('awaiting_hello')
    expect(r2.hard).toBe(false)
    expect(t.ran(t.isBuild)).toHaveLength(0)
  })
})

describe('runner: watchdog and crash recovery', () => {
  test('the watchdog firing during confirm keeps pending_confirm', async () => {
    const t = setup({ phoneConfirms: false })
    t.deps.watchdogMs = 150
    t.deps.sleep = (ms) =>
      new Promise((r) => {
        t.w.clock += ms
        setTimeout(r, 40)
      })
    const killed: number[] = []
    t.deps.liveChildren = () => [4242]
    t.deps.killTree = async (pid) => {
      killed.push(pid)
    }
    const r = await t.run()
    expect(r.outcome).toBe('run_timeout')
    expect(killed).toEqual([4242])
    const s = t.state()
    expect(s.pending_confirm).not.toBeNull()
    expect(s.last_outcome).toBe('run_timeout')
    expect(s.streaks.run_timeout).toBe(1)
    expect(existsSync(t.P.lockDir)).toBe(false)
    await Bun.sleep(300) // let the abandoned main settle; it must not write
    expect(readState(t.P.stateFile)!.last_outcome).toBe('run_timeout')
  })

  function crashState(t: ReturnType<typeof setup>, mintVerified: boolean): void {
    const runId = '20261119-030000'
    const backup = join(t.P.profileBackups, runId)
    mkdirSync(backup, { recursive: true })
    const cache = t.P.profileDirs[0]
    // The crashed run had moved OLD-APP into the backup.
    cpSync(join(cache, 'OLD-APP.mobileprovision'), join(backup, 'OLD-APP.mobileprovision'))
    rmSync(join(cache, 'OLD-APP.mobileprovision'))
    writeFileSync(
      join(backup, 'manifest.json'),
      JSON.stringify({
        run_id: runId,
        created_at: iso(T0 - D),
        dir: backup,
        manifest_path: join(backup, 'manifest.json'),
        bundle_ids: [APP],
        moves: [{ from: join(cache, 'OLD-APP.mobileprovision'), to: join(backup, 'OLD-APP.mobileprovision'), uuid: 'OLD-APP', app_id: null, expiration_date: null, moved: true }],
        undecodable: [],
        complete: false,
      }),
    )
    const s: ResignState = {
      ...emptyState(),
      enabled: true,
      profiles_moved: { run_id: runId, backup_dir: backup, uuids: ['OLD-APP'], at: iso(T0 - D) },
      mint_verified: mintVerified ? { run_id: runId, at: iso(T0 - D) } : null,
    }
    writeState(t.P.stateFile, s)
  }

  test('crash recovery without a verified mint puts the originals back', async () => {
    const t = setup({ pf: basePf({ hours_left: 100, signed_until: iso(T0 + 100 * H) }) })
    crashState(t, false)
    const r = await t.run()
    expect(r.outcome).toBe('noop')
    expect(t.cached()).toContain('OLD-APP.mobileprovision')
    expect(t.state().profiles_moved).toBeNull()
  })

  test('crash recovery with a verified mint leaves the originals in the backup', async () => {
    const t = setup({ pf: basePf({ hours_left: 100, signed_until: iso(T0 + 100 * H) }) })
    crashState(t, true)
    await t.run()
    expect(t.cached()).not.toContain('OLD-APP.mobileprovision')
    expect(t.state().profiles_moved).toBeNull()
  })
})

describe('runner: dry run, plan, kick flags', () => {
  test('dry run: every read probe, lists what would move, mutates nothing', async () => {
    const t = setup()
    const before = t.cached()
    const r = await t.run({ dryRun: true })
    expect(r.outcome).toBe('dry_run')
    expect(t.cached()).toEqual(before)
    expect(t.ran(t.isBuild)).toHaveLength(0)
    expect(t.ran(t.isInstall)).toHaveLength(0)
    expect(t.ran(t.isLaunch)).toHaveLength(0)
    expect(r.notes.filter((n) => n.startsWith('would move'))).toHaveLength(2)
    expect(r.notes.some((n) => n.startsWith('lockState: unverified'))).toBe(true)
    const s = t.state()
    expect(s.dry_run).toBe(true)
    expect(s.staged).toBeNull()
    expect(s.counters.attempts).toBe(0)
  })

  test('plan: no lock, no state, no log line', async () => {
    const t = setup()
    const r = await t.run({ plan: true, ignoreFlags: true })
    expect(r.outcome).toBe('plan')
    expect(existsSync(t.P.stateFile)).toBe(false)
    expect(existsSync(t.P.logFile)).toBe(false)
    expect(r.notes.some((n) => n.startsWith('lockState'))).toBe(false)
    const r2 = await t.run({ plan: true, ignoreFlags: true, probeLock: true })
    expect(r2.notes.some((n) => n.startsWith('lockState'))).toBe(true)
  })

  test('kick flags are consumed once (force + build-only), stale ones dropped', async () => {
    const t = setup({ pf: basePf({ hours_left: 100, signed_until: iso(T0 + 100 * H) }) })
    mkdirSync(t.P.runtime, { recursive: true })
    writeFileSync(t.P.flagsFile, JSON.stringify({ trigger: 'kick', force: true, build_only: true, at: iso(T0 - 60_000) }))
    const r = await t.run()
    expect(r.trigger).toBe('kick')
    expect(r.outcome).toBe('staged')
    expect(existsSync(t.P.flagsFile)).toBe(false)

    writeFileSync(t.P.flagsFile, JSON.stringify({ trigger: 'kick', force: true, at: iso(T0 - 2 * H) }))
    t.w.clock += 15 * 60_000
    const r2 = await t.run()
    expect(r2.trigger).toBe('interval')
    expect(r2.outcome).toBe('noop')
  })
})

// ── Review regressions ─────────────────────────────────────────────

import { createHash } from 'crypto'

describe('runner: review regressions', () => {
  test('a forced run clears account_broken even when it ends busy (Xcode open)', async () => {
    const t = setup()
    writeState(t.P.stateFile, { ...emptyState(), enabled: true, account_broken_at: iso(T0 - H) })
    const orig = t.deps.exec!
    t.deps.exec = async (argv, o) => {
      if (argv[0] === '/usr/bin/pgrep' && argv[2] === 'Xcode') {
        t.w.calls.push(argv)
        return { code: 0, stdout: '123\n', stderrTail: '', tail: '123\n', timedOut: false, idledOut: false }
      }
      return orig(argv, o)
    }
    const r = await t.run({ forced: true })
    expect(r.outcome).toBe('skipped')
    expect(r.class).toBe('busy')
    expect(t.state().account_broken_at).toBeNull()
  })

  test('an unreadable signing certificate is treated as changed: no auto install above 12h', async () => {
    const t = setup()
    const sha = createHash('sha1').update('fake-cert-der').digest('hex').toUpperCase()
    writeState(t.P.stateFile, { ...emptyState(), enabled: true, last_success: { at: iso(T0 - 6 * D), expiry: iso(T0 + 40 * H), cert_sha1: sha } })
    const orig = t.deps.exec!
    t.deps.exec = async (argv, o) => {
      if (argv[0] === '/usr/bin/codesign' && argv[1] === '-d') {
        t.w.calls.push(argv)
        return { code: 1, stdout: '', stderrTail: 'codesign: failed', tail: 'codesign: failed', timedOut: false, idledOut: false }
      }
      return orig(argv, o)
    }
    const r = await t.run()
    expect(r.class).toBe('new_certificate')
    expect(r.reason).toContain('could not be read')
    expect(t.state().staged?.cert_changed).toBe(true)
    expect(t.ran(t.isInstall)).toHaveLength(0)
    // A readable, unchanged cert installs normally.
    const t2 = setup()
    writeState(t2.P.stateFile, { ...emptyState(), enabled: true, last_success: { at: iso(T0 - 6 * D), expiry: iso(T0 + 40 * H), cert_sha1: sha } })
    expect((await t2.run()).outcome).toBe('confirmed')
  })

  test('untrusted developer under 12h: ONE episode key across runs, no reinstall every 15 min', async () => {
    const t = setup({ launch: 'untrusted', phoneConfirms: false, pf: basePf({ hours_left: 6, signed_until: iso(T0 + 6 * H) }) })
    const sinces = new Set<string>()
    for (let i = 0; i < 3; i++) {
      const r = await t.run()
      expect(r.class).toBe('untrusted_developer')
      sinces.add(t.state().episode!.since)
      t.w.clock += 15 * 60_000
    }
    expect([...sinces]).toEqual([iso(T0)])
    expect(t.ran(t.isInstall)).toHaveLength(1)
    // Past the 2h critical floor, one reinstall, and STILL the same episode.
    t.w.clock += 2 * H
    await t.run()
    expect(t.ran(t.isInstall)).toHaveLength(2)
    expect(t.state().episode!.since).toBe(iso(T0))
  })

  test('after expiry, a build installed and launched is not reinstalled every run', async () => {
    const t = setup({ phoneConfirms: false, pf: basePf({ hours_left: -2, signed_until: iso(T0 - 2 * H) }) })
    for (let i = 0; i < 3; i++) {
      const r = await t.run()
      expect(r.outcome).toBe('installed_unconfirmed')
      t.w.clock += 15 * 60_000
    }
    t.w.clock += 5 * H
    expect((await t.run()).outcome).toBe('installed_unconfirmed')
    expect(t.ran(t.isInstall)).toHaveLength(1)
    expect(t.ran(t.isLaunch)).toHaveLength(1)
  })

  test('critical but not dead: at most one reinstall per 2h while the hello does not land', async () => {
    const t = setup({ phoneConfirms: false, pf: basePf({ hours_left: 6, signed_until: iso(T0 + 6 * H) }) })
    for (let i = 0; i < 6; i++) {
      await t.run()
      t.w.clock += 15 * 60_000
    }
    expect(t.ran(t.isInstall)).toHaveLength(1)
    t.w.clock += H
    await t.run()
    expect(t.ran(t.isInstall)).toHaveLength(2)
  })

  test('a hard class from a previous window never silences the same class in the next one', async () => {
    const t = setup({ build: { fail: 'error: No Accounts: Add a new account' } })
    await t.run()
    const first = t.state().episode!.since
    expect(t.state().episode!.class).toBe('account_broken')
    // Window closes (a manual install), then the next cycle breaks the same way.
    t.w.clock += 2 * D
    t.w.pf = basePf({ hours_left: 120, signed_until: iso(t.w.clock + 120 * H) })
    expect((await t.run()).outcome).toBe('noop')
    t.w.clock += 4 * D
    t.w.pf = basePf({ hours_left: 40, signed_until: iso(t.w.clock + 40 * H) })
    const r = await t.run()
    expect(r.class).toBe('account_broken')
    expect(t.state().episode!.since).not.toBe(first)
    expect(t.state().episode!.since).toBe(iso(t.w.clock))
  })

  test('a manual install (superseded) clears the episode', async () => {
    const t = setup({ phoneConfirms: false })
    await t.run()
    const first = Date.parse(t.state().pending_confirm!.first_installed_at)
    t.w.clock += H
    t.w.pf = basePf({ phone_hello_at: iso(first + 10 * 60_000), hours_left: 39 })
    await t.run()
    expect(t.state().episode?.class).toBe('install_did_not_take')
    t.w.clock += H
    t.w.pf = basePf({ signed_until: iso(t.w.clock + 100 * H), hours_left: 100, phone_hello_at: iso(t.w.clock) })
    await t.run()
    const s = t.state()
    expect(s.pending_confirm).toBeNull()
    expect(s.episode).toBeNull()
    expect(s.last_hard_class).toBeNull()
    expect(s.episode_since).toEqual({})
  })

  test('a manual install forgets the cert baseline: a hand-trusted cert never reads as changed', async () => {
    const t = setup()
    expect((await t.run()).outcome).toBe('confirmed')
    expect(t.state().last_success?.cert_sha1).not.toBeNull()
    // He installs by hand (another, newer signature): superseded.
    t.w.clock += H
    t.w.pf = basePf({ signed_until: iso(t.w.clock + 100 * H), hours_left: 100, phone_hello_at: iso(t.w.clock) })
    // Leave a pending in place so reconcile sees the manual date as superseding it.
    const st0 = t.state()
    writeFileSync(t.P.stateFile, JSON.stringify({ ...st0, pending_confirm: { staged_run_id: 'x', first_installed_at: iso(t.w.clock - H), last_installed_at: iso(t.w.clock - H), expected_until: iso(t.w.clock + 7 * D), version: VERSION, old_signed_until: iso(T0 + 40 * H) } }))
    await t.run()
    expect(t.state().last_success?.cert_sha1).toBeNull()
  })

  test('install_did_not_take keeps ONE since even when another hard class takes the slot', async () => {
    const t = setup({ phoneConfirms: false })
    await t.run()
    const first = Date.parse(t.state().pending_confirm!.first_installed_at)
    t.w.pf = basePf({ phone_hello_at: iso(first + 10 * 60_000), hours_left: 39 })
    // Relaunch path: devicectl list fails hard every run after the reconcile.
    t.w.clock += H
    const orig = t.deps.exec!
    t.deps.exec = async (argv, o) => {
      if (argv[1] === 'devicectl' && argv[2] === 'list') {
        t.w.calls.push(argv)
        return { code: 1, stdout: '', stderrTail: 'ERROR: CoreDeviceService was unable to locate a device', tail: 'ERROR: CoreDeviceService timed out', timedOut: false, idledOut: false }
      }
      return orig(argv, o)
    }
    const sinces = new Set<string>()
    const classes: string[] = []
    for (let i = 0; i < 3; i++) {
      // pending_confirm.launched is true, so the gate stops before probes;
      // force it back to false to drive the relaunch-only path.
      const s = t.state()
      writeState(t.P.stateFile, { ...s, pending_confirm: { ...s.pending_confirm!, launched: false } })
      await t.run()
      const st = t.state()
      sinces.add(st.episode_since.install_did_not_take)
      classes.push(st.episode!.class)
      t.w.clock += 15 * 60_000
    }
    expect(sinces.size).toBe(1)
    // The slot really alternated: another hard class held it at each run's end.
    expect(classes).toEqual(['devicectl_unreachable', 'devicectl_unreachable', 'devicectl_unreachable'])
  })

  test('the watchdog winning stops the main flow: nothing spawns or stages afterwards', async () => {
    const t = setup()
    t.deps.watchdogMs = 80
    const orig = t.deps.exec!
    t.deps.exec = async (argv, o) => {
      if (t.isBuild(argv)) await Bun.sleep(250)
      return orig(argv, o)
    }
    const r = await t.run()
    expect(r.outcome).toBe('run_timeout')
    const n = t.w.calls.length
    await Bun.sleep(400) // the abandoned main settles
    const after = t.w.calls.slice(n)
    expect(after.some((a) => a[0] === '/usr/bin/codesign' || a[0] === '/usr/bin/ditto' || a[1] === 'devicectl')).toBe(false)
    expect(existsSync(t.P.stagingCurrent)).toBe(false)
    expect(t.cached()).toContain('OLD-APP.mobileprovision')
  })

  test('crash recovery runs even while disabled', async () => {
    const t = setup()
    const runId = '20261119-030000'
    const backup = join(t.P.profileBackups, runId)
    mkdirSync(backup, { recursive: true })
    const cache = t.P.profileDirs[0]
    cpSync(join(cache, 'OLD-APP.mobileprovision'), join(backup, 'OLD-APP.mobileprovision'))
    rmSync(join(cache, 'OLD-APP.mobileprovision'))
    writeFileSync(
      join(backup, 'manifest.json'),
      JSON.stringify({
        run_id: runId,
        created_at: iso(T0 - D),
        dir: backup,
        manifest_path: join(backup, 'manifest.json'),
        bundle_ids: [APP],
        moves: [{ from: join(cache, 'OLD-APP.mobileprovision'), to: join(backup, 'OLD-APP.mobileprovision'), uuid: 'OLD-APP', app_id: null, expiration_date: null, moved: true }],
        undecodable: [],
        complete: false,
      }),
    )
    writeState(t.P.stateFile, { ...emptyState(), profiles_moved: { run_id: runId, backup_dir: backup, uuids: ['OLD-APP'], at: iso(T0 - D) } })
    t.w.cfg = { ...t.w.cfg, enabled: false }
    const r = await t.run()
    expect(r.outcome).toBe('disabled')
    expect(t.cached()).toContain('OLD-APP.mobileprovision')
    expect(t.state().profiles_moved).toBeNull()
    expect(t.w.calls).toHaveLength(0)
  })

  test('a build-phone.sh that died mid-quarantine (active marker) is recovered; finished ones are not', async () => {
    const t = setup({ pf: basePf({ hours_left: 100, signed_until: iso(T0 + 100 * H) }) })
    const cache = t.P.profileDirs[0]
    const dead = join(t.P.profileBackups, '20261119-020000-build-phone')
    const done = join(t.P.profileBackups, '20261118-020000-build-phone')
    for (const d of [dead, done]) mkdirSync(d, { recursive: true })
    cpSync(join(cache, 'OLD-APP.mobileprovision'), join(dead, 'OLD-APP.mobileprovision'))
    rmSync(join(cache, 'OLD-APP.mobileprovision'))
    writeFileSync(join(dead, 'moves.tsv'), `${join(cache, 'OLD-APP.mobileprovision')}\t${join(dead, 'OLD-APP.mobileprovision')}\n`)
    writeFileSync(join(dead, 'active'), '')
    // A finished run (minted fresh: originals deliberately left in the backup).
    writeFileSync(join(done, 'GONE.mobileprovision'), '{}')
    writeFileSync(join(done, 'moves.tsv'), `${join(cache, 'GONE.mobileprovision')}\t${join(done, 'GONE.mobileprovision')}\n`)
    const r = await t.run()
    expect(r.outcome).toBe('noop')
    expect(t.cached()).toContain('OLD-APP.mobileprovision')
    expect(existsSync(join(dead, 'active'))).toBe(false)
    expect(t.cached()).not.toContain('GONE.mobileprovision')
    expect(existsSync(join(done, 'GONE.mobileprovision'))).toBe(true)
  })
})
