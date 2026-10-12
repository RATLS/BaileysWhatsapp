import React, { useEffect, useState } from "react"
import Modal from "./Modal.jsx"
import { DEFAULT_API_BASE, SEND_DELAY_BOUNDS, SEND_DELAY_FALLBACK } from "../config.js"
import { isValidHttpUrl } from "../utils.js"

function validateDelay(form) {
  const minMs = Number(form.minMs)
  const maxMs = Number(form.maxMs)
  if (!Number.isInteger(minMs) || !Number.isInteger(maxMs)) return "Min and max must be whole numbers (ms)."
  if (minMs < SEND_DELAY_BOUNDS.minMs || maxMs > SEND_DELAY_BOUNDS.maxMs) {
    return `Allowed range is ${SEND_DELAY_BOUNDS.minMs}–${SEND_DELAY_BOUNDS.maxMs} ms.`
  }
  if (minMs > maxMs) return "Min must be less than or equal to max."
  return ""
}

export default function SettingsModal({ api, apiBase, onApiBaseChange, onClose, notify }) {
  const [apiDraft, setApiDraft] = useState(apiBase)
  const [delay, setDelay] = useState(null)
  const [delayForm, setDelayForm] = useState({ minMs: "", maxMs: "" })
  const [delayLoadError, setDelayLoadError] = useState("")
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    api.get("/config/send-delay")
      .then((data) => {
        if (cancelled) return
        setDelay(data)
        setDelayForm({
          minMs: String(data.minMs ?? SEND_DELAY_FALLBACK.minMs),
          maxMs: String(data.maxMs ?? SEND_DELAY_FALLBACK.maxMs),
        })
      })
      .catch((err) => { if (!cancelled) setDelayLoadError(`Failed to load send delay: ${err.message}`) })
    return () => { cancelled = true }
  }, [api])

  const apiDraftTrimmed = apiDraft.trim().replace(/\/+$/, "")
  const apiDraftValid = isValidHttpUrl(apiDraftTrimmed)
  const delayError = delay ? validateDelay(delayForm) : ""
  const delayDirty = delay && (String(delay.minMs) !== delayForm.minMs || String(delay.maxMs) !== delayForm.maxMs)

  function applyApiBase() {
    if (!apiDraftValid) return
    onApiBaseChange(apiDraftTrimmed)
    notify("success", `API endpoint set to ${apiDraftTrimmed}`)
  }

  async function saveDelay() {
    if (delayError) return
    setSaving(true)
    try {
      const data = await api.post("/config/send-delay", {
        minMs: Number(delayForm.minMs),
        maxMs: Number(delayForm.maxMs),
      })
      setDelay({ minMs: data.minMs, maxMs: data.maxMs, source: "redis" })
      setDelayForm({ minMs: String(data.minMs), maxMs: String(data.maxMs) })
      notify("success", `Send delay saved: ${data.minMs}–${data.maxMs} ms`)
    } catch (err) {
      notify("error", `Saving send delay failed: ${err.message}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title="Settings" onClose={onClose}>
      <section className="settings-section">
        <div className="section-label">API Endpoint</div>
        <div className="inline-form">
          <input
            value={apiDraft}
            onChange={(e) => setApiDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && applyApiBase()}
            placeholder={DEFAULT_API_BASE}
            aria-label="API endpoint"
          />
          <button className="btn-primary" onClick={applyApiBase} disabled={!apiDraftValid || apiDraftTrimmed === apiBase}>
            Apply
          </button>
        </div>
        {!apiDraftValid && <div className="error-text">Enter a full http(s) URL.</div>}
        <div className="meta">
          Saved in this browser only. Default: {DEFAULT_API_BASE}
          {apiBase !== DEFAULT_API_BASE && (
            <> · <button className="link-btn" onClick={() => { setApiDraft(DEFAULT_API_BASE); onApiBaseChange(DEFAULT_API_BASE) }}>reset</button></>
          )}
        </div>
      </section>

      <section className="settings-section">
        <div className="section-label">Send Delay (global)</div>
        {delayLoadError && <div className="error-text">{delayLoadError}</div>}
        {delay && (
          <>
            <div className="delay-row">
              <div>
                <label className="field-label" htmlFor="delay-min">Min (ms)</label>
                <input
                  id="delay-min"
                  type="number"
                  min={SEND_DELAY_BOUNDS.minMs}
                  max={SEND_DELAY_BOUNDS.maxMs}
                  value={delayForm.minMs}
                  onChange={(e) => setDelayForm({ ...delayForm, minMs: e.target.value })}
                />
              </div>
              <div>
                <label className="field-label" htmlFor="delay-max">Max (ms)</label>
                <input
                  id="delay-max"
                  type="number"
                  min={SEND_DELAY_BOUNDS.minMs}
                  max={SEND_DELAY_BOUNDS.maxMs}
                  value={delayForm.maxMs}
                  onChange={(e) => setDelayForm({ ...delayForm, maxMs: e.target.value })}
                />
              </div>
            </div>
            <div className="meta">
              Active: {delay.minMs}–{delay.maxMs} ms · source: {delay.source}
              {delayDirty && <span className="unsaved"> · unsaved changes</span>}
            </div>
            {delayError && <div className="error-text">{delayError}</div>}
            <button className="btn-primary" onClick={saveDelay} disabled={saving || !delayDirty || Boolean(delayError)}>
              {saving ? "Saving…" : "Save delay"}
            </button>
          </>
        )}
      </section>
    </Modal>
  )
}
