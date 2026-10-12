const path = require("path")
const test = require("node:test")
const assert = require("node:assert/strict")
const Fastify = require("fastify")

const { loadWithMocks, clearModule } = require("../../test/loadWithMocks")
const { createEnvTagger } = require("../envTagger")

function createRedisMock() {
  const kv = new Map()
  const hashes = new Map()
  const lists = new Map()

  return {
    async get(key) {
      return kv.has(key) ? kv.get(key) : null
    },
    async set(key, value) {
      kv.set(key, value)
      return "OK"
    },
    async hget(key, field) {
      return hashes.get(key)?.get(field) ?? null
    },
    async hset(key, field, value) {
      if (!hashes.has(key)) hashes.set(key, new Map())
      hashes.get(key).set(field, value)
      return 1
    },
    async hgetall(key) {
      return Object.fromEntries(hashes.get(key)?.entries() ?? [])
    },
    async hsetnx(key, field, value) {
      if (hashes.get(key)?.has(field)) return 0
      if (!hashes.has(key)) hashes.set(key, new Map())
      hashes.get(key).set(field, value)
      return 1
    },
    async hdel(key, field) {
      return hashes.get(key)?.delete(field) ? 1 : 0
    },
    async llen(key) {
      return lists.get(key)?.length ?? 0
    },
    async lrange(key, start, end) {
      const values = lists.get(key) ?? []
      return values.slice(start, end + 1)
    },
    async lpush(key, value) {
      if (!lists.has(key)) lists.set(key, [])
      lists.get(key).unshift(value)
      return lists.get(key).length
    },
    async del(key) {
      kv.delete(key)
      lists.delete(key)
      hashes.delete(key)
      return 1
    },
    seedHash(key, entries) {
      hashes.set(key, new Map(Object.entries(entries)))
    },
    seedList(key, values) {
      lists.set(key, [...values])
    }
  }
}

async function buildApp(redis) {
  const modulePath = path.join(__dirname, "..", "routes", "clients.js")
  const plugin = loadWithMocks(modulePath, {
    "../redis": redis
  })

  const app = Fastify()
  app.decorate("envTagger", createEnvTagger(redis, { originMap: new Map() }))
  await app.register(plugin)
  return { app, modulePath }
}

test("GET /config/send-delay returns defaults when config is missing", async (t) => {
  const redis = createRedisMock()
  const { app, modulePath } = await buildApp(redis)
  t.after(async () => {
    await app.close()
    clearModule(modulePath)
  })

  const res = await app.inject({ method: "GET", url: "/config/send-delay" })

  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { minMs: 3000, maxMs: 8000, source: "default" })
})

test("GET /config/send-delay falls back to defaults for malformed redis config", async (t) => {
  const redis = createRedisMock()
  await redis.set("wa:config:sendDelay", JSON.stringify({ minMs: 9000, maxMs: 1000 }))
  const { app, modulePath } = await buildApp(redis)
  t.after(async () => {
    await app.close()
    clearModule(modulePath)
  })

  const res = await app.inject({ method: "GET", url: "/config/send-delay" })

  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { minMs: 3000, maxMs: 8000, source: "default" })
})

test("POST /config/send-delay normalizes allowed bounds", async (t) => {
  const redis = createRedisMock()
  const { app, modulePath } = await buildApp(redis)
  t.after(async () => {
    await app.close()
    clearModule(modulePath)
  })

  const res = await app.inject({
    method: "POST",
    url: "/config/send-delay",
    payload: { minMs: 100, maxMs: 150000 }
  })

  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { ok: true, minMs: 500, maxMs: 120000 })
})

test("POST /config/send-delay rejects invalid payloads", async (t) => {
  const redis = createRedisMock()
  const { app, modulePath } = await buildApp(redis)
  t.after(async () => {
    await app.close()
    clearModule(modulePath)
  })

  const res = await app.inject({
    method: "POST",
    url: "/config/send-delay",
    payload: { minMs: 4000, maxMs: 3000 }
  })

  assert.equal(res.statusCode, 400)
  assert.match(res.json().error, /minMs and maxMs are required integers/)
})

