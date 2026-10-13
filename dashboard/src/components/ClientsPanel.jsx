import React from "react"
import ClientRow from "./ClientRow.jsx"
import CreateClient from "./CreateClient.jsx"
import Icon from "./Icon.jsx"
import SearchInput from "./SearchInput.jsx"
import { ENV_META, UNKNOWN_ENV } from "../config.js"

const ENV_FILTERS = ["all", ...Object.keys(ENV_META), UNKNOWN_ENV]

function envFilterLabel(key) {
  if (key === "all") return "All"
  if (key === UNKNOWN_ENV) return "Unknown"
  return ENV_META[key].label
}

export default function ClientsPanel({
  rows,
  totalClients,
  search,
  onSearch,
  envFilter,
  onEnvFilter,
  envCounts,
  envSupported,
  alertsSupported,
  showQrButton,
  isFiltering,
  onClearFilters,
  onCreate,
  actions,
}) {
  return (
    <div className="card clients-card">
      <div className="clients-header">
        <div className="clients-header-group">
          <div className="section-label" style={{ marginBottom: 0 }}>Clients</div>
          <span className="meta">
            {isFiltering ? `${rows.length} of ${totalClients}` : `${totalClients} total`}
          </span>
          {isFiltering && (
            <button className="btn-ghost" onClick={onClearFilters}>
              <Icon name="close" size={11} /> Clear filters
            </button>
          )}
          <SearchInput value={search} onChange={onSearch} placeholder="Search clients…" />
        </div>
        <div className="clients-header-group clients-header-right">
          <CreateClient onCreate={onCreate} />
        </div>
      </div>

      {envSupported && (
        <div className="env-filters" role="group" aria-label="Filter by environment">
          {ENV_FILTERS.map((key) => (
            <button
              key={key}
              className={`env-chip${envFilter === key ? " env-chip-active" : ""}${envCounts[key] ? "" : " env-chip-empty"}`}
              onClick={() => onEnvFilter(key)}
              disabled={key !== "all" && key !== envFilter && !envCounts[key]}
            >
              <span>{envFilterLabel(key)}</span>
              <span className="env-chip-count">{envCounts[key] || 0}</span>
            </button>
          ))}
        </div>
      )}

      {totalClients === 0 && (
        <div className="empty-state">No clients yet — use "+ New client" to create one.</div>
      )}
      {totalClients > 0 && rows.length === 0 && (
        <div className="empty-state">No clients match the current search and filters.</div>
      )}

      <div className="client-list">
        {rows.map((row) => (
          <ClientRow
            key={row.clientId}
            {...row}
            envSupported={envSupported}
            alertsSupported={alertsSupported}
            showQrButton={showQrButton}
            actions={actions}
          />
        ))}
      </div>
    </div>
  )
}
