const Redis = require("ioredis")
const redis = new Redis({
  host: "redis",
  port: 6379,
  password: process.env.REDIS_PASSWORD || undefined
})

const KEY = "wa:clients:state"

const STATES = {
  CREATED: "CREATED",
  CONNECTING: "CONNECTING",
  QR_REQUIRED: "QR_REQUIRED",
  CONNECTED: "CONNECTED",
  DISCONNECTED: "DISCONNECTED",
  LOGGED_OUT: "LOGGED_OUT",
  STOPPED: "STOPPED"
}

async function setClientState(clientId, state) {
  await redis.hset(KEY, clientId, state)
}

async function removeClientState(clientId) {
  await redis.hdel(KEY, clientId)
}

// Liveness signal for the alerter: timestamp of the last worker tick.
// Expires on its own, so a dead worker leaves no fresh value behind.
const HEARTBEAT_KEY = "wa:health:worker"
const HEARTBEAT_TTL_SECONDS = 120

async function writeHeartbeat(now = Date.now()) {
  await redis.set(HEARTBEAT_KEY, String(now), "EX", HEARTBEAT_TTL_SECONDS)
}

module.exports = {
  STATES,
  setClientState,
  removeClientState,
  writeHeartbeat,
  HEARTBEAT_KEY
}
