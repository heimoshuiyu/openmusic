import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Context, Effect, Layer, Redacted, Scope, Stream } from "effect"
import { PgClient } from "@effect/sql-pg"
import { SqlClient } from "effect/unstable/sql"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { Model, Plugin, Provider } from "@opencode/plugin"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { Pool } from "pg"
import { migrateTestDb, TEST_DB_URL, truncateDomainTables } from "./helpers"
import { AppConfig } from "../src/config"
import { AgentSessionRepo } from "../src/repo/agent-sessions"
import { agentServiceEmbedded } from "../src/service/agent/embedded"
import { YoutubeImports } from "../src/service/youtube/imports"
import { NeteaseImports } from "../src/service/netease/imports"
import { Scanner } from "../src/service/scanner"
import { AgentService, type AgentEvent } from "../src/service/agent/agent-service"
import { AgentEventsRoutesLive } from "../src/http/agent-events"
import { Auth } from "../src/service/auth"

/**
 * 内嵌宿主端到端（docs/08 A1）：真 @opencode/sdk 宿主 + mock OpenAI 兼容
 * provider（本地 Bun.serve）→ 会话/归属/工具分发全链。同时是 SDK 在 Bun
 * 运行时的冒烟。无需真实 LLM key——确定性两轮对话：
 * ① 模型请求 music_search(q=Alpha) → 工具经 agent_sessions 反查属主、走
 *    真库 SearchRepo 执行；② 模型收到工具结果后回 "DONE"。
 */

const userA = 1
const userB = 2
let alphaId = 0

/** mock 的请求记录（第二轮的 messages 里应能看到工具结果 = Alpha Song） */
const recorded: Array<{ stream: boolean; body: string }> = []
let mockCalls = 0
let holdInbox: Promise<void> | null = null
let customAuthenticated = false

let mockServer: ReturnType<typeof Bun.serve> | undefined
let dataDir = ""
let agent: AgentService["Service"] | undefined
let scope: Scope.Scope | undefined
let sqlContext: Context.Context<SqlClient.SqlClient> | undefined
let fetchEvents: (cookie?: string, query?: string) => Promise<Response>
let disposeEvents: () => Promise<void>
/** NETEASE_DELETE_FIXTURE 轮的目标 trackId（测试先造行再由 mock 注入 execute 沙盒代码） */
let neteaseDeleteTrackId = 0

const PROVIDER_ID = Provider.ID.make("om-test")
const MODEL_ID = Model.ID.make("echo")

/** 第一轮 → tool_call(music_search q=Alpha)；之后 → 纯文本 DONE */
const mockProviderPlugin: Plugin.Plugin = Plugin.define({
  id: "om-test-provider",
  setup: async (ctx) => {
    await ctx.provider.transform((editor) => {
      editor.add({
        info: {
          ...Provider.Info.empty(PROVIDER_ID),
          name: "OM Test",
          activation: "enabled",
          package: "@opencode/ai/providers/openai-compatible",
          settings: { baseURL: `http://127.0.0.1:${mockServer!.port}/v1`, apiKey: "test-key" },
        },
        models: [{ ...Model.Info.default(PROVIDER_ID, MODEL_ID), name: "Echo", capabilities:{tools:true,input:['text','audio'],output:['text']} }],
      })
    })
  },
})

