const path = require("path")
const test = require("node:test")
const assert = require("node:assert/strict")
const EventEmitter = require("node:events")

const { clearModule } = require("../../test/loadWithMocks")

function loadHub() {
  const modulePath = path.join(__dirname, "..", "wsHub.js")
  clearModule(modulePath)
  const hub = require(modulePath)
  return { hub, modulePath }
}

class FakeSocket extends EventEmitter {
  constructor() {
    super()
    this.readyState = 1
    this.messages = []
  }

  send(message) {
    this.messages.push(JSON.parse(message))
  }
}

test("register moves a socket when it subscribes to a different clientId", (t) => {
  const { hub, modulePath } = loadHub()
  t.after(() => clearModule(modulePath))

  const ws = new FakeSocket()

  hub.register("client-a", ws)
  assert.deepEqual(hub.getStats(), { "client-a": 1 })

  hub.register("client-b", ws)
  assert.deepEqual(hub.getStats(), { "client-b": 1 })

  hub.broadcast("client-a", { type: "status", clientId: "client-a", state: "CONNECTED" })
  assert.equal(ws.messages.length, 0)

  hub.broadcast("client-b", { type: "status", clientId: "client-b", state: "CONNECTED" })
  assert.deepEqual(ws.messages, [
    { type: "status", clientId: "client-b", state: "CONNECTED" }
  ])
})

test("close cleans up the socket's latest subscription", (t) => {
  const { hub, modulePath } = loadHub()
  t.after(() => clearModule(modulePath))

  const ws = new FakeSocket()

  hub.register("client-a", ws)
  hub.register("client-b", ws)
  ws.emit("close")

  assert.deepEqual(hub.getStats(), {})
})
