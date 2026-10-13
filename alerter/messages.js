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

function startedMessage({ watched, openCount }, cfg) {
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