const sseChunk = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`

beforeAll(async () => {
  await migrateTestDb()
  await truncateDomainTables(true)

  const pool = new Pool({ connectionString: TEST_DB_URL })
  try {
    await pool.query(
      `insert into users (username, password_hash, subsonic_token_seed) values
        ('agent-host-a', 'x', 'x'), ('agent-host-b', 'x', 'x')`,
    )
    const folder = (await pool.query(`insert into music_folders (path, name) values ('/agent-host', 'h') returning id`)).rows[0]!
    const artist = (await pool.query(`insert into artists (name) values ('Host Artist') returning id`)).rows[0]!
    const album = (
      await pool.query(`insert into albums (artist_id, name, year) values (${artist.id}, 'Host Album', 2026) returning id`)
    ).rows[0]!
    alphaId = Number(
      (await pool.query(
        `insert into tracks (music_folder_id, album_id, artist_id, disc, track_no, title,
           duration_seconds, format, codec, size_bytes, path, mtime_ms)
         values (${folder.id}, ${album.id}, ${artist.id}, 1, 1, 'Alpha Host Song',
           100, 'flac', 'flac', 1000, 'a.flac', 0) returning id`,
      )).rows[0]!.id,
    )
  } finally {
    await pool.end()
  }

  // ---- mock OpenAI 兼容服务（流式/非流式都接） ----
  mockServer = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname !== "/v1/chat/completions" || request.method !== "POST") {
        return new Response("not found", { status: 404 })
      }
      const body = (await request.json()) as { stream?: boolean; messages?: Array<{ role?: string; content?: unknown }> }
      const bodyText = JSON.stringify(body)
      if (request.headers.get("authorization") === "Bearer fixture-admin-key" && bodyText.includes('"model":"test-model"')) customAuthenticated = true
      recorded.push({ stream: Boolean(body.stream), body: bodyText })
      mockCalls++
      // 按请求语义分流（title generator 等杂项调用会抢轮次，不能按计数判定）：
      // agent 主循环 + 无工具结果 → 请求 execute（Code Mode 编排 music_search）；
      // agent 主循环 + 已有工具结果 → DONE；其余（标题生成等）→ 纯文本
      const isAgentLoop = bodyText.includes("coding agent harness")
      if (isAgentLoop && holdInbox && bodyText.includes("INBOX_FIRST")) await holdInbox
      const hasToolResult = (body.messages ?? []).some((message) => message.role === "tool")
      const mode: "tool" | "done" | "plain" = isAgentLoop ? (hasToolResult ? "done" : "tool") : "plain"
      const outputs = (body.messages ?? []).filter(m => m.role === "tool")
      const importOutput = (bodyText.includes("YT_IMPORT_FIXTURE") || bodyText.includes("NETEASE_IMPORT_FIXTURE")) && outputs.length === 1 && typeof outputs[0]?.content === "string"
        ? outputs[0].content : undefined
      const imported = importOutput?.includes('"trackIds"') ? JSON.parse(importOutput) as {trackIds:number[]} : null
      const wantTool = mode === "tool" || (isAgentLoop && !!imported)
      const textOut = mode === "plain" ? "T" : "DONE"
      // Code Mode：模型调 execute，在 JS 沙盒里编排内层工具（按用户指令分流）
      const wantsPlay = bodyText.includes("直接播放")
      const code = imported ? `return tools.music_play_now({trackIds:${JSON.stringify(imported.trackIds)}})` : bodyText.includes("YT_IMPORT_FIXTURE")
        ? `const unpack = r => typeof r === "string" ? JSON.parse(r) : r;
           const folders = unpack(await tools.youtube.list_folders({}));
           const folder = folders.find(f => f.name === "Fixture Live" && f.writable);
           const children = unpack(await tools.youtube.list_subdirectories({folderId:folder.id}));
           return tools.youtube.start_import({url:"https://youtu.be/${bodyText.includes("YT_CANCEL_FIXTURE") ? "0123456789a" : "abcdefghijk"}", folderId:folder.id, subdirectory:children.directories.find(d => d === "Sessions")});`
        : bodyText.includes('NETEASE_IMPORT_FIXTURE') ? `const unpack = r => typeof r === "string" ? JSON.parse(r) : r;
           const folders = unpack(await tools.youtube.list_folders({}));
           const folder = folders.find(f => f.name === "Netease Live" && f.writable);
           const children = unpack(await tools.youtube.list_subdirectories({folderId:folder.id}));
           return tools.netease.start_import_netease({url:"https://music.163.com/song?id=${bodyText.includes("NETEASE_CANCEL_FIXTURE") ? "186016" : "5264842"}", folderId:folder.id, subdirectory:children.directories.find(d => d === "Sessions")});`
        : bodyText.includes('NETEASE_SEARCH_FIXTURE') ? 'return tools.netease.search_netease({query:"晴天"})'
        : bodyText.includes('NETEASE_DELETE_FIXTURE') ? `const unpack = r => typeof r === "string" ? JSON.parse(r) : r;
           const info = unpack(await tools.netease.get_metadata_netease({trackId: ${neteaseDeleteTrackId}}));
           const req = unpack(await tools.netease.request_file_deletion_netease({trackId: ${neteaseDeleteTrackId}}));
           return {info, req};`
        : bodyText.includes('LYRIC_BIND_FIXTURE') ? `const trackId="${alphaId}";
          const edit=await tools.lyrics.edit({trackId,text:"[00:01.25]Fixture verse"});
          await tools.lyrics.bind({trackId,mode:"none"}); const hidden=await tools.lyrics.read({trackId});
          await tools.lyrics.bind({trackId,mode:"saved",lyricsId:edit.lyricsId}); const restored=await tools.lyrics.read({trackId});
          return {hidden:hidden.mode,line:restored.lines[0]};`
        : bodyText.includes('YT_CAPTIONS_FIXTURE') ? 'return tools.youtube.list_captions({url:"https://youtu.be/abcdefghijk"})'
        : wantsPlay
        ? `return tools["music_play_now"]({ trackIds: [${alphaId}] })`
        : 'return tools["music_search"]({ q: "Alpha" })'
      const web = bodyText.includes('WEBSEARCH_LIVE_FIXTURE')
      const question = bodyText.includes('QUESTION_TOOL_FIXTURE')
      const toolName = question ? 'question' : web ? 'websearch' : 'execute'
      const args = JSON.stringify(question ? {questions:[{question:'使用哪个版本？',header:'版本',options:[{label:'原版',description:'保留原始音轨'}]},
        {question:'想听哪些风格？',header:'风格',multiple:true,options:[{label:'摇滚',description:''}]}]} : web ? {query:'MusicBrainz official music metadata database'} : {code})
      if (body.stream) {
        const chunks = wantTool
          ? [
              // 规范四段：role 先行 → tool_call 头（id/type/name）→ arguments → finish
               sseChunk({ id: "c1", object: "chat.completion.chunk", created: 0, model: "echo", choices: [{ index: 0, delta: { role: "assistant", content: "先查曲库。" }, finish_reason: null }] }),
               sseChunk({ id: "c1", object: "chat.completion.chunk", created: 0, model: "echo", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: toolName, arguments: "" } }] }, finish_reason: null }] }),
               sseChunk({ id: "c1", object: "chat.completion.chunk", created: 0, model: "echo", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args } }] }, finish_reason: null }] }),
              sseChunk({ id: "c1", object: "chat.completion.chunk", created: 0, model: "echo", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
            ]
          : [
              sseChunk({ id: "c2", object: "chat.completion.chunk", created: 0, model: "echo", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] }),
              sseChunk({ id: "c2", object: "chat.completion.chunk", created: 0, model: "echo", choices: [{ index: 0, delta: { content: textOut }, finish_reason: null }] }),
              sseChunk({ id: "c2", object: "chat.completion.chunk", created: 0, model: "echo", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
            ]
        // stream_options.include_usage → 空 choices + usage 块收尾
        const usage = sseChunk({ id: "c9", object: "chat.completion.chunk", created: 0, model: "echo", choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })
        return new Response(chunks.join("") + usage + "data: [DONE]\n\n", {
          headers: { "content-type": "text/event-stream" },
        })
      }
      const message = wantTool
        ? { role: "assistant", content: "先查曲库。", tool_calls: [{ id: "call_1", type: "function", function: { name: toolName, arguments: args } }] }
        : { role: "assistant", content: textOut }
      return Response.json({
        id: wantTool ? "c1" : "c2",
        object: "chat.completion",
        created: 0,
        model: "echo",
        choices: [{ index: 0, message, finish_reason: wantTool ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    },
  })

  // ---- 独立配置文件 + dataDir ----
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "om-agent-host-"))
  const agentConfig = {
    model: "om-test/echo",
    transcription: {type:'lalm',lalm:{model:'om-test/echo'}},
    websearch: {provider:'exa'},
    agents: {
      music: {
        description: "OpenMusic 曲库管家（测试）",
        mode: "primary",
        permissions: [
          { action: "*", resource: "*", effect: "allow" },
          { action: "edit", resource: "*", effect: "deny" },
          { action: "write", resource: "*", effect: "deny" },
          { action: "bash", resource: "*", effect: "deny" },
          { action: "shell", resource: "*", effect: "deny" },
          { action: "webfetch", resource: "*", effect: "deny" },
          { action: "websearch", resource: "*", effect: "allow" },
        ],
      },
    },
  }
  await fs.writeFile(path.join(dataDir, "agent-config.json"), JSON.stringify(agentConfig), "utf8")

  // ---- 组装：TestPg（SqlClient）+ AppConfig + agentServiceEmbedded ----
  const TestPg = PgClient.layer({ url: Redacted.make(TEST_DB_URL) })
  const TestAppConfig = Layer.succeed(AppConfig, {
    host: "127.0.0.1",
    port: 3997,
    databaseUrl: TEST_DB_URL,
    dataDir,
    transcodeCacheDir: path.join(dataDir, "transcode"),
    transcodeCacheMaxBytes: 1024 * 1024,
    transcodeMaxConcurrency: 1,
    coversCacheMaxBytes: 1024 * 1024,
    logLevel: "Error" as const,
    agentEnabled: true,
    agentConfigPath: "",
    musicFoldersSeed: "",
    neteaseRealIp: "",
  })

  scope = Effect.runSync(Scope.make())
  sqlContext = await Effect.runPromise(
    Layer.buildWithScope(
      PgClient.layer({ url: Redacted.make(TEST_DB_URL) }) as unknown as Layer.Layer<SqlClient.SqlClient>,
      scope,
    ) as Effect.Effect<Context.Context<SqlClient.SqlClient>, never, never>,
  )
  const context = await Effect.runPromise(
    Layer.buildWithScope(
      agentServiceEmbedded([mockProviderPlugin]).pipe(
        Layer.provide(YoutubeImports.layer), Layer.provide(NeteaseImports.layer), Layer.provide(Scanner.layer),
        Layer.provide(TestAppConfig),
        Layer.provide(Layer.succeedContext(sqlContext)),
      ) as unknown as Layer.Layer<AgentService>,
      scope,
    ) as Effect.Effect<Context.Context<AgentService>, never, never>,
  )
  agent = Context.get(context as Context.Context<AgentService>, AgentService)
  // netease-import skill 干净 seed：随机 dataDir → COPYFILE_EXCL 落 bundled 原文
  //（旧种子升级/手改保留的决策面见 src/service/agent/skill-seed.test.ts）
  expect(await fs.readFile(path.join(dataDir, "agent-home/skills/netease-import/SKILL.md"), "utf8"))
    .toEqual(await fs.readFile(path.join(import.meta.dir, "../src/service/agent/skills/netease-import/SKILL.md"), "utf8"))
  const web = HttpRouter.toWebHandler(AgentEventsRoutesLive.pipe(
    Layer.provide(Layer.succeed(AgentService, agent)), Layer.provide(Auth.layer),
    Layer.provide(TestAppConfig), Layer.provide(TestPg), Layer.provide(HttpServer.layerServices),
  ))
  fetchEvents = (cookie, query = "") => web.handler(new Request(`http://test/api/v1/agent/events${query}`, {
    headers: cookie ? { cookie: `om_session=${cookie}` } : {},
  }), Context.empty())
  disposeEvents = web.dispose
}, 120_000)

