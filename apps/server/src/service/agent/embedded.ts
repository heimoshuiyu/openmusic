import { Effect, Exit, Layer, Stream } from "effect"
import { SqlClient, SqlError } from "effect/unstable/sql"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { createHash } from "node:crypto"
import { Plugin } from "@opencode/plugin"
import { OpenCode } from "@opencode/sdk"
import { settleTool, toolCalls, toolStatus, type AgentPart } from "@openmusic/shared/agent-parts"
import { AppConfig } from "../../config"
import { notFound } from "../../domain/errors"
import { AgentSessionRepo, type AgentSessionRow } from "../../repo/agent-sessions"
import { PlayRepo } from "../../repo/annotations"
import { AgentSession, AgentService, AgentUnavailable, type AgentMessage } from "./agent-service"
import { makeEventBridge } from "./event-bridge"
import { makeProviderAdmin, waitForEntry } from "./provider-admin"
import { seedNeteaseSkill } from "./skill-seed"
import { transcriber } from "./voice"
import { answeredQuestion, questionService } from './questions'
import { YoutubeImports } from "../youtube/imports"
import { youtubeMcp } from "../youtube/mcp"
import { NeteaseImports } from "../netease/imports"
import { neteaseMcp } from "../netease/mcp"
import { lyricService } from '../lyrics'
import { musicTools, runMusicTool } from "./tools"

/**
 * AgentService 的内嵌实现（docs/08 §2/§3）：@opencode/sdk 宿主跑在本进程，
 * 无 HTTP listener。**Promise 边界隔离**——fork 使用 Effect 4.1，本仓 rc.115，
 * 两副本并存但只在边界上交换 Promise/普通对象（docs/08 §2.1 决策）。
 *
 * 隔离三件套（docs/08 §3.3 + §7 决策）：
 * - 会话库：data/agent-sessions.db（专用 sqlite，绝不与宿主机 OpenCode 共库）
 * - 配置：config.directory 指向 <dataDir>/agent-home（空目录，切断全局配置发现）
 *   + config.file 独立 JSONC（支持管理页原子更新），project:false 禁止祖先项目配置覆盖
 * - Location：会话 cwd = <dataDir>/agent-workspace（scratch，不指向仓库/音乐目录）
 *
 * music 工具执行器在宿主 Promise 回调里跑域层 Effect：SqlClient 在 Layer
 * 构建期捕获、每调用 provideService（与 SqlProvider 中间件同款手法）；
 * 用户身份由 agent_sessions 表反查（工具级多用户隔离的咽喉）。
 */

/** 宿主/IO 故障 → AgentUnavailable（文本进 message，日志可见） */
const hostError = (what: string) => (error: unknown) =>
  new AgentUnavailable({ message: `${what}：${error instanceof Error ? error.message : String(error)}` })

/** 域错误 → 模型可读文本（工具失败不抛异常，让模型看到原因自我修正） */
const failureText = (error: unknown): string => {
  const tagged = error as { readonly _tag?: string; readonly message?: string; readonly entity?: string; readonly id?: string }
  switch (tagged?._tag) {
    case "BadRequest":
      return tagged.message ?? "入参非法"
    case "Forbidden":
      return tagged.message ?? "权限不足"
    case "NotFound":
      return `${tagged.entity ?? "实体"} ${tagged.id ?? ""} 不存在`.trim()
    default:
      return "工具执行失败（基础设施错误）"
  }
}

/** play_now/enqueue 工具结果的形状守卫（宽进严出：只看 action/tracks） */
const isClientActionResult = (name: string, value: unknown): boolean => {
  if (typeof value !== "object" || value === null) return false
  const v = value as { action?: unknown; tracks?: unknown }
  const expected = name === "music_play_now" ? "play-now" : "enqueue"
  return v.action === expected && Array.isArray(v.tracks) && v.tracks.length > 0
}

type HostMessage = Awaited<ReturnType<OpenCode.Interface["sessions"]["context"]>>[number]

