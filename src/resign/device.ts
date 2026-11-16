// Thin devicectl wrappers for the auto re-sign runner. Each one runs a single
// `xcrun devicectl` command with devicectl's own --timeout PLUS an outer wall
// timeout from exec() (devicectl's limit does not cover a wedged
// CoreDevice XPC call), writes its JSON to a file in the run dir, and returns
// the raw facts. Interpretation (which device, locked or not, which failure
// class) lives in policy.ts.

import { existsSync, readFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { exec as realExec, type ExecFn } from './exec.js'
import { readJsonFile } from './state.js'

/** Outer wall timeouts, each above devicectl's own --timeout. */
export const DEVICE_TIMEOUTS = {
  list: { inner: 20, outerMs: 30_000 },
  lockState: { inner: 20, outerMs: 30_000 },
  install: { inner: 150, outerMs: 180_000 },
  appInfo: { inner: 20, outerMs: 30_000 },
  launch: { inner: 30, outerMs: 45_000 },
} as const

export interface DeviceCallResult {
  /** Exit 0 and no timeout. Says nothing about what the JSON means. */
  ok: boolean
  code: number | null
  /** The parsed --json-output file, when devicectl wrote valid JSON. */
  json?: unknown
  /** stdout + stderr tail, for classifiers and logs. */
  text: string
  stdout: string
  timedOut: boolean
  /** Where the JSON was written (kept for the run dir record). */
  jsonPath: string
}

export interface InstallResult extends DeviceCallResult {
  /** The ONLY success signal: 'App installed' in the output AND the JSON
   *  names the bundle id. An exit 0 alone is not an install. */
  installed: boolean
}

export interface DeviceDeps {
  exec?: ExecFn
}

const XCRUN = '/usr/bin/xcrun'

/** undefined when absent or unreadable (callers distinguish "no JSON"). */
function readJson(path: string): unknown {
  return readJsonFile(path) ?? undefined
}

function clear(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path)
  } catch {
    // stale file stays; readJson may then see last run's JSON, so callers
    // always pass a per-run dir
  }
}

async function run(
  args: string[],
  jsonPath: string,
  outerMs: number,
  deps: DeviceDeps,
): Promise<DeviceCallResult> {
  const exec = deps.exec ?? realExec
  clear(jsonPath)
  const r = await exec([XCRUN, 'devicectl', ...args], { timeoutMs: outerMs })
  const text = [r.stdout, r.stderrTail].filter(Boolean).join('\n')
  const json = readJson(jsonPath)
  return {
    ok: r.code === 0 && !r.timedOut,
    code: r.code,
    ...(json === undefined ? {} : { json }),
    text: text || r.tail,
    stdout: r.stdout,
    timedOut: r.timedOut,
    jsonPath,
  }
}

/** True when any string value anywhere in the JSON equals s. */
export function jsonMentions(value: unknown, s: string, depth = 0): boolean {
  if (depth > 32) return false
  if (typeof value === 'string') return value === s
  if (Array.isArray(value)) return value.some((v) => jsonMentions(v, s, depth + 1))
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some((v) => jsonMentions(v, s, depth + 1))
  }
  return false
}

/** `devicectl list devices` into runDir/devices.json. */
export function listDevices(runDir: string, deps: DeviceDeps = {}): Promise<DeviceCallResult> {
  const t = DEVICE_TIMEOUTS.list
  const jsonPath = join(runDir, 'devices.json')
  return run(['list', 'devices', '--timeout', String(t.inner), '--json-output', jsonPath], jsonPath, t.outerMs, deps)
}

/** `devicectl device info lockState` into runDir/lock.json. */
export function lockState(udid: string, runDir: string, deps: DeviceDeps = {}): Promise<DeviceCallResult> {
  const t = DEVICE_TIMEOUTS.lockState
  const jsonPath = join(runDir, 'lock.json')
  return run(
    ['device', 'info', 'lockState', '--device', udid, '--timeout', String(t.inner), '--json-output', jsonPath],
    jsonPath,
    t.outerMs,
    deps,
  )
}

/** `devicectl device install app` into runDir/install.json. */
export async function install(
  udid: string,
  appPath: string,
  bundleId: string,
  runDir: string,
  deps: DeviceDeps = {},
): Promise<InstallResult> {
  const t = DEVICE_TIMEOUTS.install
  const jsonPath = join(runDir, 'install.json')
  const r = await run(
    ['device', 'install', 'app', '--device', udid, '--timeout', String(t.inner), '--json-output', jsonPath, appPath],
    jsonPath,
    t.outerMs,
    deps,
  )
  const installed = r.ok && r.stdout.includes('App installed') && jsonMentions(r.json, bundleId)
  return { ...r, installed }
}

/** `devicectl device info apps --bundle-id` into runDir/apps.json. */
export function appInfo(udid: string, bundleId: string, runDir: string, deps: DeviceDeps = {}): Promise<DeviceCallResult> {
  const t = DEVICE_TIMEOUTS.appInfo
  const jsonPath = join(runDir, 'apps.json')
  return run(
    [
      'device',
      'info',
      'apps',
      '--device',
      udid,
      '--bundle-id',
      bundleId,
      '--timeout',
      String(t.inner),
      '--json-output',
      jsonPath,
    ],
    jsonPath,
    t.outerMs,
    deps,
  )
}

/** `devicectl device process launch --terminate-existing` into
 *  runDir/launch.json. */
export function launch(udid: string, bundleId: string, runDir: string, deps: DeviceDeps = {}): Promise<DeviceCallResult> {
  const t = DEVICE_TIMEOUTS.launch
  const jsonPath = join(runDir, 'launch.json')
  return run(
    [
      'device',
      'process',
      'launch',
      '--device',
      udid,
      '--terminate-existing',
      '--timeout',
      String(t.inner),
      '--json-output',
      jsonPath,
      bundleId,
    ],
    jsonPath,
    t.outerMs,
    deps,
  )
}
