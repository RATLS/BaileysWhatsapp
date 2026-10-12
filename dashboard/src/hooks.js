import { useEffect, useState } from "react"

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
