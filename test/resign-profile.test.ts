import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { basename, join } from 'path'
import { exec as realExec, type ExecFn } from '../src/resign/exec.js'
import {
  appIdMatches,
  decodePlistFile,
  decodeProfile,
  listProfiles,
  parseXmlStringArray,
  quarantine,
  readManifest,
  restore,
  findOurProfiles,
} from '../src/resign/profile.js'

// Placeholder ids only: no real team, device or profile values.
const TEAM = 'ABCDE12345'
const DEV1 = '00000000-0000000000000001'
const DEV2 = '00000000-0000000000000002'

function profilePlist(o: { uuid: string; appId: string; devices?: string[]; created?: string; expires?: string }): string {
  const devices = (o.devices ?? [DEV1, DEV2]).map((d) => `\t\t<string>${d}</string>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>AppIDName</key>
\t<string>XC Test App</string>
\t<key>CreationDate</key>
\t<date>${o.created ?? '2026-11-16T03:29:47Z'}</date>
\t<key>DeveloperCertificates</key>
\t<array>
\t\t<data>
\t\tTUlJQ0VUQ0NBYm1nQXdJQkFnSUJBVEFOQmdrcWhraUc5dzBCQVFzRkFEQVNNUkF3RGdZRFZRUUREQWR3
\t\tYkdGalpXaHZiR1JsY2c9PQ==
\t\t</data>
\t</array>
\t<key>Entitlements</key>
\t<dict>
\t\t<key>application-identifier</key>
\t\t<string>${o.appId}</string>
\t\t<key>get-task-allow</key>
\t\t<true/>
\t</dict>
\t<key>ExpirationDate</key>
\t<date>${o.expires ?? '2026-11-23T03:29:47Z'}</date>
\t<key>Name</key>
\t<string>iOS Team Provisioning Profile: ${o.appId.replace(/^[^.]+\./, '')}</string>
\t<key>ProvisionedDevices</key>
\t<array>
${devices}
\t</array>
\t<key>TeamIdentifier</key>
\t<array>
\t\t<string>${TEAM}</string>
\t</array>
\t<key>UUID</key>
\t<string>${o.uuid}</string>
</dict>
</plist>
`
}

/** Real exec for everything except `security cms -D`, which (for these
 *  unsigned synthetic profiles holding plain XML) becomes a copy. The real
 *  plutil path still runs on every key. */
function fakeCms(onCms?: (input: string) => void): ExecFn {
  return async (argv, opts) => {
    if (argv[0].endsWith('security') && argv[1] === 'cms') {
      const input = argv[argv.indexOf('-i') + 1]
      const output = argv[argv.indexOf('-o') + 1]
      onCms?.(input)
      const text = readFileSync(input, 'utf8')
      if (!text.includes('<plist')) {
        return { code: 1, stdout: '', stderrTail: 'security: failed to decode message', tail: 'security: failed to decode message', timedOut: false, idledOut: false }
      }
      copyFileSync(input, output)
      return { code: 0, stdout: '', stderrTail: '', tail: '', timedOut: false, idledOut: false }
    }
    return realExec(argv, opts)
  }
}

let root: string
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'health-resign-profile-'))
})
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

function fresh(name: string): string {
  const d = join(root, name)
  mkdirSync(d, { recursive: true })
  return d
}

