const { warn } = require("./logger")

const ENV_KEY = "wa:clients:env"
const MISMATCH_KEY = "wa:clients:envMismatch"
const ENVS = ["dev", "test", "uat", "prod"]
const CLIENT_ID_RE = /^[a-zA-Z0-9._:-]{1,120}$/

// Backend Lambdas send their own function name, e.g. "CRMProd-RatlsWhatsapp".
const SOURCE_RE = /^CRM(Dev|Test|Uat|Prod)-/i

// Only requests on these routes label a client. Dashboard-only routes
// (env edit, client delete, logs) are deliberately left out.
const TAGGED_ROUTES = new Set([
  "POST /messages/send",
  "POST /clients/:clientId",
  "POST /clients/:clientId/reconnect",
  "POST /clients/:clientId/restart",
  "POST /clients/:clientId/stop",
  "GET /clients/:clientId/queue",
  "DELETE /clients/:clientId/queue",
  "GET /clients/:clientId/status"
])

function normalizeOrigin(origin) {
  return String(origin).trim().replace(/\/+$/, "").toLowerCase()
}

// ENV_ORIGINS format: "https://app.example.in=prod,https://dev.example.in=dev"
function parseOriginMap(raw) {
  const map = new Map()
  if (!raw) return map

  for (const pair of String(raw).split(",")) {
    const idx = pair.lastIndexOf("=")
    if (idx <= 0) continue
    const origin = normalizeOrigin(pair.slice(0, idx))
    const env = pair.slice(idx + 1).trim().toLowerCase()
    if (!origin || !ENVS.includes(env)) {
      warn("⚠️ Ignoring invalid ENV_ORIGINS entry", pair.trim())
      continue
    }
    map.set(origin, env)
  }

  return map
}

function detectEnv(headers, originMap) {
  if (!headers) return null

  const source = headers["x-source"]
  if (typeof source === "string") {
    const match = SOURCE_RE.exec(source.trim())
    if (match) return match[1].toLowerCase()
  }

  const origin = headers.origin
  if (typeof origin === "string" && originMap.size) {
    const env = originMap.get(normalizeOrigin(origin))
    if (env) return env
  }

  return null
}

function createEnvTagger(redis, { originMap = parseOriginMap(process.env.ENV_ORIGINS) } = {}) {
  // clientId -> { env, others: Set<env> }. Once a client is here, repeat
  // requests from the same env cost no Redis call at all.
  const known = new Map()

  async function tag(clientId, env) {
    if (!env || typeof clientId !== "string" || !CLIENT_ID_RE.test(clientId)) return

    try {
      let entry = known.get(clientId)

      if (!entry) {
        const created = await redis.hsetnx(ENV_KEY, clientId, env)
        if (created === 1) {
          known.set(clientId, { env, others: new Set() })
          return
        }

        const [current, others] = await Promise.all([
          redis.hget(ENV_KEY, clientId),
          redis.hget(MISMATCH_KEY, clientId)
        ])
        if (!current) {
          await redis.hset(ENV_KEY, clientId, env)
          known.set(clientId, { env, others: new Set() })
          return
        }
        entry = { env: current, others: new Set(others ? others.split(",") : []) }
        known.set(clientId, entry)
      }

      if (entry.env === env || entry.others.has(env)) return

      // First label wins; record the other env instead of overwriting.
      entry.others.add(env)
      await redis.hset(MISMATCH_KEY, clientId, [...entry.others].join(","))
      warn(`⚠️ Env mismatch for ${clientId}: labelled ${entry.env}, also used by ${env}`)
    } catch (err) {
      warn(`⚠️ Failed to tag env for ${clientId}:`, err && err.message ? err.message : err)
    }
  }

  async function tagFromHeaders(clientId, headers) {
    await tag(clientId, detectEnv(headers, originMap))
  }

  async function setEnv(clientId, env) {
    await redis.hset(ENV_KEY, clientId, env)
    await redis.hdel(MISMATCH_KEY, clientId)
    known.set(clientId, { env, others: new Set() })
  }

  async function forget(clientId) {
    await redis.hdel(ENV_KEY, clientId)
    await redis.hdel(MISMATCH_KEY, clientId)
    known.delete(clientId)
  }

  async function list() {
    const [envs, rawMismatches] = await Promise.all([
      redis.hgetall(ENV_KEY),
      redis.hgetall(MISMATCH_KEY)
    ])
    const mismatches = {}
    for (const [clientId, value] of Object.entries(rawMismatches || {})) {
      mismatches[clientId] = value ? value.split(",") : []
    }
    return { envs: envs || {}, mismatches }
  }

  function registerHook(fastify) {
    fastify.addHook("onResponse", async (req, reply) => {
      if (reply.statusCode >= 400) return
      const route = req.routeOptions && req.routeOptions.url
      if (!TAGGED_ROUTES.has(`${req.method} ${route}`)) return
      const clientId = (req.params && req.params.clientId) || (req.body && req.body.clientId)
      await tagFromHeaders(clientId, req.headers)
    })
  }

  return { tag, tagFromHeaders, setEnv, forget, list, registerHook }
}

module.exports = {
  ENV_KEY,
  MISMATCH_KEY,
  ENVS,
  CLIENT_ID_RE,
  parseOriginMap,
  detectEnv,
  createEnvTagger
}
