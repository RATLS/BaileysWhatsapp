# Baileys WhatsApp Worker + API

Redis-orchestrated WhatsApp backend built around Baileys, Fastify, and a small operations dashboard.

This README is intended to be enough to understand the codebase before making changes. It documents the actual runtime model, data contracts, operational defaults, and the files that own each behavior.

For a beginner-friendly visual walkthrough, open [`docs/system-architecture.html`](docs/system-architecture.html) in a browser. It introduces Redis, Baileys, and Docker in plain language, then lets you explore the services, message flows, client lifecycle, Redis keys, and API routes.

## 1) What This Repo Does

The system manages multiple WhatsApp clients identified by `clientId`.

For each client, the platform can:

- create and initialize a Baileys session
- surface QR codes and state changes in realtime
- queue outbound text/media messages in Redis
- send queued jobs only while the client is connected
- restart, stop, reconnect, or delete clients
- inspect queues and logs from the dashboard
- record a per-client message log (sent and failed) with a 7-day TTL

The architecture is deliberately split into control-plane and execution-plane services:

- `api`: accepts HTTP/WebSocket requests and writes commands/queue items into Redis
- `worker`: owns Baileys sockets and drains outbound queues
- `redis`: shared system state, command bus, queue store, QR cache, and event stream
- `dashboard`: operational UI plus authenticated log viewer
- `alerter`: posts Google Chat alerts when watched clients have problems (see 4.5)
- `proxy`: Nginx TLS terminator in front of the API

## 2) Mental Model

Think of the codebase in terms of three flows:

1. Client lifecycle flow
   API writes a command -> worker starts or mutates a socket -> worker writes state + events -> API broadcasts to subscribed WebSocket clients.

2. Outbound message flow
   API validates input -> API enqueues into `wa:pending:<clientId>` -> worker sender loop waits until that client is connected -> worker dequeues one job at a time and sends it.

3. Realtime flow
   Worker publishes status/QR events to Redis Stream `wa:events:stream` -> API stream consumer validates and acknowledges them -> API broadcasts them through `wsHub` to client-specific WebSocket subscribers.

## 3) Repository Structure

```text
.
├── AGENTS.md
├── README.md
├── docker-compose.yaml
├── nginx/
│   ├── certs/
│   └── conf.d/default.conf
├── api/
│   ├── index.js
│   ├── logger.js
│   ├── redis.js
│   ├── streamConsumer.js
│   ├── wsHub.js
│   ├── routes/
│   │   ├── clients.js
│   │   ├── debug-routes.js
│   │   ├── messages.js
│   │   └── ws.js
│   └── tests/
├── worker/
│   ├── index.js
│   ├── commandListener.js
│   ├── clientState.js
│   ├── logger.js
│   ├── mediaSender.js
│   ├── sessionUtils.js
│   ├── socketManager.js
│   ├── startupRehydrate.js
│   └── tests/
├── dashboard/
│   ├── server/index.js
│   └── src/App.jsx
├── logs/
└── sessions/
```

## 4) Service Responsibilities

### 4.1 `worker`

Primary files:

- `worker/index.js`
- `worker/startupRehydrate.js`
- `worker/commandListener.js`
- `worker/socketManager.js`
- `worker/mediaSender.js`

Responsibilities:

- listen on Redis list `wa:commands`
- initialize one Baileys socket per `clientId`
- track connection lifecycle and Redis client state
- publish QR/status events into `wa:events:stream`
- maintain sender loops for outbound jobs
- clear session files when required

Important implementation details:

- session files are stored under `/sessions/<clientId>`
- state is written to Redis hash `wa:clients:state`
- active worker-owned sockets are mirrored in Redis set `wa:clients:active`
- worker startup rehydrates clients from Redis state plus persisted `/sessions` folders, skipping `STOPPED` and `LOGGED_OUT`
- one dedicated Redis connection is used per sender loop because `BRPOP` is blocking
- a separate Redis publisher connection is used for stream publishing to reduce interference with other worker operations
- one Pino logger instance is created per `clientId` and reused across reconnects (stored in `clientPinoLoggers` Map); avoids accumulating logger instances on frequent reconnects
- each Baileys socket receives a fresh bounded `msgRetryCounterCache` (max 500 entries, FIFO eviction) via `BoundedCache`; prevents unbounded growth of the default internal cache under high message volume
- after each send attempt (success or failure) the worker writes a structured log entry to `wa:msglog:<clientId>` and trims entries older than 7 days inline; logging errors are caught and warned, never propagated to delivery
- `SCRUB_SIGNAL_LOGS=true` suppresses Baileys Signal protocol session lifecycle output at both the `console.*` and `process.stdout.write` levels

### 4.2 `api`

Primary files:

- `api/index.js`
- `api/routes/clients.js`
- `api/routes/messages.js`
- `api/routes/ws.js`
- `api/routes/debug-routes.js`
- `api/routes/clientEnv.js`
- `api/envTagger.js`
- `api/streamConsumer.js`
- `api/wsHub.js`

Responsibilities:

- expose REST endpoints for client lifecycle and message enqueueing
- expose `GET /ws` for realtime client-specific updates
- read QR/state snapshots from Redis for newly registered sockets
- consume worker events from `wa:events:stream`
- broadcast valid events to interested WebSocket clients
- label each client with the environment (dev/test/uat/prod) that uses it (see 13.7)

Important implementation details:

