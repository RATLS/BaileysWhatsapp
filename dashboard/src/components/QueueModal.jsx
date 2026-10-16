import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import Modal from "./Modal.jsx"
import Icon from "./Icon.jsx"
import ActionMenu from "./ActionMenu.jsx"
import SearchInput from "./SearchInput.jsx"
import { clientPath } from "../api.js"
import { DEFAULT_JOB_TYPE, QUEUE_PAGE_SIZE } from "../config.js"
import {
  downloadCsv,
  downloadJson,
  fileTimestamp,
  formatCount,
  formatPhone,
  indexColumnWidth,
  matchesSearch,
} from "../utils.js"
import { QUEUE_CSV_COLUMNS } from "../exportColumns.js"

// Loads the whole queue in pages and shows it in send order.
// Redis list: LPUSH adds at the head, the worker BRPOPs from the tail,
// so the job at head-index i is sent at position (total - i).
export default function QueueModal({ api, clientId, onClose, notify, onChanged }) {
  const [items, setItems] = useState([])
  const [total, setTotal] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [note, setNote] = useState("")
  const [search, setSearch] = useState("")
  const runRef = useRef(0)

  const visible = useMemo(
    () => items.filter((entry) => matchesSearch(search, {
      phone: entry.parsed?.phoneNumber,
      text: entry.parsed ? entry.parsed.text : entry.raw,
    })),
    [items, search]
  )

  const load = useCallback(async () => {
    const runId = ++runRef.current
    setLoading(true)
    setError("")
    setNote("")
    setItems([])
    setTotal(null)

    const collected = []
    let offset = 0
    try {
      for (;;) {
        const page = await api.get(
          `${clientPath(clientId, "/queue")}?limit=${QUEUE_PAGE_SIZE}&offset=${offset}`
        )
        if (runRef.current !== runId) return

        // Older APIs ignore offset and keep returning the first page.
        if (offset > 0 && page.offset === undefined) {
          setNote(`This API version cannot page the queue; showing the first ${formatCount(collected.length)} messages.`)
          break
        }

        for (const m of page.messages || []) {
          collected.push({ ...m, sendPosition: page.total - m.index })
        }
        offset += page.returned || 0
        setTotal(page.total)
        setItems([...collected].sort((a, b) => a.sendPosition - b.sendPosition))

        if (!page.returned || offset >= page.total) break
      }
    } catch (err) {
      if (runRef.current === runId) setError(`Failed to load queue: ${err.message}`)
    } finally {
      if (runRef.current === runId) setLoading(false)
    }
  }, [api, clientId])

  useEffect(() => {
    load()
    // Closing the modal cancels any in-flight paging.
    return () => { runRef.current++ }
  }, [load])

  function stop() {
    runRef.current++
    setLoading(false)
    setNote(`Stopped after ${formatCount(items.length)} messages.`)
  }

  // Export follows what's on screen: the search filter is applied.
  function exportQueue(format) {
    const rows = visible.map((entry) => {
      const p = entry.parsed || {}
      return {
        sendPosition: entry.sendPosition,
        type: p.type ?? null,
        phoneNumber: p.phoneNumber ?? null,
        text: p.text ?? null,
        fileCount: Array.isArray(p.files) ? p.files.length : 0,
        files: Array.isArray(p.files) ? p.files : [],
        raw: entry.parsed ? null : entry.raw,
      }
    })
    const base = `${clientId}-queue_${fileTimestamp()}`
    if (format === "csv") {
      downloadCsv(`${base}.csv`, QUEUE_CSV_COLUMNS, rows.map((r) => ({
        ...r,
        files: r.files.map((f) => f.file_url).join(" "),
      })))
    } else {
      downloadJson(`${base}.json`, {
        clientId,
        exportedAt: new Date().toISOString(),
        totalPending: total,
        search: search.trim() || null,
        exported: rows.length,
        complete: !search.trim() && rows.length === total,
        order: "send order (sendPosition 1 = sent next)",
        messages: rows,
      })
    }
    notify("success", `Exported ${formatCount(rows.length)} queued message(s) as ${format.toUpperCase()}`)
  }

  async function clearQueue() {
    if (!window.confirm(`Clear all pending messages for "${clientId}"? They will not be sent.`)) return
    runRef.current++
    try {
      const res = await api.del(clientPath(clientId, "/queue"))
      notify("success", `Cleared ${formatCount(res.cleared)} message(s) from ${clientId}`)
      onChanged()
      load()
    } catch (err) {
      notify("error", `Clear queue failed for ${clientId}: ${err.message}`)
    }
  }

  const searching = Boolean(search.trim())
  const subtitle = total === null
    ? (loading ? "Loading…" : undefined)
    : loading
      ? `Loading ${formatCount(items.length)} of ${formatCount(total)}…`
      : searching
        ? `${formatCount(visible.length)} match · ${formatCount(total)} pending`
        : `${formatCount(total)} pending · showing ${formatCount(items.length)}`
  const indexWidth = indexColumnWidth(total)

  return (
    <Modal title={`Message Queue — ${clientId}`} subtitle={subtitle} onClose={onClose} wide>
      <div className="modal-toolbar">
        {loading
          ? <button className="btn-secondary" onClick={stop}><Icon name="stop" /> Stop loading</button>
          : <button className="btn-secondary" onClick={load}><Icon name="refresh" /> Refresh</button>}
        <ActionMenu
          label={loading ? "Wait for loading to finish" : `Export ${searching ? "matching" : "loaded"} messages`}
          triggerLabel="Export"
          triggerIcon="download"
          align="left"
          disabled={loading || visible.length === 0}
          items={[
            { label: "JSON (full detail)", onClick: () => exportQueue("json") },
            { label: "CSV (spreadsheet)", onClick: () => exportQueue("csv") },
          ]}
        />
        <button className="btn-danger-sm" onClick={clearQueue} disabled={!total}>Clear Queue</button>
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search phone or text…"
          label="Search queued messages"
          className="modal-search"
        />
      </div>
      {loading && total > 0 && (
        <div className="progress" aria-label="Loading progress">
          <div className="progress-bar" style={{ width: `${Math.min(100, (items.length / total) * 100)}%` }} />
        </div>
      )}
      {error && <div className="error-text">{error}</div>}
      {note && <div className="info-text">{note}</div>}
      <div className="modal-list">
        {!loading && !error && total === 0 && (
          <div className="empty-state">Queue is empty — no pending messages.</div>
        )}
        {searching && items.length > 0 && visible.length === 0 && (
          <div className="empty-state">No queued messages match "{search.trim()}".</div>
        )}
        {visible.map((entry) => {
          const p = entry.parsed || {}
          return (
            <div key={`${entry.sendPosition}-${entry.index}`} className="log-item">
              <div className="log-item-header">
                <span className="log-index" style={{ minWidth: indexWidth }} title="Send order (1 = sent next)">
                  #{entry.sendPosition}
                </span>
                <span className="log-phone">{formatPhone(p.phoneNumber)}</span>
                {p.type && p.type !== DEFAULT_JOB_TYPE && <span className="log-type">{p.type}</span>}
                {Array.isArray(p.files) && p.files.length > 0 && (
                  <span className="meta">{p.files.length} file(s)</span>
                )}
              </div>
              {p.text && <div className="log-text">{p.text}</div>}
              {!entry.parsed && <div className="log-error">Unreadable job: {entry.raw}</div>}
            </div>
          )
        })}
      </div>
      <div className="modal-footer-note">
        #1 is sent next · snapshot — press Refresh to update
      </div>
    </Modal>
  )
}
