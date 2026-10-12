import React from "react"
import { STATE_META } from "../config.js"
import { formatCount } from "../utils.js"

// Per-state client counts; clicking one filters the client list.
export default function StatsBar({ stateCounts, total, stateFilter, onStateFilter, totalQueued, liveCount }) {
  const extraStates = Object.keys(stateCounts).filter((s) => !STATE_META[s])

  return (
    <div className="stats-bar card">
      <div className="state-chips" role="group" aria-label="Filter by state">
        <button
          className={`state-chip${stateFilter === "all" ? " state-chip-active" : ""}`}
          onClick={() => onStateFilter("all")}
        >
          <span className="state-chip-value">{formatCount(total)}</span>
          <span className="state-chip-label">All clients</span>
        </button>
        {[...Object.keys(STATE_META), ...extraStates].map((state) => {
          const count = stateCounts[state] || 0
          const meta = STATE_META[state] || { label: state, cls: "state-unknown" }
          return (
            <button
              key={state}
              className={`state-chip ${meta.cls}-chip${count === 0 ? " state-chip-zero" : ""}${stateFilter === state ? " state-chip-active" : ""}`}
              onClick={() => onStateFilter(stateFilter === state ? "all" : state)}
              disabled={count === 0 && stateFilter !== state}
            >
              <span className="state-chip-value">{formatCount(count)}</span>
              <span className="state-chip-label">{meta.label}</span>
            </button>
          )
        })}
      </div>
      <div className="stats-side">
        <div className="stat-inline">
          <span className="state-chip-value">{totalQueued === null ? "—" : formatCount(totalQueued)}</span>
          <span className="state-chip-label">Total queued</span>
        </div>
        <div className="stat-inline">
          <span className="state-chip-value">{formatCount(liveCount)}</span>
          <span className="state-chip-label">Live sockets</span>
        </div>
      </div>
    </div>
  )
}
