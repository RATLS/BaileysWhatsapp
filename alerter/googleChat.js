// Sends messages to a Google Chat space via its incoming webhook.
// - one message at a time, spaced out (Google Chat allows ~1/sec per space)
// - retries rate-limit (429), server errors and network errors with backoff
// - with no webhook configured it only logs ("dry run"), so local runs are safe
// - never logs the webhook URL (it is a secret)

const RETRY_DELAYS_MS = [2_000, 5_000, 15_000]

function createGoogleChatSender({
  webhookUrl,
  minIntervalMs,
  log,
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = Date.now,
}) {
  let chain = Promise.resolve()
  let lastSentAt = 0

  function buildRequest(text, threadKey) {
    if (!threadKey) return { url: webhookUrl, body: { text } }
    const sep = webhookUrl.includes("?") ? "&" : "?"
    return {
      // Reply in the alert's thread, or start it if it doesn't exist yet.
      url: `${webhookUrl}${sep}messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD`,
      body: { text, thread: { threadKey } },
    }
  }

  async function deliver(text, threadKey) {
    if (!webhookUrl) {
      log.info(`[dry-run] Google Chat${threadKey ? ` (thread ${threadKey})` : ""}: ${text}`)
      return true
    }

    const { url, body } = buildRequest(text, threadKey)
    for (let attempt = 0; ; attempt++) {
      const wait = lastSentAt + minIntervalMs - now()
      if (wait > 0) await sleep(wait)
      lastSentAt = now()

      let status = 0
      try {
        const res = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json; charset=UTF-8" },
          body: JSON.stringify(body),
        })
        status = res.status
        if (res.ok) return true
      } catch (err) {
        log.warn(`Google Chat send failed (network): ${err && err.message ? err.message : err}`)
      }

      const retryable = status === 0 || status === 429 || status >= 500
      if (!retryable || attempt >= RETRY_DELAYS_MS.length) {
        log.error(`Google Chat send gave up (HTTP ${status || "network error"}) after ${attempt + 1} attempt(s)`)
        return false
      }
      await sleep(RETRY_DELAYS_MS[attempt])
    }
  }

  // Serialised: each send waits for the previous one (keeps order + spacing).
  function send({ text, threadKey }) {
    const result = chain.then(() => deliver(text, threadKey))
    chain = result.catch(() => {})
    return result
  }

  return { send, isDryRun: !webhookUrl }
}

module.exports = { createGoogleChatSender, RETRY_DELAYS_MS }
