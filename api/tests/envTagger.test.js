const path = require("path")
const test = require("node:test")
const assert = require("node:assert/strict")
const Fastify = require("fastify")

const { clearModule } = require("../../test/loadWithMocks")
const { parseOriginMap, detectEnv, createEnvTagger } = require("../envTagger")

const ORIGINS = parseOriginMap([
  "https://development.reachandteach.in/=dev",
  "https://testing.reachandteach.in/=test",
  "https://master.reachandteach.in/=uat",
  "https://institute.reachandteach.in/=prod"
].join(","))

function createRedisMock() {
  const hashes = new Map()
  const calls = []

  function hash(key) {
    if (!hashes.has(key)) hashes.set(key, new Map())
    return hashes.get(key)
  }

  return {
    calls,
    async hsetnx(key, field, value) {
      calls.push("hsetnx")
      if (hash(key).has(field)) return 0
      hash(key).set(field, value)
      return 1
    },
    async hset(key, field, value) {
      calls.push("hset")
      hash(key).set(field, value)
      return 1
    },
    async hget(key, field) {
      calls.push("hget")
      return hash(key).get(field) ?? null
    },
    async hdel(key, field) {
      calls.push("hdel")
      return hash(key).delete(field) ? 1 : 0
    },
    async hgetall(key) {
      calls.push("hgetall")
      return Object.fromEntries(hash(key).entries())
    },
    seedHash(key, entries) {
      hashes.set(key, new Map(Object.entries(entries)))
    },
    snapshot(key) {
      return Object.fromEntries(hash(key).entries())
    }
  }
}

test("parseOriginMap normalizes trailing slashes/case and skips invalid entries", () => {
  const map = parseOriginMap("https://Institute.ReachAndTeach.in/=PROD, https://x.in=staging, junk")

  assert.deepEqual([...map.entries()], [["https://institute.reachandteach.in", "prod"]])
  assert.equal(parseOriginMap("").size, 0)
  assert.equal(parseOriginMap(undefined).size, 0)
})

test("detectEnv reads X-Source Lambda names first, then the Origin header", () => {
  assert.equal(detectEnv({ "x-source": "CRMProd-RatlsWhatsapp" }, ORIGINS), "prod")
  assert.equal(detectEnv({ "x-source": "CRMUat-RatlsWhatsapp" }, ORIGINS), "uat")
  assert.equal(detectEnv({ "x-source": "CRMTest-RatlsWhatsapp" }, ORIGINS), "test")
  assert.equal(detectEnv({ "x-source": "CRMDev-RatlsWhatsapp" }, ORIGINS), "dev")
  assert.equal(detectEnv({ origin: "https://master.reachandteach.in" }, ORIGINS), "uat")
  assert.equal(
    detectEnv({ "x-source": "CRMDev-RatlsWhatsapp", origin: "https://institute.reachandteach.in" }, ORIGINS),
    "dev"
  )
})

test("detectEnv returns null for dashboard, localhost, unknown or missing headers", () => {
  assert.equal(detectEnv({ origin: "http://localhost:5173" }, ORIGINS), null)
  assert.equal(detectEnv({ origin: "http://localhost:3000" }, ORIGINS), null)
  assert.equal(detectEnv({ "x-source": "SomethingElse" }, ORIGINS), null)
  assert.equal(detectEnv({}, ORIGINS), null)
  assert.equal(detectEnv(undefined, ORIGINS), null)
})

test("tag labels a client once, then skips Redis entirely for the same env", async () => {
  const redis = createRedisMock()
  const tagger = createEnvTagger(redis, { originMap: ORIGINS })

  await tagger.tag("KWC", "prod")
  assert.deepEqual(redis.snapshot("wa:clients:env"), { KWC: "prod" })

  const callsAfterFirst = redis.calls.length
  await tagger.tag("KWC", "prod")
  await tagger.tag("KWC", "prod")
  assert.equal(redis.calls.length, callsAfterFirst)
})

test("tag never overwrites an existing label and records a mismatch once", async () => {
  const redis = createRedisMock()
  redis.seedHash("wa:clients:env", { KWC: "prod" })
  const tagger = createEnvTagger(redis, { originMap: ORIGINS })

  await tagger.tag("KWC", "dev")
  await tagger.tag("KWC", "dev")
  await tagger.tag("KWC", "uat")

  assert.deepEqual(redis.snapshot("wa:clients:env"), { KWC: "prod" })
  assert.deepEqual(redis.snapshot("wa:clients:envMismatch"), { KWC: "dev,uat" })
  assert.equal(redis.calls.filter((c) => c === "hset").length, 2)
})

test("tag ignores unknown env and invalid clientIds without touching Redis", async () => {
  const redis = createRedisMock()
  const tagger = createEnvTagger(redis, { originMap: ORIGINS })

  await tagger.tag("KWC", null)
  await tagger.tag("bad id", "prod")
  await tagger.tag(undefined, "prod")
  await tagger.tagFromHeaders("KWC", { origin: "http://localhost:5173" })

  assert.deepEqual(redis.calls, [])
})

test("tag swallows Redis errors so callers are never affected", async () => {
  const tagger = createEnvTagger({
    async hsetnx() {
      throw new Error("redis down")
    }
  }, { originMap: ORIGINS })

  await assert.doesNotReject(() => tagger.tag("KWC", "prod"))
})

