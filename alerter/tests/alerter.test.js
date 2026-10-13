const test = require("node:test")
const assert = require("node:assert/strict")
const { Alerter } = require("../alerter")

const MIN = 60_000
// 2026-10-13 04:30 UTC = 10:00 Asia/Kolkata
const DAY_10AM_IST = Date.UTC(2026, 9, 13, 4, 30)

function baseCfg(overrides = {}) {
  return {
    instanceName: "",
    dashboardUrl: "",
    timeZone: "Asia/Kolkata",
    tickMs: 15_000,
    disconnectGraceMs: 3 * MIN,
    qrGraceMs: 10 * MIN,
    queueStuckMs: 10 * MIN,
    failureWindowMs: 10 * MIN,
    failureThreshold: 5,
    batchThreshold: 3,
    dailyOkTime: "", // off unless a test turns it on
    eventMaxAgeMs: 5 * MIN,
    ...overrides,
  }
}

function createFakeRedis() {
  const sets = new Map()
  const hashes = new Map()
  const lists = new Map()
  const zsets = new Map()
  const strings = new Map()
  const hash = (k) => { if (!hashes.has(k)) hashes.set(k, new Map()); return hashes.get(k) }
  return {
    async smembers(k) { return [...(sets.get(k) || [])] },
    async hgetall(k) { return Object.fromEntries(hash(k)) },
    async hset(k, f, v) { hash(k).set(f, v); return 1 },
    async hdel(k, f) { return hash(k).delete(f) ? 1 : 0 },
    async llen(k) { return lists.get(k) || 0 },
    async zrangebyscore(k, min) {
      return (zsets.get(k) || []).filter((e) => e.score >= min).map((e) => e.member)
    },
    async get(k) { return strings.has(k) ? strings.get(k) : null },
    async set(k, v) { strings.set(k, v); return "OK" },
    // helpers
    watch(...ids) { sets.set("wa:alerts:watched", new Set([...(sets.get("wa:alerts:watched") || []), ...ids])) },
    unwatch(id) { sets.get("wa:alerts:watched").delete(id) },
    setState(id, state) { hash("wa:clients:state").set(id, state) },
    removeState(id) { hash("wa:clients:state").delete(id) },
    setEnv(id, env) { hash("wa:clients:env").set(id, env) },
    setQueue(id, n) { lists.set(`wa:pending:${id}`, n) },
    addLog(id, entry) {
      const k = `wa:msglog:${id}`
      if (!zsets.has(k)) zsets.set(k, [])
      zsets.get(k).push({ score: entry.sentAt, member: JSON.stringify(entry) })
    },
    open() { return Object.fromEntries([...hash("wa:alerts:open")].map(([f, v]) => [f, JSON.parse(v)])) },
  }
}

function setup({ cfg = {}, sendResult = true } = {}) {
  const redis = createFakeRedis()
  const sent = []
  let clock = 0
  const sender = {
    async send(msg) {
      sent.push(msg)
      return typeof sendResult === "function" ? sendResult(msg) : sendResult
    },
  }
  const log = { info() {}, warn() {}, error() {}, debug() {} }
  const make = () => new Alerter({ redis, streamRedis: null, sender, cfg: baseCfg(cfg), log, now: () => clock })
  return {
    redis,
    sent,
    alerter: make(),
    restart: make,
    at: (ms) => { clock = ms },
  }
}

test("disconnect alerts after the grace period and recovers in the same thread", async () => {
  const { redis, sent, alerter, at } = setup()
  redis.watch("KWC")
  redis.setEnv("KWC", "prod")
  redis.setState("KWC", "DISCONNECTED")

  at(0); await alerter.tick()
  at(2 * MIN); await alerter.tick()
  assert.equal(sent.length, 0)

  at(3 * MIN); await alerter.tick()
  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /⚠️ \*KWC\* \(prod\) disconnected for 3 min/)
  const threadKey = sent[0].threadKey
  assert.ok(threadKey)
  assert.ok(redis.open()["KWC|connection"])

  at(4 * MIN); await alerter.tick()
  assert.equal(sent.length, 1, "no repeat while still down")

  redis.setState("KWC", "CONNECTED")
  at(15 * MIN); await alerter.tick()
  assert.equal(sent.length, 2)
  assert.match(sent[1].text, /✅ \*KWC\* \(prod\) back online \(was down 15 min\)/)
  assert.equal(sent[1].threadKey, threadKey)
  assert.deepEqual(redis.open(), {})
})