/** Preserve assistant content order without exposing reasoning or raw tool payloads. */
const toAgentMessage = (message: HostMessage): AgentMessage | null => {
  const createdAt = new Date(message.time.created).toISOString()
  if (message.type === "user") {
    return { id: message.id, role: "user", text: message.text ?? "", createdAt }
  }
  if (message.type === "assistant") {
    let ordinal = 0 // 宿主按类型分别计数，tool / reasoning 不占文本序号
    const parts = message.content.flatMap<AgentPart>((part) => {
      if (part.type === "text") return [{ type: "text", ordinal: ordinal++, text: part.text }]
      if (part.type !== "tool") return []
      const metadata = "metadata" in part.state ? part.state.metadata : undefined
      const answered = part.name === 'question' && part.state.status === 'completed' ? answeredQuestion(part.state.input, metadata) : undefined
      const tool: AgentPart = {
        type: "tool", id: part.id, name: part.name, calls: toolCalls(metadata), ...(answered && {answered}),
        status: metadata?.error === true ? "failed" : toolStatus(part.state.status),
      }
      return [message.time.completed !== undefined || tool.status !== "running" ? settleTool(tool) : tool]
    })
    const text = parts.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n")
    return { id: message.id, role: "assistant", text, parts, createdAt }
  }
  return null
}

/**
 * 收听画像 → instruction 槽位（A3，docs/08 §6）：prompt 前把 PlayRepo.profile
 * 的 JSON put 进宿主的会话级 instruction 槽位（`listening-profile`）。
 *
 * **缓存语义（为何不走 system 注入）**：槽位值按内容 hash diff——画像没变
 * 则 delta 为空（零 token、前缀缓存无损）；变了只追加一条 "context changed
 * and supersedes" 增量块，system 前缀永不重写。会话级存储天然按用户隔离。
 * 画像内容的 hash 稳定性纪律见 PlayRepo.profile 注释。
 */
const PROFILE_KEY = "listening-profile"

const sessionBusy = (time: {busy?: number; idle?: number}) => time.busy !== undefined && (time.idle === undefined || time.busy > time.idle)

/**
 * 探索技能（A3，替代 recommend 接口——授人以渔）：agent 主动探索曲库的
 * 方法论。seed 只在文件不存在时写入——skill 有 Watcher 热刷新，手改即生效，
 * 覆写会冲掉调教。
 */
const SKILL_DIR = "skills/music-exploration"

const EXPLORATION_SKILL = `---
name: music-exploration
description: 探索曲库与猜测推荐的系统方法。当用户要「找歌」「来点可能爱听的」「推荐」而你没有直接答案时使用——先画像假设、再 facets 圈池、多变体并发搜索、播放数据交叉验证、结论必须可解释。
---

# 曲库探索与推荐方法

你的曲库探索能力 = 收听画像（system 里的 listening-profile 槽位）+ music_* 工具面。
没有现成的"推荐接口"——推荐是你自己的推理过程，按下面的方法做：

## 1. 建立口味假设
先读 listening-profile：近 30 天 top 艺人/专辑、历史最常、最近播放。
形成 1-2 个可验证的假设，例如「用户近期偏好 Vocaloid/电子，但对 Kano 这类
J-Pop 也有稳定兴趣」。

## 2. 用词表圈候选池
调 music_facets 拿库词表（genre 分布/年代分布/top 艺人）。假设要落到库里
真实存在的东西上——库里没有 Blues 就别推荐 Blues。

## 3. 多变体检索（Code Mode 并发）
一次 execute 里 Promise.all 并发多个 music_search 变体：
- 原文 / 罗马音 / 中文翻译 / 英译 各试一次（日文曲名尤其重要）
- 结构化过滤补充盲区：genre + 年代范围、artistId + sortBy=plays
- q 可省略：纯过滤浏览（如 genre=Vocaloid&yearFrom=2020&yearTo=2024）

## 4. 交叉验证
用 music_most_played(period=month) / music_recent_plays 对照检索结果：
用户循环过的是真爱，一次没听过的相近曲风是「探索候选」——两者搭配着推。

## 5. 结论必须可解释
每条推荐给一句基于事实的理由（画像事实或检索轨迹），例如：
- 「你近 30 天播放 *Luna 23 次，这是她 2023 年专辑里你还没听过的主打」
- 「同属 Vocaloid 且年代相邻，曲库里播放量靠前，你只听过两首」
找不到就诚实说没找到 + 说明试过什么。禁止编造曲库里不存在的曲目。

## 探索轨迹示例
用户：「来点我可能爱听的」
→ 读画像：topArtists30d 有 Kano/*Luna → 假设 J-Pop/Vocaloid 倾向
→ facets：Vocaloid(2148)/J-Pop(378) 是大池子
→ 并发：search(genre=Vocaloid, sortBy=plays) + search(q=Kano) +
  most_played(month) 对照
→ 输出：3-5 首带理由的候选 + 一句「想更偏某方向可以说」
`

