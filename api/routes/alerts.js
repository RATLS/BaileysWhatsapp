const redis = require("../redis")

// Watch list for the alerter service (alerter/). Only clients in this set
// produce Google Chat alerts. The alerter reads it on every check, so
// changes take effect within one check interval.
const WATCHED_KEY = "wa:alerts:watched"
const CLIENT_ID_RE = /^[a-zA-Z0-9._:-]{1,120}$/

module.exports = async function (fastify) {
  fastify.get("/alerts/watched", async () => {
    const watched = await redis.smembers(WATCHED_KEY)
    return { watched: (watched || []).sort() }
  })

  fastify.put("/clients/:clientId/alerts/watch", async (req, res) => {
    const { clientId } = req.params
    if (!CLIENT_ID_RE.test(clientId)) {
      return res.code(400).send({ error: "Invalid clientId format" })
    }
    await redis.sadd(WATCHED_KEY, clientId)
    return { ok: true, clientId, watched: true }
  })

  fastify.delete("/clients/:clientId/alerts/watch", async (req, res) => {
    const { clientId } = req.params
    if (!CLIENT_ID_RE.test(clientId)) {
      return res.code(400).send({ error: "Invalid clientId format" })
    }
    await redis.srem(WATCHED_KEY, clientId)
    return { ok: true, clientId, watched: false }
  })
}

module.exports.WATCHED_KEY = WATCHED_KEY
