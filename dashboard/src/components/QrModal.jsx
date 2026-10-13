import React, { useEffect, useState } from "react"
import QRCode from "qrcode"
import Modal from "./Modal.jsx"
import { websocketUrl } from "../api.js"
import { QR_RESYNC_MS, STATE_META } from "../config.js"

// Live QR for linking a phone. Uses the API websocket (/ws): subscribing with
// the clientId returns the current state + QR, new QRs are pushed as WhatsApp
// rotates them, and a "status" event tells us when the phone has linked.
export default function QrModal({ apiBase, clientId, onClose, onRestart }) {
  const [connection, setConnection] = useState("connecting") // connecting | open | error
  const [clientState, setClientState] = useState(null)
  const [qr, setQr] = useState(null)
  const [image, setImage] = useState(null)
  const [qrAt, setQrAt] = useState(null)

  useEffect(() => {
    let socket
    let resync
    let closed = false
    try {
      socket = new WebSocket(websocketUrl(apiBase))
    } catch {
      setConnection("error")
      return undefined
    }

    const subscribe = () => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "ping", clientId }))
    }

    socket.onopen = () => {
      setConnection("open")
      subscribe()
      resync = setInterval(subscribe, QR_RESYNC_MS)
    }
    socket.onerror = () => { if (!closed) setConnection("error") }
    socket.onclose = () => { if (!closed) setConnection("error") }
    socket.onmessage = (msg) => {
      let data
      try {
        data = JSON.parse(msg.data)
      } catch {
        return
      }
      if (data.clientId && data.clientId !== clientId) return
      if (data.type === "qr" && data.qr) {
        setQr(data.qr)
        setQrAt(new Date())
      }
      if (data.type === "status" && data.state) {
        setClientState(data.state)
        if (data.state !== "QR_REQUIRED") setQr(null)
      }
    }

    return () => {
      closed = true
      clearInterval(resync)
      socket.close()
    }
  }, [apiBase, clientId])

  useEffect(() => {
    if (!qr) {
      setImage(null)
      return
    }
    let cancelled = false
    QRCode.toDataURL(qr, { width: 280, margin: 2, errorCorrectionLevel: "M" })
      .then((url) => { if (!cancelled) setImage(url) })
      .catch(() => { if (!cancelled) setImage(null) })
    return () => { cancelled = true }
  }, [qr])

  const stateLabel = clientState ? (STATE_META[clientState]?.label || clientState) : null

  let body
  if (connection === "error") {
    body = <div className="error-text">Couldn't open live updates at {websocketUrl(apiBase)}. Check that the API is running.</div>
  } else if (clientState === "CONNECTED") {
    body = <div className="qr-done">✅ Linked — {clientId} is connected. You can close this window.</div>
  } else if (image) {
    body = (
      <>
        <img className="qr-image" src={image} alt={`WhatsApp QR code for ${clientId}`} width="280" height="280" />
        <ol className="qr-steps">
          <li>Open WhatsApp on the phone</li>
          <li>Settings → <b>Linked devices</b> → <b>Link a device</b></li>
          <li>Point the camera at this code</li>
        </ol>
        <div className="meta">The code refreshes automatically{qrAt ? ` · updated ${qrAt.toLocaleTimeString()}` : ""}</div>
      </>
    )
  } else if (clientState === "NON_EXISTENT") {
    body = <div className="info-text">This client doesn't exist.</div>
  } else if (clientState && clientState !== "QR_REQUIRED" && clientState !== "CONNECTING" && clientState !== "CREATED") {
    body = (
      <div className="qr-empty">
        <div className="info-text">No QR right now — the client is <b>{stateLabel}</b>. Restart it to get a new QR.</div>
        <button className="btn-secondary" onClick={onRestart}>Restart {clientId}</button>
      </div>
    )
  } else {
    body = <div className="qr-wait">Waiting for a QR code…</div>
  }

  return (
    <Modal
      title={`Link phone — ${clientId}`}
      subtitle={stateLabel ? `Client state: ${stateLabel}` : "Connecting…"}
      onClose={onClose}
    >
      <div className="qr-body">{body}</div>
      <div className="modal-footer-note">
        Only link a phone you intend to use for this client — whoever scans this controls its WhatsApp sending.
      </div>
    </Modal>
  )
}
