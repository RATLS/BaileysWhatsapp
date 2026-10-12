import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { createApiClient, clientPath } from "./api.js"
import { DEFAULT_API_BASE, ENV_META, REFRESH_INTERVAL_MS, UNKNOWN_ENV } from "./config.js"
import { copyText } from "./utils.js"
import { usePageVisible } from "./hooks.js"
import Toasts, { useToasts } from "./components/Toasts.jsx"
import Icon from "./components/Icon.jsx"
import StatsBar from "./components/StatsBar.jsx"
import ClientsPanel from "./components/ClientsPanel.jsx"
import QueueModal from "./components/QueueModal.jsx"
import MessageLogModal from "./components/MessageLogModal.jsx"
import HistoryModal from "./components/HistoryModal.jsx"
import SettingsModal from "./components/SettingsModal.jsx"
import ServiceLogs from "./components/ServiceLogs.jsx"

const API_BASE_STORAGE_KEY = "apiBase"
const TABS = [
  { key: "clients", label: "Clients" },
  { key: "service-logs", label: "Service Logs" },
]
const EMPTY_SNAPSHOT = { states: {}, active: [], ws: {} }
const EMPTY_ENVS = { envs: {}, mismatches: {} }
// Endpoints newer than some deployed APIs; a 404 turns the feature off
// for the current API endpoint instead of erroring on every refresh.
const ALL_FEATURES = { envs: true, queueCounts: true }

function loadApiBase() {
  try {
    return localStorage.getItem(API_BASE_STORAGE_KEY) || DEFAULT_API_BASE
  } catch {
    return DEFAULT_API_BASE
  }
}

function saveApiBase(value) {
  try {
    localStorage.setItem(API_BASE_STORAGE_KEY, value)
  } catch {
    // Storage blocked (private mode etc.): setting just won't persist.
  }
}

function countBy(items, keyOf) {
  return items.reduce((acc, item) => {
    const key = keyOf(item)
    acc[key] = (acc[key] || 0) + 1
    return acc
  }, {})
}

