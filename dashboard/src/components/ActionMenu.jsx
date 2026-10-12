import React, { useEffect, useRef, useState } from "react"
import Icon from "./Icon.jsx"

// items: [{ label, onClick, danger?, title? }]
// Default trigger is a "⋯" icon button; pass triggerLabel for a text button.
export default function ActionMenu({
  items,
  label = "More actions",
  triggerLabel,
  triggerIcon,
  disabled = false,
  align = "right",
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef(null)

  useEffect(() => {
    if (!open) return undefined
    const onPointer = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false)
    }
    const onKey = (e) => { if (e.key === "Escape") setOpen(false) }
    document.addEventListener("mousedown", onPointer)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onPointer)
      document.removeEventListener("keydown", onKey)
    }
  }, [open])

  return (
    <div className="action-menu" ref={rootRef}>
      <button
        className={triggerLabel ? "btn-secondary" : "btn-icon"}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={label}
        disabled={disabled}
      >
        {triggerLabel
          ? <>{triggerIcon && <Icon name={triggerIcon} />} {triggerLabel} <Icon name="chevronDown" size={12} /></>
          : <Icon name="more" size={16} />}
      </button>
      {open && (
        <div className={`action-menu-list${align === "left" ? " action-menu-list-left" : ""}`} role="menu">
          {items.map((item) => (
            <button
              key={item.label}
              role="menuitem"
              className={`action-menu-item${item.danger ? " action-menu-item-danger" : ""}`}
              title={item.title}
              onClick={() => {
                setOpen(false)
                item.onClick()
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
