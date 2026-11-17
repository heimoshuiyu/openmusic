#!/usr/bin/env bun
/**
 * OpenMusic TUI 入口。
 *
 * 用法：
 *   bun src/index.tsx                                     # 交互登录（默认 http://localhost:3000）；
 *                                                          已保存登录态则自动恢复（cookie → 密码 → 预填登录屏）
 *   bun src/index.tsx --url https://music.example.org        # 指定服务器
 *   OM_USER=admin OM_PASS=xxx bun src/index.tsx           # 环境变量免登录屏
 *   bun src/index.tsx --logout                            # 清除保存的登录态并退出
 *
 * 登录态保存于 ~/.config/openmusic-tui/auth.json（0600）。
 * 注意：不要用 `bun run` 传 flag——bun run 会吞掉脚本参数。
 */
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { App, type Creds } from "./app.js"
import { clearStoredAuth, loadStoredAuth } from "./auth-store.js"

function parseArgs(): Creds {
  const argv = process.argv.slice(2)
  const get = (flag: string, env: string, fallback = ""): string => {
    const i = argv.indexOf(flag)
    return (i >= 0 ? argv[i + 1] : undefined) ?? process.env[env] ?? fallback
  }
  return {
    url: get("--url", "OM_URL", "http://localhost:3000").replace(/\/+$/, ""),
    username: get("--user", "OM_USER", "admin"),
    password: get("--pass", "OM_PASS") || undefined,
  }
}

if (process.argv.includes("--logout")) {
  const stored = loadStoredAuth()
  if (stored) {
    clearStoredAuth()
    console.log(`已清除 ${stored.url}（${stored.username}）的保存登录态`)
  } else {
    console.log("没有保存的登录态")
  }
  process.exit(0)
}

const creds = parseArgs()

const renderer = await createCliRenderer({
  targetFps: 30,
  exitOnCtrlC: true,
})

createRoot(renderer).render(<App creds={creds} />)
