import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { DASHBOARD_SERVER_BASE, SERVICE_LOG_REFRESH_MS, SERVICE_LOG_TAIL_OPTIONS } from "../config.js"
import { formatCount } from "../utils.js"
import Icon from "./Icon.jsx"
import SearchInput from "./SearchInput.jsx"
import { usePageVisible } from "../hooks.js"

// Container logs via the dashboard server (dashboard/server/index.js).
// In `npm run dev`, vite proxies /api to DASHBOARD_SERVER_URL.
export default function ServiceLogs() {
  const [meta, setMeta] = useState(null)
  const [service, setService] = useState("")
  const [tail, setTail] = useState(null)
  const [filter, setFilter] = useState("")
  const [autoRefresh, setAutoRefresh] = useState(false)
  const [text, setText] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [fetchedAt, setFetchedAt] = useState(null)
  const outputRef = useRef(null)

  useEffect(() => {
    let cancelled = false
    fetch(`${DASHBOARD_SERVER_BASE}/api/logs/services`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json()
      })
      .then((data) => {
        if (cancelled) return
        setMeta(data)
        setService(data.services[0] || "")
        setTail(data.tailDefault)
      })
      .catch((err) => {
        if (!cancelled) {
          setError(
            `Dashboard server not reachable (${err.message}). Service logs need the dashboard server ` +
            "(the dashboard container, or DASHBOARD_SERVER_URL when running npm run dev)."
          )
        }
      })
    return () => { cancelled = true }
  }, [])

  const load = useCallback(async () => {
    if (!service || !tail) return
    setLoading(true)
    try {
      const params = new URLSearchParams({ service, tail: String(tail) })
      const res = await fetch(`${DASHBOARD_SERVER_BASE}/api/logs?${params}`)
      const body = await res.text()
      if (!res.ok) throw new Error(body || `HTTP ${res.status}`)
      setText(body)
      setError("")
      setFetchedAt(new Date())
    } catch (err) {
      setError(`Failed to load ${service} logs: ${err.message}`)
    } finally {
      setLoading(false)
    }
  }, [service, tail])

  useEffect(() => { load() }, [load])

  // Auto-refresh pauses while the tab is hidden and catches up when it's shown again.
  const pageVisible = usePageVisible()
  const wasVisible = useRef(pageVisible)
  useEffect(() => {
    const cameBack = pageVisible && !wasVisible.current
    wasVisible.current = pageVisible
    if (!autoRefresh || !pageVisible) return undefined
    if (cameBack) load()
    const id = setInterval(load, SERVICE_LOG_REFRESH_MS)
    return () => clearInterval(id)
  }, [autoRefresh, pageVisible, load])

  const allLines = useMemo(() => (text ? text.split(/\r?\n/).filter((l) => l.length) : []), [text])
  const lines = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    return needle ? allLines.filter((l) => l.toLowerCase().includes(needle)) : allLines
  }, [allLines, filter])

  // Keep the newest lines in view after each load.
  useEffect(() => {
    if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight
  }, [lines])

  const tailOptions = meta ? SERVICE_LOG_TAIL_OPTIONS.filter((n) => n <= meta.tailMax) : []

  return (
    <div className="card service-logs">
      <div className="service-logs-toolbar">
        <select value={service} onChange={(e) => setService(e.target.value)} disabled={!meta} aria-label="Service">
          {(meta?.services || []).map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={tail ?? ""} onChange={(e) => setTail(Number(e.target.value))} disabled={!meta} aria-label="Lines">
          {tailOptions.map((n) => <option key={n} value={n}>Last {formatCount(n)} lines</option>)}
        </select>
        <SearchInput
          value={filter}
          onChange={setFilter}
          placeholder="Filter lines (e.g. a client ID)…"
          label="Filter log lines"
          className="service-logs-filter"
        />
        <label className="checkbox-label">
          <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} disabled={!meta} />
          Auto-refresh
        </label>
        <button className="btn-secondary" onClick={load} disabled={!meta || loading}>
          <Icon name="refresh" /> {loading ? "Loading…" : "Refresh"}
        </button>
      </div>
      {error && <div className="error-text">{error}</div>}
      <div className="meta">
        {filter.trim() ? `${formatCount(lines.length)} of ${formatCount(allLines.length)} lines` : `${formatCount(allLines.length)} lines`}
        {fetchedAt && ` · fetched ${fetchedAt.toLocaleTimeString()}`}
      </div>
      <pre className="service-logs-output" ref={outputRef}>
        {lines.length ? lines.join("\n") : (meta && !loading ? "No log lines." : "")}
      </pre>
    </div>
  )
}
