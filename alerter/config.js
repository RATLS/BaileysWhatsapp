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

    // ── System checks (always on, not tied to the watch list) ──
    apiHealthUrl: (process.env.ALERT_API_HEALTH_URL || "http://api:3000/health").trim(),
    // API / Redis must be failing this long before alerting (ignores restarts/blips).
    systemGraceMs: positiveNumber("ALERT_SYSTEM_GRACE_MS", 60_000),
    // Worker heartbeat (wa:health:worker) older than this = worker down/frozen.
    workerStaleMs: positiveNumber("ALERT_WORKER_STALE_MS", 2 * 60_000),
    probeTimeoutMs: positiveNumber("ALERT_PROBE_TIMEOUT_MS", 5_000),
    redisMemoryPct: positiveNumber("ALERT_REDIS_MEMORY_PCT", 80),
    diskPct: positiveNumber("ALERT_DISK_PCT", 85),
    // Comma-separated paths to measure (read-only mounts). Empty = no disk check.
    diskPaths: (process.env.ALERT_DISK_PATHS || "").split(",").map((p) => p.trim()).filter(Boolean),
    dlqStream: process.env.WA_EVENTS_DLQ_STREAM || "wa:events:dlq",
    // At most one "broken events" notice per this period.
    dlqCooldownMs: positiveNumber("ALERT_DLQ_COOLDOWN_MS", 30 * 60_000),
    // If a check runs much later than tickMs, everything was paused (laptop
    // sleep, VM pause): hold new system alerts this long so services can catch up.
    resumeGraceMs: positiveNumber("ALERT_RESUME_GRACE_MS", 60_000),
  }
}

module.exports = { loadConfig }
