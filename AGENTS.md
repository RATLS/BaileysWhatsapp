# AGENTS.md

This document is the operational source of truth for agents working in this repository.

## Scope

- Keep docs and behavior aligned with the current codebase.
- Favor stability and operational safety over feature speed.
- Do not silently change message delivery guarantees.

---

## Agent Docs Location

- Store repo-specific agent markdown files in `agents/`.
- Keep one concern per file so agents stay easy to discover and maintain.
- When a new agent is added, update this section and `README.md` if the workflow is user-facing.

Current agent docs:

- `agents/testing-agent.md`: focused testing agent for API, worker, queue, and lifecycle validation
- `agents/review-agent.md`: focused review agent for correctness, regressions, and contract compliance

---

## Agent Activation

When a task explicitly mentions an agent from `agents/`, load and follow that agent’s full specification in addition to this file.

Available agents:

- `testing-agent` → `agents/testing-agent.md`
- `review-agent` → `agents/review-agent.md`

Activation rules:

- If the prompt includes:
  - "use testing-agent"
  - "testing agent"
  - "validate tests"
  - "use review-agent"
  - "review agent"
  - "review this change"
- Then you MUST:
  - Read the matching agent file in `agents/`
  - Follow its execution loop, decision rules, and constraints strictly

Agent behavior rules:

- Agent-specific rules override general heuristics
- Agents MUST NOT violate Critical Runtime Contracts defined in this file

---

## Rule Priority

1. Critical Runtime Contracts (this file)
2. Activated Agent (e.g., `testing-agent.md`)
3. General best practices

---

## System Summary

Services:

- `proxy`: Nginx TLS terminator for HTTPS/WSS origin traffic
- `worker`: Baileys socket lifecycle + outbound sender loops
- `api`: Fastify routes + websocket gateway + stream consumer
- `redis`: command/state/queue/event store
- `dashboard`: operations UI + server for container log access
- `alerter`: Google Chat alerts for watched clients (read-only towards worker/API keys)

Primary event path is Redis Streams (`wa:events:stream`). Pub/sub files exist but are legacy.

---

## Critical Runtime Contracts

### 1) Queue Reliability Contract

Must remain true unless explicitly approved otherwise:

1. Outbound jobs are enqueued to `wa:pending:<clientId>`.
2. Worker sender loop must not pop from queue unless client is connected.
3. Jobs remain in queue while client is uninitialized/disconnected.
4. Sending is sequential (one message at a time).
5. Random delay between sends is preserved. Runtime config may change the min/max bounds, but a fallback delay must exist if config is missing or invalid.
6. Send failure after dequeue must re-queue the job.

---

### 2) Client Lifecycle Contract

Current states in Redis hash `wa:clients:state`:

- `CREATED`, `CONNECTING`, `QR_REQUIRED`, `CONNECTED`, `DISCONNECTED`, `LOGGED_OUT`, `STOPPED`

Important transitions:

- `POST /clients/:clientId` sets up logical client and enqueues `ADD_CLIENT`
- worker startup should rehydrate non-`STOPPED`, non-`LOGGED_OUT` clients from Redis state and persisted session folders
- `401`/logout -> `LOGGED_OUT` + session clear + auto reinit
- ordinary disconnects should preserve the existing session during reconnect attempts; `405`/`408`/`428` are known transport-recoverable examples and use the slower backoff path
- repeated `DISCONNECTED` beyond retry cap -> continue reconnect attempts with the existing session; do not force session clear
- `STOP_CLIENT` -> `STOPPED` with no auto-reconnect

---

### 3) Message Log Contract

Must remain true unless explicitly approved otherwise:

1. Every dequeued job must produce a `wa:msglog:<clientId>` entry — on success (`status: "sent"`) and on failure (`status: "failed"`, with `failReason`).
2. Logging errors must be caught and warned; they must never propagate to delivery or requeue logic.
3. `deleteClient` must NOT delete `wa:msglog:<clientId>` — message history persists until TTL trimming removes all entries.
4. Entries older than 7 days are trimmed inline via `ZREMRANGEBYSCORE` on every write.

---

### 4) Stream Consumer Contract

`api/streamConsumer.js` must:

