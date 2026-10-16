import React, { useCallback, useEffect, useRef, useState } from "react"
import { TOAST_DURATION_MS } from "../config.js"
import Icon from "./Icon.jsx"

export function useToasts() {
  const [toasts, setToasts] = useState([])
  const nextId = useRef(1)
  const timers = useRef(new Map())

  const dismiss = useCallback((id) => {
    setToasts((list) => list.filter((t) => t.id !== id))
    clearTimeout(timers.current.get(id))
    timers.current.delete(id)
  }, [])

  const notify = useCallback((kind, text) => {
    const id = nextId.current++
    setToasts((list) => [...list, { id, kind, text }])
    // Errors stay a little longer so they can be read.
    const duration = kind === "error" ? TOAST_DURATION_MS * 2 : TOAST_DURATION_MS
    timers.current.set(id, setTimeout(() => dismiss(id), duration))
  }, [dismiss])

  useEffect(() => {
    const pending = timers.current
    return () => pending.forEach((timer) => clearTimeout(timer))
  }, [])

  return { toasts, notify, dismiss }
}

export default function Toasts({ toasts, onDismiss }) {
  if (!toasts.length) return null
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`}>
          <span>{t.text}</span>
          <button className="toast-close" onClick={() => onDismiss(t.id)} aria-label="Dismiss">
            <Icon name="close" size={12} />
          </button>
        </div>
      ))}
    </div>
  )
}
