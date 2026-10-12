// Central place for dashboard tunables. Anything an operator may want to
// change per deployment can be overridden with a VITE_* build-time variable.

const env = import.meta.env

function positiveNumber(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export const DEFAULT_API_BASE = env.VITE_API_BASE || "http://localhost:3000"
// Dashboard server (service logs). Empty = same origin as the dashboard.
export const DASHBOARD_SERVER_BASE = env.VITE_DASHBOARD_SERVER_BASE || ""

export const REFRESH_INTERVAL_MS = positiveNumber(env.VITE_REFRESH_INTERVAL_MS, 5000)
export const TOAST_DURATION_MS = positiveNumber(env.VITE_TOAST_DURATION_MS, 5000)

// Queue badge colours: amber at WARN, red at ALERT.
export const QUEUE_WARN_AT = positiveNumber(env.VITE_QUEUE_WARN_AT, 20)
export const QUEUE_ALERT_AT = positiveNumber(env.VITE_QUEUE_ALERT_AT, 100)

// Page sizes must stay within the API's per-request caps
// (queue: 200, message log: 200, persistent history: 500).
export const QUEUE_PAGE_SIZE = 200
export const MSG_LOG_PAGE_SIZE = 100
export const HISTORY_LIMIT = 500

// Mirrors the API's accepted send-delay range; the API stays the source of truth.
export const SEND_DELAY_BOUNDS = { minMs: 500, maxMs: 120000 }
export const SEND_DELAY_FALLBACK = { minMs: 3000, maxMs: 8000 }

export const HISTORY_PRESETS = [
  { label: "Today", days: 1 },
  { label: "7 days", days: 7 },
  { label: "30 days", days: 30 },
]

export const SERVICE_LOG_TAIL_OPTIONS = [200, 500, 1000, 2000]

// Queue jobs of this type are the normal case, so no type tag is shown for them.
export const DEFAULT_JOB_TYPE = "SEND_MESSAGE"
export const SERVICE_LOG_REFRESH_MS = positiveNumber(env.VITE_SERVICE_LOG_REFRESH_MS, 5000)

// Display order = order of the state filter chips.
// canReconnect/canStop mirror what the API and worker accept.
export const STATE_META = {
  CONNECTED:    { label: "Connected",    cls: "state-connected",    canReconnect: false, canStop: true },
  CONNECTING:   { label: "Connecting",   cls: "state-connecting",   canReconnect: false, canStop: true },
  CREATED:      { label: "Created",      cls: "state-created",      canReconnect: false, canStop: true },
  QR_REQUIRED:  { label: "Scan QR",      cls: "state-qr",           canReconnect: false, canStop: true },
  DISCONNECTED: { label: "Disconnected", cls: "state-disconnected", canReconnect: true,  canStop: true },
  LOGGED_OUT:   { label: "Logged Out",   cls: "state-loggedout",    canReconnect: true,  canStop: true },
  STOPPED:      { label: "Stopped",      cls: "state-stopped",      canReconnect: true,  canStop: false },
}
export const UNKNOWN_STATE_META = { label: "Unknown", cls: "state-unknown", canReconnect: false, canStop: true }

export const ENV_META = {
  dev:  { label: "Dev",  cls: "env-dev" },
  test: { label: "Test", cls: "env-test" },
  uat:  { label: "UAT",  cls: "env-uat" },
  prod: { label: "Prod", cls: "env-prod" },
}
export const UNKNOWN_ENV = "unknown"
