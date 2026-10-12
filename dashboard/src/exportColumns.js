// Column layouts for CSV exports (JSON exports keep every field).

export const QUEUE_CSV_COLUMNS = [
  { key: "sendPosition", label: "Send position" },
  { key: "phoneNumber", label: "Phone number" },
  { key: "text", label: "Text" },
  { key: "fileCount", label: "Files" },
  { key: "files", label: "File URLs" },
  { key: "type", label: "Type" },
  { key: "raw", label: "Raw (unreadable jobs only)" },
]

// Used by both the Message Logs and Persistent History exports.
export const LOG_CSV_COLUMNS = [
  { key: "sentAtIso", label: "Sent at (UTC)" },
  { key: "status", label: "Status" },
  { key: "phoneNumber", label: "Phone number" },
  { key: "text", label: "Text" },
  { key: "fileCount", label: "Files" },
  { key: "failReason", label: "Fail reason" },
  { key: "raw", label: "Raw (malformed entries only)" },
]

// Shape a sent/failed log entry for export.
export function toLogExportRow(entry) {
  if (entry.parseError) return { raw: entry.raw, parseError: true }
  return { ...entry, sentAtIso: entry.sentAt ? new Date(entry.sentAt).toISOString() : null }
}
