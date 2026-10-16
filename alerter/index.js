const Redis = require("ioredis")
const { loadConfig } = require("./config")
const log = require("./logger")
const { createGoogleChatSender } = require("./googleChat")
const { Alerter } = require("./alerter")

function createRedis(cfg, name, extra = {}) {
  const client = new Redis({
    ...cfg.redis,
    retryStrategy: (times) => Math.min(times * 200, 5000),
    ...extra,
  })
  client.on("error", (err) => log.warn(`Redis (${name}) error: ${err.message}`))
  return client
}

async function main() {
  const cfg = loadConfig()
  const redis = createRedis(cfg, "main")
  // Separate connection: XREADGROUP BLOCK holds its connection while waiting.
  const streamRedis = createRedis(cfg, "stream", { maxRetriesPerRequest: null })

  const sender = createGoogleChatSender({
    webhookUrl: cfg.googleChatWebhookUrl,
    minIntervalMs: cfg.minSendIntervalMs,
    log,
  })

  const alerter = new Alerter({ redis, streamRedis, sender, cfg, log })

  log.info(
    `Alerter starting · Google Chat ${sender.isDryRun ? "NOT configured (dry run, messages are only logged)" : "configured"}` +
    ` · check every ${cfg.tickMs / 1000}s · daily OK ${cfg.dailyOkTime || "off"} ${cfg.timeZone}`
  )

  await alerter.start()

  const shutdown = () => {
    log.info("Alerter stopping")
    alerter.stop()
    Promise.allSettled([redis.quit(), streamRedis.quit()]).finally(() => process.exit(0))
  }
  process.on("SIGTERM", shutdown)
  process.on("SIGINT", shutdown)
}

main().catch((err) => {
  log.error(`Alerter failed to start: ${err && err.message ? err.message : err}`)
  process.exit(1)
})
