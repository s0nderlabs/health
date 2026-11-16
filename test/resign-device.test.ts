import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ExecFn, ExecOptions, ExecResult } from '../src/resign/exec.js'
import { DEVICE_TIMEOUTS, appInfo, install, jsonMentions, launch, listDevices, lockState } from '../src/resign/device.js'

// Injected exec only: nothing here talks to a real device. Placeholder ids.
const UDID = '00000000-0000000000000001'
const BUNDLE = 'com.s0nderlabs.HealthRelay'

let runDir: string
beforeAll(() => {
  runDir = mkdtempSync(join(tmpdir(), 'health-resign-device-'))
})
afterAll(() => {
  rmSync(runDir, { recursive: true, force: true })
})

interface Call {
  argv: string[]
  opts: ExecOptions
}

function fake(o: { stdout?: string; stderr?: string; code?: number | null; timedOut?: boolean; json?: unknown }): {
  exec: ExecFn
  calls: Call[]
} {
  const calls: Call[] = []
  const exec: ExecFn = async (argv, opts) => {
    calls.push({ argv, opts })
    const i = argv.indexOf('--json-output')
    if (o.json !== undefined && i >= 0) writeFileSync(argv[i + 1], JSON.stringify(o.json))
    const r: ExecResult = {
      code: o.timedOut ? null : (o.code ?? 0),
      stdout: o.stdout ?? '',
      stderrTail: o.stderr ?? '',
      tail: `${o.stdout ?? ''}${o.stderr ?? ''}`,
      timedOut: o.timedOut ?? false,
      idledOut: false,
    }
    return r
  }
  return { exec, calls }
}

describe('devicectl argv and timeouts', () => {
  test('list devices', async () => {
    const f = fake({ json: { result: { devices: [] } } })
    const r = await listDevices(runDir, { exec: f.exec })
    expect(f.calls[0].argv).toEqual([
      '/usr/bin/xcrun',
      'devicectl',
      'list',
      'devices',
      '--timeout',
      '20',
      '--json-output',
      join(runDir, 'devices.json'),
    ])
    expect(f.calls[0].opts.timeoutMs).toBe(DEVICE_TIMEOUTS.list.outerMs)
    expect(r.ok).toBe(true)
    expect(r.json).toEqual({ result: { devices: [] } })
  })

  test('lockState, appInfo, launch', async () => {
    const f = fake({ json: {} })
    await lockState(UDID, runDir, { exec: f.exec })
    await appInfo(UDID, BUNDLE, runDir, { exec: f.exec })
    await launch(UDID, BUNDLE, runDir, { exec: f.exec })
    const [l, a, p] = f.calls
    expect(l.argv.slice(2)).toEqual([
      'device', 'info', 'lockState', '--device', UDID, '--timeout', '20', '--json-output', join(runDir, 'lock.json'),
    ])
    expect(a.argv.slice(2, 9)).toEqual(['device', 'info', 'apps', '--device', UDID, '--bundle-id', BUNDLE])
    expect(p.argv.slice(2, 7)).toEqual(['device', 'process', 'launch', '--device', UDID])
    expect(p.argv).toContain('--terminate-existing')
    expect(p.argv[p.argv.length - 1]).toBe(BUNDLE)
    expect(l.opts.timeoutMs).toBe(30_000)
    expect(a.opts.timeoutMs).toBe(30_000)
    expect(p.opts.timeoutMs).toBe(45_000)
    // Every outer limit sits above devicectl's own.
    for (const t of Object.values(DEVICE_TIMEOUTS)) expect(t.outerMs).toBeGreaterThan(t.inner * 1000)
  })

  test('install: argv ends with the app path, outer limit 180s', async () => {
    const f = fake({ stdout: 'App installed:\n• bundleID: ' + BUNDLE, json: { result: { installedApplications: [{ bundleID: BUNDLE }] } } })
    const r = await install(UDID, '/staging/r1/HealthRelay.app', BUNDLE, runDir, { exec: f.exec })
    const argv = f.calls[0].argv
    expect(argv.slice(2, 8)).toEqual(['device', 'install', 'app', '--device', UDID, '--timeout'])
    expect(argv[8]).toBe('150')
    expect(argv[argv.length - 1]).toBe('/staging/r1/HealthRelay.app')
    expect(f.calls[0].opts.timeoutMs).toBe(180_000)
    expect(r.installed).toBe(true)
  })
})

describe('install success needs both signals', () => {
  test('exit 0 without "App installed" is not an install', async () => {
    const f = fake({ stdout: 'Something else happened', json: { result: { installedApplications: [{ bundleID: BUNDLE }] } } })
    const r = await install(UDID, '/x.app', BUNDLE, runDir, { exec: f.exec })
    expect(r.ok).toBe(true)
    expect(r.installed).toBe(false)
  })

  test('"App installed" without the bundle id in the JSON is not an install', async () => {
    const f = fake({ stdout: 'App installed:', json: { result: { installedApplications: [{ bundleID: 'com.other.App' }] } } })
    expect((await install(UDID, '/x.app', BUNDLE, runDir, { exec: f.exec })).installed).toBe(false)
    const g = fake({ stdout: 'App installed:' })
    expect((await install(UDID, '/x.app', BUNDLE, runDir, { exec: g.exec })).installed).toBe(false)
  })

  test('non-zero exit or a timeout is never an install', async () => {
    const bad = fake({ code: 1, stdout: 'App installed:', stderr: 'ERROR: device locked', json: { bundleID: BUNDLE } })
    const r = await install(UDID, '/x.app', BUNDLE, runDir, { exec: bad.exec })
    expect(r.ok).toBe(false)
    expect(r.installed).toBe(false)
    expect(r.text).toContain('device locked')
    const slow = fake({ timedOut: true })
    const t = await install(UDID, '/x.app', BUNDLE, runDir, { exec: slow.exec })
    expect(t.timedOut).toBe(true)
    expect(t.ok).toBe(false)
    expect(t.installed).toBe(false)
  })

  test('a stale JSON file from an earlier call is never read back', async () => {
    const path = join(runDir, 'install.json')
    writeFileSync(path, JSON.stringify({ bundleID: BUNDLE }))
    const f = fake({ stdout: 'App installed:' }) // writes no JSON this time
    const r = await install(UDID, '/x.app', BUNDLE, runDir, { exec: f.exec })
    expect(existsSync(path)).toBe(false)
    expect(r.json).toBeUndefined()
    expect(r.installed).toBe(false)
  })

  test('unparseable JSON is simply absent', async () => {
    const exec: ExecFn = async (argv) => {
      writeFileSync(argv[argv.indexOf('--json-output') + 1], '{not json')
      return { code: 0, stdout: '', stderrTail: '', tail: '', timedOut: false, idledOut: false }
    }
    const r = await lockState(UDID, runDir, { exec })
    expect(r.ok).toBe(true)
    expect(r.json).toBeUndefined()
  })
})

test('jsonMentions searches string values at any depth', () => {
  expect(jsonMentions({ a: [{ b: { c: BUNDLE } }] }, BUNDLE)).toBe(true)
  expect(jsonMentions({ [BUNDLE]: 1 }, BUNDLE)).toBe(false)
  expect(jsonMentions({ a: `${BUNDLE}.widgets` }, BUNDLE)).toBe(false)
  expect(jsonMentions(undefined, BUNDLE)).toBe(false)
})
