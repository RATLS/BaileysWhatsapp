const path = require("path")
const test = require("node:test")
const assert = require("node:assert/strict")
const Fastify = require("fastify")

const { loadWithMocks, clearModule } = require("../../test/loadWithMocks")

function createRedisMock() {
  const sets = new Map()
  return {
    async sadd(key, member) {
      if (!sets.has(key)) sets.set(key, new Set())
      sets.get(key).add(member)
      return 1
    },
    async srem(key, member) {
      return sets.get(key)?.delete(member) ? 1 : 0
    },
    async smembers(key) {
      return [...(sets.get(key) ?? [])]
    },
  }
}

async function buildApp(redis) {
  const modulePath = path.join(__dirname, "..", "routes", "alerts.js")
  const plugin = loadWithMocks(modulePath, { "../redis": redis })
  const app = Fastify()
  await app.register(plugin)
  return { app, modulePath }
}

test("watch, list and unwatch clients for alerts", async (t) => {
  const redis = createRedisMock()
  const { app, modulePath } = await buildApp(redis)
  t.after(async () => {
    await app.close()
    clearModule(modulePath)
  })

  const empty = await app.inject({ method: "GET", url: "/alerts/watched" })
  assert.deepEqual(empty.json(), { watched: [] })

  const watchB = await app.inject({ method: "PUT", url: "/clients/KWC-B/alerts/watch" })
  await app.inject({ method: "PUT", url: "/clients/KWC-A/alerts/watch" })
  await app.inject({ method: "PUT", url: "/clients/KWC-A/alerts/watch" })
  assert.equal(watchB.statusCode, 200)
  assert.deepEqual(watchB.json(), { ok: true, clientId: "KWC-B", watched: true })

  const listed = await app.inject({ method: "GET", url: "/alerts/watched" })
  assert.deepEqual(listed.json(), { watched: ["KWC-A", "KWC-B"] })

  const unwatch = await app.inject({ method: "DELETE", url: "/clients/KWC-A/alerts/watch" })
  assert.deepEqual(unwatch.json(), { ok: true, clientId: "KWC-A", watched: false })
  assert.deepEqual((await app.inject({ method: "GET", url: "/alerts/watched" })).json(), { watched: ["KWC-B"] })
})

test("watch routes reject invalid client ids", async (t) => {
  const redis = createRedisMock()
  const { app, modulePath } = await buildApp(redis)
  t.after(async () => {
    await app.close()
    clearModule(modulePath)
  })

  const put = await app.inject({ method: "PUT", url: "/clients/bad%20id/alerts/watch" })
  const del = await app.inject({ method: "DELETE", url: "/clients/bad%20id/alerts/watch" })
  assert.equal(put.statusCode, 400)
  assert.equal(del.statusCode, 400)
  assert.deepEqual(await redis.smembers("wa:alerts:watched"), [])
})
