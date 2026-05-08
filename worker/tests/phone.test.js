const test = require("node:test")
const assert = require("node:assert/strict")
const { normalizePhoneNumber, toJid } = require("../phone")

test("normalize: bare 10-digit Indian number gets 91 prefix", () => {
  const r = normalizePhoneNumber("9699605540")
  assert.equal(r.ok, true)
  assert.equal(r.e164, "919699605540")
  assert.equal(r.country, "IN")
})

test("normalize: number already prefixed with 91 is preserved", () => {
  const r = normalizePhoneNumber("919699605540")
  assert.equal(r.ok, true)
  assert.equal(r.e164, "919699605540")
})

test("normalize: UK number with country code is preserved", () => {
  const r = normalizePhoneNumber("447598328056")
  assert.equal(r.ok, true)
  assert.equal(r.e164, "447598328056")
  assert.equal(r.country, "GB")
})

test("normalize: lenient sanitization strips +, spaces, dashes, parens", () => {
  const r = normalizePhoneNumber("+91 (96996)-05540")
  assert.equal(r.ok, true)
  assert.equal(r.e164, "919699605540")
})

test("normalize: numeric input is coerced to string", () => {
  const r = normalizePhoneNumber(9699605540)
  assert.equal(r.ok, true)
  assert.equal(r.e164, "919699605540")
})

test("normalize: rejects empty input", () => {
  assert.equal(normalizePhoneNumber("").ok, false)
  assert.equal(normalizePhoneNumber(null).ok, false)
  assert.equal(normalizePhoneNumber(undefined).ok, false)
})

test("normalize: rejects non-numeric input", () => {
  assert.equal(normalizePhoneNumber("abc").ok, false)
  assert.equal(normalizePhoneNumber("12ab34").ok, false)
})

test("normalize: rejects too-short numbers", () => {
  assert.equal(normalizePhoneNumber("123").ok, false)
  assert.equal(normalizePhoneNumber("12345").ok, false)
})

test("toJid: passes through existing s.whatsapp.net JID", () => {
  const r = toJid("919699605540@s.whatsapp.net")
  assert.equal(r.ok, true)
  assert.equal(r.jid, "919699605540@s.whatsapp.net")
})

test("toJid: passes through group JID", () => {
  const r = toJid("123-456@g.us")
  assert.equal(r.ok, true)
  assert.equal(r.jid, "123-456@g.us")
})

test("toJid: builds JID from bare IN number", () => {
  const r = toJid("9699605540")
  assert.equal(r.ok, true)
  assert.equal(r.jid, "919699605540@s.whatsapp.net")
})

test("toJid: builds JID from international number", () => {
  const r = toJid("447598328056")
  assert.equal(r.ok, true)
  assert.equal(r.jid, "447598328056@s.whatsapp.net")
})

test("toJid: returns failure for invalid input", () => {
  const r = toJid("abc")
  assert.equal(r.ok, false)
  assert.ok(r.error)
})
