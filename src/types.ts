// WHOOP v2 API record shapes (fields per the official OpenAPI spec) plus
// the plugin's own config and event types.

// ── WHOOP records ─────────────────────────────────────────────────

export type ScoreState = 'SCORED' | 'PENDING_SCORE' | 'UNSCORABLE'

export interface WhoopCycle {
  id: number
  user_id: number
  created_at: string
  updated_at: string
  start: string
  end: string | null // null while the cycle is in progress
  timezone_offset: string
  score_state: ScoreState
  score: {
    strain: number
    kilojoule: number
    average_heart_rate: number
    max_heart_rate: number
  } | null
}

export interface WhoopSleep {
  id: string // uuid
  user_id: number
  created_at: string
  updated_at: string
  start: string
  end: string
  timezone_offset: string
  nap: boolean
  score_state: ScoreState
  score: {
    stage_summary: {
      total_in_bed_time_milli: number
      total_awake_time_milli: number
      total_no_data_time_milli: number
      total_light_sleep_time_milli: number
      total_slow_wave_sleep_time_milli: number
      total_rem_sleep_time_milli: number
      sleep_cycle_count: number
      disturbance_count: number
    }
    sleep_needed: {
      baseline_milli: number
      need_from_sleep_debt_milli: number
      need_from_recent_strain_milli: number
      need_from_recent_nap_milli: number
    }
    respiratory_rate: number
    sleep_performance_percentage: number | null
    sleep_consistency_percentage: number | null
    sleep_efficiency_percentage: number | null
  } | null
}

export interface WhoopRecovery {
  cycle_id: number
  sleep_id: string // uuid; recovery webhooks carry this id
  user_id: number
  created_at: string
  updated_at: string
  score_state: ScoreState
  score: {
    user_calibrating: boolean
    recovery_score: number
    resting_heart_rate: number
    hrv_rmssd_milli: number
    spo2_percentage: number | null
    skin_temp_celsius: number | null
  } | null
}

export interface WhoopWorkout {
  id: string // uuid
  user_id: number
  created_at: string
  updated_at: string
  start: string
  end: string
  timezone_offset: string
  sport_name: string | null
  sport_id: number | null // can be null even when sport_name is set
  score_state: ScoreState
  score: {
    strain: number
    average_heart_rate: number
    max_heart_rate: number
    kilojoule: number
    percent_recorded: number
    distance_meter: number | null
    altitude_gain_meter: number | null
    altitude_change_meter: number | null
    zone_durations: {
      zone_zero_milli: number
      zone_one_milli: number
      zone_two_milli: number
      zone_three_milli: number
      zone_four_milli: number
      zone_five_milli: number
    }
  } | null
}

export interface WhoopProfile {
  user_id: number
  email: string
  first_name: string
  last_name: string
}

export interface WhoopBodyMeasurement {
  height_meter: number
  weight_kilogram: number
  max_heart_rate: number
}

export interface WhoopCollection<T> {
  records: T[]
  next_token: string | null
}

export interface WhoopWebhookPayload {
  user_id: number
  id: string | number
  type: string // e.g. workout.updated, recovery.deleted
  trace_id: string
}

// ── Strava (the cyclo's ride record; WHOOP only shadows rides in HR) ──

/** The slice of Strava's DetailedActivity the ride watcher needs. */
export interface StravaActivity {
  id: number
  name: string
  description: string | null
  sport_type: string // 'Ride' | 'VirtualRide' | 'WeightTraining' | ...
  start_date: string // ISO UTC
  start_date_local?: string // local wall time with a fake Z suffix (Strava's convention)
  elapsed_time: number // seconds
  moving_time: number // seconds
  distance: number // meters
  total_elevation_gain: number | null
  average_speed: number | null // m/s
  average_heartrate?: number
  max_heartrate?: number
  device_name?: string | null
  external_id?: string | null
  trainer?: boolean
  manual?: boolean
}

/** Webhook event payload (a pointer; the activity body is never included). */
export interface StravaWebhookEvent {
  object_type: 'activity' | 'athlete'
  object_id: number
  aspect_type: 'create' | 'update' | 'delete'
  owner_id: number
  subscription_id: number
  event_time: number
  updates?: Record<string, string>
}

export interface StravaTokenStore {
  access_token: string
  refresh_token: string
  expires_at: number // unix seconds, straight from Strava
  obtained_at: string
}

// ── Events (daemon -> session) ────────────────────────────────────

