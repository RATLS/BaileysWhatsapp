import React, { useEffect, useMemo, useState } from "react"

const DEFAULT_API_BASE = "http://localhost:3000"

function loadApiBase() {
  return localStorage.getItem("apiBase") || DEFAULT_API_BASE
}

const STATE_META = {
  CREATED:      { label: "Created",      cls: "state-created" },
  CONNECTING:   { label: "Connecting",   cls: "state-connecting" },
  QR_REQUIRED:  { label: "Scan QR",      cls: "state-qr" },
  CONNECTED:    { label: "Connected",    cls: "state-connected" },
  DISCONNECTED: { label: "Disconnected", cls: "state-disconnected" },
  LOGGED_OUT:   { label: "Logged Out",   cls: "state-loggedout" },
  STOPPED:      { label: "Stopped",      cls: "state-stopped" },
}

function Modal({ title, subtitle, onClose, children }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose() }
    window.addEventListener("keydown", onKey)
    document.body.style.overflow = "hidden"
    return () => {
      window.removeEventListener("keydown", onKey)
      document.body.style.overflow = ""
    }
  }, [onClose])

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-panel">
        <div className="modal-header">
          <div>
            <div className="modal-title">{title}</div>
            {subtitle && <div className="modal-subtitle">{subtitle}</div>}
          </div>
          <button className="modal-close-btn" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  )
}