- CORS is currently permissive: `origin: true`
- Redis host defaults to `redis`
- the API starts the stream consumer during process startup

### 4.3 `dashboard`

Primary files:

- `dashboard/server/index.js`
- `dashboard/src/App.jsx` (coordinator: refresh loop, actions, filters)
- `dashboard/src/config.js` (all tunables; `VITE_*` overrides)
- `dashboard/src/api.js` (API client that surfaces server error text)
- `dashboard/src/components/*.jsx`

Responsibilities:

- authenticated operations UI on port `8080`
- client lifecycle buttons
- queue view/clear tools
- send-delay configuration UI
- basic message enqueue form
- container log viewer through Docker socket access
- per-client message log viewer (sent and failed sends, 7-day history)

Important implementation details:

- dashboard auth is HTTP Basic Auth
- defaults are `DASH_USER=admin`, `DASH_PASS=admin` in code
- compose overrides `DASH_PASS` to `change-me`
- log access depends on mounting `/var/run/docker.sock`

### 4.4 `proxy`

Purpose:

- terminates TLS for HTTPS and WSS
- forwards traffic to the API service

The API itself stays on internal Docker port `3000`; external HTTPS/WSS should go through Nginx on `443`.

### 4.5 `alerter`

Primary files:

- `alerter/index.js` (wiring), `alerter/alerter.js` (checks + delivery), `alerter/rules.js` (pure decisions),
  `alerter/messages.js` (wording), `alerter/googleChat.js` (webhook sender), `alerter/config.js` (env settings)

Purpose: tell the team in Google Chat when a **watched** client has a problem, and again when it recovers.
It is a separate container so it keeps working when the API is down. It never writes to keys the worker
or API own, so queue/delivery behaviour is unaffected.

Which clients: only those in `wa:alerts:watched`, toggled per client in the dashboard (`⋯` → "Watch for alerts").

What it alerts on (defaults, all configurable):

| Problem | Alert after |
|---|---|
| disconnected (`DISCONNECTED`, `CONNECTING`, `CREATED`) | 3 min (`ALERT_DISCONNECT_GRACE_MS`) |
| logged out (needs QR rescan) | immediately |
| waiting for QR (`QR_REQUIRED`) | 10 min (`ALERT_QR_GRACE_MS`) |
| queue not shrinking while `CONNECTED` | 10 min (`ALERT_QUEUE_STUCK_MS`) |
| failed sends in the last 10 min | ≥ 5 (`ALERT_FAILURE_THRESHOLD`); closes when the window has none |

How it works:

- every 15 s it reads `wa:clients:state`, queue lengths and recent `wa:msglog` entries for watched clients
- it also reads `wa:events:stream` through its own consumer group `alerters` (starts at `$`, never replays
  history), only to catch `LOGGED_OUT`, which the worker replaces with a new QR cycle within seconds
- one message per problem, in its own Google Chat thread; updates (e.g. disconnected → logged out) and the
  "✅ back online" message go into the same thread
- 3+ new problems (or recoveries) in one check are combined into one message (Google Chat allows ~1 msg/s)
- open alerts are stored in `wa:alerts:open`, so restarts don't repeat or falsely close them; an alert is
  only recorded once Google Chat accepted it (otherwise it is retried on the next check)
- stopping, deleting or un-watching a client closes its alert with a note
- posts "🟢 Alerter started" on every start and a daily "all OK" summary at `ALERT_DAILY_OK_TIME`
  (default 10:00 `ALERT_TIMEZONE`, `off` disables); if the daily message is missing, the alerter or server is down

Configuration (`.env`, see `.env.example`):

- `GOOGLE_CHAT_WEBHOOK_URL` — **secret**; empty = dry run (messages are only logged, nothing is sent)
- `ALERT_INSTANCE_NAME` (e.g. `local` → every message starts with `[local]`), `ALERT_DASHBOARD_URL`
- thresholds above, `ALERT_TIMEZONE`, `ALERT_DAILY_OK_TIME`

System alerts (always on, not tied to the watch list; open → "✅" recovery like client alerts):

| Problem | How it is detected | Alert after |
|---|---|---|
| API down | `GET ALERT_API_HEALTH_URL` (default `http://api:3000/health`) fails | 1 min (`ALERT_SYSTEM_GRACE_MS`) |
| Redis down | `PING` fails / times out (client checks pause meanwhile) | 1 min |
| worker down or frozen | `wa:health:worker` (written by the worker every 30 s, `EX 120`) older than 2 min or missing | 2 min (`ALERT_WORKER_STALE_MS`), with the same grace after alerter start |
| Redis memory high | `INFO memory` used/maxmemory | ≥ 80% (`ALERT_REDIS_MEMORY_PCT`), clears below 75% |
| disk nearly full | `statfs` on read-only mounts `/mnt/sessions`, `/mnt/logs` (`ALERT_DISK_PATHS`); folders on one disk = one alert | ≥ 85% (`ALERT_DISK_PCT`), clears below 80% |
| broken events | `XLEN wa:events:dlq` grew since last seen (`wa:alerts:dlqSeen`) | one notice, at most every 30 min |

A system alert only closes on positive proof (the API answering, a fresh heartbeat, a lower reading), so an
alerter restart or a partial outage can never fake a recovery. The alerter starts and alerts even if Redis is down:
nothing at start-up waits for Redis (reads time out after `ALERT_PROBE_TIMEOUT_MS`, the event-stream reader
connects in the background), and saving an alert to an unreachable Redis is time-limited so other checks keep running.
Until the open system alerts from before a restart have been read from Redis, only "Redis down" can open, so a
restart during a Redis outage doesn't repeat alerts (e.g. disk) that were already open.

