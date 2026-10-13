import { useCallback, useEffect, useState } from "react"
import { DASHBOARD_OPTIONS } from "./config.js"

function isVisible() {
  return typeof document === "undefined" || document.visibilityState !== "hidden"
}

// True while the browser tab is visible. Used to pause polling in background tabs.
export function usePageVisible() {
  const [visible, setVisible] = useState(isVisible)

  useEffect(() => {
    const onChange = () => setVisible(isVisible())
    document.addEventListener("visibilitychange", onChange)
    return () => document.removeEventListener("visibilitychange", onChange)
  }, [])

  return visible
}

const OPTIONS_STORAGE_KEY = "dashboardOptions"
const OPTION_DEFAULTS = Object.fromEntries(DASHBOARD_OPTIONS.map((o) => [o.key, o.default]))

function loadOptions() {
  try {
    const saved = JSON.parse(localStorage.getItem(OPTIONS_STORAGE_KEY) || "{}")
    // Only known keys with boolean values; new options fall back to their default.
    const known = Object.fromEntries(
      Object.entries(saved).filter(([key, value]) => key in OPTION_DEFAULTS && typeof value === "boolean")
    )
    return { ...OPTION_DEFAULTS, ...known }
  } catch {
    return { ...OPTION_DEFAULTS }
  }
}

// Dashboard on/off options (Settings → Dashboard options), saved per browser.
export function useDashboardOptions() {
  const [options, setOptions] = useState(loadOptions)

  const setOption = useCallback((key, value) => {
    setOptions((prev) => {
      const next = { ...prev, [key]: value }
      try {
        localStorage.setItem(OPTIONS_STORAGE_KEY, JSON.stringify(next))
      } catch {
        // Storage blocked: the option still applies until the page reloads.
      }
      return next
    })
  }, [])

  return [options, setOption]
}