export type EventClass =
  | 'recovery.brief'
  | 'workout.card'
  | 'strain.threshold'
  | 'vitals.alert'
  | 'trend.alert'
  | 'bedtime.nudge'
  | 'calibration.note'
  | 'steps.daily'
  | 'system.health'
  | 'workout.intent'
  | 'live.session' // live HR feed detected a workout starting
  | 'live.confirm' // the elevation developed an exercise signature (once per session)
  | 'live.zone' // first entry into a notable HR zone this session
  | 'live.rest' // session ended: summary + HR-recovery read
  | 'ride.landed' // the cyclo's ride reached Strava: compose title/description now
  | 'lift.landed' // a WHOOP lift card reached Strava: strain line stripped, compose after his debrief

export type EventPriority = 'info' | 'notable' | 'alert'

export interface HealthEvent {
  id?: number
  class: EventClass
  priority: EventPriority
  dedupe_key: string
  content: string
  meta: Record<string, string>
  created_at: string
}

// ── Config ────────────────────────────────────────────────────────

export interface HealthConfig {
  whoop: {
    client_id: string
    redirect_uri: string
  }
  events: Record<EventClass, boolean>
  thresholds: {
    strain_notable: number
    recovery_low: number
    recovery_low_days: number
    rhr_elevated_pct: number
    hrv_drop_pct: number
    resp_rate_elevated: number
    skin_temp_delta_c: number
  }
  // wake_release (default true): a freshly-ended scored sleep arriving during
  // quiet hours proves the user is awake and lifts the hold for that window.
  quiet_hours: { start: string; end: string; wake_release?: boolean } | null
  daily_budget: number
  cooldown_minutes: Partial<Record<EventClass, number>>
  poll_interval_minutes: number
  webhook: {
    port: number
    path: string
  }
  // Strava ride watcher. Both values are generated by setup:strava; empty =
  // the leg is not configured. The webhook path doubles as the shared-secret
  // (Strava's event POSTs carry no reliably-documented signature), so it must
  // stay unguessable; verify_token authenticates the subscription challenge.
  strava: {
    webhook_path: string
    verify_token: string
    // Sign-off appended to every description the watcher writes ('' = none).
    // Config, not code: each installer signs (or not) as themselves.
    watermark: string
  }
  // Live HR ingest (BLE relayers stream raw 0x2A37 frames here over WS).
  // bind stays loopback until the phone relayer needs the tailnet. token is
  // generated by the daemon on first start; relayers on this machine read it
  // from the config file.
  live: {
    port: number
    bind: string
    token: string
    max_hr: number | null // null = derive from observed workout max HR
    hot_bpm: number | null // null = derive as 45% HR reserve above rest
  }
  // Workout-plan JSON served to the phone at GET /plan. Written by the /gym
  // skill in the user's main session; empty = default <runtime dir>/plan.json.
  plan_path: string
}

export const DEFAULT_CONFIG: HealthConfig = {
  whoop: {
    client_id: '',
    redirect_uri: 'http://localhost:8787/callback',
  },
  events: {
    'recovery.brief': true,
    'workout.card': true,
    'strain.threshold': true,
    'vitals.alert': true,
    'trend.alert': true,
    'bedtime.nudge': true,
    'calibration.note': true,
    'steps.daily': false,
    'system.health': true,
    'workout.intent': true,
    'live.session': true,
    'live.confirm': true,
    'live.zone': true,
    'live.rest': true,
    'ride.landed': true,
    'lift.landed': true,
  },
  thresholds: {
    strain_notable: 15,
    recovery_low: 33,
    recovery_low_days: 2,
    rhr_elevated_pct: 5,
    hrv_drop_pct: 15,
    resp_rate_elevated: 1.0,
    skin_temp_delta_c: 0.5,
  },
  quiet_hours: { start: '23:00', end: '06:00', wake_release: true },
  daily_budget: 6,
  cooldown_minutes: {
    'recovery.brief': 720,
    'workout.card': 5,
    'strain.threshold': 720,
    'vitals.alert': 720,
    'trend.alert': 1440,
    'bedtime.nudge': 720,
    'calibration.note': 10080,
    'system.health': 360,
    // live.* throttling is per-session inside the state machine (a zone
    // announces once per session); a class cooldown here would swallow a
    // legitimate Z4->Z5 escalation seconds apart. Small values only guard
    // against pathological session flapping.
    'live.session': 10,
    'live.zone': 0,
    'live.rest': 10,
    // ride.landed dedupes by activity id (one per ride, ever); no cooldown.
    'ride.landed': 0,
  },
  poll_interval_minutes: 5,
  webhook: {
    port: 8789,
    path: '/whoop',
  },
  strava: {
    webhook_path: '',
    verify_token: '',
    watermark: '',
  },
  live: {
    port: 8790,
    bind: '127.0.0.1',
    token: '', // generated by the daemon on first start
    max_hr: null,
    hot_bpm: null,
  },
  plan_path: '',
}

// ── MCP tool helpers (inb0x convention) ───────────────────────────

export function toolResult(text: string) {
  return { content: [{ type: 'text' as const, text }] }
}

export function toolError(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true }
}
