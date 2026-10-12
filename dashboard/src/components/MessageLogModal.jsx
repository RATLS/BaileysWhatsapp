import React, { useCallback, useEffect, useRef, useState } from "react"
import Modal from "./Modal.jsx"
import LogEntry from "./LogEntry.jsx"
import Icon from "./Icon.jsx"
import ActionMenu from "./ActionMenu.jsx"
import SearchInput from "./SearchInput.jsx"
import { clientPath } from "../api.js"
import { MSG_LOG_PAGE_SIZE } from "../config.js"
import { downloadCsv, downloadJson, fileTimestamp, formatCount, matchesSearch } from "../utils.js"
import { LOG_CSV_COLUMNS, toLogExportRow } from "../exportColumns.js"

const STATUS_FILTERS = [
  { key: "all", label: "All" },
  { key: "sent", label: "Sent" },
  { key: "failed", label: "Failed" },
]

function cursorOf(entries) {
  const last = [...entries].reverse().find((e) => typeof e.sentAt === "number")
  return last ? last.sentAt : null
}

// `before` is inclusive, so entries sharing the boundary timestamp come back
// again; skip exactly as many of them as are already loaded.
function dropOverlap(loaded, pageEntries, cursor) {
  let toSkip = loaded.filter((e) => e.sentAt === cursor).length
  return pageEntries.filter((e) => {
    if (toSkip > 0 && e.sentAt === cursor) {
      toSkip--
      return false
    }
    return true
  })
}