afterAll(async () => {
  await disposeEvents?.()
  if (scope !== undefined) {
    await Effect.runPromise(Scope.close(scope, Effect.void as never))
  }
  mockServer?.stop(true)
  if (dataDir !== "") await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {})
})

const run = <A, E>(fx: Effect.Effect<A, E, never>) => Effect.runPromise(fx)

/** 轮询直到条件成立（宿主的 prompt 是异步 inbox） */
const until = async (cond: () => Promise<boolean> | boolean, timeoutMs: number, what: string) => {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await cond()) return
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  throw new Error(`等待超时：${what}`)
}

describe("内嵌宿主端到端（A1）", () => {
  test('dictation uses only the last three pairs of the owned session',async()=>{
    const session=await run(agent!.createSession({userId:userA})), own={userId:userA,sessionID:session.id}
    for (const n of [1,2,3,4]) {
      await run(agent!.prompt({...own,text:`VOICE_PAIR_${n}`}))
      await until(async()=>(await run(agent!.messages(own))).filter(m=>m.role==='assistant' && m.text.includes('DONE')).length===n,
        10000,`turn ${n} complete`)
    }
    const audio=Bun.spawnSync(['ffmpeg','-v','error','-f','lavfi','-i','sine=f=330:d=0.2','-c:a','libopus','-f','webm','pipe:1'])
    const input={...own,mime:'audio/webm',bytes:new Uint8Array(audio.stdout)}
    const requests=()=>recorded.filter(r=>r.body.includes('input_audio') && r.body.includes('<audio-starts>'))
    const before=requests().length
    expect((await run(Effect.flip(agent!.transcribe({...input,userId:userB}))))._tag).toBe('NotFound')
    expect(requests()).toHaveLength(before)
    expect(await run(agent!.transcribe(input))).toBe('T')
    const payload=requests().at(-1)!.body
    expect(payload).not.toContain('VOICE_PAIR_1')
    for(const n of [2,3,4]) expect(payload).toContain(`User: VOICE_PAIR_${n}`)
    expect(payload).toContain('Assistant: DONE')
    expect(payload).not.toContain(dataDir)
  },55000)
  test('native question waits, rejects wrong owner/session, resumes once and preserves answered history',async()=>{
    const first=await run(agent!.createSession({userId:userA})), second=await run(agent!.createSession({userId:userA}))
    const own={sessionID:first.id,userId:userA}, other={...own,userId:userB}, text='QUESTION_TOOL_FIXTURE'
    await run(agent!.prompt({...own,text}))
    await until(async()=>(await run(agent!.inbox(own))).questions.length===1,12000,'native question')
    const pending=(await run(agent!.inbox(own))).questions[0]!
    expect(recorded.some(r=>r.body.includes(text) && JSON.parse(r.body).tools?.some((t:{function:{name:string}})=>t.function.name==='question'))).toBe(true)
    expect(pending.fields.map(f=>f.multiple)).toEqual([false,true])
    const submit={...own,id:pending.id,answers:[['原版'],['摇滚','自填']]}
    expect((await run(Effect.flip(agent!.settleQuestion({...submit,...other}))))._tag).toBe('NotFound')
    expect((await run(Effect.flip(agent!.settleQuestion({...submit,sessionID:second.id}))))._tag).toBe('NotFound')
    expect((await run(Effect.flip(agent!.settleQuestion({...submit,answers:[['a','b'],[]]}))))._tag).toBe('BadRequest')
    await run(agent!.settleQuestion(submit))
    expect((await run(Effect.flip(agent!.settleQuestion(submit))))._tag).toBe('NotFound')
    await until(async()=>(await run(agent!.messages(own))).some(m=>m.text.includes('DONE')),10000,'same turn continued')
    const history=(await run(agent!.messages(own))).flatMap(m=>m.parts??[])
    expect(history.flatMap(p=>p.type==='tool' ? p.answered??[] : []).map(q=>q.answers)).toEqual(submit.answers)
    expect(recorded.some(r=>r.body.includes(text) && JSON.parse(r.body).messages.some((m:{role:string;content:unknown})=>m.role==='tool' && JSON.stringify(m.content).includes('自填')))).toBe(true)
    const s2={...own,sessionID:second.id}; await run(agent!.prompt({...s2,text}))
    await until(async()=>(await run(agent!.inbox(s2))).questions.length>0,10000,'second question')
    await run(agent!.settleQuestion({...s2,id:(await run(agent!.inbox(s2))).questions[0]!.id,answers:null}))
    await until(async()=>{const i=await run(agent!.inbox(s2));return !i.busy && !i.questions.length},10000,'dismissed question')
  },55000)
  test('lyrics MCP: importer edits, unbinds, reads and restores an exact track version',async()=>{
    const pool=new Pool({connectionString:TEST_DB_URL})
    try {
      await pool.query('insert into youtube_imports(track_id,video_id,imported_by) values($1,$2,$3)',[alphaId,'abcdefghijk',userA])
      const s=await run(agent!.createSession({userId:userA})),text='LYRIC_BIND_FIXTURE'
      await run(agent!.prompt({userId:userA,sessionID:s.id,text}))
      const result=()=>recorded.filter(r=>r.body.includes(text)).flatMap(r=>JSON.parse(r.body).messages??[]).find(m=>m.role==='tool')?.content
      await until(()=>result()!==undefined,10000,'lyrics MCP')
      expect(JSON.parse(result())).toEqual({hidden:'none',line:{startMs:1250,text:'Fixture verse'}})
    } finally {await pool.query('delete from youtube_imports where track_id=$1',[alphaId]);await pool.end()}
  },15000)
  test.skipIf(process.env.OPENMUSIC_TEST_LIVE_WEBSEARCH!=='1')('native websearch returns real Exa source links to the music agent',async()=>{
    const session=await run(agent!.createSession({userId:userA})); const text='WEBSEARCH_LIVE_FIXTURE'
    await run(agent!.prompt({userId:userA,sessionID:session.id,text}))
    const toolResults=()=>recorded.filter(r=>r.body.includes(text)).flatMap(r=>JSON.parse(r.body).messages??[]).filter(m=>m.role==='tool')
    await until(()=>toolResults().length>0,40000,'native websearch completed')
    expect(JSON.stringify(toolResults())).toContain('https://')
    expect(JSON.stringify(toolResults()).toLowerCase()).toContain('musicbrainz')
  },45000)
  test('caption MCP ignores auto-only videos even when the extractor reports automatic tracks',async()=>{
    const bin=await fs.mkdtemp(path.join(dataDir,'caption-bin-')), prev=process.env.PATH
    try {
      await fs.writeFile(path.join(bin,'yt-dlp'),`#!/bin/sh\nprintf '%s\\n' '{"id":"abcdefghijk","automatic_captions":{"en":[{"ext":"json3","url":"https://www.youtube.com/api/timedtext?v=abcdefghijk"}]}}'\n`,{mode:0o700})
      process.env.PATH=`${bin}:${prev}`
      const s=await run(agent!.createSession({userId:userA})),text='YT_CAPTIONS_FIXTURE'
      await run(agent!.prompt({userId:userA,sessionID:s.id,text}))
      const result=()=>recorded.filter(r=>r.body.includes(text)).flatMap(r=>JSON.parse(r.body).messages??[]).find(m=>m.role==='tool')?.content
      await until(()=>result()!==undefined,8000,'MCP returns caption discovery result')
      expect(JSON.parse(result())).toEqual({videoId:'abcdefghijk',tracks:[]})
    } finally { process.env.PATH=prev }
  })
  test("busy 会话：默认 steer 在下一步投递，queue 下一轮投递；可改方式和撤回且仅限属主", async () => {
    let release!:()=>void
    holdInbox=new Promise<void>(resolve=>{release=resolve})
    const session=await run(agent!.createSession({userId:userA}))
    const own={userId:userA,sessionID:session.id}, other={...own,userId:userB}
    try {
      await run(agent!.prompt({...own,text:"INBOX_FIRST"}))
      await until(()=>recorded.some(r=>r.body.includes("INBOX_FIRST")&&r.body.includes("coding agent harness")),7000,"首步已开始")
      expect((await run(agent!.inbox(own))).busy).toBe(true)
      await run(agent!.prompt({...own,text:"INBOX_STEERING"}))
      await run(agent!.prompt({...own,text:"INBOX_LATER",delivery:"queue"}))
      await run(agent!.prompt({...own,text:"INBOX_WITHDRAW",delivery:"queue"}))
      const pending=await run(agent!.inbox(own))
      expect(pending.items.map(i=>[i.text,i.delivery])).toEqual([["INBOX_STEERING","steer"],["INBOX_LATER","queue"],["INBOX_WITHDRAW","queue"]])
      const inboxID=pending.items[2]!.id
      expect((await run(Effect.flip(agent!.inbox(other))))._tag).toBe("NotFound")
      expect((await run(Effect.flip(agent!.changePending({...other,inboxID,delivery:null}))))._tag).toBe("NotFound")
      await run(agent!.changePending({...own,inboxID,delivery:"steer"}))
      expect((await run(agent!.inbox(own))).items.find(i=>i.id===inboxID)?.delivery).toBe("steer")
      await run(agent!.changePending({...own,inboxID,delivery:null}))
      expect((await run(agent!.messages(own))).some(m=>m.text==="INBOX_LATER")).toBe(false)
    } finally {holdInbox=null;release()}
    await until(()=>recorded.some(r=>r.body.includes("coding agent harness") && r.body.includes("INBOX_LATER")),10_000,"下一轮排队消息")
    const turns=recorded.filter(r=>r.body.includes("coding agent harness") && r.body.includes("INBOX_FIRST"))
    expect(turns.some(r=>r.body.includes("INBOX_STEERING") && !r.body.includes("INBOX_LATER"))).toBe(true)
    expect(turns.some(r=>r.body.includes("INBOX_WITHDRAW"))).toBe(false)
    expect((await run(agent!.inbox(own))).items).toHaveLength(0)
  },25_000)
  test("一次 prompt：等待 YouTube MCP 完成入库，再用返回的真实 trackIds 请求播放", async () => {
    const root=path.join(dataDir,"music"), bin=path.join(dataDir,"dummy-bin"), previous=process.env.PATH
    const pool=new Pool({connectionString:TEST_DB_URL})
    try {
      await fs.mkdir(path.join(root,"Sessions"),{recursive:true}); await fs.mkdir(bin)
      await fs.symlink(root,path.join(root,"ignore-link")); await fs.mkdir(path.join(root,".hidden"))
      await fs.writeFile(path.join(bin,"yt-dlp"), '#!/bin/sh\nsleep 11\nexec ffmpeg -v error -f lavfi -i sine=frequency=400:duration=1 -metadata title="YT fixture" -c:a libopus audio.opus\n',{mode:0o700})
      process.env.PATH=`${bin}:${previous}`
      const folder=await pool.query("insert into music_folders (path,name) values ($1,'Fixture Live') returning id",[root])
      const s=await run(agent!.createSession({userId:userA}))
      const ids:string[]=[]
      const sub = Effect.runFork(Stream.runForEach(agent!.events({userId:userA}), event=>Effect.sync(()=>{
        if(event.type==="client-action" && event.sessionID===s.id && event.kind==="play-now") ids.push(...event.tracks.map(t=>String(t.id)))
      })))
      try {
        await run(agent!.prompt({userId:userA,sessionID:s.id,text:"YT_IMPORT_FIXTURE 把视频导入 Fixture Live 里的 Sessions，然后播放它"}))
        await until(()=>ids.length>0,23_000,"工具结果交回同一轮，模型继续请求播放")
        const {rows}=await pool.query("select id from tracks where music_folder_id=$1 and path=$2",[folder.rows[0].id,"Sessions/YouTube-abcdefghijk.opus"])
        expect(ids).toEqual([String(rows[0].id)])
        expect(await fs.readdir(path.join(root,"Sessions"))).toEqual(["YouTube-abcdefghijk.opus"])
      } finally {sub.interruptUnsafe()}

      // Stop a real in-flight MCP exchange; the process group must not continue as an orphan job.
      const pidFile=path.join(bin,"started-pid")
      await fs.writeFile(path.join(bin,"yt-dlp"), `#!/bin/sh\necho $$ > '${pidFile}'\nexec sleep 50\n`, {mode:0o700})
      const cancelSession=await run(agent!.createSession({userId:userA}))
      await run(agent!.prompt({userId:userA,sessionID:cancelSession.id,text:"YT_IMPORT_FIXTURE YT_CANCEL_FIXTURE 导入"}))
      await until(()=>Bun.file(pidFile).exists(),6_000,"MCP 已启动下载进程")
      const pid=Number((await fs.readFile(pidFile,"utf8")).trim())
      await run(agent!.interrupt({userId:userA,sessionID:cancelSession.id}))
      await until(()=>{try{process.kill(pid,0);return false}catch{return true}},5_000,"中断会话时终止下载")
      expect(await fs.readdir(path.join(root,"Sessions"))).toEqual(["YouTube-abcdefghijk.opus"])
    } finally { process.env.PATH=previous; await pool.end() }
  },30_000)

  // ---- 网易云 MCP：同一宿主/同一 Code Mode 链路上的三个会话级全链 ----
  // music.163.com 与 *.music.126.net 全部走 globalThis.fetch mock，媒体下载走 PATH 注入的
  // 本地 yt-dlp fixture——零外网、零真实模型；归属解析经 agent_sessions 真库反查。

  /** 与 test/netease-import.test.ts 同源的详情/搜索 fixture（一次性会话内 mock） */
  const neteaseFetchMock = (originalFetch: typeof fetch) => {
    const detail = (id: string) => id === "5264842"
      ? { id: 5264842, name: "晴天", artists: [{ name: "周杰伦" }], album: { name: "叶惠美", picUrl: "http://p1.music.126.net/6TqR_U__xy.jpg" }, fee: 8, duration: 2000 }
      : { id: Number(id), name: `网易歌曲 ${id}`, artists: [{ name: "歌手甲" }], album: { name: "网易专辑", picUrl: "http://p1.music.126.net/6TqR_U__xy.jpg" }, fee: 8, duration: 2000 }
    const vip = { id: 2606227455, name: "VIP 歌曲", artists: [{ name: "某人" }], album: { name: "专辑" }, fee: 1, duration: 281000 }
    return Object.assign((arg: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const u = new URL(arg instanceof Request ? arg.url : arg.toString())
      if (u.hostname === "music.163.com") {
        if (u.pathname === "/api/search/get") return Promise.resolve(Response.json({ code: 200, result: { songs: [detail("5264842"), vip] } }))
        if (u.pathname === "/api/song/detail") {
          const ids = (u.searchParams.get("ids") ?? "").replace(/^\[|\]$/g, "").split(",").filter(Boolean)
          return Promise.resolve(Response.json({ code: 200, songs: ids.map(detail) }))
        }
        if (u.pathname === "/api/song/lyric") return Promise.resolve(Response.json({ code: 200, lrc: { lyric: "[00:01.00]原文" }, tlyric: { lyric: "[00:01.00]译文" } }))
      }
      if (u.hostname === "p1.music.126.net")
        return Promise.resolve(new Response(new Uint8Array(Bun.spawnSync(["ffmpeg","-v","error","-f","lavfi","-i","color=c=red:s=40x40","-frames:v","1","-c:v","mjpeg","-f","image2pipe","pipe:1"]).stdout)))
      return originalFetch(arg, init)
    }, { preconnect: originalFetch.preconnect })
  }

  /** 会话里上一轮 execute 的工具结果（content 为 JSON 文本）；找不到返回 undefined */
  const toolResult = async (own: { userId: number; sessionID: string }, marker: string) => {
    for (const record of recorded.filter(r => r.body.includes(marker) && r.body.includes("coding agent harness")).reverse()) {
      const message = JSON.parse(record.body).messages?.find((m: { role: string }) => m.role === "tool")
      if (typeof message?.content === "string") return message.content
    }
    return undefined
  }

  test("网易云搜索会话：search_netease 经 Code Mode 全链返回候选（含 vip 标记）", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = neteaseFetchMock(originalFetch)
    try {
      const s = await run(agent!.createSession({ userId: userA }))
      const marker = "NETEASE_SEARCH_FIXTURE"
      await run(agent!.prompt({ userId: userA, sessionID: s.id, text: `${marker} 帮我在网易云搜「晴天」，把候选和 VIP 标记告诉我` }))
      let content: string | undefined
      await until(async () => (content = await toolResult({ userId: userA, sessionID: s.id }, marker)) !== undefined, 15_000, "netease.search_netease 工具结果回传")
      // 归属解析经 agent_sessions 真库反查成功（失败会回「无法验证会话」而非候选）
      expect(content).not.toContain("无法验证会话")
      const out = JSON.parse(content!) as Array<{ title: string; artist: string; album: string; songId: string; url: string; vip: boolean }>
      expect(out).toEqual([
        { title: "晴天", artist: "周杰伦", album: "叶惠美", songId: "5264842", url: "https://music.163.com/song?id=5264842", vip: false },
        { title: "VIP 歌曲", artist: "某人", album: "专辑", songId: "2606227455", url: "https://music.163.com/song?id=2606227455", vip: true },
      ])
      await until(async () => (await run(agent!.messages({ userId: userA, sessionID: s.id })))
        .some(m => m.role === "assistant" && m.text.includes("DONE")), 15_000, "assistant DONE")
      const history = await run(agent!.messages({ userId: userA, sessionID: s.id }))
      const parts = history.flatMap(m => m.parts ?? [])
      // Code Mode 内层调用的名字可能是带命名空间的完整路径，只钉关键段与状态
      expect(parts.some(p => p.type === "tool" && p.calls.some(c => c.name.includes("search_netease") && c.status === "done"))).toBe(true)
    } finally { globalThis.fetch = originalFetch }
  }, 30_000)

  test("网易云导入会话：start_import_netease 等终态，真实 trackIds 回传后请求播放；interrupt 终止下载进程", async () => {
    const root = path.join(dataDir, "netease-music"), bin = path.join(dataDir, "netease-bin"), previous = process.env.PATH
    const pool = new Pool({ connectionString: TEST_DB_URL })
    const originalFetch = globalThis.fetch
    try {
      await fs.mkdir(path.join(root, "Sessions"), { recursive: true }); await fs.mkdir(bin)
      globalThis.fetch = neteaseFetchMock(originalFetch)
      // 本地确定性 yt-dlp：单曲下载 = 真 ffmpeg 产物 + after_move 摘要（netease-import.test 同款）
      await fs.writeFile(path.join(bin, "yt-dlp"), `#!/bin/sh
for arg do last="$arg"; done
id=\${last##*id=}
case "$id" in ''|*[!0-9]*) exit 3;; esac
ffmpeg -v error -f lavfi -i sine=frequency=440:duration=2 -c:a libmp3lame -b:a 128k audio.mp3 || exit 1
printf '{"id":"%s","title":"网易云歌曲 %s","creators":[{"name":"歌手甲"}],"album":"网易专辑","album_artists":[{"name":"专辑艺人"}],"timestamp":1060646400,"thumbnail":"http://p1.music.126.net/6TqR_U__xy.jpg"}\\n' "$id" "$id"`, { mode: 0o700 })
      process.env.PATH = `${bin}:${previous}`
      const folder = await pool.query("insert into music_folders (path,name) values ($1,'Netease Live') returning id", [root])
      const marker = "NETEASE_IMPORT_FIXTURE"
      const s = await run(agent!.createSession({ userId: userA }))
      const ids: string[] = []
      const sub = Effect.runFork(Stream.runForEach(agent!.events({ userId: userA }), event => Effect.sync(() => {
        if (event.type === "client-action" && event.sessionID === s.id && event.kind === "play-now") ids.push(...event.tracks.map(t => String(t.id)))
      })))
      try {
        await run(agent!.prompt({ userId: userA, sessionID: s.id, text: `${marker} 把 https://music.163.com/song?id=5264842 导入 Netease Live 的 Sessions，然后播放它` }))
        await until(() => ids.length > 0, 40_000, "导入终态回传后模型用真实 trackIds 请求播放")
        let content: string | undefined
        await until(async () => (content = await toolResult({ userId: userA, sessionID: s.id }, marker)) !== undefined, 10_000, "netease.start_import_netease 工具结果在轮次请求里可见")
        const out = JSON.parse(content!) as { state: string; trackIds: number[]; files: { trackId: number; name: string }[] }
        expect(out.state).toBe("done")
        expect(out.files).toEqual([{ trackId: expect.any(Number), name: "Netease-5264842.mp3" }])
        const { rows } = await pool.query(
          "select t.id, n.song_id, n.imported_by, n.quality from tracks t join netease_imports n on n.track_id=t.id where t.music_folder_id=$1 and t.path=$2",
          [folder.rows[0].id, "Sessions/Netease-5264842.mp3"])
        expect(rows).toHaveLength(1)
        expect(rows[0]!.song_id).toBe("5264842")
        expect(Number(rows[0]!.imported_by)).toBe(userA)
        expect(ids).toEqual([String(rows[0]!.id)])
        expect(out.trackIds).toEqual([Number(rows[0]!.id)])
        expect(await fs.readdir(path.join(root, "Sessions"))).toEqual(["Netease-5264842.mp3"])
        await until(async () => (await run(agent!.messages({ userId: userA, sessionID: s.id })))
          .some(m => m.role === "assistant" && m.text.includes("DONE")), 15_000, "assistant DONE")
        // 歌词自动入共享歌词体系（原文+译文等时间戳合并）
        const lyric = await pool.query("select mode from track_lyrics where track_id=$1", [rows[0]!.id])
        expect(lyric.rows).toHaveLength(1)
      } finally { sub.interruptUnsafe() }

      // 宿主打断按钮中止进行中的 MCP 导入：进程组不得变孤儿继续下载
      const pidFile = path.join(bin, "started-pid")
      await fs.writeFile(path.join(bin, "yt-dlp"), `#!/bin/sh\necho $$ > '${pidFile}'\nexec sleep 50\n`, { mode: 0o700 })
      const cancelSession = await run(agent!.createSession({ userId: userA }))
      await run(agent!.prompt({ userId: userA, sessionID: cancelSession.id, text: "NETEASE_IMPORT_FIXTURE NETEASE_CANCEL_FIXTURE 导入另一首" }))
      await until(() => Bun.file(pidFile).exists(), 8_000, "netease MCP 已启动下载进程")
      const pid = Number((await fs.readFile(pidFile, "utf8")).trim())
      await run(agent!.interrupt({ userId: userA, sessionID: cancelSession.id }))
      await until(() => { try { process.kill(pid, 0); return false } catch { return true } }, 5_000, "中断会话时终止 netease 下载")
      expect(await fs.readdir(path.join(root, "Sessions"))).toEqual(["Netease-5264842.mp3"])
    } finally { globalThis.fetch = originalFetch; process.env.PATH = previous; await pool.end() }
  }, 60_000)

  test("网易云管理会话：get_metadata + request_file_deletion 只回人工链接，token 永不下发、文件与曲库条目原样保留", async () => {
    const pool = new Pool({ connectionString: TEST_DB_URL })
    try {
      // 直接造行（真实 mp3 + 匹配的 size/mtime）：复用导入链路之外验证管理工具的
      // 票据语义——不依赖上一条测试的状态。
      const root = path.join(dataDir, "netease-admin")
      await fs.mkdir(path.join(root, "Sessions"), { recursive: true })
      const media = path.join(root, "Sessions", "Netease-5264842.mp3")
      expect(Bun.spawnSync(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:a", "libmp3lame", "-b:a", "128k", media]).exitCode).toBe(0)
      const stat = await fs.stat(media)
      // 与 scanner 一致的 mtime 落库口径（Math.floor(stat.mtimeMs)）——removals 内核按
      // mtimeNs 截断毫秒比对，Math.round 会在余数 ≥500µs 时误判「文件已改变」
      const one = async (sql: string, values: unknown[] = []) => (await pool.query(sql, values)).rows[0] as Record<string, unknown>
      const folder = await one("insert into music_folders (path,name) values ($1,'Netease Admin') returning id", [root])
      const artist = await one("insert into artists (name) values ('网易管理艺人') returning id")
      const album = await one("insert into albums (artist_id, name, year) values ($1,'网易管理专辑',2003) returning id", [artist.id])
      const track = await one(
        `insert into tracks (music_folder_id, album_id, artist_id, disc, track_no, title, duration_seconds, format, codec, size_bytes, path, mtime_ms)
         values ($1,$2,$3,1,1,'管理面曲目',2,'mp3','mp3',$4,'Sessions/Netease-5264842.mp3',$5) returning id`,
        [folder.id, album.id, artist.id, stat.size, Math.floor(stat.mtimeMs)])
      await pool.query("insert into netease_imports(track_id,song_id,imported_by,quality) values ($1,'5264842',$2,'standard')", [track.id, userA])
      neteaseDeleteTrackId = Number(track.id)

      const s = await run(agent!.createSession({ userId: userA }))
      const marker = "NETEASE_DELETE_FIXTURE"
      await run(agent!.prompt({ userId: userA, sessionID: s.id, text: `${marker} 我要求把这首连原文件一起删掉` }))
      let content: string | undefined
      await until(async () => (content = await toolResult({ userId: userA, sessionID: s.id }, marker)) !== undefined, 15_000, "netease 管理工具结果回传")
      const out = JSON.parse(content!) as { info: { trackId: string; songId: string; filename: string }; req: Record<string, unknown> }
      expect(out.info).toMatchObject({ trackId: String(track.id), songId: "5264842", filename: "Netease-5264842.mp3", quality: "standard" })
      // 票据只给人工确认链接；token 永不随工具结果下发（确认页专属）
      expect(out.req).not.toHaveProperty("token")
      expect(out.req.state).toBe("awaiting_human")
      expect(out.req.fileDeleted).toBe(false)
      expect(out.req.reviewPath).toBe(`/review-deletion/${out.req.requestId}`)
      expect(out.req.link).toBe(`[核对并确认删除文件](${out.req.reviewPath})`)
      expect(Number(out.req.expiresAt)).toBeGreaterThan(Date.now())
      expect(Number(out.req.expiresAt)).toBeLessThanOrEqual(Date.now() + 5 * 60_000)
      // 工具本身绝不删除：文件、曲库条目、溯源行全部原样
      expect(await fs.stat(media)).toBeTruthy()
      expect((await pool.query("select 1 from tracks where id=$1", [track.id])).rows).toHaveLength(1)
      expect((await pool.query("select 1 from netease_imports where track_id=$1", [track.id])).rows).toHaveLength(1)
      await until(async () => (await run(agent!.messages({ userId: userA, sessionID: s.id })))
        .some(m => m.role === "assistant" && m.text.includes("DONE")), 15_000, "assistant DONE")
    } finally { await pool.end() }
  }, 30_000)

  test(
    "会话创建 + 归属登记",
    async () => {
      const session = await run(agent!.createSession({ userId: userA, title: "测试会话" }))
      expect(session.id.startsWith("ses_")).toBe(true)
      const rows = await Effect.runPromise(
        Effect.provideService(AgentSessionRepo.listFor(userA, 10), SqlClient.SqlClient, Context.get(sqlContext!, SqlClient.SqlClient)),
      )
      expect(rows.map((row) => row.id)).toContain(session.id)
    },
    30_000,
  )

  test(
    "prompt → 工具分发 → 回复：全链（mock provider 两轮）",
    async () => {
      // 事件观察器：实证 Code Mode 下内层 music_search 是否仍发 session.tool.* 事件
      const seen: string[] = []
      const snapshots: Array<{ id: string; ordinal: number; text: string }> = []
      const session = await run(agent!.createSession({ userId: userA }))
      const fiber = Effect.runFork(
        Stream.runForEach(agent!.events({ userId: userA }), (event) =>
          Effect.sync(() => {
            const sessionID = event.type === "raw" ? event.event.data.sessionID : event.sessionID
            if (sessionID !== session.id) return
            const raw = event.type === "raw" ? event.event.type : event.type
            seen.push(raw)
            if (event.type === "message.snapshot") snapshots.push({ id: event.messageID, ordinal: event.ordinal, text: event.text })
          })),
      )
      await run(agent!.prompt({ userId: userA, sessionID: session.id, text: "帮我找 Alpha" }))

      await until(
        async () => {
          const messages = await run(agent!.messages({ userId: userA, sessionID: session.id }))
          return messages.some((message) => message.role === "assistant" && message.text.includes("DONE"))
        },
        60_000,
        "assistant DONE 回复",
      )

      // 最后一轮 agent 请求 = 工具结果回传轮：execute 沙盒结果含真库数据
      const agentCalls = recorded.filter(
        (r) => r.body.includes("帮我找 Alpha") && r.body.includes("coding agent harness"),
      )
      expect(agentCalls.length).toBeGreaterThanOrEqual(2)
      const last = agentCalls[agentCalls.length - 1]!.body
      expect(last).toContain("Alpha Host Song") // repo 精简投影出现在工具结果里
      expect(last).toContain("Host Artist")
      // 首轮：模型发起 execute（Code Mode），代码里编排 music_search
      expect(agentCalls[0]!.body).toContain("\"execute\"")
      expect(agentCalls[0]!.body).toContain("music_search")
      expect(agentCalls[0]!.body).not.toContain("Alpha Host Song")
      // 画像槽位（A3）：首轮 system 含 listening-profile 基线（library 计数来自 seed 库）
      expect(agentCalls[0]!.body).toContain('key=\\"listening-profile\\"')
      expect(agentCalls[0]!.body).toContain('\\"library\\"')
      // 画像值未变 → 第二轮无 supersede 增量（缓存语义：没变零成本）
      expect(last).not.toContain("supersedes")
      // History can finish before the independent SSE subscription has drained its queue.
      await until(() => seen.includes("session.execution.succeeded"), 10_000, "该会话的 SSE 执行结束事件")
      expect(seen).toContain("session.tool.success")
      // 流式文本（A2 修复回归）：宿主真实事件是 session.text.delta/ended，
      // 归一化必须产出 message.delta/snapshot——曾经映射了不存在的
      // session.message.content.updated 导致前端流式全哑
      expect(seen).toContain("message.delta")
      expect(seen).toContain("message.snapshot")
      await until(() => seen.includes("session.renamed"), 10_000, "OpenCode 自动标题事件")
      const stored = await run(Effect.provideService(AgentSessionRepo.byId(session.id), SqlClient.SqlClient, Context.get(sqlContext!, SqlClient.SqlClient)))
      expect(stored?.title).toBe("T") // mock title generator; persisted independently of a list request
      // Simulate a legacy empty PG title; recovery uses only stored SDK metadata.
      await run(Effect.provideService(AgentSessionRepo.saveTitle(session.id, ""), SqlClient.SqlClient, Context.get(sqlContext!, SqlClient.SqlClient)))
      const sessions = await run(agent!.listSessions({ userId: userA }))
      expect(sessions.find((s) => s.id === session.id)?.title).toBe("T")
      expect(sessions.find((s) => s.title === "测试会话")).toBeDefined()
      const history = await run(agent!.messages({ userId: userA, sessionID: session.id }))
      const parts = history.flatMap((message) => message.parts ?? [])
      expect(parts.map((part) => part.type)).toEqual(["text", "tool", "text"])
      expect(parts[1]).toMatchObject({ type: "tool", name: "execute", status: "done", calls: [{ name: "music_search", status: "done" }] })
      expect(history.flatMap((message) => (message.parts ?? []).flatMap((part) => part.type === "text"
        ? [{ id: message.id, ordinal: part.ordinal, text: part.text }] : []))).toEqual(snapshots)
      fiber.interruptUnsafe()
    },
    90_000,
  )

  test(
    "clientAction：music_play_now 经 execute 沙盒成功 → client-action 事件（前端确认卡片源）",
    async () => {
      const actions: Array<{ kind: string; tracks: Array<{ title?: string }> }> = []
      const fiber = Effect.runFork(
        Stream.runForEach(agent!.events({ userId: userA }), (event) =>
          Effect.sync(() => {
            if (event.type === "client-action") {
              actions.push({ kind: event.kind, tracks: event.tracks as Array<{ title?: string }> })
            }
          })),
      )
      const session = await run(agent!.createSession({ userId: userA }))
      await run(agent!.prompt({ userId: userA, sessionID: session.id, text: "请直接播放 Alpha" }))

      await until(() => actions.length > 0, 60_000, "client-action 事件")
      expect(actions[0]!.kind).toBe("play-now")
      expect(actions[0]!.tracks[0]!.title).toBe("Alpha Host Song")
      expect(actions[0]!.tracks[0]).toHaveProperty("artist", "Host Artist")
      fiber.interruptUnsafe()
    },
    90_000,
  )

  test(
    "归属隔离：他人会话 → NotFound（不泄露存在性）",
    async () => {
      const session = await run(agent!.createSession({ userId: userA }))
      const err = await run(Effect.flip(agent!.messages({ userId: userB, sessionID: session.id })))
      expect(err._tag).toBe("NotFound")
      const err2 = await run(Effect.flip(agent!.prompt({ userId: userB, sessionID: session.id, text: "hi" })))
      expect(err2._tag).toBe("NotFound")
    },
    30_000,
  )

  test(
    "listSessions 只见自己的",
    async () => {
      const mine = await run(agent!.listSessions({ userId: userA }))
      const theirs = await run(agent!.listSessions({ userId: userB }))
      expect(mine.length).toBeGreaterThanOrEqual(2)
      expect(theirs).toHaveLength(0)
    },
    30_000,
  )

  test("SSE 鉴权：两名用户的正文、工具和播放确认隔离；撤销 cookie 后旧流不再下发", async () => {
    expect((await fetchEvents()).status).toBe(401)
    expect((await fetchEvents("not-a-session")).status).toBe(401)
    const pool = new Pool({ connectionString: TEST_DB_URL })
    const cookieA = crypto.randomUUID(), cookieB = crypto.randomUUID()
    const readers: Array<{ cancel(): Promise<void> }> = []
    const observe = async (cookie: string, query = "") => {
      const response = await fetchEvents(cookie, query)
      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toContain("text/event-stream")
      const reader = response.body!.getReader()
      readers.push(reader)
      const events: AgentEvent[] = []
      const drained = (async () => {
        const decoder = new TextDecoder()
        let buffer = ""
        for (;;) {
          const read = await reader.read()
          if (read.done) return
          const frames = (buffer + decoder.decode(read.value, { stream: true })).split("\n\n")
          buffer = frames.pop()!
          for (const frame of frames) events.push(JSON.parse(frame.slice("data: ".length)))
        }
      })()
      return { events, drained }
    }
    const finished = (events: AgentEvent[], id: string) => events.some((e) =>
      e.type === "raw" && e.event.type === "session.execution.succeeded" && e.event.data.sessionID === id)
    try {
      await pool.query(`insert into sessions (token, user_id, expires_at) values
        ($1, $2, now() + interval '1 day'), ($3, $4, now() + interval '1 day')`, [cookieA, userA, cookieB, userB])
      const a = await observe(cookieA)
      const b = await observe(cookieB, `?userId=${userA}`) // user ID is never client-selectable
      const sessionA = (await run(agent!.createSession({ userId: userA }))).id
      const sessionB = (await run(agent!.createSession({ userId: userB }))).id
      await run(agent!.prompt({ userId: userA, sessionID: sessionA, text: "请直接播放 Alpha" }))
      await until(() => finished(a.events, sessionA), 15_000, "A 收到完整一轮")
      await run(agent!.prompt({ userId: userB, sessionID: sessionB, text: "帮我找 Alpha" }))
      await until(() => finished(b.events, sessionB), 15_000, "B 收到完整一轮")
      for (const [events, id] of [[a.events, sessionA], [b.events, sessionB]] as const) {
        expect(events.every((e) => (e.type === "raw" ? e.event.data.sessionID : e.sessionID) === id)).toBe(true)
        expect(events.some((e) => e.type === "message.delta")).toBe(true)
        expect(events.some((e) => e.type === "message.snapshot")).toBe(true)
        expect(events.some((e) => e.type === "raw" && e.event.type === "session.tool.progress")).toBe(true)
        expect(events.some((e) => e.type === "raw" && e.event.type === "session.tool.success" && "content" in e.event.data)).toBe(false)
      }
      expect(a.events.some((e) => e.type === "client-action")).toBe(true)
      expect(b.events.some((e) => e.type === "client-action")).toBe(false)
      await pool.query("delete from sessions where token = $1", [cookieA])
      const count = a.events.length
      await run(agent!.prompt({ userId: userA, sessionID: sessionA, text: "继续" }))
      await a.drained
      expect(a.events.length).toBe(count)
      expect((await fetchEvents(cookieA)).status).toBe(401)
      await pool.query("update sessions set expires_at = now() - interval '1 day' where token = $1", [cookieB])
      const countB = b.events.length
      await run(agent!.prompt({ userId: userB, sessionID: sessionB, text: "继续" }))
      await b.drained
      expect(b.events.length).toBe(countB)
    } finally {
      await Promise.all(readers.map((r) => r.cancel()))
      await pool.end()
    }
  }, 60_000)

  test("管理员供应商设置：目录、写入、热加载、旧会话实际调用及凭据隔离", async () => {
    const admin = agent!.admin
    const initial = await run(admin.settings())
    expect(initial.integrations.some((i) => i.id === "opencode" && i.consoleLogin)).toBe(true)
    const prior = await run(agent!.createSession({ userId: userA }))
    const providerID = "om-custom-fixture"
    const custom = { type: "custom" as const, slug: "fixture", name: "Fixture gateway", baseURL: `http://127.0.0.1:${mockServer!.port}/v1`, models: ["test-model"] }
    expect((await run(Effect.flip(admin.change({ ...custom, baseURL: "file:///bad" }))))._tag).toBe("BadRequest")
    await run(admin.change(custom))
    expect((await run(Effect.flip(admin.change(custom))))._tag).toBe("BadRequest")
    await run(admin.change({ type: "key", integrationID: providerID, key: "fixture-admin-key" }))
    await run(admin.change({ type: "model", providerID, id: "test-model" }))
    const settings = await run(admin.settings())
    expect(settings.current).toEqual({ providerID, id: "test-model" })
    expect(JSON.stringify(settings)).not.toContain("fixture-admin-key")
    const persisted = await fs.readFile(path.join(dataDir, "agent-config.json"), "utf8")
    expect(persisted).not.toContain("fixture-admin-key")
    expect(Bun.JSONC.parse(persisted)).toMatchObject({ agents: { music: { model: `${providerID}/test-model`, mode: "primary" } } })
    await run(agent!.prompt({ userId: userA, sessionID: prior.id, text: "测试切换后的模型" }))
    await until(() => customAuthenticated, 15_000, "新模型及其独立凭据到达测试端点")
    const account = settings.integrations.find((i) => i.id === providerID)!.accounts[0]!
    await run(admin.change({ type: "disconnect", integrationID: providerID, credentialID: account.id }))
    expect((await run(admin.settings())).integrations.find((i) => i.id === providerID)?.accounts).toEqual([])
  }, 45_000)
})
