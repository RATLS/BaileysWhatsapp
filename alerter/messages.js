// Message text for Google Chat. Pure functions so wording is easy to test/change.
// Google Chat formatting: *bold*, _italic_, <url|label> links.

const MAX_TEXT_LENGTH = 4000 // Google Chat limit is 4096

function formatDuration(ms) {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  if (minutes < 1) return "less than a minute"
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours < 24) return rest ? `${hours} h ${rest} min` : `${hours} h`
  const days = Math.floor(hours / 24)
  const restHours = hours % 24
  return restHours ? `${days} d ${restHours} h` : `${days} d`
}

function formatClock(ms, timeZone) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(ms))
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "?"
  const units = ["B", "KB", "MB", "GB", "TB"]
  let value = bytes
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`
}

// ── System alerts (API, worker, Redis, disk) ────────────────────────────

function systemProblemLine(alert, ctx) {
  const since = `${formatDuration(ctx.now - alert.since)} (since ${formatClock(alert.since, ctx.timeZone)})`
  switch (alert.reason) {
    case "api_down":
      return `🔴 *API* is not responding for ${since} — the CRM and dashboard can't queue or manage messages`
    case "redis_down":
      return `🔴 *Redis* is unreachable for ${since} — nothing can be queued, sent or tracked`
    case "worker_down":
      return Number.isFinite(alert.lastBeat)
        ? `🔴 *Worker* has stopped reporting — last sign of life ${formatDuration(ctx.now - alert.lastBeat)} ago (${formatClock(alert.lastBeat, ctx.timeZone)}). Messages are not being sent`
        : `🔴 *Worker* has not reported since the alerter started ${formatDuration(ctx.now - alert.since)} ago. Messages are probably not being sent`
    case "redis_memory":
      return `⚠️ *Redis memory* at ${Math.round(alert.pct)}% (${formatBytes(alert.used)} of ${formatBytes(alert.max)}) — near its limit, data may be evicted`
    case "disk_full":
      return `⚠️ *Disk* at ${Math.round(alert.pct)}% for ${alert.path} (${formatBytes(alert.free)} free)`
    default:
      return `⚠️ *System* problem (${alert.reason})`
  }
}

function systemRecoveryLine(alert, ctx) {
  const lasted = formatDuration(ctx.now - alert.since)
  switch (alert.reason) {
    case "api_down":
      return `✅ *API* is responding again (was down ${lasted})`
    case "redis_down":
      return `✅ *Redis* is reachable again (was down ${lasted})`
    case "worker_down":
      return `✅ *Worker* is reporting again (was silent ${lasted})`
    case "redis_memory":
      return `✅ *Redis memory* back to a safe level`
    case "disk_full":
      return `✅ *Disk* usage back to a safe level for ${alert.path}`
    default:
      return `✅ *System* problem cleared (${alert.reason})`
  }
}

function dlqLine({ newCount, length, stream }) {
  return `⚠️ ${newCount} broken event(s) moved to the dead-letter stream \`${stream}\` (${length} in total) — status/QR updates were dropped; check the API logs`
}

function clientLabel(clientId, env) {
  return `*${clientId}*${env ? ` (${env})` : ""}`
}

function withFrame(text, cfg) {
  const prefix = cfg.instanceName ? `[${cfg.instanceName}] ` : ""
  const link = cfg.dashboardUrl ? `\n<${cfg.dashboardUrl}|Open dashboard>` : ""
  const full = `${prefix}${text}${link}`
  return full.length > MAX_TEXT_LENGTH ? `${full.slice(0, MAX_TEXT_LENGTH - 1)}…` : full
}

// ── Problem lines (used alone or inside a combined message) ─────────────

function problemLine(alert, ctx) {
  if (alert.system) return systemProblemLine(alert, ctx)
  const who = clientLabel(alert.clientId, alert.env)
  const since = `${formatDuration(ctx.now - alert.since)} (since ${formatClock(alert.since, ctx.timeZone)})`
  switch (alert.reason) {
    case "logged_out":
      return `🔴 ${who} logged out — needs a QR scan to reconnect`
    case "qr_required":
      return `📷 ${who} waiting for a QR scan for ${since}`
    case "disconnected":
      return `⚠️ ${who} disconnected for ${since}`
    case "queue_stuck":
      return `⏳ ${who} has ${alert.queueLen} message(s) queued and none sent for ${since}, while connected`
    case "send_failures":
      return `❌ ${who} — ${alert.count} sends failed in the last ${formatDuration(ctx.failureWindowMs)}${alert.lastReason ? ` (last error: ${alert.lastReason})` : ""}`
    default:
      return `⚠️ ${who} needs attention (${alert.reason})`
  }
}

function recoveryLine(alert, ctx) {
  if (alert.system) return systemRecoveryLine(alert, ctx)
  const who = clientLabel(alert.clientId, alert.env)
  const lasted = formatDuration(ctx.now - alert.since)
  switch (alert.closeReason) {
    case "stopped":
      return `⏹ ${who} was stopped — alert closed`
    case "gone":
      return `🗑 ${who} no longer exists — alert closed`
    case "unwatched":
      return `🔕 Alerts turned off for ${who} — alert closed`
    case "superseded":
      return `ℹ️ ${who} is no longer connected — queue alert closed (connection alert covers it)`
    default:
      break
  }
  switch (alert.kind) {
    case "queue_stuck":
      return `✅ ${who} queue is moving again (was stuck ${lasted})`
    case "send_failures":
      return `✅ ${who} sends are succeeding again`
    default:
      return `✅ ${who} back online (was down ${lasted})`
  }
}

function updateLine(alert, ctx) {
  return `↪️ Update: ${problemLine(alert, ctx)}`
}

// ── Whole messages ──────────────────────────────────────────────────────

function combined(title, lines, cfg) {
  return withFrame(`${title}\n${lines.map((l) => `• ${l}`).join("\n")}`, cfg)
}

function startedMessage({ watched, openCount, redisReachable = true }, cfg) {
  if (!redisReachable) {
    return withFrame("🟢 Alerter started — Redis is not reachable yet, so the watch list is unknown (system checks are running)", cfg)
  }
  const list = watched.length ? `: ${watched.join(", ")}` : ""
  const open = openCount ? ` · ${openCount} alert(s) still open` : ""
  return withFrame(`🟢 Alerter started — watching ${watched.length} client(s)${list}${open}`, cfg)
}

function dailyOkMessage({ watched, openAlerts }, ctx, cfg) {
  const head = `✅ Daily check — alerter running, watching ${watched.length} client(s)`
  if (!openAlerts.length) return withFrame(`${head}. No open alerts.`, cfg)
  return combined(`${head}. Open alerts: ${openAlerts.length}`, openAlerts.map((a) => problemLine(a, ctx)), cfg)
}

module.exports = {
  formatBytes,
  dlqLine,
  formatDuration,
  formatClock,
  withFrame,
  problemLine,
  recoveryLine,
  updateLine,
  combined,
  startedMessage,
  dailyOkMessage,
}