/** seed 探索技能（不存在才写；skill 热刷新保证后续手改即生效） */
const seedSkill = (agentHome: string) =>
  Effect.tryPromise({
    try: async () => {
      const metaSkill = path.join(agentHome,"skills/youtube-metadata/SKILL.md")
      await fs.mkdir(path.dirname(metaSkill),{recursive:true})
      const bundledSkill = path.join(import.meta.dir,"skills/youtube-metadata/SKILL.md")
      await fs.copyFile(bundledSkill,metaSkill,fs.constants.COPYFILE_EXCL)
        .catch(async (e:NodeJS.ErrnoException)=>{
          if(e.code!=="EEXIST") throw e
          // Migrate only the exact previous seed that instructed the agent to always use MP3.
          const checksum=createHash("sha256").update(await fs.readFile(metaSkill)).digest("hex")
          if(checksum === "724a7f92d965823e83ddae13585f56ced6663a8d893f8f7e8122b45f078b9b65") await fs.copyFile(bundledSkill,metaSkill)
        })
      const skillPath = path.join(agentHome, SKILL_DIR, "SKILL.md")
      await fs.mkdir(path.dirname(skillPath), { recursive: true })
      try {
        await fs.access(skillPath)
      } catch {
        await fs.writeFile(skillPath, EXPLORATION_SKILL, "utf8")
      }
      // Netease import skill: fresh dirs seed the bundled text; an existing copy upgrades
      // only when byte-identical to a known official stale seed (hand-tuned copies stay
      // untouched). Real IO errors (missing bundled file, permissions) rethrow through the
      // seedSkill catch below — same fail-loud posture as the youtube branch.
      await seedNeteaseSkill(agentHome)
    },
    catch: hostError("探索技能 seed 失败（不影响宿主启动）"),
  })

/**
 * 内嵌实现的 Layer 工厂。
 * @param extraPlugins 追加插件（测试注入 mock provider；生产留空）
 */
