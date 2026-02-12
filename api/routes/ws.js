const { register } = require("../wsHub")
const redis = require("../redis")

module.exports = async function (fastify) {
  fastify.get("/ws", { websocket: true }, async (socket, req) => {
    const { clientId } = req.query

    if (!clientId) {
      socket.close()
      return
    }

    // ✅ Register immediately (NO waiting for message)
    register(clientId, socket)

    try {
      // 1️⃣ Send current state
      const state = await redis.hget("wa:clients:state", clientId)

      socket.send(JSON.stringify({
        type: "status",
        clientId,
        state: state || "NON_EXISTENT"
      }))

      // 2️⃣ Send latest QR if exists
      const qr = await redis.get(`wa:qr:${clientId}`)
      if (qr) {
        socket.send(JSON.stringify({
          type: "qr",
          clientId,
          qr
        }))
      }

    } catch (err) {
      console.error("WS init error", err)
    }
  })
}