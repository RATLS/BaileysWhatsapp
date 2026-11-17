import React from "react"

const STATUS_FILTERS = [
  { key: "all", label: "All" },
  { key: "sent", label: "Sent" },
  { key: "failed", label: "Failed" },
]

export default function StatusFilter({ value, onChange, failedCount }) {
  return (
    <div className="segmented" role="group" aria-label="Filter by status">
      {STATUS_FILTERS.map((f) => (
        <button
          key={f.key}
          className={`segmented-btn${value === f.key ? " segmented-btn-active" : ""}`}
          onClick={() => onChange(f.key)}
        >
          {f.label}
          {f.key === "failed" && failedCount > 0 && <span className="count-pill count-pill-red">{failedCount}</span>}
        </button>
      ))}
    </div>
  )
}
