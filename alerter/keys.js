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
  CONSUMER_GROUP: "alerters",
}
