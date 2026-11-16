#!/usr/bin/env bun
// Auto re-sign of the sideloaded HealthRelay app: the CLI.
//
//   bun run resign run [--force] [--build-only] [--dry-run]
//       The timer's entry point (launchd). A real run from a terminal is
//       refused: a Terminal run inherits Terminal's privacy grants and would
//       give a false green. Use `kick` to run in the launchd context.
//   bun run resign plan [--probe-lock] [--force]
//       Read-only report of every gate and probe (no lock, no state).
//   bun run resign kick [--force] [--build-only] [--dry-run]
//       One-shot flags file, then launchctl kickstart of the agent.
//   bun run resign seed --ref <commit>
//       Snapshot relayer-ios at <commit> (git archive) as the build input.
//   bun run resign install-agent | uninstall-agent | status
//
// Everything the runner touches lives outside protected folders:
// ~/Library/Application Support/health-resign and ~/.claude/channels/health.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { createHash } from 'crypto'
import { homedir } from 'os'
import { join } from 'path'
import { DB_PATH, SOCKET_PATH, loadConfig } from '../src/config.js'
import { paths, acquireLock, readState, writeJsonAtomic } from '../src/resign/state.js'
import { runResign, readSource, type RunReport } from '../src/resign/runner.js'
import { oneShotRpc, readDbClock } from '../src/resign/rpc.js'
import { RESIGN_LABEL, type ResignPreflight } from '../src/resign/hooks.js'
import { SAFE_PATH } from '../src/resign/exec.js'
import { sameVersion } from '../src/resign/policy.js'

const REPO = join(import.meta.dir, '..')
const PLIST_PATH = join(homedir(), 'Library', 'LaunchAgents', `${RESIGN_LABEL}.plist`)
const SPAWN_TIMEOUT_MS = 15_000
const GIT_TIMEOUT_MS = 60_000

