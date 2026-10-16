// YYYY-MM-DD in the browser's local timezone (toISOString would give UTC).
export function localDateString(date = new Date()) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, "0")
  const d = String(date.getDate()).padStart(2, "0")
  return `${y}-${m}-${d}`
}

export function daysAgo(days) {
  const date = new Date()
  date.setDate(date.getDate() - (days - 1))
  return date
}

export function formatTime(ms) {
  return ms ? new Date(ms).toLocaleString() : "unknown time"
}

export function formatCount(n) {
  return Number(n || 0).toLocaleString()
}

// Display-only phone formatting. Indian numbers (91 + 10 digits) get
// "+91 98765 43210"; anything else is shown as "+<digits>" unchanged.
export function formatPhone(value) {
  if (!value) return "—"
  const digits = String(value).replace(/\D/g, "")
  if (digits.length === 12 && digits.startsWith("91")) {
    return `+91 ${digits.slice(2, 7)} ${digits.slice(7)}`
  }
  return digits ? `+${digits}` : String(value)
}

// Case-insensitive match on text; phone matched on digits only, so
// "98765 43210", "+91-9876543210" and "9876543210" all find the same number.
export function matchesSearch(query, { phone, text }) {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  if (text && String(text).toLowerCase().includes(needle)) return true
  const needleDigits = needle.replace(/\D/g, "")
  if (needleDigits.length >= 3 && phone && String(phone).replace(/\D/g, "").includes(needleDigits)) return true
  return false
}

// Width for a "#N" column so every row's text starts at the same place.
export function indexColumnWidth(maxValue) {
  return `${String(Math.max(1, maxValue || 0)).length + 1}ch`
}

// navigator.clipboard needs a secure context (https/localhost); fall back
// to execCommand so copying also works on the plain-http dashboard.
export async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text)
    return
  }
  const el = document.createElement("textarea")
  el.value = text
  el.setAttribute("readonly", "")
  el.style.position = "fixed"
  el.style.opacity = "0"
  document.body.appendChild(el)
  el.select()
  const ok = document.execCommand("copy")
  el.remove()
  if (!ok) throw new Error("Clipboard not available")
}

export function downloadFile(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export function downloadJson(filename, payload) {
  downloadFile(filename, JSON.stringify(payload, null, 2), "application/json")
}

// Spreadsheet apps execute cells starting with these characters as formulas.
const FORMULA_PREFIX = /^[=+\-@\t\r]/

function csvCell(value) {
  if (value === null || value === undefined) return ""
  let text = String(value)
  if (FORMULA_PREFIX.test(text)) text = `'${text}`
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

// columns: [{ key, label }] ; rows: plain objects
export function toCsv(columns, rows) {
  const header = columns.map((c) => csvCell(c.label)).join(",")
  const lines = rows.map((row) => columns.map((c) => csvCell(row[c.key])).join(","))
  return [header, ...lines].join("\r\n")
}

// BOM so Excel opens UTF-8 (e.g. Hindi text, emoji) correctly.
export function downloadCsv(filename, columns, rows) {
  downloadFile(filename, `﻿${toCsv(columns, rows)}`, "text/csv;charset=utf-8")
}

// File-name-safe timestamp, e.g. 2026-10-12_17-04-35
export function fileTimestamp(date = new Date()) {
  const time = [date.getHours(), date.getMinutes(), date.getSeconds()].map((n) => String(n).padStart(2, "0")).join("-")
  return `${localDateString(date)}_${time}`
}

export function isValidHttpUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:"
  } catch {
    return false
  }
}