- consume from `wa:events:stream` consumer group
- validate payload shape before broadcast
- ack successful messages
- move poison messages to DLQ stream (`wa:events:dlq` default)
- recover stale pending with `XAUTOCLAIM`

---

## API Contracts to Preserve

- `POST /clients/:clientId`
  - validates `clientId`
  - returns `409` for existing client (no state reset)
- `GET /config/send-delay`
- `POST /config/send-delay`
  - validates `minMs`/`maxMs`
  - must preserve a safe fallback if config is absent or malformed
- `POST /messages/send`
  - validates body, file structure, and non-empty content
- Queue endpoints:
  - `GET /clients/:clientId/queue?limit=<1..200>&offset=<n>`
    - read-only; `offset` optional (default/invalid → `0`); returns `{ clientId, total, returned, limit, offset, messages[] }`
    - `messages[].index` is absolute from the head; send position = `total - index`
  - `DELETE /clients/:clientId/queue`
- Message log endpoint:
  - `GET /clients/:clientId/messages/log?limit=<1..200>&before=<timestamp_ms>`
  - returns `{ clientId, total, returned, limit, messages[] }` newest-first
  - malformed entries returned as `{ raw, parseError: true }` — never throws
- Environment labels (`api/envTagger.js`, `api/routes/clientEnv.js`):
  - detected only from `X-Source` (`CRM<Env>-…` Lambda name) or `Origin` via `ENV_ORIGINS`; never from the `clientId`
  - label set once (`HSETNX`), never auto-overwritten; conflicts go to `wa:clients:envMismatch`
  - tagging must never block, fail, or alter a request (errors are warned and swallowed)
  - `GET /debug/client-envs`, `PUT /clients/:clientId/env`, `DELETE /clients/:clientId/env`
- `GET /debug/queue-counts` returns `{ counts, total }` for all clients in one call
- Alert watch list (`api/routes/alerts.js`):
  - `GET /alerts/watched`, `PUT /clients/:clientId/alerts/watch`, `DELETE /clients/:clientId/alerts/watch`
  - `DELETE /clients/:clientId` also removes the client from `wa:alerts:watched`

## Alerter Contract (`alerter/`)

- Must stay read-only towards keys owned by the worker/API (state, queues, msglog, env, heartbeat). It writes only
  `wa:alerts:open`, `wa:alerts:dailyOkDate`, `wa:alerts:dlqSeen` and its own consumer group `alerters`.
- System alerts (API, Redis, worker heartbeat, Redis memory, disk, dead-letter growth) are always on; they close
  only on positive proof of health. The alerter must start and alert even when Redis is down: no start-up step may
  wait on Redis, and Redis writes from system-alert handling must be time-limited.
- After a detected machine pause (clock watcher), new system alerts are held for `ALERT_RESUME_GRACE_MS`.
- No Docker socket in the alerter (deliberate); disk is measured through read-only mounts only.
- The worker's `wa:health:worker` write (in its existing 30 s tick) must never throw or block the worker.
- Its consumer group is independent of `api-consumers`; it must never ack or claim for other groups.
- Only clients in `wa:alerts:watched` produce alerts. One message per open problem; recovery goes to the same thread.
- An alert is recorded open only after Google Chat accepted it.
- `GOOGLE_CHAT_WEBHOOK_URL` is a secret: only from `.env`, never logged, never committed. Empty = dry run.
- Local testing must use a private test space or dry run — never a team space.

---

## Dashboard UX Contracts to Preserve

- No duplicate bottom "selected client actions" block.
- Client row is primary control area.
- Queue panel supports:
  - per-row queue view/clear
  - shows the whole queue (paged loading) in send order, `#1` = sent next
- Message log panel (separate window from queue):
  - "Logs" on client row loads the most recent 100 entries, "Load more" pages older ones
  - status badge distinguishes `sent` vs `failed` visually
- The arbitrary-`clientId` lookup box was removed on request (2026-10-12); queue/logs/history open from client rows only.
  The API endpoints still accept any `clientId`.
