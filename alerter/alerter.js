const keys = require("./keys")
const { KINDS, evaluateConnection, evaluateQueue, evaluateFailures, isWorse } = require("./rules")
const messages = require("./messages")
const { zonedDateTime } = require("./time")

const openField = (clientId, kind) => `${clientId}|${kind}`
const threadKeyFor = (clientId, kind, at) => `${clientId}-${kind}-${at}`

function safeJson(raw) {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/**
 * Watches the clients in wa:alerts:watched and posts to Google Chat when one
 * has a problem, and again when it recovers. Read-only towards everything the
 * worker/API own; the only keys it writes are wa:alerts:open and
 * wa:alerts:dailyOkDate (plus its own consumer group on the event stream).
 */
class Alerter {
  constructor({ redis, streamRedis, sender, cfg, log, now = Date.now, consumerName = "alerter-1" }) {
    this.redis = redis
    this.streamRedis = streamRedis
    this.sender = sender
    this.cfg = cfg
    this.log = log
    this.now = now
    this.consumerName = consumerName
    this.tracks = new Map() // clientId -> { conn, queue }
    this.ticking = false
    this.stopped = false
    this.timer = null
  }

  ctx(now) {
    return { now, timeZone: this.cfg.timeZone, failureWindowMs: this.cfg.failureWindowMs }
  }

  // ── Persistence of open alerts (survives alerter restarts) ────────────

  async loadOpen() {
    const raw = (await this.redis.hgetall(keys.OPEN_KEY)) || {}
    const open = new Map()
    for (const [field, value] of Object.entries(raw)) {
      const alert = safeJson(value)
      if (alert && alert.clientId && alert.kind) open.set(field, alert)
    }
    return open
  }

  async saveOpen(alert) {
    await this.redis.hset(keys.OPEN_KEY, openField(alert.clientId, alert.kind), JSON.stringify(alert))
  }

  async deleteOpen(alert) {
    await this.redis.hdel(keys.OPEN_KEY, openField(alert.clientId, alert.kind))
  }

  // ── Main check ─────────────────────────────────────────────────────────

  async tick() {
    if (this.ticking) return
    this.ticking = true
    try {
      await this.runChecks(this.now())
    } catch (err) {
      this.log.error(`Alert check failed: ${err && err.message ? err.message : err}`)
    } finally {
      this.ticking = false
    }
  }

  async runChecks(now) {
    const { cfg, redis } = this
    const [watchedList, states, envs, open] = await Promise.all([
      redis.smembers(keys.WATCHED_KEY),
      redis.hgetall(keys.STATE_KEY),
      redis.hgetall(keys.ENV_KEY),
      this.loadOpen(),
    ])
    const watched = new Set(watchedList || [])
    const opened = []
    const updated = []
    const closed = []

    // Alerts for clients that are no longer watched get closed.
    for (const alert of open.values()) {
      if (!watched.has(alert.clientId)) closed.push({ ...alert, closeReason: "unwatched" })
    }

    for (const clientId of watched) {
      const state = (states || {})[clientId]
      const env = (envs || {})[clientId] || null
      const track = this.tracks.get(clientId) || {}
      const openConn = open.get(openField(clientId, KINDS.CONNECTION))
      const openQueue = open.get(openField(clientId, KINDS.QUEUE_STUCK))
      const openFail = open.get(openField(clientId, KINDS.SEND_FAILURES))

      // After a restart, continue from the open alert instead of restarting the clock.
      const connTrack = track.conn || (openConn ? { downSince: openConn.since, loggedOutAt: null } : undefined)
      const queueTrack = track.queue || (openQueue ? { queueLen: openQueue.queueLen, progressAt: openQueue.since } : undefined)

      // Connection
      const conn = evaluateConnection(connTrack, state, now, cfg)
      if (conn.problem) {
        if (!openConn) {
          opened.push({ clientId, env, kind: KINDS.CONNECTION, reason: conn.problem.reason, since: conn.problem.since, openedAt: now })
        } else if (isWorse(openConn.reason, conn.problem.reason)) {
          updated.push({ ...openConn, env, reason: conn.problem.reason })
        }
      } else if (openConn) {
        // Only close when the client is really back (or intentionally gone);
        // "still down but inside the grace window" keeps the alert open.
        if (state === "CONNECTED") closed.push({ ...openConn, env })
        else if (conn.inactive) closed.push({ ...openConn, env, closeReason: state ? "stopped" : "gone" })
      }

      // Queue not draining (only meaningful while connected)
      const queueLen = state === "CONNECTED" ? await redis.llen(keys.pendingKey(clientId)) : 0
      const queue = evaluateQueue(queueTrack, state, queueLen, now, cfg)
      if (queue.problem && !openQueue) {
        opened.push({ clientId, env, kind: KINDS.QUEUE_STUCK, reason: "queue_stuck", queueLen: queue.problem.queueLen, since: queue.problem.since, openedAt: now })
      } else if (!queue.problem && openQueue) {
        closed.push({ ...openQueue, env, closeReason: state === "CONNECTED" ? undefined : "superseded" })
      }

      // Send failures in the recent window
      const rows = await redis.zrangebyscore(keys.msglogKey(clientId), now - cfg.failureWindowMs, "+inf")
      const failures = evaluateFailures((rows || []).map(safeJson).filter(Boolean), now, cfg)
      if (failures.breached && !openFail) {
        opened.push({ clientId, env, kind: KINDS.SEND_FAILURES, reason: "send_failures", count: failures.count, lastReason: failures.lastReason, since: now, openedAt: now })
      } else if (openFail && failures.count === 0) {
        closed.push({ ...openFail, env })
      }

      this.tracks.set(clientId, { conn: conn.track, queue: queue.track })
    }

    for (const clientId of this.tracks.keys()) {
      if (!watched.has(clientId)) this.tracks.delete(clientId)
    }

    await this.deliver({ opened, updated, closed }, now)
    await this.maybeSendDaily(now, watched)
  }

  // ── Sending ────────────────────────────────────────────────────────────

  async deliver({ opened, updated, closed }, now) {
    const ctx = this.ctx(now)
    const batch = this.cfg.batchThreshold

    // New problems. An alert is only recorded as open once Google Chat accepted
    // it, so a failed send is retried on the next check instead of being lost.
    if (opened.length >= batch) {
      const threadKey = `batch-${now}`
      const text = messages.combined(`⚠️ ${opened.length} problems need attention`, opened.map((a) => messages.problemLine(a, ctx)), this.cfg)
      if (await this.sender.send({ text, threadKey })) {
        for (const alert of opened) await this.saveOpen({ ...alert, threadKey })
      }
    } else {
      for (const alert of opened) {
        const threadKey = threadKeyFor(alert.clientId, alert.kind, now)
        const text = messages.withFrame(messages.problemLine(alert, ctx), this.cfg)
        if (await this.sender.send({ text, threadKey })) await this.saveOpen({ ...alert, threadKey })
      }
    }

    for (const alert of updated) {
      const text = messages.withFrame(messages.updateLine(alert, ctx), this.cfg)
      if (await this.sender.send({ text, threadKey: alert.threadKey })) await this.saveOpen(alert)
    }

    // Recoveries: the alert is removed even if the message fails, so a
    // flaky Chat connection can't keep an alert open forever.
    if (closed.length >= batch) {
      const text = messages.combined(`✅ ${closed.length} alerts closed`, closed.map((a) => messages.recoveryLine(a, ctx)), this.cfg)
      await this.sender.send({ text })
    } else {
      for (const alert of closed) {
        const text = messages.withFrame(messages.recoveryLine(alert, ctx), this.cfg)
        await this.sender.send({ text, threadKey: alert.threadKey })
      }
    }
    for (const alert of closed) await this.deleteOpen(alert)
  }

  async maybeSendDaily(now, watched) {
    if (!this.cfg.dailyOkTime) return
    const { date, time } = zonedDateTime(now, this.cfg.timeZone)
    if (time < this.cfg.dailyOkTime) return
    if ((await this.redis.get(keys.DAILY_OK_KEY)) === date) return

    const openAlerts = [...(await this.loadOpen()).values()]
    const text = messages.dailyOkMessage({ watched: [...watched], openAlerts }, this.ctx(now), this.cfg)
    if (await this.sender.send({ text })) await this.redis.set(keys.DAILY_OK_KEY, date)
  }

  async sendStarted() {
    const [watched, open] = await Promise.all([this.redis.smembers(keys.WATCHED_KEY), this.loadOpen()])
    await this.sender.send({ text: messages.startedMessage({ watched: (watched || []).sort(), openCount: open.size }, this.cfg) })
  }

  // ── Event stream (only used to catch logouts, which are short-lived) ──

  async ensureGroup() {
    try {
      // "$" = only new events; history is never replayed into alerts.
      await this.streamRedis.xgroup("CREATE", keys.EVENTS_STREAM, keys.CONSUMER_GROUP, "$", "MKSTREAM")
    } catch (err) {
      if (!String(err && err.message).includes("BUSYGROUP")) throw err
    }
  }

  handleEvent(id, fields) {
    const idx = Array.isArray(fields) ? fields.indexOf("data") : -1
    const event = idx >= 0 ? safeJson(fields[idx + 1]) : null
    if (!event || event.type !== "status" || !event.clientId) return

    const at = Number(String(id).split("-")[0])
    if (!Number.isFinite(at) || this.now() - at > this.cfg.eventMaxAgeMs) return

    const track = this.tracks.get(event.clientId) || {}
    const conn = track.conn || { downSince: null, loggedOutAt: null }
    if (event.state === "LOGGED_OUT") {
      this.tracks.set(event.clientId, { ...track, conn: { downSince: conn.downSince ?? at, loggedOutAt: at } })
    } else if (["CONNECTED", "STOPPED", "DELETED"].includes(event.state)) {
      this.tracks.set(event.clientId, { ...track, conn: { ...conn, loggedOutAt: null } })
    }
  }

  async readEventsOnce(blockMs = 5000) {
    const res = await this.streamRedis.xreadgroup(
      "GROUP", keys.CONSUMER_GROUP, this.consumerName,
      "COUNT", 100, "BLOCK", blockMs,
      "STREAMS", keys.EVENTS_STREAM, ">"
    )
    if (!res) return 0
    const ids = []
    for (const [, entries] of res) {
      for (const [id, fields] of entries) {
        this.handleEvent(id, fields)
        ids.push(id)
      }
    }
    if (ids.length) await this.streamRedis.xack(keys.EVENTS_STREAM, keys.CONSUMER_GROUP, ...ids)
    return ids.length
  }

  async runEventLoop() {
    while (!this.stopped) {
      try {
        await this.readEventsOnce()
      } catch (err) {
        if (this.stopped) break
        const message = err && err.message ? err.message : String(err)
        this.log.warn(`Event stream read failed: ${message}`)
        if (message.includes("NOGROUP")) await this.ensureGroup().catch(() => {})
        await new Promise((r) => setTimeout(r, 2000))
      }
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  async start() {
    await this.ensureGroup()
    await this.sendStarted()
    await this.tick()
    this.timer = setInterval(() => this.tick(), this.cfg.tickMs)
    this.runEventLoop()
  }

  stop() {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
  }
}

module.exports = { Alerter, openField }