test("clients that are not watched never alert", async () => {
  const { redis, sent, alerter, at } = setup()
  redis.setState("OTHER", "DISCONNECTED")
  at(0); await alerter.tick()
  at(60 * MIN); await alerter.tick()
  assert.equal(sent.length, 0)
})

test("a logout event alerts immediately even though the state is already QR_REQUIRED", async () => {
  const { redis, sent, alerter, at } = setup()
  redis.watch("KWC")
  redis.setState("KWC", "QR_REQUIRED")
  at(10_000)
  alerter.handleEvent("9000-0", ["data", JSON.stringify({ type: "status", clientId: "KWC", state: "LOGGED_OUT" })])
  await alerter.tick()
  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /🔴 \*KWC\* logged out — needs a QR scan/)
})

test("old logout events (e.g. replayed after downtime) are ignored", async () => {
  const { redis, sent, alerter, at } = setup()
  redis.watch("KWC")
  redis.setState("KWC", "QR_REQUIRED")
  at(60 * MIN)
  alerter.handleEvent("1000-0", ["data", JSON.stringify({ type: "status", clientId: "KWC", state: "LOGGED_OUT" })])
  await alerter.tick()
  assert.equal(sent.length, 0)
})

test("connection alert posts an update in its thread when it gets worse", async () => {
  const { redis, sent, alerter, at } = setup()
  redis.watch("KWC")
  redis.setState("KWC", "DISCONNECTED")
  at(0); await alerter.tick()
  at(3 * MIN); await alerter.tick()
  redis.setState("KWC", "LOGGED_OUT")
  at(4 * MIN); await alerter.tick()
  assert.equal(sent.length, 2)
  assert.match(sent[1].text, /↪️ Update: 🔴 \*KWC\* logged out/)
  assert.equal(sent[1].threadKey, sent[0].threadKey)
  at(5 * MIN); await alerter.tick()
  assert.equal(sent.length, 2, "same reason is not posted again")
})

test("restarting the alerter neither duplicates nor falsely recovers an open alert", async () => {
  const { redis, sent, alerter, restart, at } = setup()
  redis.watch("KWC")
  redis.setState("KWC", "DISCONNECTED")
  at(0); await alerter.tick()
  at(3 * MIN); await alerter.tick()
  assert.equal(sent.length, 1)

  const fresh = restart()
  at(4 * MIN); await fresh.tick()
  assert.equal(sent.length, 1)
  assert.ok(redis.open()["KWC|connection"])

  redis.setState("KWC", "CONNECTED")
  at(20 * MIN); await fresh.tick()
  assert.match(sent[1].text, /back online \(was down 20 min\)/)
})

test("several problems in one check are combined into one message", async () => {
  const { redis, sent, alerter, at } = setup()
  for (const id of ["A", "B", "C"]) {
    redis.watch(id)
    redis.setState(id, "DISCONNECTED")
  }
  at(0); await alerter.tick()
  at(3 * MIN); await alerter.tick()
  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /⚠️ 3 problems need attention/)
  assert.equal(Object.keys(redis.open()).length, 3)

  for (const id of ["A", "B", "C"]) redis.setState(id, "CONNECTED")
  at(5 * MIN); await alerter.tick()
  assert.equal(sent.length, 2)
  assert.match(sent[1].text, /✅ 3 alerts closed/)
})

