import React, { useState } from "react"
import Icon from "./Icon.jsx"

// Compact "+ New client" button that expands into an inline form.
export default function CreateClient({ onCreate }) {
  const [open, setOpen] = useState(false)
  const [newClientId, setNewClientId] = useState("")

  function close() {
    setOpen(false)
    setNewClientId("")
  }

  async function create() {
    const id = newClientId.trim()
    if (!id) return
    if (await onCreate(id)) close()
  }

  if (!open) {
    return (
      <button className="btn-primary" onClick={() => setOpen(true)}>
        <Icon name="plus" /> New client
      </button>
    )
  }

  return (
    <div className="inline-form create-client">
      <input
        autoFocus
        value={newClientId}
        onChange={(e) => setNewClientId(e.target.value)}
        placeholder="New client ID"
        onKeyDown={(e) => {
          if (e.key === "Enter") create()
          if (e.key === "Escape") close()
        }}
        aria-label="New client ID"
      />
      <button className="btn-primary" onClick={create} disabled={!newClientId.trim()}>Create</button>
      <button className="btn-secondary" onClick={close}>Cancel</button>
    </div>
  )
}
