/**
 * OpenMusic TUI —— @opentui/react 渲染。App 只管阶段机（boot/login/main）
 * 与完整界面 ↔ mini 播放器切换；主屏见 screens/main.tsx。
 *
 * 注意：不用 @opentui/solid——实测 0.5.8 solid 绑定的响应式更新在 Linux
 * 上全冻结（signal→renderable 不生效，官方示例同样复现）；React 绑定正常
 * （OpenCode 生产同款）。
 */
import { useCallback, useEffect, useMemo, useState } from "react"
import { useTerminalDimensions } from "@opentui/react"
import { OmApi } from "./api.js"
import { Player } from "./player.js"
import { loadStoredAuth, saveStoredAuth } from "./auth-store.js"
import { loadPlayerState } from "./player-state.js"
import { MiniPlayer } from "./components/mini-player.js"
import { LoginScreen } from "./screens/login.js"
import { MainScreen } from "./screens/main.js"

// —— mini 播放器阈值：窗口小于任一值即从完整界面切换 ——
const MINI_MAX_WIDTH = 70
const MINI_MAX_HEIGHT = 16

export interface Creds {
  url: string
  username: string
  password?: string
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

export function App({ creds }: { creds: Creds }) {
  // boot = 启动期恢复（cookie/记住的密码）；loading = 显式登录中
  const [phase, setPhase] = useState<"boot" | "login" | "loading" | "main">(
    creds.password ? "loading" : "boot",
  )
  const [error, setError] = useState("")
  // 登录屏预填值 + 顶栏展示用户名（恢复会话后来自 /auth/me）
  const [prefill, setPrefill] = useState({ user: creds.username, pass: "" })
  const [loginUser, setLoginUser] = useState(creds.username)
  // 实例必须跨渲染稳定：cookie 存在 OmApi 实例上，重建即丢会话
  const api = useMemo(() => new OmApi(creds.url), [creds.url])
  const [player] = useState(() => new Player(api))

  /** 登录成功后落盘（url/用户名/密码/新 cookie） */
  const persist = useCallback(
    (username: string, password: string) => {
      saveStoredAuth({ url: creds.url, username, password, cookie: api.sessionCookie })
    },
    [api, creds.url],
  )

  /** 恢复上次播放态：同服务器的上次曲目以暂停态回到播放条（空格从头播） */
  const resumePlayback = useCallback(() => {
    const stored = loadPlayerState()
    if (stored !== null && stored.url === creds.url) {
      player.restore(stored.queue, stored.index, stored.volume)
    }
  }, [creds.url, player])

  const login = useCallback(
    async (username: string, password: string) => {
      setError("")
      try {
        await api.login(username, password)
        setLoginUser(username)
        persist(username, password)
        resumePlayback()
        setPhase("main")
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        // 已在登录屏上则保持挂载（不切 loading 再切回——重挂载会把
        // 用户刚改的输入重置成预填值）；启动期（loading/boot）才落到登录屏
        setPhase((p) => (p === "login" ? p : "login"))
      }
    },
    [api, persist, resumePlayback],
  )

  // 启动恢复链：CLI 密码 → 保存的 cookie → 记住的密码 → 登录屏（预填）
  useEffect(() => {
    if (!creds.password) return
    void login(creds.username, creds.password)
  }, [creds, login])

  useEffect(() => {
    if (creds.password || phase !== "boot") return
    let cancelled = false
    const resume = async () => {
      const stored = loadStoredAuth()
      const usable = stored !== null && stored.url === creds.url
      if (usable && stored.cookie !== "") {
        // ① 上次的会话 cookie 还活着 → 无感直进
        api.restoreSession(stored.cookie)
        try {
          const me = await api.me()
          if (cancelled) return
          setLoginUser(me.username !== "" ? me.username : stored.username)
          setPrefill({ user: stored.username, pass: stored.password })
          resumePlayback()
          setPhase("main")
          return
        } catch {
          // cookie 过期 → 继续 ②
          api.restoreSession("")
        }
      }
      if (cancelled) return
      if (usable && stored.password !== "") {
        // ② 记住的密码 → 静默重登（顺带刷新 cookie）
        setPrefill({ user: stored.username, pass: stored.password })
        try {
          await api.login(stored.username, stored.password)
          if (cancelled) return
          setLoginUser(stored.username)
          persist(stored.username, stored.password)
          resumePlayback()
          setPhase("main")
          return
        } catch (e) {
          setError(`自动登录失败：${e instanceof Error ? e.message : String(e)}`)
          setPhase("login")
          return
        }
      }
      // ③ 没有任何可用的 → 登录屏
      setPhase("login")
    }
    void resume()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅启动时执行一次
  }, [])

  useEffect(() => () => player.dispose(), [player])

  const dims = useTerminalDimensions()
  const mini = dims.width < MINI_MAX_WIDTH || dims.height < MINI_MAX_HEIGHT

  if (phase === "login") {
    return (
      <LoginScreen defaultUser={prefill.user} defaultPass={prefill.pass} error={error} onSubmit={login} />
    )
  }
  if (phase === "boot") {
    return (
      <box style={{ flexGrow: 1, alignItems: "center", justifyContent: "center" }}>
        <text fg="#a5a5ae">{`正在恢复 ${creds.url} 的登录态 …`}</text>
      </box>
    )
  }
  if (phase === "loading") {
    return (
      <box style={{ flexGrow: 1, alignItems: "center", justifyContent: "center" }}>
        <text fg="#a5a5ae">{`正在连接 ${creds.url} …`}</text>
      </box>
    )
  }
  // 主界面与 mini 播放器双挂载、visible 切换：
  // 缩窗不卸载 MainScreen（浏览位置/视图栈不丢），放大即原样恢复
  return (
    <box style={{ flexGrow: 1, flexDirection: "column" }}>
      <box visible={!mini} style={{ flexGrow: 1, flexDirection: "column" }}>
        <MainScreen
          api={api}
          player={player}
          interactive={!mini}
          username={loginUser}
          host={hostOf(creds.url)}
        />
      </box>
      <box
        visible={mini}
        style={{ flexGrow: 1, flexDirection: "column", alignItems: "center", justifyContent: "center" }}
      >
        <MiniPlayer player={player} width={dims.width} height={dims.height} />
      </box>
    </box>
  )
}
