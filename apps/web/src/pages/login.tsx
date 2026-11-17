import { useState } from "react"
import { useNavigate } from "@tanstack/react-router"
import { useQueryClient } from "@tanstack/react-query"
import { api } from "@/api/client"
import { Sleeve, Wordmark } from "@/components/identity"
import { btnPlay, inputClass } from "@/components/page"

/** 开机时刻：面板待机 → 电源灯呼吸 → 进室 */
export function LoginPage() {
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setLoading(true)
    setError(null)
    try {
      await api.login(username, password)
      await queryClient.invalidateQueries()
      navigate({ to: "/" })
    } catch (err) {
      setError(err instanceof Error ? err.message : "登录失败")
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="catalog-login"><header className="mb-8"><Wordmark/></header>
      <div className="login-spread"><Sleeve className="login-art"/>
      <form
        onSubmit={submit}
        className="w-full"
      >
        <h1 className="detail-title mb-7">登录音乐库</h1>

        <label className="mb-1 block text-xs text-dim" htmlFor="login-username">
          用户名
        </label>
        <input
          id="login-username"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          autoComplete="username"
          className={`mb-4 w-full ${inputClass}`}
        />
        <label className="mb-1 block text-xs text-dim" htmlFor="login-password">
          密码
        </label>
        <input
          id="login-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          type="password"
          autoComplete="current-password"
          className={`mb-4 w-full ${inputClass}`}
        />
        {error && (
          <div className="mb-4 text-xs text-danger" role="alert">
            {error}
          </div>
        )}
        <button
          type="submit"
          disabled={loading || !username || !password}
          className={`w-full ${btnPlay}`}
        >
          {loading ? "正在登录…" : "登录"}
        </button>
      </form>
    </div></main>
  )
}
