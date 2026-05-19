const { error } = require("./logger")
// No external dependencies needed
const clients = new Map()
// clientId -> Set<WebSocket>
const socketClients = new WeakMap()
const socketsWithCloseHandler = new WeakSet()

function register(clientId, ws) {
  const existingClientId = socketClients.get(ws)
  if (existingClientId === clientId) {
    return
  }

  if (existingClientId) {
    unregister(existingClientId, ws)
  }

  if (!clients.has(clientId)) {
    clients.set(clientId, new Set())
  }

  const clientSockets = clients.get(clientId)
  clientSockets.add(ws)
  socketClients.set(ws, clientId)

  if (!socketsWithCloseHandler.has(ws)) {
    socketsWithCloseHandler.add(ws)
    // Clean up on close using the current subscription, which may change
    // during the socket lifetime if the caller switches clientId.
    ws.on("close", () => {
      const currentClientId = socketClients.get(ws)
      if (currentClientId) {
        unregister(currentClientId, ws)
      }
    })
  }
}

function unregister(clientId, ws) {
  const clientSockets = clients.get(clientId)
  
  if (clientSockets) {
    clientSockets.delete(ws)
    
    // Remove entry if no more sockets
    if (clientSockets.size === 0) {
      clients.delete(clientId)
    }
  }

  if (socketClients.get(ws) === clientId) {
    socketClients.delete(ws)
  }
}

function broadcast(clientId, payload) {
  const clientSockets = clients.get(clientId)

  if (!clientSockets || clientSockets.size === 0) {
    return
  }

  const msg = JSON.stringify(payload)

  for (const ws of clientSockets) {
    try {
      if (ws.readyState === 1) {
        ws.send(msg)
      }
    } catch (err) {
      error(`❌ Failed to send to socket:`, err.message)
    }
  }
}

function getStats() {
  const stats = {}
  for (const [clientId, sockets] of clients.entries()) {
    stats[clientId] = sockets.size
  }
  return stats
}

module.exports = { 
  register, 
  unregister,
  broadcast,
  getStats
}
