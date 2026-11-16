// Provisioning profiles for the auto re-sign runner: decode, quarantine,
// restore.
//
// DECODE. A .mobileprovision is a CMS-signed XML plist. `security cms -D`
// strips the signature into a temp plist, then `plutil -extract <key> raw`
// pulls one key at a time. NEVER `plutil -convert json`: it refuses any plist
// holding <date> or <data>, and every real profile holds both (CreationDate,
// ExpirationDate, DeveloperCertificates). Verified against real cached
// profiles: `raw` prints dates as ISO-8601 UTC ("2026-11-16T03:29:47Z"), and
// an array key prints its COUNT, so ProvisionedDevices is read as xml1.
//
// QUARANTINE. Before a re-sign build, our own cached profiles (and only ours,
// matched by application-identifier) are moved out of Xcode's cache so Xcode
// has to mint a fresh 7-day one. manifest.json is written BEFORE the first
// move and rewritten after each move, so a crash at any point leaves a record
// of exactly what is where. restore() puts them back and never overwrites a
// file Xcode wrote in the meantime: on a name collision the existing file is
// kept and the backup stays in the backup dir.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { basename, dirname, join } from 'path'
import { exec as realExec, type ExecFn } from './exec.js'
import { readJsonFile } from './state.js'

const CMS_TIMEOUT_MS = 10_000
const PLUTIL_TIMEOUT_MS = 10_000

export interface ProfileInfo {
  /** Absolute path of the source file (the .mobileprovision or plist). */
  path: string
  uuid: string
  name: string | null
  /** ISO-8601 as plutil prints it, or null when absent. */
  creationDate: string | null
  expirationDate: string | null
  /** TeamIdentifier.0 */
  teamId: string | null
  /** Entitlements.application-identifier, e.g. "<TEAM>.com.example.App". */
  appId: string | null
  /** ProvisionedDevices (hardware UDIDs); [] when the key is absent. */
  devices: string[]
}

export type DecodeResult = { ok: true; profile: ProfileInfo } | { ok: false; error: string }

export interface ProfileDeps {
  exec?: ExecFn
  /** Parent dir for the temp decode dir. Default os.tmpdir(). */
  tmpDir?: string
}

async function extractRaw(exec: ExecFn, plist: string, key: string): Promise<string | null> {
  const r = await exec(['/usr/bin/plutil', '-extract', key, 'raw', '-o', '-', plist], { timeoutMs: PLUTIL_TIMEOUT_MS })
  if (r.code !== 0) return null
  const v = r.stdout.replace(/\r?\n$/, '')
  return v === '' ? null : v
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&')
}

/** The <string> members of an xml1-extracted array. Exported for tests. */
export function parseXmlStringArray(xml: string): string[] {
  const body = xml.match(/<array>([\s\S]*?)<\/array>/)
  if (!body) return []
  const out: string[] = []
  for (const m of body[1].matchAll(/<string>([\s\S]*?)<\/string>/g)) out.push(unescapeXml(m[1].trim()))
  return out
}

async function extractStringArray(exec: ExecFn, plist: string, key: string): Promise<string[]> {
  const r = await exec(['/usr/bin/plutil', '-extract', key, 'xml1', '-o', '-', plist], { timeoutMs: PLUTIL_TIMEOUT_MS })
  if (r.code !== 0) return []
  return parseXmlStringArray(r.stdout)
}

/** Read the profile keys out of an already-decoded XML (or binary) plist.
 *  UUID is required; every other key is null/[] when absent. */
export async function decodePlistFile(plistPath: string, deps: ProfileDeps = {}): Promise<DecodeResult> {
  const exec = deps.exec ?? realExec
  if (!existsSync(plistPath)) return { ok: false, error: `no such plist: ${plistPath}` }
  const uuid = await extractRaw(exec, plistPath, 'UUID')
  if (!uuid) return { ok: false, error: `no UUID in ${basename(plistPath)}` }
  const [name, creationDate, expirationDate, teamId, appId, devices] = await Promise.all([
    extractRaw(exec, plistPath, 'Name'),
    extractRaw(exec, plistPath, 'CreationDate'),
    extractRaw(exec, plistPath, 'ExpirationDate'),
    extractRaw(exec, plistPath, 'TeamIdentifier.0'),
    extractRaw(exec, plistPath, 'Entitlements.application-identifier'),
    extractStringArray(exec, plistPath, 'ProvisionedDevices'),
  ])
  return { ok: true, profile: { path: plistPath, uuid, name, creationDate, expirationDate, teamId, appId, devices } }
}