Pause handling: a 5 s clock watcher detects when the whole machine was frozen (laptop sleep, VM pause). After such a
pause, failure clocks restart and new system alerts are held for `ALERT_RESUME_GRACE_MS` (default 60 s) so services
can report in again; recoveries are still sent. A slow check alone never counts as a pause. If the worker's heartbeat
key has expired, the message uses the last beat the alerter saw ("last sign of life … ago").

Every message actually delivered to Google Chat is logged as `Google Chat: sent "…"` (text only, never the URL).
It has no Docker socket access, so container restart counts and the dashboard container are not monitored;
a crash-looping API or worker still shows up through its failing health check / heartbeat.

Known limit: if the whole server or the alerter is down, nothing can alert — the missing daily message is the signal.

## 5) Redis Data Model

These keys are the runtime contracts the rest of the code assumes:

- `wa:clients:state`
  Redis hash of `clientId -> state`

- `wa:commands`
  Redis list used as a worker command queue

- `wa:pending:<clientId>`
  Redis list containing outbound jobs for one client

- `wa:qr:<clientId>`
  Redis string holding the latest QR payload, TTL 120 seconds

- `wa:clients:active`
  Redis set of worker-initialized active sockets

- `wa:events:stream`
  Redis stream carrying QR/status/test events from worker or debug routes

- `wa:events:dlq`
  Redis stream used by the API stream consumer for poison messages

- `wa:config:sendDelay`
  Redis JSON string with runtime send-delay config:
  `{ "minMs": number, "maxMs": number }`

- `wa:msglog:<clientId>`
  Redis sorted set of message log entries for one client.
  Score is Unix timestamp in ms. Member is a JSON string:
  `{ phoneNumber, sentAt, status, text, fileCount, failReason? }`
  `status` is `"sent"` or `"failed"`. `failReason` is present only on failures.
  Entries older than 7 days are trimmed inline on each write.
  This key is intentionally NOT deleted when a client is deleted — it expires naturally via TTL trimming.

- `wa:clients:env`
  Redis hash of `clientId -> dev | test | uat | prod`.
  Set once (`HSETNX`) on the first labelled request for a client; never overwritten automatically.
  Changed only from the dashboard (`PUT/DELETE /clients/:clientId/env`). Removed on client delete.

- `wa:clients:envMismatch`
  Redis hash of `clientId -> comma-separated envs` that used the client after it was labelled differently.
  Warning only; cleared when the env is set manually or the client is deleted.

- `wa:alerts:watched`
  Redis set of clientIds the alerter watches. Written by the API (`PUT/DELETE /clients/:clientId/alerts/watch`),
  removed on client delete.

- `wa:alerts:open`
  Redis hash `clientId|kind -> JSON` of alerts currently open (kind: `connection`, `queue_stuck`, `send_failures`),
  including the Google Chat thread key. Owned by the alerter.

- `wa:alerts:dailyOkDate`
  Redis string, date (in `ALERT_TIMEZONE`) of the last daily "all OK" message. Owned by the alerter.

- `wa:alerts:dlqSeen`
  Redis string, `wa:events:dlq` length the alerter last reported on. Owned by the alerter.

- `wa:health:worker`
  Redis string, Unix ms of the worker's last 30 s tick, `EX 120`. Written by the worker (`worker/clientState.js`),
  read by the alerter. Missing or old = worker down or frozen.

- `wa:alerts:open` also holds system alerts under fields `__system__|<kind>` (`api_down`, `redis_down`,
  `worker_down`, `redis_memory`, `disk_full:<paths>`); `__system__` can't clash with a real clientId.

- consumer group `alerters` on `wa:events:stream` — the alerter's own group, independent of `api-consumers`.

## 6) Client States

The worker and API currently operate on these states:

- `CREATED`
- `CONNECTING`
- `QR_REQUIRED`
- `CONNECTED`
- `DISCONNECTED`
- `LOGGED_OUT`
- `STOPPED`

Special note:

- `DELETE_CLIENT` removes the client from `wa:clients:state`, clears queue and QR keys, clears the session directory, and publishes a `DELETED` status event. `DELETED` is an event state, not a persisted hash state.

## 7) Command Flow

Worker control is command-driven through `wa:commands`.

Command payloads:

- `ADD_CLIENT`
- `RESTART_CLIENT`
- `STOP_CLIENT`
- `DELETE_CLIENT`

Who writes commands:

- `POST /clients/:clientId` -> `ADD_CLIENT`
- `POST /clients/:clientId/reconnect` -> `ADD_CLIENT`
- `POST /clients/:clientId/restart` -> `RESTART_CLIENT`
- `POST /clients/:clientId/stop` -> `STOP_CLIENT`
- `DELETE /clients/:clientId` -> `DELETE_CLIENT`

Who consumes commands:

- `worker/commandListener.js` blocks on `BRPOP wa:commands`
- the listener dispatches each command into `socketManager`

## 8) Actual Client Lifecycle

This section mirrors `worker/socketManager.js`.

### 8.1 Create and initialize

