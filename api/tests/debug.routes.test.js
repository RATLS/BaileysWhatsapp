const path = require("path")
const test = require("node:test")
const assert = require("node:assert/strict")
const Fastify = require("fastify")

const { loadWithMocks, clearModule } = require("../../test/loadWithMocks")

async function buildApp(redis) {
  const modulePath = path.join(__dirname, "..", "routes", "debug-routes.js")
  const plugin = loadWithMocks(modulePath, {
    "../redis": redis,
    "../wsHub": { getStats: () => ({}) }
  })

  const app = Fastify()
  await app.register(plugin)
  return { app, modulePath }
}

test("GET /debug/queue-counts returns per-client queue length and total in one call", async (t) => {
  const lists = { "wa:pending:client-a": 3, "wa:pending:client-b": 0, "wa:pending:client-c": 12 }
  const redis = {
    async hgetall(key) {
      assert.equal(key, "wa:clients:state")
      return { "client-a": "CONNECTED", "client-b": "STOPPED", "client-c": "QR_REQUIRED" }
    },
    async llen(key) {
      return lists[key] ?? 0
    }
  }
  const { app, modulePath } = await buildApp(redis)
  t.after(async () => {
    await app.close()
    clearModule(modulePath)
  })

  const res = await app.inject({ method: "GET", url: "/debug/queue-counts" })

  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json().counts, { "client-a": 3, "client-b": 0, "client-c": 12 })
  assert.equal(res.json().total, 15)
})

test("GET /debug/queue-counts handles no clients", async (t) => {
  const redis = {
    async hgetall() {
      return {}
    },
    async llen() {
      throw new Error("should not be called")
    }
  }
  const { app, modulePath } = await buildApp(redis)
  t.after(async () => {
    await app.close()
    clearModule(modulePath)
  })

  const res = await app.inject({ method: "GET", url: "/debug/queue-counts" })

  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json().counts, {})
  assert.equal(res.json().total, 0)
})