export default function App() {
  const [apiBase, setApiBase] = useState(loadApiBase)
  const api = useMemo(() => createApiClient(apiBase), [apiBase])
  const apiRef = useRef(api)
  const { toasts, notify, dismiss } = useToasts()
  const pageVisible = usePageVisible()

  const [snapshot, setSnapshot] = useState(EMPTY_SNAPSHOT)
  const [queueCounts, setQueueCounts] = useState(null)
  const [clientEnvs, setClientEnvs] = useState(EMPTY_ENVS)
  const [features, setFeatures] = useState(ALL_FEATURES)
  const featuresRef = useRef(ALL_FEATURES)
  const [loading, setLoading] = useState(false)
  const [lastRefresh, setLastRefresh] = useState(null)
  const [apiDown, setApiDown] = useState(null)
  const inFlight = useRef(false)

  const [tab, setTab] = useState(TABS[0].key)
  const [search, setSearch] = useState("")
  const [stateFilter, setStateFilter] = useState("all")
  const [envFilter, setEnvFilter] = useState("all")
  const [modal, setModal] = useState(null)

  const refresh = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    setLoading(true)
    const isCurrent = () => apiRef.current === api

    async function optional(feature, path) {
      if (!featuresRef.current[feature]) return null
      try {
        return await api.get(path)
      } catch (err) {
        if (err.status === 404 && isCurrent()) {
          featuresRef.current = { ...featuresRef.current, [feature]: false }
          setFeatures(featuresRef.current)
        }
        return null
      }
    }

    try {
      let core
      try {
        core = await Promise.all([
          api.get("/debug/client-states"),
          api.get("/debug/active-clients"),
          api.get("/debug/ws-stats"),
        ])
      } catch (err) {
        if (isCurrent()) {
          setApiDown((prev) => ({ since: prev ? prev.since : new Date(), message: err.message }))
        }
        return
      }
      if (!isCurrent()) return

      const [states, active, ws] = core
      setSnapshot({ states: states.states || {}, active: active.active || [], ws: ws.websockets || {} })
      setLastRefresh(new Date())
      setApiDown(null)

      const [counts, envData] = await Promise.all([
        optional("queueCounts", "/debug/queue-counts"),
        optional("envs", "/debug/client-envs"),
      ])
      if (!isCurrent()) return
      if (counts) setQueueCounts({ counts: counts.counts || {}, total: counts.total ?? 0 })
      if (envData) setClientEnvs({ envs: envData.envs || {}, mismatches: envData.mismatches || {} })
    } finally {
      inFlight.current = false
      setLoading(false)
    }
  }, [api])

  // New endpoint: start from a clean slate and re-detect features.
  // Declared before the polling effect so it runs first.
  useEffect(() => {
    apiRef.current = api
    featuresRef.current = ALL_FEATURES
    setFeatures(ALL_FEATURES)
    setSnapshot(EMPTY_SNAPSHOT)
    setQueueCounts(null)
    setClientEnvs(EMPTY_ENVS)
    setApiDown(null)
    setLastRefresh(null)
    inFlight.current = false
  }, [api])

  // Poll only while the tab is visible; refresh immediately when it comes back.
  useEffect(() => {
    if (!pageVisible) return undefined
    refresh()
    const id = setInterval(refresh, REFRESH_INTERVAL_MS)
    return () => clearInterval(id)
  }, [refresh, pageVisible])

  function changeApiBase(value) {
    saveApiBase(value)
    setApiBase(value)
  }

  // Runs a mutating call, reports the outcome, refreshes. Returns success.
  const runAction = useCallback(async (call, successText, failureText) => {
    try {
      await call()
      if (successText) notify("success", successText)
      refresh()
      return true
    } catch (err) {
      notify("error", `${failureText}: ${err.message}`)
      return false
    }
  }, [notify, refresh])

  const actions = useMemo(() => ({
    openQueue: (clientId) => setModal({ kind: "queue", clientId }),
    openLogs: (clientId) => setModal({ kind: "logs", clientId }),
    openHistory: (clientId) => setModal({ kind: "history", clientId }),
    copyId: async (clientId) => {
      try {
        await copyText(clientId)
        notify("success", `Copied ${clientId}`)
      } catch (err) {
        notify("error", `Copy failed: ${err.message}`)
      }
    },
    reconnect: (clientId) => runAction(
      () => api.post(clientPath(clientId, "/reconnect")),
      `Reconnect requested for ${clientId}`,
      `Reconnect failed for ${clientId}`
    ),
    restart: (clientId, resetSession) => {
      if (resetSession && !window.confirm(
        `Reset session and restart "${clientId}"?\n\nThis wipes the WhatsApp session. Someone will need to scan the QR code again.`
      )) return
      runAction(
        () => api.post(clientPath(clientId, "/restart"), { resetSession }),
        `${resetSession ? "Reset + restart" : "Restart"} requested for ${clientId}`,
        `Restart failed for ${clientId}`
      )
    },
    stop: (clientId, resetSession) => {
      if (resetSession && !window.confirm(
        `Reset session and stop "${clientId}"?\n\nThis wipes the WhatsApp session. Starting it again will need a new QR scan.`
      )) return
      runAction(
        () => api.post(clientPath(clientId, "/stop"), { resetSession }),
        `${resetSession ? "Reset + stop" : "Stop"} requested for ${clientId}`,
        `Stop failed for ${clientId}`
      )
    },
    remove: (clientId) => {
      if (!window.confirm(`Delete client "${clientId}"? This cannot be undone.`)) return
      runAction(
        () => api.del(clientPath(clientId)),
        `Delete requested for ${clientId}`,
        `Delete failed for ${clientId}`
      )
    },
    setEnv: (clientId, env) => runAction(
      () => (env ? api.put(clientPath(clientId, "/env"), { env }) : api.del(clientPath(clientId, "/env"))),
      env ? `${clientId} set to ${ENV_META[env].label}` : `${clientId} environment cleared`,
      `Updating environment failed for ${clientId}`
    ),
  }), [api, notify, runAction])

  const createClient = (clientId) => runAction(
    () => api.post(clientPath(clientId)),
    `Client ${clientId} created`,
    `Create failed for ${clientId}`
  )

  // ── Derived view data ─────────────────────────────────────────────
  const clients = useMemo(() => Object.keys(snapshot.states).sort((a, b) => a.localeCompare(b)), [snapshot.states])
  const activeSet = useMemo(() => new Set(snapshot.active), [snapshot.active])
  const envOf = useCallback(
    (id) => (ENV_META[clientEnvs.envs[id]] ? clientEnvs.envs[id] : UNKNOWN_ENV),
    [clientEnvs.envs]
  )
  const stateCounts = useMemo(() => countBy(clients, (id) => snapshot.states[id]), [clients, snapshot.states])
  const envCounts = useMemo(() => ({ all: clients.length, ...countBy(clients, envOf) }), [clients, envOf])
  const effectiveEnvFilter = features.envs ? envFilter : "all"

  const needle = search.trim().toLowerCase()
  const rows = clients
    .filter((id) => !needle || id.toLowerCase().includes(needle))
    .filter((id) => stateFilter === "all" || snapshot.states[id] === stateFilter)
    .filter((id) => effectiveEnvFilter === "all" || envOf(id) === effectiveEnvFilter)
    .map((id) => ({
      clientId: id,
      state: snapshot.states[id],
      isLive: activeSet.has(id),
      wsCount: snapshot.ws[id] || 0,
      queueCount: queueCounts ? queueCounts.counts[id] || 0 : 0,
      env: envOf(id),
      otherEnvs: clientEnvs.mismatches[id] || [],
    }))
  const isFiltering = Boolean(needle) || stateFilter !== "all" || effectiveEnvFilter !== "all"

  function clearFilters() {
    setSearch("")
    setStateFilter("all")
    setEnvFilter("all")
  }

  const closeModal = useCallback(() => setModal(null), [])

  return (
    <div className="page">
      <header className="topbar">
        <h1>Socket Control Center</h1>
        <div className="topbar-status">
          <span className={`status-dot ${apiDown ? "status-dot-down" : lastRefresh ? "status-dot-up" : ""}`} />
          <span className="meta">
            {apiBase} · {lastRefresh ? `updated ${lastRefresh.toLocaleTimeString()}` : "not yet refreshed"}
          </span>
          <button className="btn-secondary" onClick={refresh} disabled={loading}>
            <Icon name="refresh" className={loading ? "icon-spin" : ""} /> Refresh
          </button>
          <button className="btn-secondary" onClick={() => setModal({ kind: "settings" })}>
            <Icon name="settings" /> Settings
          </button>
        </div>
      </header>

      {apiDown && (
        <div className="banner-error" role="alert">
          <strong>API unreachable</strong> since {apiDown.since.toLocaleTimeString()} — {lastRefresh
            ? `showing data from ${lastRefresh.toLocaleTimeString()}.`
            : "no data loaded yet."} <span className="banner-detail">{apiDown.message}</span>
        </div>
      )}

      <nav className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            className={`tab${tab === t.key ? " tab-active" : ""}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {tab === "clients" && (
        <>
          <StatsBar
            stateCounts={stateCounts}
            total={clients.length}
            stateFilter={stateFilter}
            onStateFilter={setStateFilter}
            totalQueued={queueCounts ? queueCounts.total : null}
            liveCount={snapshot.active.length}
          />
          <ClientsPanel
            rows={rows}
            totalClients={clients.length}
            search={search}
            onSearch={setSearch}
            envFilter={effectiveEnvFilter}
            onEnvFilter={setEnvFilter}
            envCounts={envCounts}
            envSupported={features.envs}
            isFiltering={isFiltering}
            onClearFilters={clearFilters}
            onCreate={createClient}
            actions={actions}
          />
        </>
      )}

      {tab === "service-logs" && <ServiceLogs />}

      {modal?.kind === "queue" && (
        <QueueModal api={api} clientId={modal.clientId} onClose={closeModal} notify={notify} onChanged={refresh} />
      )}
      {modal?.kind === "logs" && (
        <MessageLogModal api={api} clientId={modal.clientId} onClose={closeModal} notify={notify} />
      )}
      {modal?.kind === "history" && (
        <HistoryModal api={api} clientId={modal.clientId} onClose={closeModal} notify={notify} />
      )}
      {modal?.kind === "settings" && (
        <SettingsModal
          api={api}
          apiBase={apiBase}
          onApiBaseChange={changeApiBase}
          onClose={closeModal}
          notify={notify}
        />
      )}

      <Toasts toasts={toasts} onDismiss={dismiss} />
    </div>
  )
}
