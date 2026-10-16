import path from "path"
import { fileURLToPath } from "url"
import express from "express"
import basicAuth from "basic-auth"
import Docker from "dockerode"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const distPath = path.resolve(__dirname, "../dist")

const app = express()
const docker = new Docker({ socketPath: "/var/run/docker.sock" })

const DASH_USER = process.env.DASH_USER || "admin"
const DASH_PASS = process.env.DASH_PASS || "admin"
const PORT = Number(process.env.DASH_PORT || 8080)
const LOG_SERVICES = (process.env.DASH_LOG_SERVICES || "worker,api,redis,dashboard")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
const LOG_TAIL_DEFAULT = 200
const LOG_TAIL_MAX = 2000

function authMiddleware(req, res, next) {
  const creds = basicAuth(req)
  if (!creds || creds.name !== DASH_USER || creds.pass !== DASH_PASS) {
    res.set("WWW-Authenticate", "Basic realm=BaileysDashboard")
    return res.status(401).send("Authentication required")
  }
  return next()
}

function matchContainer(name, service) {
  const n = name.replace(/^\//, "")
  return (
    n.includes(`_${service}_`) ||
    n.includes(`-${service}-`) ||
    n === service ||
    n.endsWith(`_${service}_1`) ||
    n.endsWith(`-${service}-1`) ||
    n.endsWith(`${service}_1`) ||
    n.endsWith(`${service}-1`)
  )
}

// Containers without a TTY return logs multiplexed: each frame is an
// 8-byte header [stream, 0, 0, 0, size(uint32 BE)] followed by payload.
// Strip the headers; return TTY (unframed) output unchanged.
function demuxDockerLogs(buf) {
  const parts = []
  let offset = 0
  while (offset + 8 <= buf.length) {
    const streamType = buf[offset]
    const isHeader = streamType <= 2 && buf[offset + 1] === 0 && buf[offset + 2] === 0 && buf[offset + 3] === 0
    if (!isHeader) return buf.toString("utf-8")
    const size = buf.readUInt32BE(offset + 4)
    parts.push(buf.subarray(offset + 8, offset + 8 + size))
    offset += 8 + size
  }
  return offset === buf.length ? Buffer.concat(parts).toString("utf-8") : buf.toString("utf-8")
}

async function findContainer(service) {
  const containers = await docker.listContainers({ all: true })
  const running = containers.filter((c) => c.State === "running")
  const pool = running.length ? running : containers

  for (const c of pool) {
    if (c.Names && c.Names.some((n) => matchContainer(n, service))) {
      return docker.getContainer(c.Id)
    }
  }

  return null
}

app.use(authMiddleware)
app.use(express.json())

app.get("/api/health", (_req, res) => {
  res.json({ ok: true })
})

app.get("/api/logs/services", (_req, res) => {
  res.json({ services: LOG_SERVICES, tailDefault: LOG_TAIL_DEFAULT, tailMax: LOG_TAIL_MAX })
})

app.get("/api/logs", async (req, res) => {
  const service = String(req.query.service || LOG_SERVICES[0])
  const requestedTail = Number(req.query.tail || LOG_TAIL_DEFAULT)
  const tail = Number.isFinite(requestedTail)
    ? Math.min(Math.max(Math.floor(requestedTail), 1), LOG_TAIL_MAX)
    : LOG_TAIL_DEFAULT

  if (!LOG_SERVICES.includes(service)) {
    return res.status(400).send("Invalid service")
  }

  try {
    const container = await findContainer(service)
    if (!container) {
      return res.status(404).send(`Container not found for service: ${service}`)
    }

    const stream = await container.logs({
      stdout: true,
      stderr: true,
      tail,
      timestamps: false
    })

    if (Buffer.isBuffer(stream) || typeof stream === "string") {
      const text = Buffer.isBuffer(stream) ? demuxDockerLogs(stream) : stream
      return res.type("text/plain").send(text)
    }

    const chunks = []
    stream.on("data", (chunk) => chunks.push(chunk))
    stream.on("end", () => {
      res.type("text/plain").send(demuxDockerLogs(Buffer.concat(chunks)))
    })
    stream.on("error", (err) => {
      res.status(500).send(`Failed to read logs: ${err && err.message ? err.message : "unknown error"}`)
    })
  } catch (err) {
    res.status(500).send(`Failed to read logs: ${err && err.message ? err.message : "unknown error"}`)
  }
})

app.use(express.static(distPath))
app.get("*", (_req, res) => {
  res.sendFile(path.join(distPath, "index.html"))
})

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Dashboard server running on :${PORT}`)
})
