import { Effect, Semaphore } from "effect"
import type { OpenCode } from "@opencode/sdk"
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser"
import * as fs from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { BadRequest } from "../../domain/errors"
import { AgentUnavailable, type AgentService } from "./agent-service"
import type { SettingsChange } from "../../domain/agent-settings"

// Never propagate SDK/config errors verbatim: they may contain an HTTP request or substituted credentials.
const sdk = <A>(message: string, fn: () => Promise<A>) => Effect.tryPromise({ try: fn, catch: () => new AgentUnavailable({ message }) })
const invalid = (message: string) => Effect.fail(new BadRequest({ message }))
const safeID = /^[\w][\w./:@+-]*$/
const printable = (s: string) => s.trim() !== "" && !/[{}\x00-\x1f\x7f]/.test(s)

/** Only edit known JSONC paths. Keep comments, env references, permissions and other hand-authored settings. */
async function editConfig(file: string, keys: string[], value: unknown, extra?: [string[], unknown]) {
  const original = await fs.readFile(file, "utf8")
  const errors: ParseError[] = []
  const document = parse(original, errors, { allowTrailingComma: true })
  if (errors.length || !document || typeof document !== "object" || Array.isArray(document)) throw new Error("Invalid config")
  if (keys[0] === "providers" && Object.hasOwn(document.providers ?? {}, keys[1]!)) throw new Error("Provider already exists")
  const update = (text: string, path: string[], val: unknown) => applyEdits(text, modify(text, path, val, { formattingOptions: { insertSpaces: true, tabSize: 2 } }))
  const edited = update(original, keys, value)
  const next = extra ? update(edited, ...extra) : edited
  const tmp = `${file}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(tmp, next, { mode: 0o600, flag: "wx" })
    await fs.rename(tmp, file)
  } finally { await fs.rm(tmp, { force: true }) }
}

export async function waitForEntry<A>(read: () => Promise<A>, ready: (value: A) => boolean) {
  for (let i = 0; i < 50; i++) {
    const value = await read()
    if (ready(value)) return value
    await Bun.sleep(100)
  }
  throw new Error("助手目录尚未就绪，请稍后重试")
}

const audioPackage = /^(?:@opencode\/ai\/providers\/|(?:aisdk:)?@ai-sdk\/)(?:google|openai|openai-compatible)$/
const canHear = (model: { enabled: boolean; package?: string | undefined; capabilities: { input: readonly string[] } }) =>
  model.enabled && audioPackage.test(model.package ?? "") && model.capabilities.input.some((mime) => mime.startsWith("audio"))

export function makeProviderAdmin(host: OpenCode.Interface, directory: string, file: string): AgentService["Service"]["admin"] {
  const location = { directory }
  const opts = { location }
  const lock = Semaphore.makeUnsafe(1)
  const catalog = () => sdk("无法读取模型目录", () => host.model.list(opts))
  const integrations = () => sdk("无法读取供应商目录", () => host.integration.list(opts))
  const music = () => host.agent.get({ ...opts, agentID: "music" })
  const consoleInput = { ...opts, integrationID: "opencode" }

  // The SDK watches config.file. Wait for acknowledgement without restarting the host or interrupting a turn.
  const waitFor = (ready: () => Promise<boolean>) => Effect.gen(function* () {
    for (let i = 0; i < 25; i++) {
      if (yield* sdk("配置已写入，但读取宿主状态失败；请刷新模型目录", ready)) return
      yield* Effect.sleep("200 millis")
    }
    return yield* Effect.fail(new AgentUnavailable({ message: "配置已写入，OpenCode 尚未加载；请稍后刷新模型目录" }))
  })

  const change = Effect.fnUntraced(function* (input: typeof SettingsChange.Type) {
    if (input.type === "voiceModel") {
      const model = (yield* catalog()).data.find(m => m.providerID === input.providerID && m.id === input.id && canHear(m))
      if (!model || !safeID.test(model.id) || !safeID.test(model.providerID)) return yield* invalid("请选择可接收音频的模型")
      yield* sdk("听写模型保存失败", () => editConfig(file, ["transcription", "lalm", "model"], `${model.providerID}/${model.id}`, [["transcription", "type"], "lalm"]))
      return
    }
    if (input.type === "model") {
      const model = (yield* catalog()).data.find((m) => m.providerID === input.providerID && m.id === input.id && m.enabled && m.capabilities.tools)
      if (!model || !safeID.test(model.id) || !safeID.test(model.providerID)) return yield* invalid("请选择目录中支持工具调用的可用模型")
      yield* sdk("模型配置写入失败，请检查文件权限和 JSONC 格式", () => editConfig(file, ["agents", "music", "model"], `${model.providerID}/${model.id}`))
      yield* waitFor(async () => {
        const selected = (await music()).data.model
        return selected?.providerID === model.providerID && selected.id === model.id
      })
      return
    }
    if (input.type === "custom") {
      const url = URL.parse(input.baseURL)
      const models = [...new Set(input.models)]
      if (!/^[a-z][a-z0-9-]{0,47}$/.test(input.slug) || !printable(input.name) || !models.every((id) => safeID.test(id) && !["__proto__", "constructor", "prototype"].includes(id))) {
        return yield* invalid("供应商标识使用小写字母、数字或连字符；名称和模型 ID 不能为空或包含配置表达式")
      }
      if (!url || !["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash || !printable(input.baseURL)) {
        return yield* invalid("请使用不含凭据、查询参数和片段的 HTTP(S) 接口地址")
      }
      // A custom endpoint must never inherit a built-in/previous connection's key.
      const id = `om-custom-${input.slug}`
      if ((yield* integrations()).data.some((i) => i.id === id)) return yield* invalid("此供应商标识已存在，请使用新标识")
      yield* sdk("添加供应商失败，请检查配置文件和标识", () => editConfig(file, ["providers", id], {
        name: input.name.trim(), package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: url.href },
        models: Object.fromEntries(models.map((m) => [m, { capabilities: { tools: true, input: ["text"], output: ["text"] } }])),
      }))
      yield* waitFor(async () => (await host.integration.list(opts)).data.some((i) => i.id === id))
      return
    }
    const integration = (yield* integrations()).data.find((i) => i.id === input.integrationID)
    if (!integration) return yield* invalid("未知供应商")
    if (input.type === "key") {
      if (!integration.methods.some((m) => m.type === "key" && !m.form?.length) || !input.key.trim()) return yield* invalid("此连接需要不同的认证方式，或 API Key 为空")
      yield* sdk("保存凭据失败，请检查供应商与认证方式", () => host.integration.connect.key({ ...opts, integrationID: integration.id, key: input.key.trim() }))
    } else {
      if (!integration.connections.some((c) => c.type === "credential" && c.id === input.credentialID)) return yield* invalid("此供应商没有该账号")
      if (input.type === "activate") yield* sdk("切换账号失败", () => host.credential.activate({ credentialID: input.credentialID }))
      else yield* sdk("断开连接失败", () => host.credential.remove({ credentialID: input.credentialID }))
    }
  })

  return {
    settings: () => sdk("无法读取助手模型设置", async () => {
      const auth = await waitForEntry(() => host.integration.list(opts), value => value.data.some(i => i.id === "opencode" && i.methods.length > 0))
      const [models, providers, agent, fallback] = await Promise.all([
        host.model.list(opts), host.provider.list(opts), waitForEntry(() => music().catch(() => null), a => a !== null), host.model.default(opts),
      ])
      const current = agent!.data.model ?? fallback.data
      const names = new Map(providers.data.map((p) => [p.id, p.name]))
      const voice = parse(await fs.readFile(file, "utf8"))?.transcription
      return {
        voiceModel: voice?.type === "whisper" ? "Whisper" : typeof voice?.lalm?.model === "string" ? voice.lalm.model : "",
        voiceModels: models.data.filter(canHear).map(m => ({providerID:m.providerID, id:m.id, name:m.name, provider:names.get(m.providerID) ?? m.providerID})),
        current: current ? { providerID: current.providerID, id: current.id } : null,
        models: models.data.filter((m) => m.enabled && m.capabilities.tools).map((m) => ({ providerID: m.providerID, id: m.id, name: m.name, provider: names.get(m.providerID) ?? m.providerID })),
        integrations: auth.data.map((i) => ({ id: i.id, name: i.name, key: i.methods.some((m) => m.type === "key" && !m.form?.length),
          consoleLogin: i.id === "opencode" && i.methods.some((m) => m.type === "oauth" && m.id === "device"), connected: i.connections.length > 0,
          accounts: i.connections.flatMap((c) => c.type === "credential" ? [{ id: c.id, label: c.label }] : []),
        })),
      }
    }),
    change: (input) => lock.withPermit(change(input)),
    consoleBegin: () => sdk("无法启动 OpenCode Console 授权，请检查网络或稍后重试", async () => {
      const { data } = await host.integration.oauth.connect({ ...consoleInput, methodID: "device" })
      const url = new URL(data.url)
      if (url.origin !== "https://opencode.ai" || url.username || url.password || data.mode !== "auto") {
        await host.integration.oauth.cancel({ ...consoleInput, attemptID: data.attemptID })
        throw new Error("Unexpected authorization URL")
      }
      return { attemptID: data.attemptID, url: url.href, instructions: data.instructions, expires: data.time.expires }
    }),
    consoleStatus: (attemptID) => sdk("无法读取授权状态，请重试", async () => (await host.integration.oauth.status({ ...consoleInput, attemptID })).data.status),
    consoleCancel: (attemptID) => sdk("取消授权失败", () => host.integration.oauth.cancel({ ...consoleInput, attemptID })),
  }
}
