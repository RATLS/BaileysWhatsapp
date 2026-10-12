import React, { useCallback, useEffect, useRef, useState } from "react"
import Modal from "./Modal.jsx"
import LogEntry from "./LogEntry.jsx"
import Icon from "./Icon.jsx"
import ActionMenu from "./ActionMenu.jsx"
import SearchInput from "./SearchInput.jsx"
import { clientPath } from "../api.js"
import { HISTORY_LIMIT, HISTORY_PRESETS } from "../config.js"
import { daysAgo, downloadCsv, downloadJson, formatCount, localDateString, matchesSearch } from "../utils.js"
import { LOG_CSV_COLUMNS, toLogExportRow } from "../exportColumns.js"

export default function HistoryModal({ api, clientId, onClose, notify }) {
  const [range, setRange] = useState(() => ({ from: localDateString(), to: localDateString() }))
  const [search, setSearch] = useState("")
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const runRef = useRef(0)

  const load = useCallback(async ({ from, to }) => {
    const runId = ++runRef.current
    setLoading(true)
    setError("")
    try {
      const params = new URLSearchParams({ from, to, limit: String(HISTORY_LIMIT) })
      const res = await api.get(`${clientPath(clientId, "/logs/persistent")}?${params}`)
      if (runRef.current === runId) setData(res)
    } catch (err) {
      if (runRef.current === runId) setError(`Failed to load history: ${err.message}`)
    } finally {
      if (runRef.current === runId) setLoading(false)
    }
  }, [api, clientId])

  // Initial load only; later loads are explicit (Load button / presets),
  // so editing a date doesn't fire a request per keystroke.
  useEffect(() => {
    load(range)
    return () => { runRef.current++ }
  }, [load])

  function applyPreset(days) {
    const next = { from: localDateString(daysAgo(days)), to: localDateString() }
    setRange(next)
    load(next)
  }

  // Exports the loaded entries with the search filter applied.
  // JSON keeps the original shape (`entries`, `sentAtFormatted`) for existing consumers.
  function exportHistory(format) {
    if (!visible.length) return
    const base = `${clientId}-history_${range.from}_to_${range.to}${searchTerm ? "-search" : ""}`
    if (format === "csv") {
      downloadCsv(`${base}.csv`, LOG_CSV_COLUMNS, visible.map(toLogExportRow))
    } else {
      downloadJson(`${base}.json`, {
        clientId,
        from: range.from,
        to: range.to,
        total: data.total,
        returned: data.returned,
        search: searchTerm || null,
        exported: visible.length,
        exportedAt: new Date().toISOString(),
        entries: visible.map((entry) => ({
          ...toLogExportRow(entry),
          sentAtFormatted: entry.sentAt ? new Date(entry.sentAt).toLocaleString() : null,
        })),
      })
    }
    notify("success", `Exported ${formatCount(visible.length)} history entries as ${format.toUpperCase()}`)
  }

  async function deleteFile() {
    if (!window.confirm(`Delete the persistent log file for "${clientId}"? This cannot be undone.`)) return
    try {
      await api.del(clientPath(clientId, "/logs/persistent"))
      setData(null)
      notify("success", `Persistent history deleted for ${clientId}`)
    } catch (err) {
      notify("error", `Delete history failed for ${clientId}: ${err.message}`)
    }
  }

  const searchTerm = search.trim()
  const entries = data?.entries || []
  const visible = searchTerm
    ? entries.filter((e) => matchesSearch(search, { phone: e.phoneNumber, text: e.text }))
    : entries

  const subtitle = loading
    ? "Loading…"
    : data
      ? searchTerm
        ? `${formatCount(visible.length)} match · ${formatCount(data.returned)} loaded`
        : `${formatCount(data.total)} in range · showing ${formatCount(data.returned)}`
      : undefined

  return (
    <Modal title={`Persistent History — ${clientId}`} subtitle={subtitle} onClose={onClose} wide>
      <div className="modal-toolbar persist-toolbar">
        <div className="date-range">
          <label className="field-label" htmlFor="history-from">From</label>
          <input
            id="history-from"
            type="date"
            value={range.from}
            max={range.to}
            onChange={(e) => setRange({ ...range, from: e.target.value })}
          />
          <label className="field-label" htmlFor="history-to">To</label>
          <input
            id="history-to"
            type="date"
            value={range.to}
            min={range.from}
            onChange={(e) => setRange({ ...range, to: e.target.value })}
          />
        </div>
        <div className="toolbar-btns">
          {HISTORY_PRESETS.map((p) => (
            <button key={p.label} className="btn-secondary" onClick={() => applyPreset(p.days)} disabled={loading}>
              {p.label}
            </button>
          ))}
          <button className="btn-secondary" onClick={() => load(range)} disabled={loading}>
            <Icon name="refresh" /> {loading ? "Loading…" : "Load"}
          </button>
          <ActionMenu
            label={`Export ${searchTerm ? "matching" : "loaded"} entries`}
            triggerLabel="Export"
            triggerIcon="download"
            align="left"
            disabled={loading || visible.length === 0}
            items={[
              { label: "JSON (full detail)", onClick: () => exportHistory("json") },
              { label: "CSV (spreadsheet)", onClick: () => exportHistory("csv") },
            ]}
          />
          <button className="btn-danger-sm" onClick={deleteFile}>Delete File</button>
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="Search phone or text…"
            label="Search history"
            className="modal-search"
          />
        </div>
      </div>
      {error && <div className="error-text">{error}</div>}
      {data && data.total > data.returned && (
        <div className="info-text">
          Showing the newest {formatCount(HISTORY_LIMIT)} of {formatCount(data.total)} — narrow the date range to see older ones.
        </div>
      )}
      <div className="modal-list">
        {!loading && data && entries.length === 0 && (
          <div className="empty-state">No entries in this date range.</div>
        )}
        {searchTerm && entries.length > 0 && visible.length === 0 && (
          <div className="empty-state">No loaded entries match "{searchTerm}".</div>
        )}
        {visible.map((entry, i) => (
          <LogEntry key={`${entry.sentAt ?? "x"}-${i}`} entry={entry} />
        ))}
      </div>
      <div className="modal-footer-note">
        Newest first · dates are UTC days · no expiry — "Delete File" is permanent
      </div>
    </Modal>
  )
}
