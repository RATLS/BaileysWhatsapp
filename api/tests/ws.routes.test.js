const path = require("path")
const test = require("node:test")
const assert = require("node:assert/strict")
const EventEmitter = require("node:events")

const { loadWithMocks, clearModule } = require("../../test/loadWithMocks")

class FakeSocket extends EventEmitter {
  constructor() {
    super()
    this.sent = []
  }

  send(message) {
    this.sent.push(JSON.parse(message))
  }

  async receive(payload) {
    const listeners = this.listeners("message")
    await Promise.all(listeners.map((listener) => listener(Buffer.from(JSON.stringify(payload)))))
  }
}

test("websocket route re-subscribes when a socket sends a different clientId", async (t) => {
  const registrations = []
  const tagged = []
  const routePath = path.join(__dirname, "..", "routes", "ws.js")
  const route = loadWithMocks(routePath, {
    "../wsHub": {
      register(clientId, socket) {
        registrations.push({ clientId, socket })
      }
    },
    "../redis": {
      async hget(key, clientId) {
        assert.equal(key, "wa:clients:state")
        return clientId === "client-a" ? "CONNECTED" : "QR_REQUIRED"
      },
      async get() {
        return null
      },
      async llen() {
        return 0
      }
    },
    "../logger": {
      warn() {},
      error() {}
    }
  })
  t.after(() => clearModule(routePath))

  let handler
  await route({
    envTagger: {
      async tagFromHeaders(clientId, headers) {
        tagged.push({ clientId, headers })
      }
    },
    get(pathName, options, routeHandler) {
      assert.equal(pathName, "/ws")
      assert.deepEqual(options, { websocket: true })
      handler = routeHandler
    }
  })

  const socket = new FakeSocket()
  const headers = { origin: "https://institute.reachandteach.in" }
  handler(socket, { headers })

  await socket.receive({ type: "ping", clientId: "client-a" })
  await socket.receive({ type: "ping", clientId: "client-b" })

  assert.deepEqual(registrations.map((entry) => entry.clientId), ["client-a", "client-b"])
  assert.equal(registrations[0].socket, socket)
  assert.equal(registrations[1].socket, socket)
  assert.deepEqual(socket.sent.filter((message) => message.type === "status"), [
    { type: "status", clientId: "client-a", state: "CONNECTED", queueCount: 0 },
    { type: "status", clientId: "client-b", state: "QR_REQUIRED", queueCount: 0 }
  ])
  // Env tagging runs once per subscription, with the upgrade request headers.
  assert.deepEqual(tagged, [
    { clientId: "client-a", headers },
    { clientId: "client-b", headers }
  ])
})