test("POST /clients/:clientId creates a client and enqueues ADD_CLIENT", async (t) => {
  const redis = createRedisMock()
  const { app, modulePath } = await buildApp(redis)
  t.after(async () => {
    await app.close()
    clearModule(modulePath)
  })

  const res = await app.inject({ method: "POST", url: "/clients/client-1" })

  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { ok: true, clientId: "client-1" })
  const clients = await redis.hgetall("wa:clients:state")
  const commands = await redis.lrange("wa:commands", 0, 10)
  assert.equal(clients["client-1"], "CREATED")
  assert.deepEqual(JSON.parse(commands[0]), { type: "ADD_CLIENT", clientId: "client-1" })
})

test("POST /clients/:clientId rejects invalid client ids", async (t) => {
  const redis = createRedisMock()
  const { app, modulePath } = await buildApp(redis)
  t.after(async () => {
    await app.close()
    clearModule(modulePath)
  })

  const res = await app.inject({ method: "POST", url: "/clients/bad id" })

  assert.equal(res.statusCode, 400)
  assert.equal(res.json().error, "Invalid clientId format")
})

test("POST /clients/:clientId returns 409 for existing clients", async (t) => {
  const redis = createRedisMock()
  redis.seedHash("wa:clients:state", { "client-1": "CONNECTED" })
  const { app, modulePath } = await buildApp(redis)
  t.after(async () => {
    await app.close()
    clearModule(modulePath)
  })

  const res = await app.inject({ method: "POST", url: "/clients/client-1" })

  assert.equal(res.statusCode, 409)
  assert.deepEqual(res.json(), {
    error: "Client already exists",
    clientId: "client-1",
    state: "CONNECTED"
  })
})

for (const allowedState of ["LOGGED_OUT", "DISCONNECTED", "STOPPED"]) {
  test(`POST /clients/:clientId/reconnect accepts ${allowedState}`, async (t) => {
    const redis = createRedisMock()
    redis.seedHash("wa:clients:state", { clientA: allowedState })
    const { app, modulePath } = await buildApp(redis)
    t.after(async () => {
      await app.close()
      clearModule(modulePath)
    })

    const res = await app.inject({ method: "POST", url: "/clients/clientA/reconnect" })

    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), { ok: true, clientId: "clientA" })
  })
}

test("POST /clients/:clientId/reconnect rejects unsupported states", async (t) => {
  const redis = createRedisMock()
  redis.seedHash("wa:clients:state", { clientA: "CONNECTED" })
  const { app, modulePath } = await buildApp(redis)
  t.after(async () => {
    await app.close()
    clearModule(modulePath)
  })

  const res = await app.inject({ method: "POST", url: "/clients/clientA/reconnect" })

  assert.equal(res.statusCode, 400)
  assert.equal(res.json().error, "Client must be LOGGED_OUT, DISCONNECTED, or STOPPED")
})

test("GET /clients/:clientId/queue returns parsed and raw rows with bounded limit", async (t) => {
  const redis = createRedisMock()
  redis.seedList("wa:pending:client-1", [
    JSON.stringify({ text: "hello" }),
    "{bad-json}"
  ])
  const { app, modulePath } = await buildApp(redis)
  t.after(async () => {
    await app.close()
    clearModule(modulePath)
  })

  const res = await app.inject({ method: "GET", url: "/clients/client-1/queue?limit=999" })

  assert.equal(res.statusCode, 200)
  assert.equal(res.json().clientId, "client-1")
  assert.equal(res.json().total, 2)
  assert.equal(res.json().limit, 200)
  assert.deepEqual(res.json().messages[0], {
    index: 0,
    raw: JSON.stringify({ text: "hello" }),
    parsed: { text: "hello" }
  })
  assert.equal(res.json().messages[1].parsed, null)
  assert.equal(res.json().offset, 0)
})

