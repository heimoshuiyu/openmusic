/**
 * 登录态持久化：~/.config/openmusic-tui/auth.json（权限 0600）。
 *
 * 保存 url / username / password / om_session cookie。恢复优先级：
 *   ① 保存的 cookie 仍有效 → 直接进主界面（不打扰）
 *   ② cookie 过期但有记住的密码 → 静默重登并刷新 cookie
 *   ③ 都不行 → 登录屏（用户名密码预填，回车即登）
 *
 * 密码明文落盘是自托管/局域网场景的便利性取舍（与主流 CLI 客户端一致）：
 * 文件属主可读写，写失败不影响使用（只是下次要重新登录）。
 */
import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export interface StoredAuth {
  url: string
  username: string
  password: string
  cookie: string
}

const dir = join(homedir(), ".config", "openmusic-tui")
const file = join(dir, "auth.json")

/** 读取保存的登录态；无文件/损坏 → null */
export function loadStoredAuth(): StoredAuth | null {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<StoredAuth>
    if (typeof raw.url === "string" && typeof raw.username === "string") {
      return {
        url: raw.url,
        username: raw.username,
        password: typeof raw.password === "string" ? raw.password : "",
        cookie: typeof raw.cookie === "string" ? raw.cookie : "",
      }
    }
  } catch {
    // 无文件或 JSON 损坏 → 当作未保存过
  }
  return null
}

/** 保存/覆盖登录态（0600；失败静默——持久化只是便利性，不该让登录失败） */
export function saveStoredAuth(auth: StoredAuth): void {
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, JSON.stringify(auth, null, 2) + "\n", { mode: 0o600 })
    try {
      chmodSync(file, 0o600)
    } catch {
      // 个别文件系统不支持 chmod
    }
  } catch {
    // 只读 HOME / 磁盘满等——忽略
  }
}

/** 清除保存的登录态（--logout） */
export function clearStoredAuth(): void {
  try {
    unlinkSync(file)
  } catch {
    // 无文件
  }
}