export default function MessageLogModal({ api, clientId, onClose, notify }) {
  const [entries, setEntries] = useState([])
  const [total, setTotal] = useState(null)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState("")
  const [statusFilter, setStatusFilter] = useState("all")
  const [search, setSearch] = useState("")
  const runRef = useRef(0)

  const fetchPage = useCallback((before) => {
    const params = new URLSearchParams({ limit: String(MSG_LOG_PAGE_SIZE) })
    if (before !== undefined) params.set("before", String(before))
    return api.get(`${clientPath(clientId, "/messages/log")}?${params}`)
  }, [api, clientId])

  const loadFirst = useCallback(async () => {
    const runId = ++runRef.current
    setLoading(true)
    setError("")
    try {
      const page = await fetchPage()
      if (runRef.current !== runId) return
      setEntries(page.messages || [])
      setTotal(page.total ?? 0)
      setHasMore((page.returned || 0) >= MSG_LOG_PAGE_SIZE)
    } catch (err) {
      if (runRef.current === runId) setError(`Failed to load message logs: ${err.message}`)
    } finally {
      if (runRef.current === runId) setLoading(false)
    }
  }, [fetchPage])

  useEffect(() => {
    loadFirst()
    return () => { runRef.current++ }
  }, [loadFirst])

  // Fetches the page after `loaded`; returns only entries not already loaded.
  async function fetchNext(loaded) {
    const cursor = cursorOf(loaded)
    if (cursor === null) return { fresh: [], more: false, total: null }
    const page = await fetchPage(cursor)
    const fresh = dropOverlap(loaded, page.messages || [], cursor)
    return {
      fresh,
      more: fresh.length > 0 && (page.returned || 0) >= MSG_LOG_PAGE_SIZE,
      total: page.total ?? null,
    }
  }

  async function loadMore() {
    const runId = ++runRef.current
    setLoading(true)
    setError("")
    try {
      const next = await fetchNext(entries)
      if (runRef.current !== runId) return
      setEntries((prev) => [...prev, ...next.fresh])
      if (next.total !== null) setTotal(next.total)
      setHasMore(next.more)
    } catch (err) {
      if (runRef.current === runId) setError(`Failed to load more: ${err.message}`)
    } finally {
      if (runRef.current === runId) setLoading(false)
    }
  }

  const searchTerm = search.trim()
  const isFiltered = statusFilter !== "all" || Boolean(searchTerm)
  const entryMatches = (e) =>
    (statusFilter === "all" || e.status === statusFilter) &&
    matchesSearch(search, { phone: e.phoneNumber, text: e.parseError ? e.raw : e.text })

  // Exports every entry (fetching pages not yet loaded), with the current filters applied.
  async function exportLogs(format) {
    setExporting(true)
    try {
      let all = entries
      let more = hasMore
      while (more) {
        const next = await fetchNext(all)
        all = [...all, ...next.fresh]
        more = next.more
      }
      const rows = all.filter(entryMatches).map(toLogExportRow)
      const base = `${clientId}-logs${statusFilter === "all" ? "" : `-${statusFilter}`}${searchTerm ? "-search" : ""}_${fileTimestamp()}`
      if (format === "csv") {
        downloadCsv(`${base}.csv`, LOG_CSV_COLUMNS, rows)
      } else {
        downloadJson(`${base}.json`, {
          clientId,
          exportedAt: new Date().toISOString(),
          statusFilter,
          search: searchTerm || null,
          exported: rows.length,
          order: "newest first",
          messages: rows,
        })
      }
      notify("success", `Exported ${formatCount(rows.length)} log entries as ${format.toUpperCase()}`)
    } catch (err) {
      notify("error", `Export failed for ${clientId}: ${err.message}`)
    } finally {
      setExporting(false)
    }
  }

  const failedCount = entries.filter((e) => e.status === "failed").length
  const visible = isFiltered ? entries.filter(entryMatches) : entries

  const subtitle = total === null
    ? (loading ? "Loading…" : undefined)
    : [
        `${formatCount(total)} logged`,
        `loaded ${formatCount(entries.length)}`,
        isFiltered ? `${formatCount(visible.length)} match` : `${formatCount(failedCount)} failed`,
      ].join(" · ")

  return (
    <Modal title={`Message Logs — ${clientId}`} subtitle={subtitle} onClose={onClose} wide>
      <div className="modal-toolbar">
        <button className="btn-secondary" onClick={loadFirst} disabled={loading}>
          <Icon name="refresh" /> {loading ? "Loading…" : "Refresh"}
        </button>
        <div className="segmented" role="group" aria-label="Filter by status">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.key}
              className={`segmented-btn${statusFilter === f.key ? " segmented-btn-active" : ""}`}
              onClick={() => setStatusFilter(f.key)}
            >
              {f.label}
              {f.key === "failed" && failedCount > 0 && <span className="count-pill count-pill-red">{failedCount}</span>}
            </button>
          ))}
        </div>
        <ActionMenu
          label={`Export all ${isFiltered ? "matching " : ""}entries (not just the loaded ones)`}
          triggerLabel={exporting ? "Exporting…" : "Export"}
          triggerIcon="download"
          align="left"
          disabled={loading || exporting || !total}
          items={[
            { label: "JSON (full detail)", onClick: () => exportLogs("json") },
            { label: "CSV (spreadsheet)", onClick: () => exportLogs("csv") },
          ]}
        />
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search phone or text…"
          label="Search message logs"
          className="modal-search"
        />
      </div>
      {error && <div className="error-text">{error}</div>}
      <div className="modal-list">
        {!loading && entries.length === 0 && !error && (
          <div className="empty-state">No message logs yet.</div>
        )}
        {entries.length > 0 && visible.length === 0 && (
          <div className="empty-state">
            No loaded entries match{searchTerm ? ` "${searchTerm}"` : ""}{statusFilter !== "all" ? ` (${statusFilter})` : ""}.
            {hasMore && " Load more to search older ones."}
          </div>
        )}
        {visible.map((entry, i) => (
          <LogEntry key={`${entry.sentAt ?? "x"}-${i}`} entry={entry} />
        ))}
        {hasMore && (
          <button className="btn-secondary load-more" onClick={loadMore} disabled={loading}>
            {loading ? "Loading…" : `Load ${MSG_LOG_PAGE_SIZE} more`}
          </button>
        )}
      </div>
      <div className="modal-footer-note">
        Newest first · filters apply to loaded entries · kept 7 days
      </div>
    </Modal>
  )
}
