import React from "react"
import { formatPhone, formatTime } from "../utils.js"

// One sent/failed message entry (Redis message log or persistent history).
export default function LogEntry({ entry }) {
  if (entry.parseError) {
    return (
      <div className="log-item log-item-failed">
        <div className="log-error">Malformed log entry</div>
        {entry.raw && <div className="log-text log-raw">{entry.raw}</div>}
      </div>
    )
  }

  const isFailed = entry.status === "failed"
  return (
    <div className={`log-item${isFailed ? " log-item-failed" : ""}`}>
      <div className="log-item-header">
        <span className={`status-badge ${isFailed ? "status-failed" : "status-sent"}`}>
          {entry.status || "unknown"}
        </span>
        <span className="log-phone">{formatPhone(entry.phoneNumber)}</span>
        {(entry.fileCount ?? 0) > 0 && <span className="meta">{entry.fileCount} file(s)</span>}
        <span className="meta log-time">{formatTime(entry.sentAt)}</span>
      </div>
      {entry.text && <div className="log-text">{entry.text}</div>}
      {isFailed && entry.failReason && <div className="log-error">Error: {entry.failReason}</div>}
    </div>
  )
}
