/**
 * 登录屏：用户名/密码两栏输入。
 *
 * 坑（AGENTS）：交互登录失败时 phase 保持 "login" 不切走——LoginScreen 重挂载
 * 会把用户刚改的输入重置回预填值；靠 busy 挡重复提交。
 * OpenTUI input 无密码掩码——明文显示是已知取舍。
 */
import { useEffect, useRef, useState } from "react"
import type { InputRenderable } from "@opentui/core"
import { C } from "../theme.js"

export function LoginScreen({
  defaultUser,
  defaultPass,
  error,
  onSubmit,
}: {
  defaultUser: string
  defaultPass: string
  error: string
  onSubmit: (username: string, password: string) => void | Promise<void>
}) {
  const [username, setUsername] = useState(defaultUser)
  const [password, setPassword] = useState(defaultPass)
  const [busy, setBusy] = useState(false)
  const userRef = useRef<InputRenderable | null>(null)
  const passRef = useRef<InputRenderable | null>(null)

  useEffect(() => {
    // 用户名已预填（记住的登录态）→ 直接聚焦密码框，回车即登
    if (defaultUser !== "") passRef.current?.focus()
    else userRef.current?.focus()
  }, [])

  const submit = () => {
    if (!username || !password || busy) return
    setBusy(true)
    // onSubmit 返回 Promise（login）——完成前 busy 挡住重复提交
    void Promise.resolve(onSubmit(username, password)).finally(() => setBusy(false))
  }

  return (
    <box style={{ flexGrow: 1, alignItems: "center", justifyContent: "center" }}>
      <box style={{ flexDirection: "column", width: 44, border: true, borderColor: C.line, padding: 1, gap: 1 }}>
        <text fg={C.accent} attributes={1}>
          OpenMusic
        </text>
        <text fg={C.faint}>连接服务器并登录（密码明文显示）</text>
        <box style={{ flexDirection: "column" }}>
          <text fg={C.dim}>用户名（回车 → 密码框）</text>
          <input
            ref={(r) => {
              userRef.current = r
            }}
            value={username}
            onInput={setUsername}
            onSubmit={() => passRef.current?.focus()}
            placeholder="username"
          />
        </box>
        <box style={{ flexDirection: "column" }}>
          <text fg={C.dim}>密码（回车登录）</text>
          <input
            ref={(r) => {
              passRef.current = r
            }}
            value={password}
            onInput={setPassword}
            onSubmit={submit}
            placeholder="password"
          />
        </box>
        {busy && <text fg={C.dim}>连接中…</text>}
        {error !== "" && <text fg={C.danger}>{error}</text>}
      </box>
    </box>
  )
}