describe('decodePlistFile: the real plutil path', () => {
  test('reads every key from a plist holding <date> and <data>', async () => {
    const d = fresh('decode')
    const p = join(d, 'p.plist')
    writeFileSync(p, profilePlist({ uuid: 'aaaaaaaa-0000-0000-0000-000000000001', appId: `${TEAM}.com.example.App` }))
    const r = await decodePlistFile(p)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.profile.uuid).toBe('aaaaaaaa-0000-0000-0000-000000000001')
    expect(r.profile.creationDate).toBe('2026-11-16T03:29:47Z')
    expect(r.profile.expirationDate).toBe('2026-11-23T03:29:47Z')
    expect(Number.isFinite(Date.parse(r.profile.expirationDate!))).toBe(true)
    expect(r.profile.teamId).toBe(TEAM)
    expect(r.profile.appId).toBe(`${TEAM}.com.example.App`)
    expect(r.profile.name).toBe('iOS Team Provisioning Profile: com.example.App')
    expect(r.profile.devices).toEqual([DEV1, DEV2])
  })

  test('the json trap the design rules out really is a trap', async () => {
    const d = fresh('trap')
    const p = join(d, 'p.plist')
    writeFileSync(p, profilePlist({ uuid: 'aaaaaaaa-0000-0000-0000-000000000002', appId: `${TEAM}.com.example.App` }))
    const r = await realExec(['/usr/bin/plutil', '-convert', 'json', '-o', '-', p], { timeoutMs: 10_000 })
    expect(r.code).not.toBe(0)
  })

  test('absent optional keys come back null / empty, missing UUID is an error', async () => {
    const d = fresh('sparse')
    const p = join(d, 'p.plist')
    writeFileSync(
      p,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>UUID</key><string>u-1</string></dict></plist>
`,
    )
    const r = await decodePlistFile(p)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.profile.expirationDate).toBeNull()
      expect(r.profile.appId).toBeNull()
      expect(r.profile.devices).toEqual([])
    }
    const q = join(d, 'q.plist')
    writeFileSync(q, `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict/></plist>\n`)
    const bad = await decodePlistFile(q)
    expect(bad.ok).toBe(false)
    expect((await decodePlistFile(join(d, 'missing.plist'))).ok).toBe(false)
  })

  test('parseXmlStringArray unescapes entities and ignores non-arrays', () => {
    expect(parseXmlStringArray('<plist><array><string> a&amp;b </string><string>c</string></array></plist>')).toEqual(['a&b', 'c'])
    expect(parseXmlStringArray('<plist><string>x</string></plist>')).toEqual([])
  })
})

describe('decodeProfile: the cms step (injected)', () => {
  test('passes the profile to security cms -D and decodes the output', async () => {
    const d = fresh('cms-ok')
    const prof = join(d, 'x.mobileprovision')
    writeFileSync(prof, profilePlist({ uuid: 'bbbbbbbb-0000-0000-0000-000000000001', appId: `${TEAM}.com.example.App` }))
    const seen: string[][] = []
    const base = fakeCms()
    const r = await decodeProfile(prof, {
      exec: async (argv, opts) => {
        seen.push(argv)
        return base(argv, opts)
      },
      tmpDir: d,
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.profile.path).toBe(prof)
      expect(r.profile.uuid).toBe('bbbbbbbb-0000-0000-0000-000000000001')
    }
    expect(seen[0].slice(0, 5)).toEqual(['/usr/bin/security', 'cms', '-D', '-i', prof])
    // Never the json conversion.
    expect(seen.some((a) => a.includes('json'))).toBe(false)
    // The temp decode dir is gone.
    expect(listProfiles(d)).toEqual([prof])
    expect(Bun.spawnSync(['/bin/ls', d]).stdout.toString().trim()).toBe('x.mobileprovision')
  })

  test('cms failure and timeout are errors, not throws', async () => {
    const d = fresh('cms-bad')
    const prof = join(d, 'y.mobileprovision')
    writeFileSync(prof, 'not a profile')
    const r = await decodeProfile(prof, { exec: fakeCms(), tmpDir: d })
    expect(r.ok).toBe(false)
    const t = await decodeProfile(prof, {
      exec: async () => ({ code: null, stdout: '', stderrTail: '', tail: '', timedOut: true, idledOut: false }),
      tmpDir: d,
    })
    expect(t.ok).toBe(false)
    if (!t.ok) expect(t.error).toContain('timed out')
  })
})

describe('appIdMatches', () => {
  const ids = ['com.s0nderlabs.HealthRelay', 'com.s0nderlabs.HealthRelay.widgets']
  test('team-prefixed match with a dot boundary', () => {
    expect(appIdMatches(`${TEAM}.com.s0nderlabs.HealthRelay`, ids)).toBe(true)
    expect(appIdMatches(`${TEAM}.com.s0nderlabs.HealthRelay.widgets`, ids)).toBe(true)
    expect(appIdMatches(`${TEAM}.com.s0nderlabs.HealthRelay.other`, ids)).toBe(false)
    expect(appIdMatches(`${TEAM}.xcom.s0nderlabs.HealthRelay`, ids)).toBe(false)
    expect(appIdMatches(`${TEAM}.com.other.App`, ids)).toBe(false)
    expect(appIdMatches(null, ids)).toBe(false)
  })
  test('with a team id, only that team matches', () => {
    expect(appIdMatches(`${TEAM}.com.s0nderlabs.HealthRelay`, ids, TEAM)).toBe(true)
    expect(appIdMatches(`ZZZZZ99999.com.s0nderlabs.HealthRelay`, ids, TEAM)).toBe(false)
  })
})

describe('quarantine / restore round trip (temp dirs only)', () => {
  const BUNDLES = ['com.s0nderlabs.HealthRelay', 'com.s0nderlabs.HealthRelay.widgets']

  function seed(dir: string, uuid: string, appId: string): string {
    const p = join(dir, `${uuid}.mobileprovision`)
    writeFileSync(p, profilePlist({ uuid, appId }))
    return p
  }

  test('moves only ours, manifest first, restore puts them back', async () => {
    const xcode = fresh('rt/xcode')
    const md = fresh('rt/mobiledevice')
    const backups = join(root, 'rt/backups')
    const app = seed(xcode, 'aaaa0001-0000-0000-0000-000000000000', `${TEAM}.com.s0nderlabs.HealthRelay`)
    const widget = seed(xcode, 'aaaa0002-0000-0000-0000-000000000000', `${TEAM}.com.s0nderlabs.HealthRelay.widgets`)
    const other = seed(xcode, 'aaaa0003-0000-0000-0000-000000000000', `${TEAM}.com.other.App`)
    const lookalike = seed(xcode, 'aaaa0004-0000-0000-0000-000000000000', `${TEAM}.xcom.s0nderlabs.HealthRelay`)
    const junk = join(xcode, 'junk.mobileprovision')
    writeFileSync(junk, 'garbage')
    const mdApp = seed(md, 'aaaa0005-0000-0000-0000-000000000000', `${TEAM}.com.s0nderlabs.HealthRelay`)

    const m = await quarantine([xcode, md, join(root, 'rt/absent')], BUNDLES, backups, '20261116-101500', {
      exec: fakeCms(),
      tmpDir: root,
    })
    expect(m.complete).toBe(true)
    expect(m.moves.map((x) => basename(x.from)).sort()).toEqual(
      [basename(app), basename(widget), basename(mdApp)].sort(),
    )
    expect(m.moves.every((x) => x.moved)).toBe(true)
    expect(m.undecodable.map((u) => u.path)).toEqual([junk])
    for (const p of [app, widget, mdApp]) expect(existsSync(p)).toBe(false)
    for (const p of [other, lookalike, junk]) expect(existsSync(p)).toBe(true)
    const onDisk = readManifest(join(backups, '20261116-101500', 'manifest.json'))
    expect(onDisk?.moves.length).toBe(3)
    for (const x of m.moves) expect(existsSync(x.to)).toBe(true)

    const r = restore(m.manifest_path)
    expect(r.restored.sort()).toEqual([app, widget, mdApp].sort())
    expect(r.keptExisting).toEqual([])
    for (const p of [app, widget, mdApp]) expect(existsSync(p)).toBe(true)
    expect(readManifest(m.manifest_path)?.restored_at).toBeTruthy()
    // Idempotent: a second restore moves nothing.
    const again = restore(m.manifest_path)
    expect(again.restored).toEqual([])
    expect(again.errors).toEqual([])
  })

  test('same-name collision: the existing file wins, the backup stays', async () => {
    const xcode = fresh('col/xcode')
    const backups = join(root, 'col/backups')
    const app = seed(xcode, 'cccc0001-0000-0000-0000-000000000000', `${TEAM}.com.s0nderlabs.HealthRelay`)
    const widget = seed(xcode, 'cccc0002-0000-0000-0000-000000000000', `${TEAM}.com.s0nderlabs.HealthRelay.widgets`)
    const m = await quarantine([xcode], BUNDLES, backups, 'run-col', { exec: fakeCms(), tmpDir: root })
    expect(m.moves.length).toBe(2)
    // Something (Xcode) put a file back under the app profile's name.
    writeFileSync(app, 'NEWER')
    const r = restore(m)
    expect(r.keptExisting).toEqual([app])
    expect(r.restored).toEqual([widget])
    expect(readFileSync(app, 'utf8')).toBe('NEWER')
    const appMove = m.moves.find((x) => x.from === app)!
    expect(existsSync(appMove.to)).toBe(true)
    expect(appMove.restore).toBe('kept_existing')
  })

  test('a failure mid-quarantine leaves a manifest that restores exactly what moved', async () => {
    const a = fresh('crash/a')
    const b = fresh('crash/b')
    const backups = join(root, 'crash/backups')
    const fromA = seed(a, 'dddd0001-0000-0000-0000-000000000000', `${TEAM}.com.s0nderlabs.HealthRelay`)
    const fromB = seed(b, 'dddd0002-0000-0000-0000-000000000000', `${TEAM}.com.s0nderlabs.HealthRelay.widgets`)
    // After dir b is decoded, make it read-only so the move out of it fails.
    const exec = fakeCms((input) => {
      if (input === fromB) setTimeout(() => chmodSync(b, 0o555), 0)
    })
    let threw = false
    try {
      await quarantine([a, b], BUNDLES, backups, 'run-crash', { exec, tmpDir: root })
    } catch {
      threw = true
    } finally {
      chmodSync(b, 0o755)
    }
    expect(threw).toBe(true)
    const m = readManifest(join(backups, 'run-crash', 'manifest.json'))!
    expect(m.complete).toBe(false)
    expect(m.moves.find((x) => x.from === fromA)?.moved).toBe(true)
    expect(m.moves.find((x) => x.from === fromB)?.moved).toBe(false)
    expect(existsSync(fromA)).toBe(false)
    expect(existsSync(fromB)).toBe(true)
    const r = restore(m)
    expect(r.restored).toEqual([fromA])
    expect(existsSync(fromA)).toBe(true)
  })

  test('nothing ours: an empty manifest is still written', async () => {
    const xcode = fresh('none/xcode')
    seed(xcode, 'eeee0001-0000-0000-0000-000000000000', `${TEAM}.com.other.App`)
    const m = await quarantine([xcode], BUNDLES, join(root, 'none/backups'), 'run-none', { exec: fakeCms(), tmpDir: root })
    expect(m.moves).toEqual([])
    expect(existsSync(m.manifest_path)).toBe(true)
  })
})

describe('findOurProfiles (review v0.18.0)', () => {
  test('reads the app-id first and fully decodes only our profiles', async () => {
    const d = fresh('scan')
    writeFileSync(join(d, 'ours.mobileprovision'), profilePlist({ uuid: 'aaaaaaaa-0000-0000-0000-0000000000a1', appId: `${TEAM}.com.s0nderlabs.HealthRelay` }))
    writeFileSync(join(d, 'theirs.mobileprovision'), profilePlist({ uuid: 'aaaaaaaa-0000-0000-0000-0000000000a2', appId: `${TEAM}.com.example.Other` }))
    const calls: string[][] = []
    const base = fakeCms()
    const exec: ExecFn = async (argv, opts) => {
      calls.push(argv)
      return base(argv, opts)
    }
    const r = await findOurProfiles([d], ['com.s0nderlabs.HealthRelay', 'com.s0nderlabs.HealthRelay.widgets'], { exec, tmpDir: root })
    expect(r.matches.map((m) => m.uuid)).toEqual(['aaaaaaaa-0000-0000-0000-0000000000a1'])
    // Ours: 1 app-id read + 7 keys; theirs: the app-id read only.
    expect(calls.filter((c) => c[0].endsWith('plutil')).length).toBeLessThanOrEqual(9)
  })
})