function say(msg = ''): void {
  console.log(msg)
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** The LaunchAgent plist (inline, the onboarding.ts pattern). StartInterval
 *  900 with RunAtLoad false; ProcessType Standard + Nice 5 (Background would
 *  throttle xcodebuild and its network); AbandonProcessGroup left at its
 *  default (false) so launchd reaps any child bun leaves behind. */
export function resignPlist(o: { bunPath: string; repo: string; logPath: string }): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${RESIGN_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${xmlEscape(o.bunPath)}</string>
        <string>run</string>
        <string>${xmlEscape(join(o.repo, 'scripts', 'resign.ts'))}</string>
        <string>run</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${xmlEscape(o.repo)}</string>
    <key>StartInterval</key>
    <integer>900</integer>
    <key>RunAtLoad</key>
    <false/>
    <key>ProcessType</key>
    <string>Standard</string>
    <key>Nice</key>
    <integer>5</integer>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${SAFE_PATH}</string>
    </dict>
    <key>StandardOutPath</key>
    <string>${xmlEscape(o.logPath)}</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(o.logPath)}</string>
</dict>
</plist>
`
}

/** 'X.Y.Z (N)' from a project.yml (first MARKETING_VERSION and
 *  CURRENT_PROJECT_VERSION, the app target's). null when absent. */
export function versionFromProjectYml(yml: string): string | null {
  const mv = yml.match(/^\s*MARKETING_VERSION:\s*["']?([0-9][0-9.]*)["']?\s*$/m)?.[1]
  const cv = yml.match(/^\s*CURRENT_PROJECT_VERSION:\s*["']?([0-9]+)["']?\s*$/m)?.[1]
  if (!mv) return null
  return cv ? `${mv} (${cv})` : mv
}

export function parseArgs(argv: string[]): { cmd: string; flags: Set<string>; ref: string | null } {
  const [cmd = 'help', ...rest] = argv
  const flags = new Set<string>()
  let ref: string | null = null
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a === '--ref') ref = rest[++i] ?? null
    else if (a.startsWith('--ref=')) ref = a.slice(6)
    else flags.add(a)
  }
  return { cmd, flags, ref }
}

function spawnBounded(argv: string[], timeoutMs = SPAWN_TIMEOUT_MS, cwd?: string) {
  const r = Bun.spawnSync(argv, { cwd, stdout: 'pipe', stderr: 'pipe', timeout: timeoutMs })
  return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() }
}

function uid(): string {
  return typeof process.getuid === 'function' ? String(process.getuid()) : spawnBounded(['/usr/bin/id', '-u']).stdout.trim()
}

async function preflight(): Promise<ResignPreflight | null> {
  const r = await oneShotRpc<ResignPreflight>(SOCKET_PATH, 'resign_preflight', {}, 5_000)
  return r.ok ? r.data : null
}

function printReport(r: RunReport): void {
  say(`${r.mode} ${r.run_id}: ${r.outcome}${r.reason ? ` (${r.reason})` : ''}, hours_left ${r.hours_left ?? 'unknown'}`)
  for (const n of r.notes) say(`  - ${n}`)
  say(`  run dir: ${r.run_dir}`)
}

async function cmdRun(flags: Set<string>, plan: boolean): Promise<number> {
  const dryRun = flags.has('--dry-run')
  if (!plan && !dryRun && (process.stdin.isTTY || process.stdout.isTTY)) {
    console.error(
      'Refusing a real re-sign run from a terminal: it would inherit the terminal\'s privacy grants and prove nothing about the launchd context.\n' +
        'Use: bun run resign kick [--force] [--build-only]   (or add --dry-run here for a read-only pass)',
    )
    return 2
  }
  const report = await runResign(
    {
      trigger: 'interval',
      forced: flags.has('--force'),
      buildOnly: flags.has('--build-only'),
      dryRun,
      plan,
      probeLock: flags.has('--probe-lock'),
      ignoreFlags: plan,
    },
    {
      paths: paths(),
      preflight,
      loadConfig: () => loadConfig().resign,
      readDbClock: () => readDbClock(DB_PATH),
      log: (line) => process.stderr.write(line + '\n'),
    },
  )
  if (plan || dryRun) printReport(report)
  return 0
}

function cmdKick(flags: Set<string>): number {
  const p = paths()
  writeJsonAtomic(p.flagsFile, {
    trigger: 'kick',
    force: flags.has('--force'),
    build_only: flags.has('--build-only'),
    dry_run: flags.has('--dry-run'),
    at: new Date().toISOString(),
  })
  // Never -k: a run in progress is never killed by a kick.
  const r = spawnBounded(['/bin/launchctl', 'kickstart', `gui/${uid()}/${RESIGN_LABEL}`])
  if (r.code !== 0) {
    rmSync(p.flagsFile, { force: true })
    console.error(`launchctl kickstart failed (${r.code}): ${r.stderr.trim()}\nIs the agent installed? bun run resign install-agent`)
    return 1
  }
  say(`kicked ${RESIGN_LABEL}${flags.size ? ` (${[...flags].join(' ')})` : ''}. Follow: tail -f ${p.logFile}`)
  return 0
}

function cmdSeed(ref: string | null): number {
  if (!ref) {
    console.error('usage: bun run resign seed --ref <commit of the build installed on the phone>')
    return 2
  }
  const p = paths()
  const commit = spawnBounded(['/usr/bin/git', '-C', REPO, 'rev-parse', '--verify', `${ref}^{commit}`], GIT_TIMEOUT_MS)
  if (commit.code !== 0) {
    console.error(`not a commit: ${ref}`)
    return 1
  }
  const sha = commit.stdout.trim()
  const lock = acquireLock(p.lockDir, { holder: 'seed' })
  if (!lock.ok) {
    console.error(`a re-sign run holds the lock (pid ${lock.owner?.pid}); try again when it finishes`)
    return 1
  }
  const tmp = join(p.base, `source.seed-${Date.now()}`)
  try {
    mkdirSync(tmp, { recursive: true })
    const tar = join(tmp, 'src.tar')
    const ar = spawnBounded(['/usr/bin/git', '-C', REPO, 'archive', '--format=tar', '-o', tar, sha, 'relayer-ios'], GIT_TIMEOUT_MS)
    if (ar.code !== 0) {
      console.error(`git archive failed: ${ar.stderr.trim()}`)
      return 1
    }
    const content = createHash('sha256').update(readFileSync(tar)).digest('hex')
    const x = spawnBounded(['/usr/bin/tar', '-xf', tar, '-C', tmp], GIT_TIMEOUT_MS)
    rmSync(tar, { force: true })
    if (x.code !== 0 || !existsSync(join(tmp, 'relayer-ios', 'project.yml'))) {
      console.error(`unpacking the snapshot failed: ${x.stderr.trim()}`)
      return 1
    }
    const version = versionFromProjectYml(readFileSync(join(tmp, 'relayer-ios', 'project.yml'), 'utf8'))
    if (!version) {
      console.error('no MARKETING_VERSION in the snapshot project.yml')
      return 1
    }
    // Swap in: source/ is replaced whole, never merged.
    const live = join(p.base, 'source')
    const old = join(p.base, `source.old-${Date.now()}`)
    if (existsSync(live)) renameSync(live, old)
    renameSync(tmp, live)
    rmSync(old, { recursive: true, force: true })
    rmSync(join(live, 'src.tar'), { force: true })
    writeJsonAtomic(p.sourceJson, {
      version,
      git_commit: sha,
      dirty: false,
      content_sha256: content,
      captured_at: new Date().toISOString(),
    })
    say(`seeded ${p.sourceDir} from ${sha.slice(0, 12)} (${version}); check it matches the phone with: bun run resign status`)
    return 0
  } finally {
    rmSync(tmp, { recursive: true, force: true })
    if (lock.ok) lock.lock.release()
  }
}

function cmdInstallAgent(): number {
  const p = paths()
  mkdirSync(p.runtime, { recursive: true })
  mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true })
  const bunPath = Bun.which('bun') ?? process.execPath
  writeFileSync(PLIST_PATH, resignPlist({ bunPath, repo: REPO, logPath: p.launchdLog }))
  const u = uid()
  spawnBounded(['/bin/launchctl', 'bootout', `gui/${u}/${RESIGN_LABEL}`])
  const boot = spawnBounded(['/bin/launchctl', 'bootstrap', `gui/${u}`, PLIST_PATH])
  if (boot.code !== 0) {
    console.error(`launchctl bootstrap failed: ${boot.stderr.trim()}`)
    return 1
  }
  const enabled = loadConfig().resign.enabled
  say(`LaunchAgent installed (${RESIGN_LABEL}, every 15 min). Runs log to ${p.logFile}.`)
  if (!enabled) say('resign.enabled is false: interval runs only stamp a heartbeat; kick --force still runs.')
  return 0
}

function cmdUninstallAgent(): number {
  spawnBounded(['/bin/launchctl', 'bootout', `gui/${uid()}/${RESIGN_LABEL}`])
  rmSync(PLIST_PATH, { force: true })
  say(`LaunchAgent removed (${RESIGN_LABEL}). State and logs are kept in ${paths().runtime}.`)
  return 0
}

async function cmdStatus(): Promise<number> {
  const p = paths()
  const st = readState(p.stateFile)
  const source = readSource(p)
  const pf = await preflight()
  const cfg = loadConfig().resign
  say(`enabled: ${cfg.enabled}, device_udid: ${cfg.device_udid ? 'set' : 'not set'}, agent plist: ${existsSync(PLIST_PATH) ? 'installed' : 'absent'}`)
  say(`daemon: ${pf ? `signed_until ${pf.signed_until ?? 'unknown'} (${pf.hours_left ?? '?'}h), phone ${pf.phone_app_version ?? '?'}, blocker ${pf.blocker?.reason ?? 'none'}` : 'unreachable'}`)
  say(`snapshot: ${source ? `${source.version} @ ${source.git_commit?.slice(0, 12) ?? '?'} (${source.captured_at})${pf?.phone_app_version ? (sameVersion(source.version, pf.phone_app_version) ? ', matches the phone' : ', DOES NOT match the phone') : ''}` : 'none (bun run resign seed --ref <commit>)'}`)
  if (!st) {
    say('state: none yet')
    return 0
  }
  say(`last run: ${st.last_run_at ?? 'never'} (${st.trigger ?? '?'}${st.dry_run ? ', dry run' : ''}) -> ${st.last_outcome ?? '?'}${st.last_reason ? `: ${st.last_reason}` : ''}`)
  if (st.staged) say(`staged: ${st.staged.run_id} ${st.staged.version}, app until ${st.staged.app_expiry}${st.staged.cert_changed ? ', NEW CERT' : ''}`)
  if (st.pending_confirm) say(`pending: installed ${st.pending_confirm.first_installed_at}, expecting ${st.pending_confirm.expected_until}`)
  if (st.episode) say(`episode: ${st.episode.class} since ${st.episode.since}${st.episode.detail ? ` (${st.episode.detail})` : ''}`)
  if (st.last_success) say(`last success: ${st.last_success.at} (until ${st.last_success.expiry})`)
  say(`counters: ${JSON.stringify(st.counters)}`)
  return 0
}

async function main(argv: string[]): Promise<number> {
  const { cmd, flags, ref } = parseArgs(argv)
  switch (cmd) {
    case 'run':
      return cmdRun(flags, false)
    case 'plan':
      return cmdRun(flags, true)
    case 'kick':
      return cmdKick(flags)
    case 'seed':
      return cmdSeed(ref)
    case 'install-agent':
      return cmdInstallAgent()
    case 'uninstall-agent':
      return cmdUninstallAgent()
    case 'status':
      return cmdStatus()
    default:
      say('usage: bun run resign <run|plan|kick|seed|install-agent|uninstall-agent|status> [--force] [--build-only] [--dry-run] [--probe-lock] [--ref <commit>]')
      return cmd === 'help' ? 0 : 2
  }
}

if (import.meta.main) {
  let code = 1
  try {
    code = await main(process.argv.slice(2))
  } catch (err) {
    console.error(`resign: ${err instanceof Error ? err.message : String(err)}`)
  }
  // Always exit: nothing (a stray timer, a socket) may keep a headless run alive.
  process.exit(code)
}
