const { ENVS, CLIENT_ID_RE } = require("../envTagger")

module.exports = async function (fastify) {
  const envTagger = fastify.envTagger

  fastify.get("/debug/client-envs", async () => {
    const { envs, mismatches } = await envTagger.list()
    return {
      envs,
      mismatches,
      timestamp: new Date().toISOString()
    }
  })

  // Manual override from the dashboard. Clears any recorded mismatch.
  fastify.put("/clients/:clientId/env", async (req, res) => {
    const { clientId } = req.params
    if (!CLIENT_ID_RE.test(clientId)) {
      return res.code(400).send({ error: "Invalid clientId format" })
    }

    const env = req.body && typeof req.body.env === "string" ? req.body.env.trim().toLowerCase() : ""
    if (!ENVS.includes(env)) {
      return res.code(400).send({ error: `env must be one of: ${ENVS.join(", ")}` })
    }

    await envTagger.setEnv(clientId, env)
    return { ok: true, clientId, env }
  })

  // Removes the label; the next request from a backend/frontend labels it again.
  fastify.delete("/clients/:clientId/env", async (req, res) => {
    const { clientId } = req.params
    if (!CLIENT_ID_RE.test(clientId)) {
      return res.code(400).send({ error: "Invalid clientId format" })
    }

    await envTagger.forget(clientId)
    return { ok: true, clientId }
  })
}
