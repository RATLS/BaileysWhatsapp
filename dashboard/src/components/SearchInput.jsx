import React from "react"
import Icon from "./Icon.jsx"

export default function SearchInput({ value, onChange, placeholder, label, className = "" }) {
  return (
    <div className={`client-search ${className}`}>
      <Icon name="search" className="client-search-icon" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && value && onChange("")}
        placeholder={placeholder}
        aria-label={label || placeholder}
      />
      {value && (
        <button className="client-search-clear" onClick={() => onChange("")} title="Clear" aria-label="Clear">
          <Icon name="close" size={12} />
        </button>
      )}
    </div>
  )
}
