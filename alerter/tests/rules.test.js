const test = require("node:test")
const assert = require("node:assert/strict")
const { evaluateConnection, evaluateQueue, evaluateFailures, isWorse } = require("../rules")

const MIN = 60_000
const cfg = {
  disconnectGraceMs: 3 * MIN,
  qrGraceMs: 10 * MIN,
  queueStuckMs: 10 * MIN,
  failureWindowMs: 10 * MIN,
  failureThreshold: 5,
}

test("connected client has no problem and clears tracking", () => {
  const r = evaluateConnection({ downSince: 1, loggedOutAt: 1 }, "CONNECTED", 100, cfg)
  assert.equal(r.problem, null)
  assert.deepEqual(r.track, { downSince: null, loggedOutAt: null })
})

test("short disconnect inside the grace period does not alert", () => {
  let r = evaluateConnection(undefined, "DISCONNECTED", 0, cfg)
  assert.equal(r.problem, null)
  r = evaluateConnection(r.track, "CONNECTING", 2 * MIN, cfg)
  assert.equal(r.problem, null)
  r = evaluateConnection(r.track, "CONNECTED", 2.5 * MIN, cfg)
  assert.equal(r.problem, null)
})

test("disconnect past the grace period alerts, counting from when it first went down", () => {
  let r = evaluateConnection(undefined, "DISCONNECTED", 0, cfg)
  r = evaluateConnection(r.track, "CONNECTING", 1 * MIN, cfg)
  r = evaluateConnection(r.track, "DISCONNECTED", 3 * MIN, cfg)
  assert.deepEqual(r.problem, { reason: "disconnected", since: 0 })
})

test("logged out alerts immediately, also when the state already moved on to QR_REQUIRED", () => {
  assert.equal(evaluateConnection(undefined, "LOGGED_OUT", 0, cfg).problem.reason, "logged_out")
  const r = evaluateConnection({ downSince: null, loggedOutAt: 50 }, "QR_REQUIRED", 60, cfg)
  assert.equal(r.problem.reason, "logged_out")
  assert.equal(r.problem.since, 50)
})

test("QR_REQUIRED alerts only after the QR grace period", () => {
  let r = evaluateConnection(undefined, "QR_REQUIRED", 0, cfg)
  r = evaluateConnection(r.track, "QR_REQUIRED", 9 * MIN, cfg)
  assert.equal(r.problem, null)
  r = evaluateConnection(r.track, "QR_REQUIRED", 10 * MIN, cfg)
  assert.equal(r.problem.reason, "qr_required")
})

test("stopped, deleted or missing clients are inactive, never a problem", () => {
  for (const state of ["STOPPED", "DELETED", undefined]) {
    const r = evaluateConnection({ downSince: 0 }, state, 60 * MIN, cfg)
    assert.equal(r.problem, null)
    assert.equal(r.inactive, true)
  }
})

test("queue only counts as stuck while connected and not shrinking", () => {
  let q = evaluateQueue(undefined, "CONNECTED", 10, 0, cfg)
  q = evaluateQueue(q.track, "CONNECTED", 12, 5 * MIN, cfg)
  assert.equal(q.problem, null)
  q = evaluateQueue(q.track, "CONNECTED", 12, 10 * MIN, cfg)
  assert.deepEqual(q.problem, { queueLen: 12, since: 0 })
})

test("queue shrinking or client disconnecting resets the stuck timer", () => {
  let q = evaluateQueue(undefined, "CONNECTED", 10, 0, cfg)
  q = evaluateQueue(q.track, "CONNECTED", 9, 9 * MIN, cfg)
  q = evaluateQueue(q.track, "CONNECTED", 9, 15 * MIN, cfg)
  assert.equal(q.problem, null)
  q = evaluateQueue(q.track, "DISCONNECTED", 0, 30 * MIN, cfg)
  q = evaluateQueue(q.track, "CONNECTED", 50, 35 * MIN, cfg)
  assert.equal(q.problem, null)
})

test("failures breach at the threshold inside the window only", () => {
  const now = 100 * MIN
  const entries = [
    ...Array.from({ length: 4 }, (_, i) => ({ status: "failed", sentAt: now - i * MIN, failReason: `e${i}` })),
    { status: "failed", sentAt: now - 20 * MIN },
    { status: "sent", sentAt: now },
  ]
  let f = evaluateFailures(entries, now, cfg)
  assert.equal(f.count, 4)
  assert.equal(f.breached, false)
  f = evaluateFailures([...entries, { status: "failed", sentAt: now - 1000, failReason: "Timed Out" }], now, cfg)
  assert.equal(f.breached, true)
  assert.equal(f.lastReason, "e0")
})

test("severity ordering for connection alert updates", () => {
  assert.equal(isWorse("disconnected", "logged_out"), true)
  assert.equal(isWorse("qr_required", "logged_out"), true)
  assert.equal(isWorse("logged_out", "disconnected"), false)
})