test("GET /clients/:clientId/queue pages with offset and keeps absolute indexes", async (t) => {
  const redis = createRedisMock()
  redis.seedList("wa:pending:client-1", ["a", "b", "c", "d", "e"].map((text) => JSON.stringify({ text })))
  const { app, modulePath } = await buildApp(redis)
  t.after(async () => {
    await app.close()
    clearModule(modulePath)
  })

  const res = await app.inject({ method: "GET", url: "/clients/client-1/queue?limit=2&offset=2" })

  assert.equal(res.statusCode, 200)
  assert.equal(res.json().total, 5)
  assert.equal(res.json().offset, 2)
  assert.equal(res.json().returned, 2)
  assert.deepEqual(res.json().messages.map((m) => [m.index, m.parsed.text]), [[2, "c"], [3, "d"]])
})

test("GET /clients/:clientId/queue treats invalid or negative offset as 0 and past-end as empty", async (t) => {
  const redis = createRedisMock()
  redis.seedList("wa:pending:client-1", ["a", "b"].map((text) => JSON.stringify({ text })))
  const { app, modulePath } = await buildApp(redis)
  t.after(async () => {
    await app.close()
    clearModule(modulePath)
  })

  const negative = await app.inject({ method: "GET", url: "/clients/client-1/queue?offset=-5" })
  assert.equal(negative.json().offset, 0)
  assert.equal(negative.json().returned, 2)

  const junk = await app.inject({ method: "GET", url: "/clients/client-1/queue?offset=abc" })
  assert.equal(junk.json().offset, 0)

  const pastEnd = await app.inject({ method: "GET", url: "/clients/client-1/queue?offset=10" })
  assert.equal(pastEnd.json().total, 2)
  assert.equal(pastEnd.json().returned, 0)
  assert.deepEqual(pastEnd.json().messages, [])
})

test("DELETE /clients/:clientId/queue clears queued messages", async (t) => {
  const redis = createRedisMock()
  redis.seedList("wa:pending:client-2", ["a", "b", "c"])
  const { app, modulePath } = await buildApp(redis)
  t.after(async () => {
    await app.close()
    clearModule(modulePath)
  })

  const res = await app.inject({ method: "DELETE", url: "/clients/client-2/queue" })

  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { ok: true, clientId: "client-2", cleared: 3 })
  assert.equal(await redis.llen("wa:pending:client-2"), 0)
})

test("DELETE /clients/:clientId enqueues DELETE_CLIENT and clears the env label", async (t) => {
  const redis = createRedisMock()
  redis.seedHash("wa:clients:env", { "client-1": "prod", "client-2": "dev" })
  redis.seedHash("wa:clients:envMismatch", { "client-1": "dev" })
  const { app, modulePath } = await buildApp(redis)
  t.after(async () => {
    await app.close()
    clearModule(modulePath)
  })

  const res = await app.inject({ method: "DELETE", url: "/clients/client-1" })

  assert.equal(res.statusCode, 200)
  const commands = await redis.lrange("wa:commands", 0, 10)
  assert.deepEqual(JSON.parse(commands[0]), { type: "DELETE_CLIENT", clientId: "client-1" })
  assert.deepEqual(await redis.hgetall("wa:clients:env"), { "client-2": "dev" })
  assert.deepEqual(await redis.hgetall("wa:clients:envMismatch"), {})
})

test("GET /clients/:clientId/logs/persistent returns empty history when the client has no log file", async (t) => {
  const redis = createRedisMock()
  const { app, modulePath } = await buildApp(redis)
  t.after(async () => {
    await app.close()
    clearModule(modulePath)
  })

  const res = await app.inject({
    method: "GET",
    url: "/clients/never-sent-anything-client/logs/persistent?from=2026-10-12&to=2026-10-12"
  })

  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { clientId: "never-sent-anything-client", total: 0, returned: 0, entries: [] })
})

test("GET /clients/:clientId/status returns NON_EXISTENT for unknown clients", async (t) => {
  const redis = createRedisMock()
  const { app, modulePath } = await buildApp(redis)
  t.after(async () => {
    await app.close()
    clearModule(modulePath)
  })

  const res = await app.inject({ method: "GET", url: "/clients/missing/status" })

  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { clientId: "missing", state: "NON_EXISTENT" })
})