1. `POST /clients/:clientId` validates the `clientId`.
2. API returns `409` if the client already exists in `wa:clients:state`.
3. API writes `CREATED` into `wa:clients:state`.
4. API enqueues `{ type: "ADD_CLIENT", clientId }` into `wa:commands`.
5. Worker receives the command and calls `initClient(clientId)`.
6. Worker sets state to `CONNECTING`.
7. Worker loads or creates auth state from `/sessions/<clientId>`.
8. Worker fetches the latest Baileys WhatsApp version at startup of that socket.

### 8.1.1 Worker startup rehydration

On worker process startup:

- the worker reads `wa:clients:state`
- the worker scans `/sessions` for persisted session folders
- it builds the union of those client IDs
- it skips clients currently marked `STOPPED` or `LOGGED_OUT`
- it calls `initClient()` for the remaining clients

This allows sockets to come back after worker or Redis restarts without requiring a manual dashboard restart for each client.

### 8.2 QR issuance

When Baileys emits a QR:

- worker sets state `QR_REQUIRED`
- worker stores QR at `wa:qr:<clientId>` with TTL 120 seconds
- worker publishes `{ type: "qr", clientId, qr }` to `wa:events:stream`
- the publish is retried once if the first attempt fails

### 8.3 Open connection

When Baileys reports `connection === "open"`:

- worker clears reconnect counters
- worker sets state `CONNECTED`
- worker deletes `wa:qr:<clientId>`
- worker publishes a `status` event with state `CONNECTED`
- worker adds the client to `connectedClients`
- worker starts the sender loop after a 2 second delay

### 8.4 Logged out / unauthorized

On `401` or `DisconnectReason.loggedOut`:

- worker sets state `LOGGED_OUT`
- worker publishes a `LOGGED_OUT` status event
- worker removes the socket
- worker removes the client from `wa:clients:active`
- worker clears the session directory
- worker automatically reinitializes after 1.5 seconds so a fresh QR can be generated

### 8.5 Post-login restart required

Baileys often emits `515` immediately after a fresh login. The code treats this as expected handover when it happens shortly after `isNewLogin`.

Behavior:

- state is set to `CONNECTING`
- a `CONNECTING` status event is published
- the socket is restarted without clearing session files
- reinitialization happens after 1.5 seconds

### 8.6 Recoverable disconnects

The worker preserves the existing auth session for reconnect attempts unless the client explicitly logged out (`401`) or the retry cap is exceeded. Status codes `405`, `408`, and `428` are treated as known transport-level recoverable disconnects.

Behavior:

- state becomes `DISCONNECTED`
- a `DISCONNECTED` status event is published
- the session is preserved
- reconnect delay is `min(15000 * attempt, 120000)` milliseconds

This avoids unnecessary QR churn during transient failures.

### 8.7 Other disconnects

For other disconnects:

- state becomes `DISCONNECTED`
- a `DISCONNECTED` status event is published
- the session is preserved
- reconnect delay is `min(3000 * attempt, 30000)` milliseconds

### 8.8 Retry cap

If reconnect attempts exceed 8:

- the worker keeps the existing session
- the state remains in the disconnect/retry path
- reconnect attempts continue with capped backoff
- no QR reset is forced purely because the retry counter grew

### 8.9 Stop, restart, delete

`restartClient(clientId, { resetSession })`

- stops sender loop
- drops current socket
- optionally clears session
- sets state `CONNECTING`
- publishes `CONNECTING`
- immediately calls `initClient`

`stopClient(clientId, { resetSession })`

- marks client as stopped
- stops sender loop
- drops current socket
- optionally clears session
- sets state `STOPPED`
- publishes `STOPPED`
- does not auto-reconnect

`deleteClient(clientId)`

- marks client as stopped
- stops sender loop
- drops current socket
- deletes `wa:qr:<clientId>`
- deletes `wa:pending:<clientId>`
- removes the client from `wa:clients:state`
- clears session files
- publishes a `DELETED` status event
- does NOT delete `wa:msglog:<clientId>` — message history is kept until TTL trimming removes all entries

## 9) Outbound Queue Contract

This is the most important behavioral contract in the system.

### 9.1 Enqueue behavior

`POST /messages/send` does not send directly. It only validates and enqueues.

The API writes this shape into `wa:pending:<clientId>`:

```json
{
  "type": "SEND_MESSAGE",
  "clientId": "client-1",
  "phoneNumber": "9999999999",
  "text": "hello",
  "files": []
}
```

Validation rules in `api/routes/messages.js`:

- `clientId` must be a non-empty string
- `phoneNumber` must be present
- `files` must be an array
- every file must contain non-empty `file_url` and `mimeType`
- at least one of `text` or `files[]` must be present
- text is trimmed before enqueueing

### 9.2 Dequeue behavior

The worker sender loop in `worker/socketManager.js`:

- starts only once per client
- does not dequeue anything while the client is disconnected or missing
- blocks on `BRPOP wa:pending:<clientId>` only when the socket is present and marked connected
- processes one queue item at a time

This means messages can safely be queued before a client has ever connected.

### 9.3 Retry behavior

If sending fails after dequeue:

- the raw job is pushed back to the same queue using `RPUSH`
- the worker sleeps for 3 seconds
- the item is retried later

The queue currently has:

- requeue-on-failure
- no explicit retry counter
- no outbound DLQ

### 9.4 Send-delay behavior

Runtime delay config is read from `wa:config:sendDelay`.

Normalization rules used by both API and worker:

- minimum allowed delay: `500ms`
- maximum allowed delay: `120000ms`
- if config is missing, malformed, or invalid, fallback is `3000-8000ms`

After each successful send, the worker sleeps for a random value between `minMs` and `maxMs`.

### 9.5 Queue ordering note

The code currently uses:

- `LPUSH` when enqueueing
- `BRPOP` when consuming

That gives FIFO behavior for newly queued jobs. Failed sends are reinserted with `RPUSH`, which keeps the failed item as the next item retried for that client.

## 10) Media Send Behavior

Implemented in `worker/mediaSender.js`.

Rules:

- text-only payloads send as `{ text }`
- one image or video can carry the text as a caption
- one document or audio file is sent first; if text exists and cannot be captioned, text is sent as a second message
- multiple files are sent one-by-one, then trailing text is sent afterward

Media type handling:

- `image/*` -> `image`
- `video/*` -> `video`
- `audio/*` -> `audio`
- everything else -> `document`

Validation safeguards:

- missing or invalid `file_url` throws an error before send

Phone normalization detail:

- sender loop converts a bare phone number into `91<phone>@s.whatsapp.net`
- if the phone already contains `@s.whatsapp.net`, it is used as-is

This is an important implementation assumption: the current worker defaults bare numbers to the India country code `91`.

## 11) Realtime Event Flow

### 11.1 Worker publishes

Worker publishes events to Redis Stream `wa:events:stream` as:

- stream fields: `data`, `JSON.stringify(event)`

Common event shapes:

- `{ type: "qr", clientId, qr }`
- `{ type: "status", clientId, state }`
- `{ type: "test", clientId, message, timestamp }`

### 11.2 API consumes

`api/streamConsumer.js`:

- uses consumer group `api-consumers`
- uses a unique consumer name per process
- creates the group with `MKSTREAM` if needed
- processes own pending entries first
- then runs `XAUTOCLAIM` recovery for stale pending entries
- then blocks for new entries

### 11.3 Validation and ack

An event is considered valid only if:

- the stream message contains a `data` field
- `data` parses as JSON
- the parsed object contains both `clientId` and `type`

Successful processing:

- broadcast through `wsHub`
- `XACK` the message

Failed processing:

- failure count is tracked in-memory per message ID
- after `WA_EVENTS_POISON_THRESHOLD` attempts, message is copied to DLQ
- the original message is then acknowledged

Default stream consumer environment knobs:

- `WA_EVENTS_DLQ_STREAM=wa:events:dlq`
- `WA_EVENTS_POISON_THRESHOLD=5`
- `WA_EVENTS_AUTOCLAIM_MIN_IDLE_MS=60000`
- `WA_EVENTS_AUTOCLAIM_BATCH_SIZE=50`

Important limitation:

- poison attempt counters are in-memory, so they reset if the API process restarts

## 12) WebSocket Model

Implemented by:

- `api/routes/ws.js`
- `api/wsHub.js`

Behavior:

- WebSocket endpoint is `GET /ws`
- the first inbound message must include `clientId`
- first message may be a normal message or a ping
- once registered, the socket is associated with that `clientId`
- registration triggers an immediate snapshot push:
  - current status from `wa:clients:state`
  - current QR from `wa:qr:<clientId>`, if present

Ping handling:

```json
{ "clientId": "client-1", "type": "ping" }
```

Pong reply:

```json
{ "type": "pong", "timestamp": 1710000000000 }
```

Broadcast model:

- `wsHub` stores `clientId -> Set<WebSocket>`
- broadcasts go only to sockets registered for that same `clientId`
- sockets are removed from the registry on `close`

## 13) REST API

### 13.1 Health

- `GET /health`
  - returns `{ status: "ok" }`

### 13.2 Client lifecycle

- `GET /clients`
  - returns raw `wa:clients:state` hash

- `POST /clients/:clientId`
  - validates `clientId` with `^[a-zA-Z0-9._:-]{1,120}$`
  - returns `409` if client already exists
  - writes `CREATED` and queues `ADD_CLIENT`

- `POST /clients/:clientId/reconnect`
  - allowed only from `LOGGED_OUT`, `DISCONNECTED`, or `STOPPED`
  - queues `ADD_CLIENT`

- `POST /clients/:clientId/restart`
  - body: `{ resetSession?: boolean }`
  - queues `RESTART_CLIENT`

- `POST /clients/:clientId/stop`
  - body: `{ resetSession?: boolean }`
  - queues `STOP_CLIENT`

- `DELETE /clients/:clientId`
  - queues `DELETE_CLIENT`
  - removes the client's env label (`wa:clients:env`, `wa:clients:envMismatch`)

- `GET /clients/:clientId/status`
  - returns `{ state: "<STATE>" }` if known
  - returns `{ clientId, state: "NON_EXISTENT" }` if missing

### 13.3 Send-delay config

- `GET /config/send-delay`
  - returns active config and source:
    `{ minMs, maxMs, source: "default" | "redis" }`

- `POST /config/send-delay`
  - body: `{ minMs, maxMs }`
  - validates integer bounds
  - returns `400` on invalid ranges
  - stores normalized values in Redis

### 13.4 Queue

- `POST /messages/send`
  - validates and enqueues outbound jobs