- Every mutating action reports success or the API error text (toast); no silent failures.
- Session-wiping actions (Reset + Restart / Reset + Stop) and Delete require confirmation.
- Row actions are state-aware (Reconnect only for `DISCONNECTED`/`LOGGED_OUT`/`STOPPED`, Stop hidden for `STOPPED`).
- Dashboard tunables live in `dashboard/src/config.js` (`VITE_*` overrides); don't hardcode them in components.
- Newer endpoints must degrade gracefully on older APIs (404 → feature off, no repeated errors).
- QR linking uses the existing API websocket (`/ws`), not a new endpoint; the "Show QR" button can be hidden
  via Settings → Dashboard options.
- Dashboard on/off options are declared in `DASHBOARD_OPTIONS` (`dashboard/src/config.js`), stored per browser;
  add new options there rather than ad-hoc localStorage keys.

---

## Canonical Keys

- `wa:clients:state`
- `wa:commands`
- `wa:pending:<clientId>`
- `wa:qr:<clientId>`
- `wa:clients:active`
- `wa:events:stream`
- `wa:events:dlq`
- `wa:config:sendDelay`
- `wa:msglog:<clientId>` — Redis sorted set; score = Unix ms timestamp; member = JSON `{ phoneNumber, sentAt, status, text, fileCount, failReason? }`; entries older than 7 days are trimmed inline on each write; NOT deleted on client delete
- `wa:clients:env` — Redis hash `clientId -> dev|test|uat|prod`; set once by the API; deleted on client delete
- `wa:clients:envMismatch` — Redis hash `clientId -> comma-separated other envs`; warning only; deleted on client delete or manual env set
- `wa:alerts:watched` — Redis set of watched clientIds; written by the API; removed on client delete
- `wa:alerts:open` — Redis hash `clientId|kind -> JSON` of open alerts (incl. Google Chat thread key); owned by the alerter
- `wa:alerts:dailyOkDate` — Redis string, last daily "all OK" date; owned by the alerter
- `wa:alerts:dlqSeen` — Redis string, last reported `wa:events:dlq` length; owned by the alerter
- `wa:health:worker` — Redis string, worker's last tick (Unix ms), `EX 120`; written by the worker, read by the alerter
- consumer group `alerters` on `wa:events:stream` — owned by the alerter

---

## Files to Review First Before Any Change

1. `worker/socketManager.js`
2. `worker/startupRehydrate.js`
3. `worker/mediaSender.js`
4. `api/streamConsumer.js`
5. `api/routes/clients.js`
6. `api/routes/messages.js`
7. `dashboard/src/App.jsx`, `dashboard/src/config.js`, `dashboard/src/components/`
8. `api/envTagger.js`, `alerter/alerter.js`, `alerter/rules.js`
9. `api/tests/*.test.js` (includes `messageLogs.routes.test.js`, `envTagger.test.js`)
10. `worker/tests/*.test.js`

---

## Change Checklist (Mandatory)

When changing queue/state/event behavior:

1. Update tests or add focused validation steps.
2. Update `README.md` and this `AGENTS.md` in same PR.
3. Document migration/rollback risk in PR description.
4. Keep changes backward-compatible unless explicitly approved.

---

## Testing Baseline

- API tests run with `cd api && npm test`.
- Worker tests run with `cd worker && npm test`.
- Alerter tests run with `cd alerter && npm test`.
- Current automated coverage includes:
  - API config, client, queue, and message validation routes
  - stream consumer payload validation, ack flow, and DLQ handling
  - worker disconnect handling for `401`, `405`, `408`, `428`, ordinary disconnect retries, retry-cap persistence, sender-loop requeue behavior, and startup rehydration
  - message log write on successful send and on failure (including `failReason`)
  - message log errors do not block delivery or requeue
  - message log API: pagination, limit clamping, `before` cursor, field shapes, malformed-entry handling
  - queue `offset` paging, `/debug/queue-counts`
  - environment labels: detection, label-once, mismatch, ignored callers, error swallowing, manual routes, delete cleanup, websocket tagging
  - alert watch routes; alerter rules, delivery, threading, batching, restart safety, daily OK, Google Chat retries/dry run
  - alerter system checks: API/Redis/worker down, Redis memory, disk (grouped per disk), dead-letter growth, no false recovery
- Prefer adding focused tests beside the changed surface before expanding broader integration coverage.

---

## Current Known Risks (for planning)

- API/WS authentication is not implemented.
- Redis host config is hardcoded in several modules.
- Outbound queue has requeue-on-failure but no retry cap/outbound DLQ.
