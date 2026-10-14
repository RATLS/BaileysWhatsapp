// Redis keys read or owned by the alerter.

module.exports = {
  // Read-only (owned by worker / API)
  STATE_KEY: "wa:clients:state",
  ENV_KEY: "wa:clients:env",
  EVENTS_STREAM: "wa:events:stream",
  pendingKey: (clientId) => `wa:pending:${clientId}`,
  msglogKey: (clientId) => `wa:msglog:${clientId}`,

  // Owned by the alerter (watch list is written by the API)
  WATCHED_KEY: "wa:alerts:watched",
  OPEN_KEY: "wa:alerts:open",
  DAILY_OK_KEY: "wa:alerts:dailyOkDate",
  DLQ_SEEN_KEY: "wa:alerts:dlqSeen",
  CONSUMER_GROUP: "alerters",

  // Written by the worker every 30 s (EX 120)
  WORKER_HEARTBEAT_KEY: "wa:health:worker",

  // Pseudo client id for system alerts in wa:alerts:open. Contains "_", which
  // the clientId format forbids, so it can never clash with a real client.
  SYSTEM_ID: "__system__",
}
