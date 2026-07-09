import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'
import type { HealthConfig } from './types.js'
import { DEFAULT_CONFIG } from './types.js'

// HEALTH_CONFIG_PATH override exists for tests only; real installs use the default.
const CONFIG_PATH =
  process.env.HEALTH_CONFIG_PATH ?? join(homedir(), '.config', 'health', 'config.json')

// Runtime dir: db, socket, pidfile, log all live together (attn convention).
export const RUNTIME_DIR =
  process.env.HEALTH_RUNTIME_DIR ?? join(homedir(), '.claude', 'channels', 'health')

export const DB_PATH = join(RUNTIME_DIR, 'health.db')
export const SOCKET_PATH = join(RUNTIME_DIR, 'daemon.sock')
export const PID_PATH = join(RUNTIME_DIR, 'daemon.pid')
export const LOG_PATH = join(RUNTIME_DIR, 'daemon.log')

export function ensureRuntimeDir(): void {
  mkdirSync(RUNTIME_DIR, { recursive: true })
}

export function loadConfig(): HealthConfig {
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf8')
    const parsed = JSON.parse(raw) as Partial<HealthConfig>
    return {
      whoop: { ...DEFAULT_CONFIG.whoop, ...parsed.whoop },
      events: { ...DEFAULT_CONFIG.events, ...parsed.events },
      thresholds: { ...DEFAULT_CONFIG.thresholds, ...parsed.thresholds },
      quiet_hours: parsed.quiet_hours === undefined ? DEFAULT_CONFIG.quiet_hours : parsed.quiet_hours,
      daily_budget: parsed.daily_budget ?? DEFAULT_CONFIG.daily_budget,
      cooldown_minutes: { ...DEFAULT_CONFIG.cooldown_minutes, ...parsed.cooldown_minutes },
      poll_interval_minutes: parsed.poll_interval_minutes ?? DEFAULT_CONFIG.poll_interval_minutes,
      webhook: { ...DEFAULT_CONFIG.webhook, ...parsed.webhook },
      live: { ...DEFAULT_CONFIG.live, ...parsed.live },
      plan_path: parsed.plan_path ?? DEFAULT_CONFIG.plan_path,
    }
  } catch {
    return structuredClone(DEFAULT_CONFIG)
  }
}

/** Where the /gym plan JSON lives; config override or the runtime dir default. */
export function resolvePlanPath(config: HealthConfig): string {
  return config.plan_path || join(RUNTIME_DIR, 'plan.json')
}

export function saveConfig(config: HealthConfig): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true })
  // Atomic: a crash mid-write must never leave a truncated config behind.
  writeFileSync(CONFIG_PATH + '.tmp', JSON.stringify(config, null, 2) + '\n')
  renameSync(CONFIG_PATH + '.tmp', CONFIG_PATH)
}

/**
 * Is the on-disk config safe to REWRITE? True when the file is absent (fresh
 * install) or parses cleanly. False means loadConfig() is serving defaults in
 * place of a malformed file the user can still repair: writing would destroy it.
 */
export function configFileWritable(): boolean {
  try {
    JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT'
  }
}

export function inQuietHours(config: HealthConfig, now = new Date()): boolean {
  if (!config.quiet_hours?.start || !config.quiet_hours.end) return false // malformed = off, never a crash
  const current = now.getHours() * 60 + now.getMinutes()
  const [startH, startM] = config.quiet_hours.start.split(':').map(Number)
  const [endH, endM] = config.quiet_hours.end.split(':').map(Number)
  const start = startH * 60 + startM
  const end = endH * 60 + endM
  if (start > end) return current >= start || current < end // overnight window
  return current >= start && current < end
}
