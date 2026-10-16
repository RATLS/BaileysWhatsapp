const test = require("node:test")
const assert = require("node:assert/strict")
const { createGoogleChatSender } = require("../googleChat")

const WEBHOOK = "https://chat.googleapis.com/v1/spaces/TEST/messages?key=k&token=t"

function setup(responses) {
  const calls = []
  const logs = []
  let clock = 0
  const sleeps = []
  const sender = createGoogleChatSender({
    webhookUrl: WEBHOOK,
    minIntervalMs: 1100,
    log: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) },
    now: () => clock,
    sleep: async (ms) => { sleeps.push(ms); clock += ms },
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) })
      const next = responses.shift()
      if (next instanceof Error) throw next
      return { ok: next >= 200 && next < 300, status: next }
    },
  })
  return { sender, calls, logs, sleeps }
}

test("posts plain text without a thread", async () => {
  const { sender, calls } = setup([200])
  assert.equal(await sender.send({ text: "hello" }), true)
  assert.equal(calls[0].url, WEBHOOK)
  assert.deepEqual(calls[0].body, { text: "hello" })
})

test("posts into a thread with the reply option", async () => {
  const { sender, calls } = setup([200])
  await sender.send({ text: "down", threadKey: "kwc-connection-1" })
  assert.equal(calls[0].url, `${WEBHOOK}&messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD`)
  assert.deepEqual(calls[0].body, { text: "down", thread: { threadKey: "kwc-connection-1" } })
})

test("retries rate limits, server errors and network errors, then succeeds", async () => {
  const { sender, calls } = setup([429, 503, new Error("ECONNRESET"), 200])
  assert.equal(await sender.send({ text: "x" }), true)
  assert.equal(calls.length, 4)
})

test("does not retry other client errors and never logs the webhook URL", async () => {
  const { sender, calls, logs } = setup([404])
  assert.equal(await sender.send({ text: "x" }), false)
  assert.equal(calls.length, 1)
  assert.ok(logs.every((l) => !l.includes("token=")))
})

test("gives up after the retry limit", async () => {
  const { sender, calls } = setup([500, 500, 500, 500, 500])
  assert.equal(await sender.send({ text: "x" }), false)
  assert.equal(calls.length, 4)
})

test("keeps at least the minimum interval between messages and preserves order", async () => {
  const { sender, calls, sleeps } = setup([200, 200])
  await Promise.all([sender.send({ text: "first" }), sender.send({ text: "second" })])
  assert.deepEqual(calls.map((c) => c.body.text), ["first", "second"])
  assert.ok(sleeps.includes(1100))
})

test("without a webhook it only logs (dry run)", async () => {
  const logs = []
  const sender = createGoogleChatSender({
    webhookUrl: "",
    minIntervalMs: 0,
    log: { info: (m) => logs.push(m), warn() {}, error() {} },
    fetchImpl: async () => { throw new Error("must not be called") },
  })
  assert.equal(sender.isDryRun, true)
  assert.equal(await sender.send({ text: "hi" }), true)
  assert.match(logs[0], /\[dry-run\].*hi/)
})