function App() {
  const [apiBase, setApiBase] = useState(loadApiBase)
  const [clientStates, setClientStates] = useState({})
  const [activeClients, setActiveClients] = useState([])
  const [wsStats, setWsStats] = useState({})
  const [sendDelay, setSendDelay] = useState({ minMs: 3000, maxMs: 8000, source: "default" })
  const [sendDelayForm, setSendDelayForm] = useState({ minMs: "3000", maxMs: "8000" })
  const [sendDelaySaving, setSendDelaySaving] = useState(false)
  const [sendDelayError, setSendDelayError] = useState("")
  const [sendForm, setSendForm] = useState({ clientId: "", phoneNumber: "", text: "" })
  const [newClientId, setNewClientId] = useState("")
  const [loading, setLoading] = useState(false)
  const [lastRefresh, setLastRefresh] = useState(null)
  const [directLookupId, setDirectLookupId] = useState("")

  // Queue modal
  const [queueModal, setQueueModal] = useState(null)
  const [queueData, setQueueData] = useState(null)
  const [queueLoading, setQueueLoading] = useState(false)
  const [queueError, setQueueError] = useState("")

  // Message log modal
  const [msgLogModal, setMsgLogModal] = useState(null)
  const [msgLogData, setMsgLogData] = useState(null)
  const [msgLogLoading, setMsgLogLoading] = useState(false)
  const [msgLogError, setMsgLogError] = useState("")

  // Persistent log modal
  const [persistModal, setPersistModal] = useState(null)
  const [persistLogFrom, setPersistLogFrom] = useState(() => new Date().toISOString().slice(0, 10))
  const [persistLogTo, setPersistLogTo] = useState(() => new Date().toISOString().slice(0, 10))
  const [persistLogData, setPersistLogData] = useState(null)
  const [persistLogLoading, setPersistLogLoading] = useState(false)
  const [persistLogError, setPersistLogError] = useState("")

  const clients = useMemo(() => Object.keys(clientStates || {}), [clientStates])

  async function apiGet(path) {
    const res = await fetch(`${apiBase}${path}`)
    if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`)
    return res.json()
  }

  async function apiPost(path, body) {
    const res = await fetch(`${apiBase}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body || {})
    })
    if (!res.ok) throw new Error(`POST ${path} failed: ${res.status}`)
    return res.json()
  }

  async function apiDelete(path) {
    const res = await fetch(`${apiBase}${path}`, { method: "DELETE" })
    if (!res.ok) throw new Error(`DELETE ${path} failed: ${res.status}`)
    return res.json()
  }

  async function refreshAll() {
    setLoading(true)
    try {
      const [states, active, ws] = await Promise.all([
        apiGet("/debug/client-states"),
        apiGet("/debug/active-clients"),
        apiGet("/debug/ws-stats")
      ])
      setClientStates(states.states || {})
      setActiveClients(active.active || [])
      setWsStats(ws.websockets || {})
      setLastRefresh(new Date())
    } catch (err) {
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    refreshAll()
    const id = setInterval(refreshAll, 5000)
    return () => clearInterval(id)
  }, [apiBase])

  useEffect(() => { localStorage.setItem("apiBase", apiBase) }, [apiBase])

  useEffect(() => {
    let cancelled = false
    async function loadSendDelay() {
      try {
        const data = await apiGet("/config/send-delay")
        if (cancelled) return
        setSendDelay(data)
        setSendDelayForm({ minMs: String(data.minMs ?? 3000), maxMs: String(data.maxMs ?? 8000) })
        setSendDelayError("")
      } catch {
        if (!cancelled) setSendDelayError("Failed to load send delay config")
      }
    }
    loadSendDelay()
    return () => { cancelled = true }
  }, [apiBase])

  async function createClient() {
    if (!newClientId) return
    await apiPost(`/clients/${encodeURIComponent(newClientId)}`)
    setNewClientId("")
    await refreshAll()
  }

  async function reconnectClient(clientId) {
    await apiPost(`/clients/${encodeURIComponent(clientId)}/reconnect`)
    await refreshAll()
  }

  async function restartClient(clientId, resetSession) {
    await apiPost(`/clients/${encodeURIComponent(clientId)}/restart`, { resetSession })
    await refreshAll()
  }

  async function stopClient(clientId, resetSession) {
    await apiPost(`/clients/${encodeURIComponent(clientId)}/stop`, { resetSession })
    await refreshAll()
  }

  async function deleteClient(clientId) {
    if (!window.confirm(`Delete client "${clientId}"? This cannot be undone.`)) return
    await apiDelete(`/clients/${encodeURIComponent(clientId)}`)
    await refreshAll()
  }

  // ── Queue ─────────────────────────────────────────────────────────────────

  async function fetchQueue(clientId) {
    setQueueLoading(true)
    setQueueError("")
    try {
      const data = await apiGet(`/clients/${encodeURIComponent(clientId)}/queue?limit=100`)
      setQueueData(data)
    } catch {
      setQueueError(`Failed to load queue for ${clientId}`)
    } finally {
      setQueueLoading(false)
    }
  }

  function openQueueModal(clientId) {
    setQueueModal({ clientId })
    setQueueData(null)
    fetchQueue(clientId)
  }

  async function clearQueue(clientId) {
    if (!window.confirm(`Clear all pending messages for "${clientId}"?`)) return
    setQueueLoading(true)
    setQueueError("")
    try {
      await apiDelete(`/clients/${encodeURIComponent(clientId)}/queue`)
      await fetchQueue(clientId)
    } catch {
      setQueueError(`Failed to clear queue for ${clientId}`)
      setQueueLoading(false)
    }
  }

  // ── Message logs ──────────────────────────────────────────────────────────

  async function fetchMsgLog(clientId) {
    setMsgLogLoading(true)
    setMsgLogError("")
    try {
      const data = await apiGet(`/clients/${encodeURIComponent(clientId)}/messages/log?limit=100`)
      setMsgLogData(data)
    } catch {
      setMsgLogError(`Failed to load message logs for ${clientId}`)
    } finally {
      setMsgLogLoading(false)
    }
  }

  function openMsgLogModal(clientId) {
    setMsgLogModal({ clientId })
    setMsgLogData(null)
    fetchMsgLog(clientId)
  }

  // ── Persistent logs ───────────────────────────────────────────────────────

  async function fetchPersistLog(clientId, from, to) {
    setPersistLogLoading(true)
    setPersistLogError("")
    try {
      const params = new URLSearchParams({ from, to, limit: 500 })
      const data = await apiGet(`/clients/${encodeURIComponent(clientId)}/logs/persistent?${params}`)
      setPersistLogData(data)
    } catch {
      setPersistLogError(`Failed to load persistent logs for ${clientId}`)
    } finally {
      setPersistLogLoading(false)
    }
  }

  function openPersistModal(clientId) {
    setPersistModal({ clientId })
    setPersistLogData(null)
    fetchPersistLog(clientId, persistLogFrom, persistLogTo)
  }

  async function deletePersistentLog(clientId) {
    if (!window.confirm(`Delete persistent log file for "${clientId}"? This cannot be undone.`)) return
    try {
      await apiDelete(`/clients/${encodeURIComponent(clientId)}/logs/persistent`)
      setPersistLogData(null)
    } catch {
      setPersistLogError(`Failed to delete log for ${clientId}`)
    }
  }

  // ── Send / delay ──────────────────────────────────────────────────────────

  async function sendTestMessage() {
    if (!sendForm.clientId || !sendForm.phoneNumber || !sendForm.text) return
    await apiPost("/messages/send", {
      clientId: sendForm.clientId,
      phoneNumber: sendForm.phoneNumber,
      text: sendForm.text,
      files: []
    })
    setSendForm({ clientId: "", phoneNumber: "", text: "" })
  }

  async function saveSendDelay() {
    setSendDelaySaving(true)
    setSendDelayError("")
    try {
      const data = await apiPost("/config/send-delay", {
        minMs: Number(sendDelayForm.minMs),
        maxMs: Number(sendDelayForm.maxMs)
      })
      setSendDelay({ minMs: data.minMs, maxMs: data.maxMs, source: "redis" })
      setSendDelayForm({ minMs: String(data.minMs), maxMs: String(data.maxMs) })
    } catch {
      setSendDelayError("Failed to save send delay config")
    } finally {
      setSendDelaySaving(false)
    }
  }

  const sortedClients = [...clients].sort((a, b) => a.localeCompare(b))

  return (
    <div className="page">
      {/* ── Header ──────────────────────────────── */}
      <header className="header">
        <div className="header-left">
          <div className="eyebrow">Baileys Ops</div>
          <h1>Socket Control Center</h1>
          <p className="header-desc">WhatsApp client management on a single node</p>
        </div>
        <div className="card api-card">
          <label className="field-label">API Endpoint</label>
          <input
            value={apiBase}
            onChange={(e) => setApiBase(e.target.value)}
            placeholder={DEFAULT_API_BASE}
          />
          <div className="refresh-row">
            <button className="btn-secondary" onClick={refreshAll} disabled={loading}>
              {loading ? "Refreshing…" : "↺ Refresh"}
            </button>
            <span className="meta">
              {lastRefresh ? `Updated ${lastRefresh.toLocaleTimeString()}` : "Not yet refreshed"}
            </span>
          </div>
        </div>
      </header>

      {/* ── Top grid ────────────────────────────── */}
      <div className="top-grid">
        <div className="card">
          <div className="section-label">System Overview</div>
          <div className="stat-row">
            <div className="stat">
              <div className="stat-label">Known Clients</div>
              <div className="stat-value">{clients.length}</div>
            </div>
            <div className="stat">
              <div className="stat-label">Active Sockets</div>
              <div className="stat-value">{activeClients.length}</div>
            </div>
            <div className="stat">
              <div className="stat-label">WS Connections</div>
              <div className="stat-value">{Object.values(wsStats).reduce((a, b) => a + b, 0)}</div>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="section-label">Create New Client</div>
          <div className="inline-form">
            <input
              value={newClientId}
              onChange={(e) => setNewClientId(e.target.value)}
              placeholder="e.g. client-123"
              onKeyDown={(e) => e.key === "Enter" && createClient()}
            />
            <button className="btn-primary" onClick={createClient} disabled={!newClientId}>
              Create
            </button>
          </div>
        </div>

        <div className="card">
          <div className="section-label">Send Test Message</div>
          <input
            value={sendForm.clientId}
            onChange={(e) => setSendForm({ ...sendForm, clientId: e.target.value })}
            placeholder="Client ID"
          />
          <input
            value={sendForm.phoneNumber}
            onChange={(e) => setSendForm({ ...sendForm, phoneNumber: e.target.value })}
            placeholder="Phone number"
          />
          <input
            value={sendForm.text}
            onChange={(e) => setSendForm({ ...sendForm, text: e.target.value })}
            placeholder="Message text"
          />
          <button
            className="btn-primary"
            onClick={sendTestMessage}
            disabled={!sendForm.clientId || !sendForm.phoneNumber || !sendForm.text}
          >
            Queue Message
          </button>
        </div>

        <div className="card">
          <div className="section-label">Send Delay</div>
          <div className="delay-row">
            <div>
              <label className="field-label">Min (ms)</label>
              <input
                type="number" min="500" max="120000"
                value={sendDelayForm.minMs}
                onChange={(e) => setSendDelayForm({ ...sendDelayForm, minMs: e.target.value })}
              />
            </div>
            <div>
              <label className="field-label">Max (ms)</label>
              <input
                type="number" min="500" max="120000"
                value={sendDelayForm.maxMs}
                onChange={(e) => setSendDelayForm({ ...sendDelayForm, maxMs: e.target.value })}
              />
            </div>
          </div>
          <div className="meta" style={{ marginTop: 6 }}>
            Active: {sendDelay.minMs}ms – {sendDelay.maxMs}ms · source: {sendDelay.source}
          </div>
          {sendDelayError && <div className="error-text">{sendDelayError}</div>}
          <button className="btn-primary" onClick={saveSendDelay} disabled={sendDelaySaving}>
            {sendDelaySaving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      {/* ── Clients ─────────────────────────────── */}
      <div className="card clients-card">
        <div className="clients-header">
          <div className="clients-header-left">
            <div className="section-label" style={{ marginBottom: 0 }}>Connected Clients</div>
            <span className="meta">{sortedClients.length} total</span>
          </div>
          <div className="direct-lookup">
            <input
              value={directLookupId}
              onChange={(e) => setDirectLookupId(e.target.value)}
              placeholder="Look up any client queue by ID…"
              onKeyDown={(e) => e.key === "Enter" && directLookupId.trim() && openQueueModal(directLookupId.trim())}
            />
            <button
              className="btn-view"
              onClick={() => directLookupId.trim() && openQueueModal(directLookupId.trim())}
              disabled={!directLookupId.trim()}
            >
              View Queue
            </button>
          </div>
        </div>

        {sortedClients.length === 0 && (
          <div className="empty-state">No clients yet — create one above to get started.</div>
        )}

        <div className="client-list">
          {sortedClients.map((clientId) => {
            const state = clientStates[clientId]
            const wsCount = wsStats[clientId] || 0
            const isActive = activeClients.includes(clientId)
            const meta = STATE_META[state] || { label: state || "Unknown", cls: "state-unknown" }
            return (
              <div key={clientId} className="client-row">
                <div className="client-info">
                  <div className="client-id">{clientId}</div>
                  <div className="client-badges">
                    <span className={`state-badge ${meta.cls}`}>{meta.label}</span>
                    {isActive && <span className="live-badge">● Live</span>}
                    {wsCount > 0 && <span className="ws-badge">{wsCount} WS</span>}
                  </div>
                </div>

                <div className="client-actions">
                  <div className="action-group">
                    <span className="action-label">View</span>
                    <button className="btn-view" onClick={() => openQueueModal(clientId)}>Queue</button>
                    <button className="btn-view" onClick={() => openMsgLogModal(clientId)}>Logs</button>
                    <button className="btn-view" onClick={() => openPersistModal(clientId)}>History</button>
                  </div>
                  <div className="action-sep" />
                  <div className="action-group">
                    <span className="action-label">Control</span>
                    <button className="btn-control" onClick={() => reconnectClient(clientId)}>Reconnect</button>
                    <button className="btn-control" onClick={() => restartClient(clientId, false)}>Restart</button>
                    <button
                      className="btn-control"
                      onClick={() => restartClient(clientId, true)}
                      title="Wipe WhatsApp session then restart"
                    >
                      Reset+Restart
                    </button>
                  </div>
                  <div className="action-sep" />
                  <div className="action-group">
                    <span className="action-label">Stop</span>
                    <button className="btn-stop" onClick={() => stopClient(clientId, false)}>Stop</button>
                    <button
                      className="btn-stop"
                      onClick={() => stopClient(clientId, true)}
                      title="Wipe WhatsApp session then stop"
                    >
                      Reset+Stop
                    </button>
                    <button className="btn-danger" onClick={() => deleteClient(clientId)}>Delete</button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* ── Queue Modal ──────────────────────────── */}
      {queueModal && (
        <Modal
          title={`Message Queue — ${queueModal.clientId}`}
          subtitle={
            queueLoading ? "Loading…"
            : queueData ? `${queueData.total ?? 0} pending · showing ${queueData.returned ?? 0}`
            : undefined
          }
          onClose={() => { setQueueModal(null); setQueueData(null) }}
        >
          <div className="modal-toolbar">
            <button
              className="btn-secondary"
              onClick={() => fetchQueue(queueModal.clientId)}
              disabled={queueLoading}
            >
              {queueLoading ? "Loading…" : "↺ Refresh"}
            </button>
            <button
              className="btn-danger-sm"
              onClick={() => clearQueue(queueModal.clientId)}
              disabled={queueLoading}
            >
              Clear Queue
            </button>
          </div>
          {queueError && <div className="error-text">{queueError}</div>}
          <div className="modal-list">
            {!queueLoading && queueData?.messages?.length === 0 && (
              <div className="empty-state">Queue is empty — no pending messages.</div>
            )}
            {queueData?.messages?.map((entry) => {
              const p = entry.parsed || {}
              return (
                <div key={`${entry.index}-${entry.raw?.slice(0, 20)}`} className="log-item">
                  <div className="log-item-header">
                    <span className="log-index">#{entry.index + 1}</span>
                    {p.type && <span className="log-type">{p.type}</span>}
                    <span className="meta">{p.phoneNumber || "—"}</span>
                    {Array.isArray(p.files) && p.files.length > 0 && (
                      <span className="meta">{p.files.length} file(s)</span>
                    )}
                  </div>
                  {p.text && <div className="log-text">{p.text}</div>}
                </div>
              )
            })}
          </div>
          <div className="modal-footer-note">
            Read-only view of pending jobs. Use "Clear Queue" to drop all pending messages.
          </div>
        </Modal>
      )}

      {/* ── Message Log Modal ────────────────────── */}
      {msgLogModal && (
        <Modal
          title={`Message Logs — ${msgLogModal.clientId}`}
          subtitle={
            msgLogLoading ? "Loading…"
            : msgLogData
              ? `${msgLogData.total ?? 0} logged · showing ${msgLogData.returned ?? 0} · kept 7 days`
            : undefined
          }
          onClose={() => { setMsgLogModal(null); setMsgLogData(null) }}
        >
          <div className="modal-toolbar">
            <button
              className="btn-secondary"
              onClick={() => fetchMsgLog(msgLogModal.clientId)}
              disabled={msgLogLoading}
            >
              {msgLogLoading ? "Loading…" : "↺ Refresh"}
            </button>
          </div>
          {msgLogError && <div className="error-text">{msgLogError}</div>}
          <div className="modal-list">
            {!msgLogLoading && msgLogData?.messages?.length === 0 && (
              <div className="empty-state">No message logs yet.</div>
            )}
            {msgLogData?.messages?.map((entry, i) => {
              const ts = entry.sentAt ? new Date(entry.sentAt).toLocaleString() : "unknown time"
              const isFailed = entry.status === "failed"
              return (
                <div key={`${i}-${entry.sentAt}`} className={`log-item${isFailed ? " log-item-failed" : ""}`}>
                  <div className="log-item-header">
                    <span className={`status-badge ${isFailed ? "status-failed" : "status-sent"}`}>
                      {entry.status || "unknown"}
                    </span>
                    <span className="meta">{entry.phoneNumber || "—"}</span>
                    {(entry.fileCount ?? 0) > 0 && <span className="meta">{entry.fileCount} file(s)</span>}
                    <span className="meta">{ts}</span>
                  </div>
                  {entry.text && <div className="log-text">{entry.text}</div>}
                  {isFailed && entry.failReason && (
                    <div className="log-error">Error: {entry.failReason}</div>
                  )}
                  {entry.parseError && <div className="log-error">Malformed log entry</div>}
                </div>
              )
            })}
          </div>
          <div className="modal-footer-note">Logs auto-expire after 7 days.</div>
        </Modal>
      )}

      {/* ── Persistent Log Modal ─────────────────── */}
      {persistModal && (
        <Modal
          title={`Persistent History — ${persistModal.clientId}`}
          subtitle={
            persistLogLoading ? "Loading…"
            : persistLogData
              ? `${persistLogData.total ?? 0} matched · showing ${persistLogData.returned ?? 0}`
            : undefined
          }
          onClose={() => { setPersistModal(null); setPersistLogData(null) }}
        >
          <div className="modal-toolbar persist-toolbar">
            <div className="date-range">
              <label className="field-label">From</label>
              <input
                type="date"
                value={persistLogFrom}
                onChange={(e) => setPersistLogFrom(e.target.value)}
              />
              <label className="field-label">To</label>
              <input
                type="date"
                value={persistLogTo}
                onChange={(e) => setPersistLogTo(e.target.value)}
              />
            </div>
            <div className="toolbar-btns">
              <button
                className="btn-secondary"
                onClick={() => fetchPersistLog(persistModal.clientId, persistLogFrom, persistLogTo)}
                disabled={persistLogLoading}
              >
                {persistLogLoading ? "Loading…" : "↺ Load"}
              </button>
              <button
                className="btn-danger-sm"
                onClick={() => deletePersistentLog(persistModal.clientId)}
              >
                Delete File
              </button>
            </div>
          </div>
          {persistLogError && <div className="error-text">{persistLogError}</div>}
          <div className="modal-list">
            {!persistLogLoading && persistLogData?.entries?.length === 0 && (
              <div className="empty-state">No entries in this date range.</div>
            )}
            {persistLogData?.entries?.map((entry, i) => {
              const ts = entry.sentAt ? new Date(entry.sentAt).toLocaleString() : "unknown"
              const isFailed = entry.status === "failed"
              return (
                <div key={`${i}-${entry.sentAt}`} className={`log-item${isFailed ? " log-item-failed" : ""}`}>
                  <div className="log-item-header">
                    <span className={`status-badge ${isFailed ? "status-failed" : "status-sent"}`}>
                      {entry.status || "unknown"}
                    </span>
                    <span className="meta">{entry.phoneNumber || "—"}</span>
                    {(entry.fileCount ?? 0) > 0 && <span className="meta">{entry.fileCount} file(s)</span>}
                    <span className="meta">{ts}</span>
                  </div>
                  {entry.text && <div className="log-text">{entry.text}</div>}
                  {isFailed && entry.failReason && (
                    <div className="log-error">Error: {entry.failReason}</div>
                  )}
                </div>
              )
            })}
          </div>
          <div className="modal-footer-note">
            Persistent logs have no TTL. "Delete File" permanently removes the log file.
          </div>
        </Modal>
      )}
    </div>
  )
}

export default App
