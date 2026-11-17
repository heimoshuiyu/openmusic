import { defineConfig, mergeConfig } from "vite"
import base from "./vite.config"
import { fileURLToPath } from "node:url"

export default mergeConfig(base, defineConfig({
  base: "./", publicDir: false,
  resolve: { alias: [
    {find:"@/api/transport",replacement:fileURLToPath(new URL("./src/android-assistant/bridge.ts",import.meta.url))},
    {find:"@/agent/platform",replacement:fileURLToPath(new URL("./src/android-assistant/platform.ts",import.meta.url))},
  ] },
  build: { emptyOutDir:true, target:"chrome111", rolldownOptions:{input:["android-assistant.html", "android-admin.html"]} },
}))