- `GET /clients/:clientId/queue?limit=<1..200>&offset=<n>`
  - `offset` (optional, default `0`, invalid/negative treated as `0`) pages from the head of the list
  - read-only (`LLEN` + `LRANGE`); never removes or reorders jobs
  - returns:
    - `clientId`
    - `total`
    - `returned`
    - `limit`
    - `offset`
    - `messages`
  - each `messages[]` row includes:
    - `index` (absolute position from the head, i.e. includes `offset`)
    - `raw`
    - `parsed` or `null`
  - send order: jobs are `LPUSH`ed and the worker `BRPOP`s the tail, so index `0` is the newest job and
    a job's send position is `total - index` (`1` = sent next). The dashboard pages through the whole
    queue and shows it in send order.

- `DELETE /clients/:clientId/queue`
  - deletes the Redis list for that client
  - returns how many items were cleared

### 13.5 Message Logs

- `GET /clients/:clientId/messages/log?limit=<1..200>&before=<timestamp_ms>`
  - reads from `wa:msglog:<clientId>` sorted set
  - returns entries newest-first
  - query params:
    - `limit`: number of entries to return (default `50`, min `1`, max `200`)
    - `before`: only return entries with score ≤ this Unix timestamp in ms (default `+inf`)
  - returns:
    - `clientId`
    - `total`: total number of entries in the sorted set
    - `returned`: entries returned in this response
    - `limit`: effective limit used
    - `messages`: array of log entries
  - each `messages[]` entry includes:
    - `phoneNumber`
    - `sentAt` (Unix ms timestamp)
    - `status`: `"sent"` or `"failed"`
    - `text`
    - `fileCount`
    - `failReason` (only present for `"failed"` entries)
  - malformed stored entries are returned as `{ raw, parseError: true }` rather than throwing

### 13.6 Debug

- `GET /debug/ws-stats`
- `GET /debug/client-states`
- `GET /debug/active-clients`
- `POST /debug/test-broadcast/:clientId`
- `GET /debug/qr/:clientId`
- `GET /debug/pending/:clientId`
- `GET /debug/queue-counts`
  - `{ counts: { clientId: queueLength }, total, timestamp }` for every client in `wa:clients:state`
  - one call for all row badges instead of one request per client
- `GET /debug/client-envs`
  - `{ envs: { clientId: env }, mismatches: { clientId: [env...] }, timestamp }`

These endpoints are operational/debug tooling, not hardened admin APIs.

### 13.6.1 Alert watch list

- `GET /alerts/watched` → `{ watched: [clientId...] }` (sorted)
- `PUT /clients/:clientId/alerts/watch` → `{ ok, clientId, watched: true }`
- `DELETE /clients/:clientId/alerts/watch` → `{ ok, clientId, watched: false }`
- invalid `clientId` → `400`; changes take effect on the alerter's next check (≤ 15 s)

### 13.7 Client environment labels

Every client gets the environment (`dev`, `test`, `uat`, `prod`) of whoever uses it. Nothing about
sending changes; the label is recorded only.

How the environment is detected (first match wins, otherwise the request is ignored):

1. `X-Source` header with a backend Lambda name: `CRMDev-…`, `CRMTest-…`, `CRMUat-…`, `CRMProd-…`
   (the CRM backend sends `os.environ["AWS_LAMBDA_FUNCTION_NAME"]`)
2. `Origin` header matched against `ENV_ORIGINS` (browser calls from the CRM frontend / desktop app)

`ENV_ORIGINS` is set on the `api` service, format `origin=env,origin=env`, e.g.
`https://institute.reachandteach.in=prod,https://development.reachandteach.in=dev`.
The dashboard and `localhost` are not in the list, so they never label clients.

When a client is labelled:

- only on successful (`< 400`) requests to: `POST /messages/send`, `POST /clients/:clientId`,
  `POST /clients/:clientId/{reconnect,restart,stop}`, `GET|DELETE /clients/:clientId/queue`,
  `GET /clients/:clientId/status`, and on websocket subscribe
- first label wins (`HSETNX`); after that the API keeps the label in memory and skips Redis entirely
- a different env later using the same client is recorded in `wa:clients:envMismatch`, not overwritten
- tagging errors are logged and swallowed; they never affect the request

Manual control (dashboard):

- `PUT /clients/:clientId/env` body `{ env }` — sets the label, clears mismatches
- `DELETE /clients/:clientId/env` — removes the label; the next labelled request sets it again

Note: the in-memory cache is per API process. If Redis is wiped while the API keeps running,
already-seen clients are not re-labelled until the API restarts.

## 14) Dashboard Behavior

The React dashboard (`dashboard/src/`) is a polling admin UI with queue tools and log access.

Layout:

- top bar: API endpoint + last refresh time, Refresh, Settings
- red banner when the API is unreachable (shows since when and how old the data is)
- tabs: **Clients** and **Service Logs**

Clients tab:

- state counters (one per client state) plus total queued and live sockets; clicking a counter filters the list
- environment filter chips (All / Dev / Test / UAT / Prod / Unknown); combine with search and state filter
- create client
- client rows (the primary control area):
  - env badge (dropdown to override), mismatch warning, state, live, websocket count
  - queue badge (`N queued`), amber at `VITE_QUEUE_WARN_AT` (default 20), red at `VITE_QUEUE_ALERT_AT` (default 100)
  - copy client ID
  - Queue / Logs / History
  - only actions valid for the state: Reconnect (Disconnected, Logged Out, Stopped), Restart (always), Stop (not Stopped)
  - `⋯` menu: Reset session + Restart, Reset session + Stop (both confirm first), Delete