export const agentServiceEmbedded =
  (extraPlugins: ReadonlyArray<Plugin.Plugin> = []) =>
  Layer.effect(
    AgentService,
    Effect.gen(function* () {
      const appConfig = yield* AppConfig
      const sql = yield* SqlClient.SqlClient
      const imports = yield* YoutubeImports
      const neteaseImports = yield* NeteaseImports
      const ownerOf = (id:string) => Effect.runPromise(AgentSessionRepo.ownerOf(id).pipe(Effect.provideService(SqlClient.SqlClient, sql)))
      // Same loopback listener as the YouTube MCP; the embedded host owns both lifecycles.
      const netease = yield* Effect.acquireRelease(Effect.sync(() => neteaseMcp(neteaseImports, ownerOf)), mcp => Effect.promise(mcp.close))
      const youtube = yield* Effect.acquireRelease(Effect.sync(() => youtubeMcp(imports, lyricService(sql), ownerOf, netease)), mcp => Effect.promise(mcp.close))

      // SqlError 等基础设施错误 → defect（与 handler 层 infra 同款）
      const infra = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, Exclude<E, SqlError.SqlError>, R> =>
        Effect.catch(effect, (error) =>
          (error as { readonly _tag?: string })._tag === "SqlError"
            ? Effect.die(error)
            : Effect.fail(error as never)) as Effect.Effect<A, Exclude<E, SqlError.SqlError>, R>

      const sqlEffect = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
        infra(Effect.provideService(effect, SqlClient.SqlClient, sql))

      const bridge = yield* makeEventBridge(
        (id) => Effect.provideService(AgentSessionRepo.ownerOf(id), SqlClient.SqlClient, sql),
        (id, title) => Effect.provideService(AgentSessionRepo.saveTitle(id, title), SqlClient.SqlClient, sql),
      )

      // ---- music 插件：工具注册（身份反查 + 域层执行 + 失败文本化） ----
      const openmusicPlugin: Plugin.Plugin = Plugin.define({
        id: "openmusic",
        setup: async (ctx) => {
          await ctx.tool.transform((editor) => {
            for (const tool of musicTools) {
              editor.add({
                name: tool.name,
                description: tool.description,
                input: tool.input,
                // Code Mode（2026-09-19 用户决策）：模型在 execute 沙盒里编排调用
                // （tools.music_search(...)），可组合/并发——代价是不设 codemode:false
                // 时工具不进直接调用面，session.tool.* 事件只属于外层 execute
                execute: async (input, context) => {
                  const exit = await Effect.runPromiseExit(
                    sqlEffect(
                      Effect.flatMap(AgentSessionRepo.ownerOf(context.sessionID), (owner):
                        Effect.Effect<{ owner: number; value: unknown }, unknown, SqlClient.SqlClient> =>
                        owner === null
                          ? Effect.fail({ _tag: "Forbidden" as const, message: "会话未登记归属，无法解析执行身份" })
                          : Effect.map(runMusicTool(tool.name, input, { userId: owner }), (value) => ({ owner, value }))),
                    ),
                  )
                  // 失败也走 content（含原因）——模型可据此重试/修正，而不是整轮报错
                  const result = Exit.match(exit, {
                    onSuccess: ({ value, owner }) => ({ content: JSON.stringify(value), value, owner }),
                    onFailure: (cause) => ({
                      content: JSON.stringify({ error: failureText((cause as { error?: unknown }).error ?? cause) }),
                      value: undefined as unknown,
                      owner: null,
                    }),
                  })
                  // clientAction（play-now/enqueue）成功 → 广播给前端确认卡片
                  if (result.owner !== null && tool.clientAction !== undefined && isClientActionResult(tool.name, result.value)) {
                    const action = result.value as { action: string; position?: string; tracks: unknown }
                    await Effect.runPromise(bridge.clientAction(result.owner, {
                      type: "client-action",
                      sessionID: context.sessionID,
                      kind: tool.clientAction,
                      ...(action.position === undefined ? {} : { position: action.position }),
                      tracks: action.tracks as ReadonlyArray<Record<string, unknown>>,
                    }))
                  }
                  return { content: result.content }
                },
              })
            }
          })
        },
      })

      // ---- 隔离目录与独立配置（一律绝对路径：SDK 的 sqlite/工作区对相对路径不宽容） ----
      const agentHome = path.resolve(appConfig.dataDir, "agent-home")
      const workspaceDir = path.resolve(appConfig.dataDir, "agent-workspace")
      const dbPath = path.resolve(appConfig.dataDir, "agent-sessions.db")
      const configPath = path.resolve(
        appConfig.agentConfigPath === "" ? path.join(appConfig.dataDir, "agent-config.json") : appConfig.agentConfigPath,
      )
      yield* Effect.tryPromise({
        try: async () => {
          await fs.mkdir(agentHome, { recursive: true })
          await fs.mkdir(workspaceDir, { recursive: true })
        },
        catch: hostError("agent 目录创建失败"),
      })
      // 探索技能 seed（不存在才写；skills/ 在 config directory 下自动发现 + 热刷新）
      yield* seedSkill(agentHome)
      yield* Effect.tryPromise({
        try: () => fs.access(configPath, fs.constants.R_OK),
        catch: hostError(`agent 配置文件不可读（${configPath}）`),
      })

      // ---- 宿主生命周期（Promise 边界；close 经 acquireRelease 兜底）。
      // 宿主事件泵与 Layer 同寿命，先释放订阅再关闭宿主。 ----
      const host = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: async () => {
            const host = await OpenCode.create({
              app: { name: "openmusic-agent" },
              database: { path: dbPath },
              // Dedicated, watched JSONC; do not discover repository or user provider configs.
              config: { directory: agentHome, file: configPath, content: JSON.stringify(youtube.config), project: false },
              plugins: [openmusicPlugin, ...extraPlugins],
            })
            return host
          },
          catch: hostError("OpenCode 宿主启动失败"),
        }),
        (host) => Effect.promise(() => host.close()),
      )
      yield* Stream.runForEach(Stream.fromAsyncIterable(host.events.subscribe(), (error) => error), bridge.hostEvent)
        .pipe(Effect.forkScoped)

      // 归属检查：非属主与不存在同样 NotFound（不泄露存在性）
      const ownedSession = (sessionID: string, userId: number) =>
        Effect.flatMap(sqlEffect(AgentSessionRepo.byId(sessionID)), (row) =>
          row === null || row.ownerUserId !== userId
            ? Effect.fail(notFound("agent_session", sessionID))
            : Effect.succeed(row))

      const toAgentSession = (row: AgentSessionRow) =>
        new AgentSession({ id: row.id, title: row.title, createdAt: row.createdAt })

      // Older rows missed session.renamed. Read existing metadata only for this owner's
      // untitled list entries; the conditional write cannot overwrite a concurrent rename.
      const restoreTitle = Effect.fnUntraced(function* (row: AgentSessionRow) {
        if (row.title) return toAgentSession(row)
        const info = yield* Effect.tryPromise(() => host.sessions.get({ sessionID: row.id })).pipe(Effect.orElseSucceed(() => null))
        const title = info?.title?.trim()
        if (!info || !title || title === `New session - ${new Date(info.time.created).toISOString()}`) return toAgentSession(row)
        const updated = yield* sqlEffect(AgentSessionRepo.saveTitle(row.id, title, true))
        return toAgentSession(updated ?? row)
      })

      const questions = questionService(host.sessions.form)
      const transcribe = transcriber(host, workspaceDir)
      return AgentService.of({
        admin: makeProviderAdmin(host, workspaceDir, configPath),
        transcribe: input => input.sessionID === undefined ? transcribe(input)
          : Effect.flatMap(ownedSession(input.sessionID, input.userId), () => transcribe(input)),
        createSession: ({ userId, title }) =>
          Effect.tryPromise({
            try: async () => {
              const session = await host.sessions.create({
                title,
                agent: "music",
                location: { directory: workspaceDir },
              })
              await Effect.runPromise(
                sqlEffect(AgentSessionRepo.register(userId, session.id, title ?? "")),
              )
              return new AgentSession({
                id: session.id,
                title: title ?? "",
                createdAt: new Date(session.time.created).toISOString(),
              })
            },
            catch: hostError("会话创建失败"),
          }),
        inbox: ({userId,sessionID}) => Effect.flatMap(ownedSession(sessionID,userId), () => Effect.tryPromise({
          try: async () => {
            const [session,items,pending]=await Promise.all([host.sessions.get({sessionID}),host.sessions.inbox.list({sessionID}),questions.list(sessionID)])
            return {busy:sessionBusy(session.time),questions:pending,items:items.flatMap(i=>i.type==="user" ? [{id:i.id,text:i.payload.text,delivery:i.delivery}] : [])}
          }, catch:hostError("读取待投递消息失败"),
        })),
        settleQuestion: ({userId,sessionID,id,answers}) => Effect.flatMap(ownedSession(sessionID,userId), () => questions.settle(sessionID,id,answers)),
        changePending: ({userId,sessionID,inboxID,delivery}) => Effect.flatMap(ownedSession(sessionID,userId), () => Effect.gen(function* () {
          const items=yield* Effect.tryPromise({try:()=>host.sessions.inbox.list({sessionID}),catch:hostError("读取待投递消息失败")})
          if(!items.some(i=>i.type==="user" && i.id===inboxID))return yield* notFound("inbox_message",inboxID)
          yield* Effect.tryPromise({try:()=>delivery===null ? host.sessions.inbox.cancel({sessionID,inboxID}) : host.sessions.inbox.update({sessionID,inboxID,delivery}),catch:hostError("消息可能已被投递，无法修改")})
        })),
        prompt: ({ userId, sessionID, text, delivery = "steer" }) =>
          Effect.flatMap(ownedSession(sessionID, userId), (row: AgentSessionRow) =>
            Effect.tryPromise({
              try: async () => {
                // Active-turn input goes straight to the SDK inbox. In particular, do not
                // switch its model or rewrite instructions to deliver a correction.
                if (sessionBusy((await host.sessions.get({sessionID:row.id})).time)) {
                  await host.sessions.prompt({sessionID:row.id,text,delivery}); return
                }
                // 画像先入槽位再 prompt：宿主在执行环开始时读槽位（prepareContext），
                // 同一轮就生效——首轮进基线，后续轮次仅在画像变化时追加 supersede 增量。
                // 画像查询/put 失败不阻断对话（画像只影响口味先验，不该让消息发不出去）
                const profile = await Effect.runPromiseExit(sqlEffect(PlayRepo.profile(userId)))
                if (Exit.isSuccess(profile)) {
                  await host.sessions.instructions.entry
                    .put({ sessionID: row.id, key: PROFILE_KEY, value: profile.value })
                    .catch(() => undefined)
                }
                // A saved global music-agent choice also applies to existing chats on their
                // next prompt. No switch is sent while the administrator edits settings.
                const agentInput = { location: { directory: workspaceDir }, agentID: "music" }
                const entry = await waitForEntry(() => host.agent.get(agentInput).catch(() => null), value => value !== null)
                const chosen = entry!.data.model
                if (chosen) {
                  const current = (await host.sessions.get({ sessionID: row.id })).model
                  if (current?.providerID !== chosen.providerID || current.id !== chosen.id || current.variant !== chosen.variant) {
                    await host.sessions.switchModel({ sessionID: row.id, model: chosen })
                  }
                }
                await host.sessions.prompt({ sessionID: row.id, text, delivery })
              },
              catch: hostError("消息发送失败"),
            })),
        messages: ({ userId, sessionID }) =>
          Effect.flatMap(ownedSession(sessionID, userId), (row: AgentSessionRow) =>
            Effect.tryPromise({
              try: async () => {
                const messages = await host.sessions.context({ sessionID: row.id })
                return messages.flatMap((message) => {
                  const mapped = toAgentMessage(message)
                  return mapped === null ? [] : [mapped]
                })
              },
              catch: hostError("消息读取失败"),
            })),
        interrupt: ({ userId, sessionID }) =>
          Effect.flatMap(ownedSession(sessionID, userId), (row: AgentSessionRow) =>
            Effect.tryPromise({
              try: async () => {
                try { await host.sessions.interrupt({ sessionID: row.id }) }
                finally { youtube.interrupt(row.id); netease.interrupt(row.id) }
              },
              catch: hostError("打断失败"),
            })),
        listSessions: ({ userId }) =>
          Effect.flatMap(
            sqlEffect(AgentSessionRepo.listFor(userId, 50)),
            (rows) => Effect.forEach(rows, restoreTitle, { concurrency: 4 }),
          ),
        events: bridge.events,
      })
    }),
  )
