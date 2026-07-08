import { readFileSync, writeFileSync, mkdirSync } from 'fs'
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
    }
  } catch {
    return structuredClone(DEFAULT_CONFIG)
  }
}

export function saveConfig(config: HealthConfig): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true })
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n')
}

export function inQuietHours(config: HealthConfig, now = new Date()): boolean {
  if (!config.quiet_hours) return false
  const current = now.getHours() * 60 + now.getMinutes()
  const [startH, startM] = config.quiet_hours.start.split(':').map(Number)
  const [endH, endM] = config.quiet_hours.end.split(':').map(Number)
  const start = startH * 60 + startM
  const end = endH * 60 + endM
  if (start > end) return current >= start || current < end // overnight window
  return current >= start && current < end
}