/** Decode a .mobileprovision: `security cms -D` into a private temp dir,
 *  read the keys, remove the temp dir. With `keep`, the application
 *  identifier is read FIRST and the remaining keys only when keep(appId) is
 *  true (one plutil instead of seven for every other app's profile); a
 *  rejected profile comes back as { ok: true, skipped: true }. */
export type SkippedProfile = { ok: true; skipped: true; appId: string | null }
export function decodeProfile(path: string, deps?: ProfileDeps): Promise<DecodeResult>
export function decodeProfile(
  path: string,
  deps: ProfileDeps,
  keep: (appId: string | null) => boolean,
): Promise<DecodeResult | SkippedProfile>
export async function decodeProfile(
  path: string,
  deps: ProfileDeps = {},
  keep?: (appId: string | null) => boolean,
): Promise<DecodeResult | SkippedProfile> {
  const exec = deps.exec ?? realExec
  if (!existsSync(path)) return { ok: false, error: `no such profile: ${path}` }
  let dir: string
  try {
    dir = mkdtempSync(join(deps.tmpDir ?? tmpdir(), 'health-resign-profile-'))
  } catch (e) {
    return { ok: false, error: `temp dir: ${e instanceof Error ? e.message : String(e)}` }
  }
  try {
    const plist = join(dir, 'profile.plist')
    const r = await exec(['/usr/bin/security', 'cms', '-D', '-i', path, '-o', plist], { timeoutMs: CMS_TIMEOUT_MS })
    if (r.timedOut) return { ok: false, error: `security cms timed out on ${basename(path)}` }
    if (r.code !== 0 || !existsSync(plist)) {
      return { ok: false, error: `security cms failed on ${basename(path)}: ${r.tail.trim().slice(-300)}` }
    }
    if (keep) {
      const appId = await extractRaw(exec, plist, 'Entitlements.application-identifier')
      if (!keep(appId)) return { ok: true, skipped: true, appId }
    }
    const d = await decodePlistFile(plist, { exec })
    if (!d.ok) return d
    return { ok: true, profile: { ...d.profile, path } }
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // our own temp dir; leaking it is harmless
    }
  }
}

/** *.mobileprovision files in dir, absolute and sorted; [] when the dir is
 *  missing or unreadable. */
export function listProfiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.mobileprovision'))
      .sort()
      .map((f) => join(dir, f))
  } catch {
    return []
  }
}

/** True when appId is one of bundleIds under any team prefix ("<TEAM>.<id>"),
 *  or exactly the bundle id. A suffix match needs the dot boundary, so
 *  com.x.App never matches com.x.App.widgets or xcom.x.App. */
export function appIdMatches(appId: string | null, bundleIds: string[], teamId?: string | null): boolean {
  if (!appId) return false
  for (const b of bundleIds) {
    if (teamId) {
      if (appId === `${teamId}.${b}`) return true
    } else if (appId === b || appId.endsWith(`.${b}`)) {
      return true
    }
  }
  return false
}

// ── quarantine / restore ─────────────────────────────────────────

export interface QuarantineMove {
  /** Where the profile lived (and goes back to on restore). */
  from: string
  /** Where it sits in the backup dir. */
  to: string
  uuid: string
  app_id: string | null
  expiration_date: string | null
  moved: boolean
  /** Set by restore(). */
  restore?: 'restored' | 'kept_existing' | 'missing_backup' | 'error'
  restore_error?: string
}

export interface QuarantineManifest {
  run_id: string
  created_at: string
  /** The per-run backup dir (backupDir/runId). */
  dir: string
  manifest_path: string
  bundle_ids: string[]
  moves: QuarantineMove[]
  /** Profiles that failed to decode: left in place, never judged. */
  undecodable: { path: string; error: string }[]
  complete: boolean
  restored_at?: string
}

export interface QuarantineOptions extends ProfileDeps {
  /** When set, only "<teamId>.<bundle>" matches. */
  teamId?: string | null
  /** Clock for created_at / restored_at (tests). */
  now?: () => Date
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n')
  renameSync(tmp, path)
}

/** Move a file, falling back to copy + unlink across volumes. Refuses to
 *  overwrite an existing destination. */
function moveNoClobber(from: string, to: string): void {
  if (existsSync(to)) throw new Error(`destination exists: ${to}`)
  mkdirSync(dirname(to), { recursive: true })
  try {
    renameSync(from, to)
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== 'EXDEV') throw e
    copyFileSync(from, to)
    unlinkSync(from)
  }
}

/** A backup path no existing file and no earlier planned move uses (the
 *  same UUID can sit in both profile dirs). */
function uniqueTarget(dir: string, name: string, reserved: Set<string>): string {
  let p = join(dir, name)
  for (let i = 1; existsSync(p) || reserved.has(p); i++) p = join(dir, `${i}-${name}`)
  reserved.add(p)
  return p
}

