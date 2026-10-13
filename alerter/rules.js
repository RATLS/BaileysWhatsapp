// Pure decision logic: no Redis, no network, no clock. Each function takes
// the previous per-client tracking data plus what was just observed and
// returns the new tracking data and the current problem (or null).

const KINDS = {
  CONNECTION: "connection",
  QUEUE_STUCK: "queue_stuck",
  SEND_FAILURES: "send_failures",
}

// Higher = more serious. Used to post an update when an open
// connection alert gets worse (e.g. disconnected -> logged out).
const CONNECTION_SEVERITY = { disconnected: 1, qr_required: 2, logged_out: 3 }

// States where the client is intentionally not running.
const INACTIVE_STATES = new Set(["STOPPED", "DELETED"])

/**
 * Connection health of one client.
 * track: { downSince, loggedOutAt }
 * Returns { track, problem, inactive } where problem = { reason, since } | null.
 */
function evaluateConnection(track, state, now, cfg) {
  const prev = track || {}

  if (state === "CONNECTED") {
    return { track: { downSince: null, loggedOutAt: null }, problem: null, inactive: false }
  }
  if (!state || INACTIVE_STATES.has(state)) {
    return { track: { downSince: null, loggedOutAt: null }, problem: null, inactive: true }
  }

  const downSince = prev.downSince ?? now
  const loggedOutAt = prev.loggedOutAt ?? null
  const downFor = now - downSince
  let reason = null

  // A logout needs a person to rescan the QR, so it alerts immediately.
  // The worker re-initialises right after, so the state may already be
  // QR_REQUIRED by now; the logout event (loggedOutAt) is what tells us.
  if (state === "LOGGED_OUT" || loggedOutAt) reason = "logged_out"
  else if (state === "QR_REQUIRED") reason = downFor >= cfg.qrGraceMs ? "qr_required" : null
  else reason = downFor >= cfg.disconnectGraceMs ? "disconnected" : null

  return {
    track: { downSince, loggedOutAt },
    problem: reason ? { reason, since: loggedOutAt && reason === "logged_out" ? Math.min(loggedOutAt, downSince) : downSince } : null,
    inactive: false,
  }
}

/**
 * Queue not draining while the client is connected.
 * track: { queueLen, progressAt }
 * Disconnected clients are expected to build a queue, so the timer only
 * runs while CONNECTED and restarts whenever the queue shrinks or empties.
 */
function evaluateQueue(track, state, queueLen, now, cfg) {
  const prev = track || {}
  if (state !== "CONNECTED" || !queueLen) {
    return { track: { queueLen: queueLen || 0, progressAt: now }, problem: null }
  }

  const shrank = prev.queueLen === undefined || prev.queueLen === null || queueLen < prev.queueLen
  const progressAt = shrank ? now : (prev.progressAt ?? now)
  const stuck = now - progressAt >= cfg.queueStuckMs

  return {
    track: { queueLen, progressAt },
    problem: stuck ? { queueLen, since: progressAt } : null,
  }
}

/**
 * Send failures in the recent window (from wa:msglog entries).
 * Opens at >= threshold failures; the caller keeps the alert open until
 * the window has no failures at all (hysteresis, avoids flapping).
 */
function evaluateFailures(entries, now, cfg) {
  const cutoff = now - cfg.failureWindowMs
  const failed = entries.filter((e) => e && e.status === "failed" && e.sentAt >= cutoff)
  const latest = failed.reduce((a, b) => (!a || b.sentAt > a.sentAt ? b : a), null)
  return {
    count: failed.length,
    lastReason: latest ? latest.failReason || null : null,
    breached: failed.length >= cfg.failureThreshold,
  }
}

function isWorse(oldReason, newReason) {
  return (CONNECTION_SEVERITY[newReason] || 0) > (CONNECTION_SEVERITY[oldReason] || 0)
}

module.exports = {
  KINDS,
  evaluateConnection,
  evaluateQueue,
  evaluateFailures,
  isWorse,
}
