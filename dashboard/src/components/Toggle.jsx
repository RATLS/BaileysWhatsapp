import React from "react"

// Accessible on/off switch (a styled checkbox with role="switch").
export default function Toggle({ id, checked, onChange, label, help }) {
  return (
    <label className="toggle-row" htmlFor={id}>
      <span className="toggle-text">
        <span className="toggle-label">{label}</span>
        {help && <span className="toggle-help">{help}</span>}
      </span>
      <input
        id={id}
        type="checkbox"
        role="switch"
        className="toggle-input"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="toggle-track" aria-hidden="true"><span className="toggle-thumb" /></span>
    </label>
  )
}
