const fs = require("fs")
const keys = require("./keys")
const { KINDS, evaluateConnection, evaluateQueue, evaluateFailures, isWorse } = require("./rules")
const {
  evaluateDown,
  evaluateHeartbeat,
  evaluatePercent,
  parseRedisMemory,
  diskUsage,
  evaluateDlq,
} = require("./systemRules")
const messages = require("./messages")
const { zonedDateTime } = require("./time")

function withTimeout(promise, ms) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms) }),
  ]).finally(() => clearTimeout(timer))
}

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
  constructor({
    redis,
    streamRedis,
    sender,
    cfg,
    log,
    now = Date.now,
    consumerName = "alerter-1",
    fetchImpl = globalThis.fetch,
    statfs = (path) => fs.promises.statfs(path),
  }) {
    this.redis = redis
    this.streamRedis = streamRedis
    this.sender = sender
    this.cfg = cfg
    this.log = log
    this.now = now
    this.consumerName = consumerName
    this.fetchImpl = fetchImpl
    this.statfs = statfs
    this.tracks = new Map() // clientId -> { conn, queue }
    this.systemTracks = {} // { redis, api } -> { failingSince }
    this.systemOpen = new Map() // kind -> open system alert
    this.dlqNoticeAt = null
    this.startedAt = now()
    this.ticking = false
    this.stopped = false
    this.timer = null
    this.lastStreamWarnAt = 0
  }

  ctx(now) {
    return { now, timeZone: this.cfg.timeZone, failureWindowMs: this.cfg.failureWindowMs }
  }

  // ── Persistence of open alerts (survives alerter restarts) ────────────

  // Client alerts only; system alerts live in this.systemOpen.
  async loadOpen() {
    const raw = (await this.redis.hgetall(keys.OPEN_KEY)) || {}
    const open = new Map()
    for (const [field, value] of Object.entries(raw)) {
      const alert = safeJson(value)
      if (alert && alert.clientId && alert.kind && alert.clientId !== keys.SYSTEM_ID) open.set(field, alert)
    }
    return open
  }

  async loadSystemOpen() {
    const raw = (await this.redis.hgetall(keys.OPEN_KEY)) || {}
    for (const value of Object.values(raw)) {
      const alert = safeJson(value)
      if (alert && alert.clientId === keys.SYSTEM_ID && alert.kind) this.systemOpen.set(alert.kind, alert)
    }
  }

  // Best effort: Redis itself may be the thing that is down.
  async persistSystem(alert) {
    try {
      await this.redis.hset(keys.OPEN_KEY, openField(keys.SYSTEM_ID, alert.kind), JSON.stringify(alert))
    } catch {}
  }

  async unpersistSystem(alert) {
    try {
      await this.redis.hdel(keys.OPEN_KEY, openField(keys.SYSTEM_ID, alert.kind))
    } catch {}
  }

  allOpenAlerts(clientOpen) {
    return [...this.systemOpen.values(), ...clientOpen.values()]
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
      const now = this.now()
      const redisOk = await this.runSystemChecks(now)
      // Client checks need Redis; while it's down only the Redis alert applies.
      if (redisOk) await this.runChecks(now)
    } catch (err) {
      this.log.error(`Alert check failed: ${err && err.message ? err.message : err}`)
    } finally {
      this.ticking = false
    }
  }

  // ── System checks (always on) ─────────────────────────────────────────

  async probeRedis() {
    try {
      await withTimeout(this.redis.ping(), this.cfg.probeTimeoutMs)
      return true
    } catch {
      return false
    }
  }

  async probeApi() {
    if (!this.cfg.apiHealthUrl) return true
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.cfg.probeTimeoutMs)
    try {
      const res = await this.fetchImpl(this.cfg.apiHealthUrl, { signal: controller.signal })
      return Boolean(res && res.ok)
    } catch {
      return false
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Opens/closes one system alert. An alert only closes on positive proof
   * that things are fine (healthy === true), never just because a check
   * couldn't run, so restarts or partial outages can't fake a recovery.
   */
  async setSystemAlert(kind, problem, healthy, now) {
    const open = this.systemOpen.get(kind)
    const ctx = this.ctx(now)
    if (problem && !open) {
      const alert = {
        system: true,
        clientId: keys.SYSTEM_ID,
        kind,
        reason: kind.split(":")[0],
        openedAt: now,
        ...problem,
        since: problem.since ?? now,
      }
      if (await this.sender.send({ text: messages.withFrame(messages.problemLine(alert, ctx), this.cfg) })) {
        this.systemOpen.set(kind, alert)
        await this.persistSystem(alert)
      }
    } else if (!problem && open && healthy) {
      await this.sender.send({ text: messages.withFrame(messages.recoveryLine(open, ctx), this.cfg) })
      this.systemOpen.delete(kind)
      await this.unpersistSystem(open)
    }
  }

  // Seed the failure clock from an open alert (e.g. after an alerter restart).
  downTrack(name, kind) {
    const open = this.systemOpen.get(kind)
    return this.systemTracks[name] || (open ? { failingSince: open.since } : undefined)
  }

  async runSystemChecks(now) {
    const { cfg } = this

    const redisOk = await this.probeRedis()
    const redisState = evaluateDown(this.downTrack("redis", "redis_down"), redisOk, now, cfg.systemGraceMs)
    this.systemTracks.redis = redisState.track
    await this.setSystemAlert("redis_down", redisState.problem, redisOk, now)

    const apiOk = await this.probeApi()
    const apiState = evaluateDown(this.downTrack("api", "api_down"), apiOk, now, cfg.systemGraceMs)
    this.systemTracks.api = apiState.track
    await this.setSystemAlert("api_down", apiState.problem, apiOk, now)

    await this.checkDisks(now)

    if (!redisOk) return false

    await this.checkWorker(now).catch((err) => this.log.warn(`Worker check failed: ${err.message}`))
    await this.checkRedisMemory(now).catch((err) => this.log.warn(`Redis memory check failed: ${err.message}`))
    await this.checkDlq(now).catch((err) => this.log.warn(`Dead-letter check failed: ${err.message}`))
    return true
  }

  // Folders on the same disk report the same totals; alert once per disk,
  // listing all its folders, e.g. "disk_full:/mnt/sessions,/mnt/logs".
  async checkDisks(now) {
    const { cfg } = this
    if (!cfg.diskPaths.length) return
    const groups = new Map() // total bytes -> { paths, usage }
    let allMeasured = true
    for (const path of cfg.diskPaths) {
      const usage = diskUsage(await this.statfs(path).catch(() => null))
      if (!usage) {
        allMeasured = false
        continue
      }
      const group = groups.get(usage.total) || { paths: [], usage }
      group.paths.push(path)
      groups.set(usage.total, group)
    }

    const checked = new Set()
    for (const { paths, usage } of groups.values()) {
      const kind = `disk_full:${paths.join(",")}`
      checked.add(kind)
      const breached = evaluatePercent(usage.pct, cfg.diskPct, this.systemOpen.has(kind))
      await this.setSystemAlert(kind, breached ? { path: paths.join(", "), pct: usage.pct, free: usage.free } : null, !breached, now)
    }

    // Disk alerts from an older folder layout/grouping: drop quietly once every
    // configured folder could be measured (so a read error can't hide a real one).
    if (!allMeasured) return
    for (const [kind, alert] of this.systemOpen) {
      if (alert.reason === "disk_full" && !checked.has(kind)) {
        this.systemOpen.delete(kind)
        await this.unpersistSystem(alert)
        this.log.info(`Dropped stale disk alert ${kind}`)
      }
    }
  }

  async checkWorker(now) {
    const raw = await this.redis.get(keys.WORKER_HEARTBEAT_KEY)
    const lastBeat = raw === null || raw === undefined ? null : Number(raw)
    const problem = evaluateHeartbeat(lastBeat, now, this.cfg.workerStaleMs, this.startedAt)
    const healthy = Number.isFinite(lastBeat) && now - lastBeat <= this.cfg.workerStaleMs
    await this.setSystemAlert("worker_down", problem, healthy, now)
  }

  async checkRedisMemory(now) {
    const mem = parseRedisMemory(await this.redis.info("memory"))
    if (mem.pct === null) return // no maxmemory configured: nothing to compare against
    const breached = evaluatePercent(mem.pct, this.cfg.redisMemoryPct, this.systemOpen.has("redis_memory"))
    await this.setSystemAlert("redis_memory", breached ? { pct: mem.pct, used: mem.used, max: mem.max } : null, !breached, now)
  }

  // Broken events are a one-off notice (no open/recover), rate-limited.
  async checkDlq(now) {
    const [length, seenRaw] = await Promise.all([
      this.redis.xlen(this.cfg.dlqStream),
      this.redis.get(keys.DLQ_SEEN_KEY),
    ])
    const seen = seenRaw === null || seenRaw === undefined ? null : Number(seenRaw)
    const result = evaluateDlq(seen, length, now, this.dlqNoticeAt, this.cfg.dlqCooldownMs)
    if (result.notify) {
      const text = messages.withFrame(messages.dlqLine({ newCount: result.newCount, length, stream: this.cfg.dlqStream }), this.cfg)
      if (!(await this.sender.send({ text }))) return // retry next check
      this.dlqNoticeAt = now
    }
    if (result.seen !== seen) await this.redis.set(keys.DLQ_SEEN_KEY, String(result.seen))
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

    const openAlerts = this.allOpenAlerts(await this.loadOpen())
    const text = messages.dailyOkMessage({ watched: [...watched], openAlerts }, this.ctx(now), this.cfg)
    if (await this.sender.send({ text })) await this.redis.set(keys.DAILY_OK_KEY, date)
  }

  async sendStarted() {
    let watched = []
    let openCount = this.systemOpen.size
    try {
      const [list, open] = await Promise.all([this.redis.smembers(keys.WATCHED_KEY), this.loadOpen()])
      watched = (list || []).sort()
      openCount += open.size
    } catch (err) {
      this.log.warn(`Could not read watch list at start: ${err.message}`)
    }
    await this.sender.send({ text: messages.startedMessage({ watched, openCount }, this.cfg) })
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
        // While Redis is down this fails every 2 s; log at most once a minute.
        if (Date.now() - this.lastStreamWarnAt > 60_000) {
          this.log.warn(`Event stream read failed: ${message}`)
          this.lastStreamWarnAt = Date.now()
        }
        if (message.includes("NOGROUP")) await this.ensureGroup().catch(() => {})
        await new Promise((r) => setTimeout(r, 2000))
      }
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  // Must not fail when Redis is down at start, or the "Redis down" alert
  // could never be sent; anything that needs Redis is retried later.
  async start() {
    this.startedAt = this.now()
    await this.ensureGroup().catch((err) => this.log.warn(`Consumer group not ready yet: ${err.message}`))
    await this.loadSystemOpen().catch(() => {})
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
