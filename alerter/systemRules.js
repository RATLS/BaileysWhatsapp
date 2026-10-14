// Pure decision logic for system checks (no Redis, network or clock).

/**
 * Something that is either reachable or not (API health, Redis ping).
 * Alerts only after it has been failing continuously for graceMs.
 * track: { failingSince }
 */
function evaluateDown(track, ok, now, graceMs) {
  if (ok) return { track: { failingSince: null }, problem: null }
  const failingSince = (track && track.failingSince) ?? now
  return {
    track: { failingSince },
    problem: now - failingSince >= graceMs ? { since: failingSince } : null,
  }
}

/**
 * Worker heartbeat. lastBeat is the timestamp in wa:health:worker (null if
 * the key is missing). With no beat at all, wait staleMs after the alerter
 * started before calling it down, so a fresh deployment doesn't alert.
 */
function evaluateHeartbeat(lastBeat, now, staleMs, startedAt) {
  if (Number.isFinite(lastBeat)) {
    return now - lastBeat > staleMs ? { lastBeat, since: lastBeat } : null
  }
  return now - startedAt > staleMs ? { lastBeat: null, since: startedAt } : null
}

/**
 * Percentage threshold with hysteresis: opens at >= threshold, and once open
 * stays open until it drops below threshold - margin (avoids flapping).
 */
function evaluatePercent(pct, threshold, wasOpen, margin = 5) {
  if (!Number.isFinite(pct)) return false
  return wasOpen ? pct >= threshold - margin : pct >= threshold
}

// Parses `INFO memory` output into bytes. max is 0 when Redis has no limit.
function parseRedisMemory(info) {
  const read = (name) => {
    const match = new RegExp(`^${name}:(\\d+)`, "m").exec(info || "")
    return match ? Number(match[1]) : null
  }
  const used = read("used_memory")
  const max = read("maxmemory")
  return { used, max, pct: used !== null && max ? (used / max) * 100 : null }
}

// Disk usage from fs.statfs() (bsize, blocks, bavail).
function diskUsage(stats) {
  if (!stats || !stats.blocks) return null
  const total = stats.blocks * stats.bsize
  const free = stats.bavail * stats.bsize
  return { total, free, pct: ((total - free) / total) * 100 }
}

/**
 * New entries in the dead-letter stream since last seen.
 * Returns { notify, newCount, seen } where seen is the value to store.
 */
function evaluateDlq(seen, length, now, lastNoticeAt, cooldownMs) {
  if (!Number.isFinite(length)) return { notify: false, newCount: 0, seen }
  // First run (nothing stored) or the stream was trimmed/cleared: just record.
  if (!Number.isFinite(seen) || length < seen) return { notify: false, newCount: 0, seen: length }
  const newCount = length - seen
  if (!newCount) return { notify: false, newCount: 0, seen }
  const coolingDown = Number.isFinite(lastNoticeAt) && now - lastNoticeAt < cooldownMs
  // During cooldown keep the old "seen" so the count accumulates for the next notice.
  return coolingDown ? { notify: false, newCount, seen } : { notify: true, newCount, seen: length }
}

module.exports = {
  evaluateDown,
  evaluateHeartbeat,
  evaluatePercent,
  parseRedisMemory,
  diskUsage,
  evaluateDlq,
}
