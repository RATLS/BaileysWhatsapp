import React from "react"
import ActionMenu from "./ActionMenu.jsx"
import Icon from "./Icon.jsx"
import { ENV_META, QUEUE_ALERT_AT, QUEUE_WARN_AT, STATE_META, UNKNOWN_ENV, UNKNOWN_STATE_META } from "../config.js"
import { formatCount } from "../utils.js"

function queueLevel(count) {
  if (count >= QUEUE_ALERT_AT) return "queue-badge-alert"
  if (count >= QUEUE_WARN_AT) return "queue-badge-warn"
  return ""
}

export default function ClientRow({
  clientId,
  state,
  isLive,
  wsCount,
  queueCount,
  env,
  otherEnvs,
  envSupported,
  alertWatched,
  alertsSupported,
  showQrButton,
  actions,
}) {
  const meta = STATE_META[state] || { ...UNKNOWN_STATE_META, label: state || UNKNOWN_STATE_META.label }
  const alertMenuItem = alertsSupported
    ? [{
        label: alertWatched ? "Stop alerts" : "Watch for alerts",
        title: alertWatched
          ? "Stop posting this client's problems to Google Chat"
          : "Post to Google Chat when this client disconnects, needs a QR scan, gets stuck or fails to send",
        onClick: () => actions.setAlertWatch(clientId, !alertWatched),
      }]
    : []

  return (
    <div className="client-row">
      <div className="client-info">
        <div className="client-id-line">
          <span className="client-id">{clientId}</span>
          {alertWatched && (
            <span className="alert-watch" title="Alerts on: problems are posted to Google Chat" aria-label="Alerts on">
              <Icon name="bell" size={13} />
            </span>
          )}
          <button className="btn-copy" onClick={() => actions.copyId(clientId)} title="Copy client ID" aria-label={`Copy ${clientId}`}>
            <Icon name="copy" size={13} />
          </button>
        </div>
        <div className="client-badges">
          <span className={`env-badge ${ENV_META[env]?.cls || "env-unknown"}${envSupported ? "" : " env-badge-disabled"}`}>
            <select
              value={env === UNKNOWN_ENV ? "" : env}
              onChange={(e) => actions.setEnv(clientId, e.target.value)}
              disabled={!envSupported}
              title={envSupported
                ? "Environment (auto-detected; change to override)"
                : "This API version doesn't support environment labels yet"}
              aria-label={`Environment for ${clientId}`}
            >
              <option value="">Unknown</option>
              {Object.entries(ENV_META).map(([key, m]) => (
                <option key={key} value={key}>{m.label}</option>
              ))}
            </select>
            <Icon name="chevronDown" size={10} className="env-badge-caret" />
          </span>
          {otherEnvs.length > 0 && (
            <span
              className="env-mismatch"
              title={`Also used by: ${otherEnvs.join(", ")}. Set the environment manually to clear this warning.`}
            >
              ⚠ also {otherEnvs.join(", ")}
            </span>
          )}
          <span className={`state-badge ${meta.cls}`}>{meta.label}</span>
          {isLive && <span className="live-badge">Live</span>}
          {wsCount > 0 && <span className="ws-badge" title="Open websocket connections">{wsCount} WS</span>}
          {queueCount > 0 && (
            <button
              className={`queue-badge ${queueLevel(queueCount)}`}
              onClick={() => actions.openQueue(clientId)}
              title="Open queue"
            >
              {formatCount(queueCount)} queued
            </button>
          )}
        </div>
      </div>

      <div className="client-actions">
        <div className="action-group">
          <button className="btn-view" onClick={() => actions.openQueue(clientId)}>Queue</button>
          <button className="btn-view" onClick={() => actions.openLogs(clientId)}>Logs</button>
          <button className="btn-view" onClick={() => actions.openHistory(clientId)}>History</button>
        </div>
        <div className="action-sep" />
        <div className="action-group">
          {showQrButton && state === "QR_REQUIRED" && (
            <button className="btn-qr" onClick={() => actions.openQr(clientId)} title="Show the QR code to link a phone">
              <Icon name="qr" /> Show QR
            </button>
          )}
          {meta.canReconnect && (
            <button className="btn-control" onClick={() => actions.reconnect(clientId)}>Reconnect</button>
          )}
          <button className="btn-control" onClick={() => actions.restart(clientId, false)}>Restart</button>
          {meta.canStop && (
            <button className="btn-stop" onClick={() => actions.stop(clientId, false)}>Stop</button>
          )}
          <ActionMenu
            label={`More actions for ${clientId}`}
            items={[
              ...alertMenuItem,
              {
                label: "Reset session + Restart",
                title: "Wipe the WhatsApp session, then restart (QR scan needed)",
                onClick: () => actions.restart(clientId, true),
              },
              {
                label: "Reset session + Stop",
                title: "Wipe the WhatsApp session, then stop (QR scan needed later)",
                onClick: () => actions.stop(clientId, true),
              },
              { label: "Delete client", danger: true, onClick: () => actions.remove(clientId) },
            ]}
          />
        </div>
      </div>
    </div>
  )
}
