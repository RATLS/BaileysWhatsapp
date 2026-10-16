const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 }
const LOG_LEVEL = (process.env.ALERTER_LOG_LEVEL || process.env.LOG_LEVEL || "info").toLowerCase()

function shouldLog(level) {
  return (LEVELS[level] ?? LEVELS.info) <= (LEVELS[LOG_LEVEL] ?? LEVELS.info)
}

function log(level, message, meta) {
  if (!shouldLog(level)) return
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${message}${meta === undefined ? "" : ` ${typeof meta === "string" ? meta : JSON.stringify(meta)}`}`
  if (level === "error") console.error(line)
  else if (level === "warn") console.warn(line)
  else console.log(line)
}

module.exports = {
  info: (m, meta) => log("info", m, meta),
  warn: (m, meta) => log("warn", m, meta),
  error: (m, meta) => log("error", m, meta),
  debug: (m, meta) => log("debug", m, meta),
}
