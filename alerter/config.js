// All alerter settings come from environment variables (see .env.example).
// Every value has a safe default so the service starts with nothing set.

function positiveNumber(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw === "") return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function dailyTime(raw) {
  // "" or "off" disables the daily message; otherwise HH:mm (24h).
  if (raw === undefined) return "10:00"
  const value = String(raw).trim()
  if (!value || value.toLowerCase() === "off") return ""
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : "10:00"
}

function loadConfig() {
  return {
    redis: {
      host: process.env.REDIS_HOST || "redis",
      port: positiveNumber("REDIS_PORT", 6379),
      password: process.env.REDIS_PASSWORD || undefined,
    },
    // Secret: never log this value.
    googleChatWebhookUrl: (process.env.GOOGLE_CHAT_WEBHOOK_URL || "").trim(),
    // Shown as a "[name]" prefix on every message, e.g. "local" while testing.
    instanceName: (process.env.ALERT_INSTANCE_NAME || "").trim(),
    dashboardUrl: (process.env.ALERT_DASHBOARD_URL || "").trim(),
    timeZone: process.env.ALERT_TIMEZONE || "Asia/Kolkata",

    tickMs: positiveNumber("ALERT_TICK_MS", 15_000),
    disconnectGraceMs: positiveNumber("ALERT_DISCONNECT_GRACE_MS", 3 * 60_000),
    qrGraceMs: positiveNumber("ALERT_QR_GRACE_MS", 10 * 60_000),
    queueStuckMs: positiveNumber("ALERT_QUEUE_STUCK_MS", 10 * 60_000),
    failureWindowMs: positiveNumber("ALERT_FAILURE_WINDOW_MS", 10 * 60_000),
    failureThreshold: positiveNumber("ALERT_FAILURE_THRESHOLD", 5),
    // This many alerts in one check are combined into a single message.
    batchThreshold: positiveNumber("ALERT_BATCH_THRESHOLD", 3),
    dailyOkTime: dailyTime(process.env.ALERT_DAILY_OK_TIME),

    // Google Chat accepts about 1 message/second per space.
    minSendIntervalMs: positiveNumber("ALERT_MIN_SEND_INTERVAL_MS", 1100),
    // Logout events older than this (e.g. replayed after downtime) are ignored.
    eventMaxAgeMs: positiveNumber("ALERT_EVENT_MAX_AGE_MS", 5 * 60_000),
  }
}

module.exports = { loadConfig }