test("an alert is only recorded as open when Google Chat accepted it", async () => {
  let accept = false
  const { redis, sent, alerter, at } = setup({ sendResult: () => accept })
  redis.watch("KWC")
  redis.setState("KWC", "LOGGED_OUT")
  at(0); await alerter.tick()
  assert.deepEqual(redis.open(), {})
  accept = true
  at(15_000); await alerter.tick()
  assert.equal(sent.length, 2, "retried on the next check")
  assert.ok(redis.open()["KWC|connection"])
})

test("stopping or un-watching a client closes its alert with a note", async () => {
  const { redis, sent, alerter, at } = setup()
  redis.watch("A", "B")
  redis.setState("A", "LOGGED_OUT")
  redis.setState("B", "LOGGED_OUT")
  at(0); await alerter.tick()
  assert.equal(sent.length, 2)

  redis.setState("A", "STOPPED")
  redis.unwatch("B")
  at(MIN); await alerter.tick()
  const texts = sent.slice(2).map((m) => m.text).join("\n")
  assert.match(texts, /⏹ \*A\* was stopped — alert closed/)
  assert.match(texts, /🔕 Alerts turned off for \*B\*/)
  assert.deepEqual(redis.open(), {})
})

test("queue stuck while connected alerts, and recovers when it moves", async () => {
  const { redis, sent, alerter, at } = setup()
  redis.watch("KWC")
  redis.setState("KWC", "CONNECTED")
  redis.setQueue("KWC", 40)
  at(0); await alerter.tick()
  at(10 * MIN); await alerter.tick()
  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /⏳ \*KWC\* has 40 message\(s\) queued and none sent for 10 min/)

  redis.setQueue("KWC", 39)
  at(11 * MIN); await alerter.tick()
  assert.match(sent[1].text, /✅ \*KWC\* queue is moving again/)
})

test("send failures alert at the threshold and close once the window is clean", async () => {
  const { redis, sent, alerter, at } = setup()
  redis.watch("KWC")
  redis.setState("KWC", "CONNECTED")
  for (let i = 0; i < 5; i++) redis.addLog("KWC", { status: "failed", sentAt: 20 * MIN + i, failReason: "Timed Out" })
  at(21 * MIN); await alerter.tick()
  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /❌ \*KWC\* — 5 sends failed in the last 10 min \(last error: Timed Out\)/)

  at(29 * MIN); await alerter.tick()
  assert.equal(sent.length, 1, "still failures in window")
  at(31 * MIN); await alerter.tick()
  assert.match(sent[1].text, /✅ \*KWC\* sends are succeeding again/)
})

test("daily OK message is sent once per day after the configured time", async () => {
  const { redis, sent, alerter, at } = setup({ cfg: { dailyOkTime: "10:00" } })
  redis.watch("KWC")
  redis.setState("KWC", "CONNECTED")
  at(DAY_10AM_IST - MIN); await alerter.tick()
  assert.equal(sent.length, 0)
  at(DAY_10AM_IST); await alerter.tick()
  at(DAY_10AM_IST + 5 * MIN); await alerter.tick()
  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /✅ Daily check — alerter running, watching 1 client\(s\)\. No open alerts\./)
  at(DAY_10AM_IST + 24 * 60 * MIN); await alerter.tick()
  assert.equal(sent.length, 2)
})

test("instance name and dashboard link frame every message", async () => {
  const { redis, sent, alerter, at } = setup({ cfg: { instanceName: "local", dashboardUrl: "http://localhost:8080" } })
  redis.watch("KWC")
  redis.setState("KWC", "LOGGED_OUT")
  at(0); await alerter.tick()
  assert.match(sent[0].text, /^\[local\] 🔴/)
  assert.match(sent[0].text, /<http:\/\/localhost:8080\|Open dashboard>$/)
})

test("started message lists watched clients", async () => {
  const { redis, sent, alerter } = setup()
  redis.watch("B", "A")
  await alerter.sendStarted()
  assert.match(sent[0].text, /🟢 Alerter started — watching 2 client\(s\): A, B/)
})
