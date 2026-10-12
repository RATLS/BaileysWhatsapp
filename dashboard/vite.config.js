import { defineConfig, loadEnv } from "vite"
import react from "@vitejs/plugin-react"

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "")

  return {
    plugins: [react()],
    build: {
      outDir: "dist"
    },
    server: {
      port: 5173,
      host: "0.0.0.0",
      // In dev, /api/* (service logs) is served by the dashboard server
      // (dashboard/server/index.js), normally the dashboard container.
      proxy: {
        "/api": env.DASHBOARD_SERVER_URL || "http://localhost:8080"
      }
    }
  }
})
