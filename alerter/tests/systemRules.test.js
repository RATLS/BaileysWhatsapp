const test = require("node:test")
const assert = require("node:assert/strict")
const {
  evaluateDown,
  evaluateHeartbeat,
  evaluatePercent,
  parseRedisMemory,
  diskUsage,
  evaluateDlq,
} = require("../systemRules")

const MIN = 60_000

test("evaluateDown alerts only after failing continuously for the grace period", () => {
  let r = evaluateDown(undefined, false, 0, MIN)
  assert.equal(r.problem, null)
  r = evaluateDown(r.track, false, 59_000, MIN)
  assert.equal(r.problem, null)
  r = evaluateDown(r.track, false, MIN, MIN)
  assert.deepEqual(r.problem, { since: 0 })
  r = evaluateDown(r.track, true, 2 * MIN, MIN)
  assert.equal(r.problem, null)
  assert.deepEqual(r.track, { failingSince: null })
})

test("a single success resets the failure clock", () => {
  let r = evaluateDown(undefined, false, 0, MIN)
  r = evaluateDown(r.track, true, 30_000, MIN)
  r = evaluateDown(r.track, false, 40_000, MIN)
  r = evaluateDown(r.track, false, 90_000, MIN)
  assert.equal(r.problem, null, "only 50 s of continuous failure")
})

test("evaluateHeartbeat uses the beat age, or the alerter start time when there is none", () => {
  assert.equal(evaluateHeartbeat(100_000, 150_000, 2 * MIN, 0), null)
  assert.deepEqual(evaluateHeartbeat(0, 2 * MIN + 1, 2 * MIN, 0), { lastBeat: 0, since: 0 })
  assert.equal(evaluateHeartbeat(null, MIN, 2 * MIN, 0), null, "startup grace")
  assert.deepEqual(evaluateHeartbeat(null, 3 * MIN, 2 * MIN, 0), { lastBeat: null, since: 0 })
})

test("evaluatePercent opens at the threshold and closes only below threshold - margin", () => {
  assert.equal(evaluatePercent(79, 80, false), false)
  assert.equal(evaluatePercent(80, 80, false), true)
  assert.equal(evaluatePercent(77, 80, true), true, "still open inside the margin")
  assert.equal(evaluatePercent(74, 80, true), false)
  assert.equal(evaluatePercent(NaN, 80, true), false)
})

test("parseRedisMemory reads INFO memory output", () => {
  const info = "# Memory\r\nused_memory:121634816\r\nused_memory_human:116.00M\r\nmaxmemory:146800640\r\n"
  const mem = parseRedisMemory(info)
  assert.equal(mem.used, 121634816)
  assert.equal(mem.max, 146800640)
  assert.equal(Math.round(mem.pct), 83)
  assert.equal(parseRedisMemory("used_memory:5\r\nmaxmemory:0\r\n").pct, null, "no limit configured")
})

test("diskUsage computes used percent and free bytes", () => {
  const usage = diskUsage({ bsize: 4096, blocks: 1000, bavail: 100 })
  assert.equal(Math.round(usage.pct), 90)
  assert.equal(usage.free, 409600)
  assert.equal(diskUsage(null), null)
})

test("evaluateDlq: first run records, growth notifies, cooldown accumulates, trims reset", () => {
  assert.deepEqual(evaluateDlq(null, 7, 0, null, MIN), { notify: false, newCount: 0, seen: 7 })
  assert.deepEqual(evaluateDlq(7, 7, 0, null, MIN), { notify: false, newCount: 0, seen: 7 })
  assert.deepEqual(evaluateDlq(7, 9, 0, null, MIN), { notify: true, newCount: 2, seen: 9 })
  assert.deepEqual(evaluateDlq(9, 10, 30_000, 0, MIN), { notify: false, newCount: 1, seen: 9 }, "cooling down")
  assert.deepEqual(evaluateDlq(9, 12, 2 * MIN, 0, MIN), { notify: true, newCount: 3, seen: 12 })
  assert.deepEqual(evaluateDlq(12, 2, 3 * MIN, 0, MIN), { notify: false, newCount: 0, seen: 2 }, "stream cleared")
})
