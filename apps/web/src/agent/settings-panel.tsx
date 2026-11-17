import { useEffect, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { api, ApiError, type AssistantChange, type AssistantModel, type ConsoleAttempt } from "@/api/client"
import { btnQuiet, inputClass, PageHeader } from "@/components/page"

const modelRef = (m: AssistantModel) => `${m.providerID}/${m.id}`
const summary = "cursor-pointer py-3 text-sm font-medium text-paper"

export function AssistantSettingsPanel() {
  const { data, error, isFetching, refetch } = useQuery({ queryKey: ["assistant-settings"], queryFn: api.assistantSettings,
    retry: (failures, e) => failures < 2 && e instanceof ApiError && e.status === 503 })
  const [selection, setSelection] = useState("")
  const [voiceSelection, setVoiceSelection] = useState("")
  const [provider, setProvider] = useState("opencode")
  const [key, setKey] = useState("")
  const [custom, setCustom] = useState({ slug: "", name: "", baseURL: "", models: "" })
  const [attempt, setAttempt] = useState<ConsoleAttempt | null>(null)
  const [busy, setBusy] = useState(false)
  const [syncCatalog, setSyncCatalog] = useState(0)
  const [notice, setNotice] = useState("")
  const current = data?.current ? modelRef(data.current) : ""
  const selected = selection || current
  const model = data?.models.find((m) => modelRef(m) === selected)
  const providerOptions = data?.integrations.filter((i) => i.key) ?? []
  const providers = [...new Set(data?.models.map((m) => m.providerID))]
  const openCode = data?.integrations.find((i) => i.id === "opencode")
  const accountCount = openCode?.accounts.length ?? 0

  useEffect(() => {
    if (!attempt) return
    let live = true
    let timer: ReturnType<typeof setTimeout>
    async function poll() {
      if (!attempt || !live) return
      try {
        const status = await api.consoleStatus(attempt.attemptID)
        if (!live) return
        if (status !== "pending" || Date.now() >= attempt.expires) {
          if (status === "complete") {
            await refetch() // Load the saved account before leaving the device-code screen.
            if (!live) return
            setSyncCatalog((n) => n + 1)
          }
          setAttempt(null)
          setNotice(status === "complete" ? "Console 已连接。请选择工作区提供的模型；目录尚未更新时可点击刷新。"
            : status === "failed" ? "授权未成功，请重新连接。" : "授权码已过期，请重新连接。")
          return
        }
      } catch {
        if (!live) return
        if (Date.now() >= attempt.expires) { setAttempt(null); setNotice("授权已过期，请重新连接。"); return }
        setNotice("暂时无法读取授权状态，正在重试。")
      }
      timer = setTimeout(poll, 2000)
    }
    void poll()
    return () => { live = false; clearTimeout(timer) }
  }, [attempt, refetch])

  // Console account completion and workspace model discovery are separate SDK events.
  useEffect(() => {
    if (!syncCatalog) return
    const timers = [1200, 3500, 8000].map((ms) => setTimeout(() => void refetch(), ms))
    return () => timers.forEach(clearTimeout)
  }, [syncCatalog, refetch])

  async function run(work: () => Promise<void>) {
    if (busy) return
    setBusy(true); setNotice("")
    try { await work() }
    catch (e) { setNotice(e instanceof Error ? e.message : "操作失败，请重试。") }
    finally { setBusy(false) }
  }
  async function change(input: AssistantChange, message: string) {
    await api.assistantChange(input)
    await refetch()
    setNotice(message)
    if (input.type === "key" || input.type === "activate" || input.type === "disconnect") setSyncCatalog((n) => n + 1)
  }
  const beginConsole = () => void run(async () => setAttempt(await api.consoleBegin()))

  return <section id="assistant-settings" aria-label="音乐助手设置">
    <PageHeader title="音乐助手" level={2}><button className={btnQuiet} disabled={busy || isFetching} onClick={() => void refetch()}>刷新模型目录</button></PageHeader>
    {error && <p role="alert" className="text-sm text-dim">{error instanceof ApiError && error.status === 503
      ? `助手设置不可用：${error.message}` : `读取失败：${error.message}`}</p>}
    {!data && !error && <p className="text-sm text-dim">正在读取模型目录…</p>}
    {data && <div className="max-w-3xl space-y-4">
      <form onSubmit={(e) => { e.preventDefault(); if (model) void run(async () => {
        await change({ type: "model", providerID: model.providerID, id: model.id }, "已保存。新对话和已有对话的下一条消息将使用此模型。")
        setSelection("")
      }) }}>
        <label htmlFor="assistant-model" className="text-sm font-medium text-paper">默认对话模型</label>
        <div className="my-2 flex flex-wrap items-center gap-2">
          <select id="assistant-model" className={`${inputClass} min-w-0 max-w-full flex-1`} value={selected} disabled={busy} onChange={(e) => setSelection(e.target.value)}>
            {!model && <option value={selected}>{selected ? `${selected}（不可用）` : "请选择模型"}</option>}
            {providers.map((p) => {
              const models = data.models.filter((m) => m.providerID === p)
              return <optgroup key={p} label={models[0]!.provider}>{models.map((m) => <option key={modelRef(m)} value={modelRef(m)}>{m.name} · {modelRef(m)}</option>)}</optgroup>
            })}
          </select>
          <button className={btnQuiet} disabled={busy || !model || selected === current}>保存模型</button>
        </div>
        <p className="text-xs text-dim">全站用户共用，只列出支持工具调用的模型。切换不会打断正在生成的回复。</p>
      </form>

      <form onSubmit={e => { e.preventDefault(); const m = data.voiceModels.find(v => modelRef(v) === voiceSelection); if (m) void run(async () => {
        await change({ type:"voiceModel", providerID:m.providerID, id:m.id }, "已保存听写模型。对话模型未改变。"); setVoiceSelection("")
      }) }}>
        <label htmlFor="assistant-voice-model" className="text-sm font-medium text-paper">语音输入模型</label>
        <div className="my-2 flex flex-wrap items-center gap-2">
          <select id="assistant-voice-model" value={voiceSelection || data.voiceModel} disabled={busy} onChange={e => setVoiceSelection(e.target.value)} className={`${inputClass} min-w-0 max-w-full flex-1`}>
            {!data.voiceModels.some(m => modelRef(m) === data.voiceModel) && <option value={data.voiceModel}>{data.voiceModel || "请选择听写模型"}</option>}
            {data.voiceModels.map(m => <option key={modelRef(m)} value={modelRef(m)}>{m.name} · {modelRef(m)}</option>)}
          </select>
          <button className={btnQuiet} disabled={busy || !voiceSelection || voiceSelection === data.voiceModel}>保存听写模型</button>
        </div>
        <p className="text-xs text-dim">只列出支持音频输入的兼容模型。录音将发送给所选供应商，不附带聊天记录。</p>
      </form>
      <div className="divide-y divide-line border-y border-line">
        <div className="space-y-2 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div><h2 className="text-sm font-medium text-paper">OpenCode Console</h2><p className="mt-1 text-xs text-dim">{accountCount > 0
              ? `已保存 ${accountCount} 个 OpenCode 账号，可在下方管理。`
              : "连接后，全站音乐助手可使用该工作区的供应商和配额。"}</p></div>
            {accountCount > 0 ? <span className="text-sm text-paper">已连接</span> : !attempt && (
              <button className={btnQuiet} disabled={busy || !openCode?.consoleLogin} onClick={beginConsole}>连接 Console 账号</button>
            )}
          </div>
          {attempt && <div className="space-y-2 rounded-md border border-line bg-panel p-3 text-sm">
            <p>在 OpenCode 官方页面确认设备码并选择工作区。</p><p className="select-all font-readout text-paper">{attempt.instructions}</p>
            <div className="flex flex-wrap items-center gap-3"><a className={btnQuiet} href={attempt.url} target="_blank" rel="noopener noreferrer">打开授权页面</a>
              <span className="text-xs text-dim">等待授权…</span><button className="text-xs text-dim underline" disabled={busy} onClick={() => void run(async () => {
                await api.consoleCancel(attempt.attemptID); setAttempt(null); setNotice("授权已取消。")
              })}>取消</button></div>
          </div>}
        </div>
        <details><summary className={summary}>使用供应商 API Key</summary>
          <form className="flex flex-wrap gap-2 pb-3" onSubmit={(e) => { e.preventDefault(); const secret = key; setKey(""); void run(() => change({ type: "key", integrationID: provider, key: secret }, "凭据已保存。请选择模型并保存。")) }}>
            <select aria-label="供应商" className={`${inputClass} max-w-full`} value={provider} disabled={busy} onChange={(e) => { setProvider(e.target.value); setKey("") }}>
              {providerOptions.map((i) => <option key={i.id} value={i.id}>{i.name} ({i.id})</option>)}
            </select>
            <input aria-label="供应商 API Key" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder="API Key" className={`${inputClass} min-w-0 flex-1`} />
            <button className={btnQuiet} disabled={busy || !key.trim() || !providerOptions.some((i) => i.id === provider)}>保存凭据</button>
          </form>
        </details>
        <details><summary className={summary}>添加自定义 OpenAI 兼容服务</summary>
          <form className="space-y-3 pb-3" onSubmit={(e) => { e.preventDefault(); void run(async () => {
            await change({ type: "custom", ...custom, models: custom.models.trim().split(/[\s,，]+/) }, "供应商已添加。如需认证，请在「使用供应商 API Key」中保存凭据，然后选择模型。")
            setProvider(`om-custom-${custom.slug}`); setKey(""); setCustom({ slug: "", name: "", baseURL: "", models: "" })
          }) }}>
            <div className="grid gap-2 sm:grid-cols-2">{([
              ["name", "显示名称", "我的推理服务"], ["slug", "唯一标识", "local-gateway"],
              ["baseURL", "接口地址", "https://example.com/v1"], ["models", "支持工具调用的模型 ID（用逗号分隔）", "model-a, model-b"],
            ] as const).map(([field, label, placeholder]) => <label key={field} className="grid gap-1 text-xs text-dim">{label}
              <input className={`${inputClass} w-full`} required type={field === "baseURL" ? "url" : "text"} value={custom[field]} placeholder={placeholder} onChange={(e) => setCustom({ ...custom, [field]: e.target.value })} />
            </label>)}</div><button className={btnQuiet} disabled={busy}>添加供应商</button>
          </form>
        </details>
        {data.integrations.some((i) => i.connected) && <details><summary className={summary}>已连接的供应商账号</summary>
          <ul className="space-y-2 pb-3 text-sm text-dim">{data.integrations.filter((i) => i.connected).map((i) => <li key={i.id}>
            {i.name}{!i.accounts.length && "（环境配置）"}
            {i.accounts.map((a) => <div key={a.id} className="ml-3 flex flex-wrap items-center gap-3"><span className="mr-auto">{a.label || "已保存的账号"}</span>
              {i.accounts.length > 1 && <button className="text-xs underline" disabled={busy} onClick={() => void run(() => change({ type: "activate", integrationID: i.id, credentialID: a.id }, "已切换供应商账号。"))}>使用此账号</button>}
              <button className="text-xs text-danger" disabled={busy} onClick={() => {
                if (window.confirm(`断开 ${i.name} 的此账号？使用它的模型可能不再可用。`)) void run(() => change({ type: "disconnect", integrationID: i.id, credentialID: a.id }, "账号已断开。"))
              }}>断开连接</button></div>)}
            {i.id === "opencode" && accountCount > 0 && i.consoleLogin && !attempt && (
              <button className="ml-3 mt-2 text-xs underline" disabled={busy} onClick={beginConsole}>添加其他 Console 账号</button>
            )}
          </li>)}</ul></details>}
      </div>
      <p role="status" className="text-sm text-dim">{busy ? "正在处理…" : notice}</p>
    </div>}
  </section>
}