async function buildApp(redis) {
  const routePath = path.join(__dirname, "..", "routes", "clientEnv.js")
  const tagger = createEnvTagger(redis, { originMap: ORIGINS })
  const app = Fastify()
  app.decorate("envTagger", tagger)
  tagger.registerHook(app)

  // Stand-ins with the same route shapes as the real handlers.
  app.post("/messages/send", async (req, res) => {
    if (!req.body || !req.body.text) return res.code(400).send({ error: "Nothing to send" })
    return { ok: true, queued: true }
  })
  app.post("/clients/:clientId/restart", async () => ({ ok: true }))
  app.get("/clients/:clientId/messages/log", async () => ({ messages: [] }))
  await app.register(require(routePath))

  return { app, routePath }
}

test("hook labels clients from backend sends and frontend calls on allowed routes only", async (t) => {
  const redis = createRedisMock()
  const { app, routePath } = await buildApp(redis)
  t.after(async () => {
    await app.close()
    clearModule(routePath)
  })

  await app.inject({
    method: "POST",
    url: "/messages/send",
    headers: { "x-source": "CRMProd-RatlsWhatsapp" },
    payload: { clientId: "KWC", phoneNumber: "9999999999", text: "hi" }
  })
  await app.inject({
    method: "POST",
    url: "/clients/DEVINST/restart",
    headers: { origin: "https://development.reachandteach.in" }
  })
  // Failed request, unlisted route and dashboard origin must not label anything.
  await app.inject({
    method: "POST",
    url: "/messages/send",
    headers: { "x-source": "CRMDev-RatlsWhatsapp" },
    payload: { clientId: "FAILED" }
  })
  await app.inject({
    method: "GET",
    url: "/clients/LOGONLY/messages/log",
    headers: { origin: "https://institute.reachandteach.in" }
  })
  await app.inject({
    method: "POST",
    url: "/clients/DASH/restart",
    headers: { origin: "http://localhost:5173" }
  })

  assert.deepEqual(redis.snapshot("wa:clients:env"), { KWC: "prod", DEVINST: "dev" })
})

test("PUT /clients/:clientId/env sets a label manually and clears mismatches", async (t) => {
  const redis = createRedisMock()
  redis.seedHash("wa:clients:env", { KWC: "dev" })
  redis.seedHash("wa:clients:envMismatch", { KWC: "prod" })
  const { app, routePath } = await buildApp(redis)
  t.after(async () => {
    await app.close()
    clearModule(routePath)
  })

  const res = await app.inject({ method: "PUT", url: "/clients/KWC/env", payload: { env: "PROD" } })

  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { ok: true, clientId: "KWC", env: "prod" })
  assert.deepEqual(redis.snapshot("wa:clients:env"), { KWC: "prod" })
  assert.deepEqual(redis.snapshot("wa:clients:envMismatch"), {})

  // Later prod traffic matches the new label, so no mismatch is recorded.
  await app.inject({
    method: "POST",
    url: "/clients/KWC/restart",
    headers: { origin: "https://institute.reachandteach.in" }
  })
  assert.deepEqual(redis.snapshot("wa:clients:envMismatch"), {})
})

test("PUT /clients/:clientId/env rejects bad env and clientId", async (t) => {
  const redis = createRedisMock()
  const { app, routePath } = await buildApp(redis)
  t.after(async () => {
    await app.close()
    clearModule(routePath)
  })

  const badEnv = await app.inject({ method: "PUT", url: "/clients/KWC/env", payload: { env: "staging" } })
  const missingEnv = await app.inject({ method: "PUT", url: "/clients/KWC/env", payload: {} })
  const badId = await app.inject({ method: "PUT", url: "/clients/bad%20id/env", payload: { env: "prod" } })

  assert.equal(badEnv.statusCode, 400)
  assert.match(badEnv.json().error, /env must be one of/)
  assert.equal(missingEnv.statusCode, 400)
  assert.equal(badId.statusCode, 400)
  assert.deepEqual(redis.snapshot("wa:clients:env"), {})
})

test("DELETE /clients/:clientId/env removes the label so the next request relabels it", async (t) => {
  const redis = createRedisMock()
  redis.seedHash("wa:clients:env", { KWC: "dev" })
  const { app, routePath } = await buildApp(redis)
  t.after(async () => {
    await app.close()
    clearModule(routePath)
  })

  const res = await app.inject({ method: "DELETE", url: "/clients/KWC/env" })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(redis.snapshot("wa:clients:env"), {})

  await app.inject({
    method: "POST",
    url: "/clients/KWC/restart",
    headers: { origin: "https://institute.reachandteach.in" }
  })
  assert.deepEqual(redis.snapshot("wa:clients:env"), { KWC: "prod" })
})

test("GET /debug/client-envs returns labels and mismatch lists", async (t) => {
  const redis = createRedisMock()
  redis.seedHash("wa:clients:env", { KWC: "prod", DEVINST: "dev" })
  redis.seedHash("wa:clients:envMismatch", { KWC: "dev,uat" })
  const { app, routePath } = await buildApp(redis)
  t.after(async () => {
    await app.close()
    clearModule(routePath)
  })

  const res = await app.inject({ method: "GET", url: "/debug/client-envs" })

  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json().envs, { KWC: "prod", DEVINST: "dev" })
  assert.deepEqual(res.json().mismatches, { KWC: ["dev", "uat"] })
})
