const path = require("path")
const test = require("node:test")
const assert = require("node:assert/strict")
const Fastify = require("fastify")

const { loadWithMocks, clearModule } = require("../../test/loadWithMocks")

function createRedisMock() {
  const lists = new Map()
  return {
    async lpush(key, value) {
      if (!lists.has(key)) lists.set(key, [])
      lists.get(key).unshift(value)
      return lists.get(key).length
    },
    async lrange(key, start, end) {
      return (lists.get(key) ?? []).slice(start, end + 1)
    }
  }
}

async function buildApp(redis) {
  const modulePath = path.join(__dirname, "..", "routes", "messages.js")
  const plugin = loadWithMocks(modulePath, {
    "../redis": redis
  })
  const app = Fastify()
  await app.register(plugin)
  return { app, modulePath }
}

test("POST /messages/send queues trimmed text messages", async (t) => {
  const redis = createRedisMock()
  const { app, modulePath } = await buildApp(redis)
  t.after(async () => {
    await app.close()
    clearModule(modulePath)
  })

  const res = await app.inject({
    method: "POST",
    url: "/messages/send",
    payload: {
      clientId: "client-1",
      phoneNumber: "9999999999",
      text: "  hello  "
    }
  })

  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { ok: true, queued: true })
  const rows = await redis.lrange("wa:pending:client-1", 0, 10)
  assert.deepEqual(JSON.parse(rows[0]), {
    type: "SEND_MESSAGE",
    clientId: "client-1",
    phoneNumber: "919999999999",
    text: "hello",
    files: []
  })
})

test("POST /messages/send accepts international numbers and queues E.164", async (t) => {
  const redis = createRedisMock()
  const { app, modulePath } = await buildApp(redis)
  t.after(async () => {
    await app.close()
    clearModule(modulePath)
  })

  const res = await app.inject({
    method: "POST",
    url: "/messages/send",
    payload: {
      clientId: "client-uk",
      phoneNumber: "447598328056",
      text: "hi"
    }
  })

  assert.equal(res.statusCode, 200)
  const rows = await redis.lrange("wa:pending:client-uk", 0, 10)
  assert.equal(JSON.parse(rows[0]).phoneNumber, "447598328056")
})

test("POST /messages/send sanitizes formatting and respects existing country code", async (t) => {
  const redis = createRedisMock()
  const { app, modulePath } = await buildApp(redis)
  t.after(async () => {
    await app.close()
    clearModule(modulePath)
  })

  const res = await app.inject({
    method: "POST",
    url: "/messages/send",
    payload: {
      clientId: "client-fmt",
      phoneNumber: "+91 96996-05540",
      text: "hi"
    }
  })

  assert.equal(res.statusCode, 200)
  const rows = await redis.lrange("wa:pending:client-fmt", 0, 10)
  assert.equal(JSON.parse(rows[0]).phoneNumber, "919699605540")
})

test("POST /messages/send rejects invalid phone numbers with 400", async (t) => {
  const redis = createRedisMock()
  const { app, modulePath } = await buildApp(redis)
  t.after(async () => {
    await app.close()
    clearModule(modulePath)
  })

  const res = await app.inject({
    method: "POST",
    url: "/messages/send",
    payload: {
      clientId: "client-bad",
      phoneNumber: "abc123",
      text: "hi"
    }
  })

  assert.equal(res.statusCode, 400)
  assert.match(res.json().error, /phoneNumber/)
})

test("POST /messages/send rejects too-short numbers with 400", async (t) => {
  const redis = createRedisMock()
  const { app, modulePath } = await buildApp(redis)
  t.after(async () => {
    await app.close()
    clearModule(modulePath)
  })

  const res = await app.inject({
    method: "POST",
    url: "/messages/send",
    payload: {
      clientId: "client-short",
      phoneNumber: "12345",
      text: "hi"
    }
  })

  assert.equal(res.statusCode, 400)
})

test("POST /messages/send queues file-only messages", async (t) => {
  const redis = createRedisMock()
  const { app, modulePath } = await buildApp(redis)
  t.after(async () => {
    await app.close()
    clearModule(modulePath)
  })

  const res = await app.inject({
    method: "POST",
    url: "/messages/send",
    payload: {
      clientId: "client-2",
      phoneNumber: "9999999999",
      files: [{ file_url: "https://example.com/a.pdf", mimeType: "application/pdf" }]
    }
  })

  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { ok: true, queued: true })
})

test("POST /messages/send rejects missing required fields", async (t) => {
  const redis = createRedisMock()
  const { app, modulePath } = await buildApp(redis)
  t.after(async () => {
    await app.close()
    clearModule(modulePath)
  })

  const res = await app.inject({
    method: "POST",
    url: "/messages/send",
    payload: { text: "hello" }
  })

  assert.equal(res.statusCode, 400)
  assert.equal(res.json().error, "Missing fields")
})

test("POST /messages/send rejects non-array files", async (t) => {
  const redis = createRedisMock()
  const { app, modulePath } = await buildApp(redis)
  t.after(async () => {
    await app.close()
    clearModule(modulePath)
  })

  const res = await app.inject({
    method: "POST",
    url: "/messages/send",
    payload: {
      clientId: "client-1",
      phoneNumber: "9999999999",
      files: {}
    }
  })

  assert.equal(res.statusCode, 400)
  assert.equal(res.json().error, "files must be an array")
})

test("POST /messages/send rejects invalid file entries", async (t) => {
  const redis = createRedisMock()
  const { app, modulePath } = await buildApp(redis)
  t.after(async () => {
    await app.close()
    clearModule(modulePath)
  })

  const res = await app.inject({
    method: "POST",
    url: "/messages/send",
    payload: {
      clientId: "client-1",
      phoneNumber: "9999999999",
      files: [{ file_url: "", mimeType: "image/png" }]
    }
  })

  assert.equal(res.statusCode, 400)
  assert.equal(res.json().error, "Each file requires non-empty file_url and mimeType")
})

test("POST /messages/send rejects empty text when no files are present", async (t) => {
  const redis = createRedisMock()
  const { app, modulePath } = await buildApp(redis)
  t.after(async () => {
    await app.close()
    clearModule(modulePath)
  })

  const res = await app.inject({
    method: "POST",
    url: "/messages/send",
    payload: {
      clientId: "client-1",
      phoneNumber: "9999999999",
      text: "   "
    }
  })

  assert.equal(res.statusCode, 400)
  assert.equal(res.json().error, "Nothing to send")
})