- every action reports success or the API's error text as a toast

Windows:

- Queue: loads the whole queue 200 at a time with progress, shown in send order (`#1` = sent next); Stop / Refresh / Clear;
  Export JSON/CSV of the loaded messages (JSON records whether the export is complete)
- Message Logs: newest 100, All / Sent / Failed filter, failed count, "Load more" via the `before` cursor;
  Export JSON/CSV fetches all remaining pages first and applies the current status filter
- Queue, Message Logs and History each have a search box (phone digits or message text); exports apply
  the current search/status filters. Phones are displayed as `+91 98765 43210`.
- CSV exports are UTF-8 with BOM (opens correctly in Excel) and escape cells starting with `= + - @`
  so message text can't run as a spreadsheet formula
- History: date range plus Today / 7 days / 30 days presets, Export JSON, Delete File
- Settings: dashboard options (on/off switches, per browser), API endpoint (validated, stored in localStorage),
  send delay (min ≤ max and range checked)
- Link phone (QR): "Show QR" on rows in `QR_REQUIRED` (hidden when Settings → "Show QR button" is off).
  The window subscribes to the API websocket (`/ws`) for that client, renders each new QR as WhatsApp rotates it,
  and shows "Linked" once the client reports `CONNECTED`. No extra API endpoint; QR images are drawn in the
  browser with the `qrcode` package.

Dashboard options (Settings → Dashboard options) are defined in `DASHBOARD_OPTIONS` in
`dashboard/src/config.js` and saved per browser (`localStorage` key `dashboardOptions`). To add one, add an
entry there and read `options.<key>` where it is used.

Service Logs tab:

- container logs from the dashboard server (`/api/logs`), service list from `/api/logs/services`
  (`DASH_LOG_SERVICES`, default `worker,api,redis,dashboard`), line count, text filter (e.g. a client ID), auto-refresh
- in `npm run dev`, vite proxies `/api` to `DASHBOARD_SERVER_URL` (default `http://localhost:8080`), so the
  dashboard container (or `npm start`) must be running

Compatibility with older APIs:

- if `/debug/queue-counts` or `/debug/client-envs` return `404`, that feature is switched off for the
  current endpoint (no badges / env controls disabled) instead of erroring on every refresh
- if the queue endpoint ignores `offset`, the Queue window shows the first page and says so

Configuration (`dashboard/src/config.js`, build-time `VITE_*` variables):

- `VITE_API_BASE` (default `http://localhost:3000`), `VITE_DASHBOARD_SERVER_BASE` (default same origin)
- `VITE_REFRESH_INTERVAL_MS` (default `5000`), `VITE_TOAST_DURATION_MS`, `VITE_SERVICE_LOG_REFRESH_MS`
- `VITE_QUEUE_WARN_AT`, `VITE_QUEUE_ALERT_AT`

Polling behavior:

- refreshes client states, active sockets, websocket stats, queue counts and env labels every
  `VITE_REFRESH_INTERVAL_MS`; a refresh is skipped while the previous one is still running
- polling (and Service Logs auto-refresh) pauses while the browser tab is hidden and refreshes
  immediately when the tab is shown again

Operational UX contract already assumed in the repo:

- client row is the primary control area
- no duplicate bottom action block
- queue, logs and history open from the client row (the arbitrary-`clientId` lookup box was removed;
  for a client that isn't listed, call the API directly, e.g. `GET /clients/<id>/queue`)

## 15) Docker Compose Defaults

Current `docker-compose.yaml` defines:

- `redis`
- `worker`
- `api`
- `proxy`
- `dashboard`

Defaults worth knowing:

- Redis persistence is enabled with:
  - `--save 60 1000`
  - `--appendonly yes`
  - `--appendfsync everysec`
- Redis data is stored in the named Docker volume `redis-data`
- worker mounts:
  - `./sessions:/sessions`
  - `./logs:/logs`
- dashboard mounts:
  - `/var/run/docker.sock:/var/run/docker.sock`
- external ports:
  - `6379` for Redis
  - `443` for Nginx proxy
  - `8080` for dashboard

Current compose environment highlights:

- worker:
  - `WA_DEVICE_NAME`
  - `WA_DEVICE_PLATFORM`
  - `WA_DEVICE_VERSION`
  - `LOG_LEVEL`
  - `CLIENT_LOG_LEVEL`
  - `LOG_CLIENTS_DIR`
  - `SCRUB_SIGNAL_LOGS`

- api:
  - `LOG_LEVEL`
  - `API_LOG_LEVEL`
  - `ENV_ORIGINS` (frontend origin → environment map, see 13.7; overridable from `.env`)

- dashboard:
  - `DASH_USER`
  - `DASH_PASS`
  - `DASH_PORT`
  - `DASH_LOG_SERVICES` (optional; services shown in Service Logs, default `worker,api,redis,dashboard`)

- alerter:
  - `GOOGLE_CHAT_WEBHOOK_URL` (secret, from `.env`; empty = dry run), `ALERT_*` settings (see 4.5)
  - read-only mounts `./sessions:/mnt/sessions:ro`, `./logs:/mnt/logs:ro` (disk-space check only)
  - memory limit 96 MB (uses ~20 MB), `restart: unless-stopped`

## 16) TLS / Proxy Setup

The proxy expects these files:

- `nginx/certs/origin.crt`
- `nginx/certs/origin.key`

Recommended permissions:

```bash
chmod 600 nginx/certs/origin.key
chmod 644 nginx/certs/origin.crt
```

Typical restart after cert updates:

```bash
docker compose up -d --force-recreate proxy api
```

## 17) Testing Surface

Current automated tests live in:

- `api/tests/clients.routes.test.js`
- `api/tests/messages.routes.test.js`
- `api/tests/messageLogs.routes.test.js`
- `api/tests/debug.routes.test.js`
- `api/tests/envTagger.test.js`
- `api/tests/ws.routes.test.js`
- `api/tests/streamConsumer.test.js`
- `worker/tests/socketManager.test.js`
- `worker/tests/startupRehydrate.test.js`
- `api/tests/alerts.routes.test.js`
- `alerter/tests/rules.test.js`, `alerter/tests/alerter.test.js`, `alerter/tests/googleChat.test.js`

What is covered today:

- send-delay defaults, normalization, and validation
- client creation and duplicate handling
- reconnect state gatekeeping
- queue inspection and clearing endpoints, including `offset` paging and invalid/past-end offsets
- queue counts for all clients in one call
- environment labels: `X-Source` / `Origin` detection, label-once, in-memory skip, mismatch recording,
  ignored dashboard/localhost/unknown callers, Redis errors swallowed, allowed-routes-only hook,
  manual set/clear routes, label cleared on client delete, websocket subscribe tagging
- message enqueue validation
- stream message validation, ack, and DLQ handling
- disconnect handling for `401`, `405`, `408`, `428`, ordinary disconnect retries, retry-cap session persistence, and sender-loop requeue behavior
- worker startup rehydration from Redis state and session folders
- sender-loop requeue-on-send-failure behavior
- message log write on successful send (zadd + zremrangebyscore trim)
- message log write on send failure with `failReason`
- message log errors do not block delivery or requeue
- message log API: empty client, newest-first ordering, default/min/max limit, total vs returned, `before` cursor pagination, failed entry with `failReason`, sent entry without `failReason`, malformed entry handling, full field shape
- persistent history returns empty (not 500) for a client with no log file
- alert watch list routes; watch removed on client delete
- alerter: grace periods, immediate logout (incl. via event while state is already `QR_REQUIRED`), stale events
  ignored, thread updates on worsening, no duplicate/false recovery after restart, batching, retry when Google
  Chat rejects, stop/unwatch closing, queue-stuck and send-failure alerts, daily OK once per day, message framing;
  Google Chat sender threading, retries/backoff, no URL in logs, rate spacing, dry run
- alerter system checks: API/Redis down after grace and recovery, client checks paused while Redis is down,
  worker heartbeat (startup grace, stale, missing, recovery), no false recovery after restart, Redis memory and
  disk thresholds with hysteresis, one alert per disk, stale disk alerts dropped, dead-letter growth notices
  with cooldown, system alerts in the daily message

How to run tests:

```bash
cd api && npm test
```

```bash
cd worker && npm test
```

```bash
cd alerter && npm test
```

## 18) Files To Read Before Changing Behavior

If you are changing lifecycle, queues, or realtime behavior, read these first:

1. `worker/socketManager.js`
2. `worker/startupRehydrate.js`
3. `worker/mediaSender.js`
4. `api/streamConsumer.js`
5. `api/routes/clients.js`
6. `api/routes/messages.js`
7. `api/routes/ws.js`
8. `api/wsHub.js`
9. `dashboard/src/App.jsx`
10. `api/tests/*.test.js`
11. `worker/tests/*.test.js`

## 19) Known Gaps and Risks

These are current realities, not future tasks:

- API and WebSocket endpoints are unauthenticated
- API CORS is permissive
- Redis host is hardcoded to `redis` in several modules
- outbound queue has no retry counter and no outbound DLQ
- poison message tracking in the stream consumer is in-memory only
- bare phone numbers are normalized to India prefix `91`

## 20) Common Operations

Create a client:

```bash
curl -k -X POST https://localhost/clients/client-1
```

Queue a text message:

```bash
curl -k -X POST https://localhost/messages/send \
  -H "content-type: application/json" \
  -d '{"clientId":"client-1","phoneNumber":"9999999999","text":"hello"}'
```

Check client status:

```bash
curl -k https://localhost/clients/client-1/status
```

View queue:

```bash
curl -k "https://localhost/clients/client-1/queue?limit=20"
```

Clear queue:

```bash
curl -k -X DELETE "https://localhost/clients/client-1/queue"
```

View message logs (most recent 50):

```bash
curl -k "https://localhost/clients/client-1/messages/log"
```

View message logs with custom limit and cursor:

```bash
curl -k "https://localhost/clients/client-1/messages/log?limit=100&before=1712345678000"
```

## 21) Change Rules For Future Work

If you change queue, state, or event behavior:

- update focused tests in the same change
- keep this README aligned with the code
- do not silently change the dequeue-while-disconnected contract
- do not silently remove requeue-on-send-failure behavior
- do not silently alter reconnect semantics for `401`, ordinary disconnect retries, `405`, `408`, `428`, or retry-cap session persistence
- do not silently remove or bypass the `logMessage` call on send success or send failure — message log entries are expected for every dequeued job
- do not delete `wa:msglog:<clientId>` from `deleteClient` — log history is retained until TTL trimming removes all entries

This repository relies on those behaviors operationally.
