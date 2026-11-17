import { defineConfig, loadEnv } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { fileURLToPath } from "node:url"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    // Private LAN/tailnet deployments can opt in via apps/web/.env.local.
    host: process.env.OPENMUSIC_WEB_HOST || loadEnv("development", fileURLToPath(new URL(".", import.meta.url)), "OPENMUSIC_WEB_").OPENMUSIC_WEB_HOST || "127.0.0.1",
    port: 5175,
    strictPort: true,
    proxy: {
      "/api": "http://localhost:3000",
      "/rest": "http://localhost:3000",
    },
  },
})