export function readManifest(path: string): QuarantineManifest | null {
  return readJsonFile<QuarantineManifest>(path)
}

/** Move every profile in profileDirs whose application-identifier matches
 *  one of bundleIds into backupDir/runId. The manifest is on disk before
 *  the first move and updated after each one; a throw mid-way leaves the
 *  manifest describing exactly the moves that happened (moved: true). */
/** THE scan for our profiles, shared by the real quarantine and the dry run
 *  (so the plan always predicts exactly what a run would move). */
export async function findOurProfiles(
  profileDirs: string[],
  bundleIds: string[],
  opts: ProfileDeps & { teamId?: string | null } = {},
): Promise<{ matches: ProfileInfo[]; undecodable: Array<{ path: string; error: string }> }> {
  const matches: ProfileInfo[] = []
  const undecodable: Array<{ path: string; error: string }> = []
  const keep = (appId: string | null) => appIdMatches(appId, bundleIds, opts.teamId)
  for (const pdir of profileDirs) {
    for (const file of listProfiles(pdir)) {
      const d = await decodeProfile(file, opts, keep)
      if (!d.ok) undecodable.push({ path: file, error: d.error })
      else if (!('skipped' in d)) matches.push(d.profile)
    }
  }
  return { matches, undecodable }
}

export async function quarantine(
  profileDirs: string[],
  bundleIds: string[],
  backupDir: string,
  runId: string,
  opts: QuarantineOptions = {},
): Promise<QuarantineManifest> {
  const now = opts.now ?? (() => new Date())
  const dir = join(backupDir, runId)
  const manifestPath = join(dir, 'manifest.json')
  const manifest: QuarantineManifest = {
    run_id: runId,
    created_at: now().toISOString(),
    dir,
    manifest_path: manifestPath,
    bundle_ids: [...bundleIds],
    moves: [],
    undecodable: [],
    complete: false,
  }
  const reserved = new Set<string>()
  const found = await findOurProfiles(profileDirs, bundleIds, opts)
  manifest.undecodable.push(...found.undecodable)
  for (const p of found.matches) {
    const to = uniqueTarget(dir, basename(p.path), reserved)
    manifest.moves.push({
      from: p.path,
      to,
      uuid: p.uuid,
      app_id: p.appId,
      expiration_date: p.expirationDate,
      moved: false,
    })
  }
  // On disk before anything moves.
  writeJsonAtomic(manifestPath, manifest)
  for (const m of manifest.moves) {
    moveNoClobber(m.from, m.to)
    m.moved = true
    writeJsonAtomic(manifestPath, manifest)
  }
  manifest.complete = true
  writeJsonAtomic(manifestPath, manifest)
  return manifest
}

export interface RestoreResult {
  restored: string[]
  /** A file of the same name already exists at the origin: it was kept and
   *  the backup left in place. */
  keptExisting: string[]
  missingBackup: string[]
  errors: { path: string; error: string }[]
}

/** Move quarantined profiles back. Never overwrites: a same-name (so
 *  same-UUID, Xcode names them <UUID>.mobileprovision) file at the origin
 *  wins and the backup stays. Accepts the manifest or its path. */
export function restore(manifestOrPath: QuarantineManifest | string, opts: { now?: () => Date } = {}): RestoreResult {
  const result: RestoreResult = { restored: [], keptExisting: [], missingBackup: [], errors: [] }
  const manifest = typeof manifestOrPath === 'string' ? readManifest(manifestOrPath) : manifestOrPath
  if (!manifest) {
    result.errors.push({ path: String(manifestOrPath), error: 'manifest unreadable' })
    return result
  }
  for (const m of manifest.moves) {
    if (!m.moved) continue
    if (m.restore === 'restored') continue
    if (existsSync(m.from)) {
      m.restore = 'kept_existing'
      result.keptExisting.push(m.from)
      continue
    }
    if (!existsSync(m.to)) {
      m.restore = 'missing_backup'
      result.missingBackup.push(m.to)
      continue
    }
    try {
      moveNoClobber(m.to, m.from)
      m.restore = 'restored'
      result.restored.push(m.from)
    } catch (e) {
      m.restore = 'error'
      m.restore_error = e instanceof Error ? e.message : String(e)
      result.errors.push({ path: m.from, error: m.restore_error })
    }
  }
  manifest.restored_at = (opts.now ?? (() => new Date()))().toISOString()
  try {
    writeJsonAtomic(manifest.manifest_path, manifest)
  } catch (e) {
    result.errors.push({ path: manifest.manifest_path, error: e instanceof Error ? e.message : String(e) })
  }
  return result
}
