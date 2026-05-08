const { parsePhoneNumberFromString } = require("libphonenumber-js")

function normalizePhoneNumber(input) {
  if (input === undefined || input === null) {
    return { ok: false, error: "phoneNumber is required" }
  }
  const raw = String(input).trim()
  if (!raw) return { ok: false, error: "phoneNumber is empty" }

  const sanitized = raw.replace(/[\s\-()+]/g, "")
  if (!/^\d+$/.test(sanitized)) {
    return { ok: false, error: "phoneNumber must contain only digits" }
  }

  // Try first as an international number (country code embedded). libphonenumber-js requires
  // a leading '+' to interpret digits as international rather than national.
  const asIntl = parsePhoneNumberFromString(`+${sanitized}`)
  if (asIntl && asIntl.isValid()) {
    return {
      ok: true,
      e164: asIntl.number.replace(/^\+/, ""),
      country: asIntl.country || null
    }
  }

  // Fallback: treat as a national number under the default region (India).
  const asIN = parsePhoneNumberFromString(sanitized, "IN")
  if (asIN && asIN.isValid()) {
    return {
      ok: true,
      e164: asIN.number.replace(/^\+/, ""),
      country: asIN.country || "IN"
    }
  }

  return { ok: false, error: "phoneNumber is not a valid number" }
}

function toJid(input) {
  if (input === undefined || input === null) {
    return { ok: false, error: "phoneNumber is required" }
  }
  const s = String(input)
  if (s.includes("@s.whatsapp.net") || s.includes("@g.us")) {
    return { ok: true, jid: s }
  }
  const result = normalizePhoneNumber(s)
  if (!result.ok) return result
  return {
    ok: true,
    jid: `${result.e164}@s.whatsapp.net`,
    e164: result.e164,
    country: result.country
  }
}

module.exports = { normalizePhoneNumber, toJid }
