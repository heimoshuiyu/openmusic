import { expect, test } from "bun:test"
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/server"
import { Effect } from "effect"
import { BadRequest, notFound, type NotFound } from "../../domain/errors"
import type { NeteaseCandidate, NeteaseImportResult, NeteaseInfo, NeteaseTags } from "../../domain/netease"
import { neteaseMcp, type NeteaseMcp } from "./mcp"

/** MCP 协议面单测（免 DB/免网络）：直连 server.fetch 走标准 Streamable HTTP JSON-RPC，
 *  fake imports 以 Effect 应答。钉住：tools/list 精确 schema、会话守卫、参数守卫、
 *  六个工具的 happy path、BadRequest/NotFound/未知错误三向映射、interrupt 中止传播、
 *  以及「不存在 confirm/review 工具」——物理删除永远只能由人工在确认页完成。
 *  ownerOf/服务层的属主与权限语义由 test/netease-import.test.ts 覆盖，这里只验 MCP 边界。 */

const candidates: NeteaseCandidate[] = [
  { title: "晴天", artist: "周杰伦", album: "叶惠美", songId: "5264842", url: "https://music.163.com/song?id=5264842", vip: false },
  { title: "VIP 歌曲", artist: "某人", album: "专辑", songId: "2606227455", url: "https://music.163.com/song?id=2606227455", vip: true },
]
const doneResult: NeteaseImportResult = {
  url: "https://music.163.com/song?id=5264842", kind: "song", state: "done",
  total: 1, imported: 1, skipped: 0, failed: 0, destination: "/music",
  trackIds: [42], files: [{ trackId: 42, name: "Netease-5264842.mp3" }], failures: [], warnings: [],
}
const failedResult: NeteaseImportResult = { ...doneResult, state: "failed", imported: 0, trackIds: [], files: [] }
const infoResult: NeteaseInfo = {
  trackId: "42", songId: "5264842", quality: "standard", format: "mp3", filename: "Netease-5264842.mp3",
  title: "晴天", artist: "周杰伦", album: "叶惠美", albumArtist: "周杰伦",
  genre: null, trackNumber: null, discNumber: 1, hasCover: true,
}
const editedInfo: NeteaseInfo = { ...infoResult, title: "编辑后的标题", genre: "J-Pop", warnings: ["未能嵌入文件标签；保留原文件，指定的文字元数据已存入曲库。未转码。"] }
const ticket = { requestId: "0f0e0d0c-0000-4000-8000-000000000000", reviewPath: "/review-deletion/0f0e0d0c-0000-4000-8000-000000000000", expiresAt: 1770000000000 }

type Call = { tool: string; owner: number; args: Record<string, unknown> }

/** fake NeteaseImports：记录 (tool, owner, args)，行为按测试注入；全部返回 Effect。 */
type Imports = import("./imports").NeteaseImports["Service"]
type JsonSchema = { type?: string; required?: string[]; additionalProperties?: boolean; properties?: Record<string, Record<string, unknown>> }

function makeFake(behavior: {
  search?: Effect.Effect<NeteaseCandidate[], BadRequest | NotFound | Error>
  start?: Effect.Effect<NeteaseImportResult, BadRequest | NotFound | Error>
  info?: Effect.Effect<NeteaseInfo, BadRequest | NotFound | Error>
  edit?: Effect.Effect<NeteaseInfo, BadRequest | NotFound | Error>
  unindex?: Effect.Effect<void, BadRequest | NotFound | Error>
  request?: Effect.Effect<typeof ticket, BadRequest | NotFound | Error>
} = {}) {
  const calls: Call[] = []
  const service = {
    search: (owner: number, query: string) => {
      calls.push({ tool: "search", owner, args: { query } })
      return behavior.search ?? Effect.succeed(candidates)
    },
    folders: () => Effect.succeed([]),
    children: () => Effect.succeed({ directories: [], truncated: false }),
    start: (owner: number, session: string, url: string, folderId: string, subdirectory: string) => {
      calls.push({ tool: "start", owner, args: { session, url, folderId, subdirectory } })
      return behavior.start ?? Effect.succeed(doneResult)
    },
    info: (id: string) => {
      calls.push({ tool: "info", owner: -1, args: { id } })
      return behavior.info ?? Effect.succeed(infoResult)
    },
    edit: (owner: number, id: string, tags: NeteaseTags) => {
      calls.push({ tool: "edit", owner, args: { id, tags } })
      return behavior.edit ?? Effect.succeed(editedInfo)
    },
    removals: {
      unindex: (owner: number, id: string) => {
        calls.push({ tool: "unindex", owner, args: { id } })
        return behavior.unindex ?? Effect.void
      },
      request: (owner: number, id: string) => {
        calls.push({ tool: "request", owner, args: { id } })
        return behavior.request ?? Effect.succeed(ticket)
      },
      // MCP 不暴露 preview/cancel/confirm：代理到即败，防将来误接线。
      preview: () => Effect.fail(new BadRequest({ message: "preview 不经 MCP 暴露" })),
      cancel: () => Effect.fail(new BadRequest({ message: "cancel 不经 MCP 暴露" })),
      confirm: () => Effect.fail(new BadRequest({ message: "confirm 不经 MCP 暴露" })),
    },
  }
  return { calls, service: service as unknown as Imports }
}

const ownerOf = (id: string) => Promise.resolve(id === "ses_owner" ? 7 : null)

/** Streamable HTTP 回包是单帧 SSE（event: message + data: <json>）。 */
const frame = async (response: Response) => {
  expect(response.status).toBe(200)
  const text = await response.text()
  const data = text.split("\n").find(line => line.startsWith("data: "))
  if (data === undefined) throw new Error(`SSE data frame missing: ${text.slice(0, 200)}`)
  return JSON.parse(data.slice("data: ".length)) as { result?: unknown; error?: { code: number; message: string } }
}

const rpc = async (mcp: NeteaseMcp, body: Record<string, unknown>) =>
  frame(await mcp.server.fetch(new Request("http://local/netease", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify(body),
  })))

const callTool = (mcp: NeteaseMcp, name: string, args: Record<string, unknown>, sessionID: string | null = "ses_owner") =>
  rpc(mcp, { jsonrpc: "2.0", id: 1, method: "tools/call", params: {
    name, arguments: args, ...(sessionID === null ? {} : { _meta: { "ai.opencode/sessionID": sessionID } }),
  } })

const payload = (message: { result?: unknown }) => {
  const result = message.result as { content: Array<{ type: string; text: string }>; isError: boolean }
  expect(result.content).toHaveLength(1)
  expect(result.content[0]!.type).toBe("text")
  return { isError: result.isError, value: JSON.parse(result.content[0]!.text) as unknown }
}

const withMcp = async (service: import("./imports").NeteaseImports["Service"], fn: (mcp: NeteaseMcp) => Promise<void>) => {
  const mcp = neteaseMcp(service, ownerOf)
  try { await fn(mcp) } finally { await mcp.close() }
}

test("initialize + tools/list：六个工具、精确 schema、危险语义在 instructions 里可见", async () => {
  const { service } = makeFake()
  await withMcp(service, async mcp => {
    const init = await rpc(mcp, { jsonrpc: "2.0", id: 0, method: "initialize", params: {
      protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "unit", version: "0" } } })
    const info = init.result as { serverInfo: { name: string }; instructions: string }
    expect(info.serverInfo.name).toBe("OpenMusic Netease")
    // 危险工具必须在 instructions 里自带纪律文案（不依赖 skill 也可见）
    expect(info.instructions).toContain("remove_from_library_netease")
    expect(info.instructions).toContain("request_file_deletion_netease")
    expect(info.instructions).toContain("不要代表用户打开、确认或声称已经删除")
    const listed = await rpc(mcp, { jsonrpc: "2.0", id: 0, method: "tools/list", params: {} })
    const tools = (listed.result as { tools: Array<Record<string, unknown>> }).tools
    expect(tools.map(t => t.name)).toEqual([
      "search_netease", "start_import_netease", "get_metadata_netease",
      "edit_metadata_netease", "remove_from_library_netease", "request_file_deletion_netease",
    ])
    // 新增四件的输入形状逐字段钉住（描述允许演进，结构不许漂移）
    const schemaOf = (name: string) => tools.find(t => t.name === name)!.inputSchema as JsonSchema
    expect(schemaOf("get_metadata_netease")).toEqual({
      type: "object", properties: { trackId: { type: "integer", minimum: 1 } }, required: ["trackId"], additionalProperties: false })
    expect(schemaOf("remove_from_library_netease")).toEqual(schemaOf("get_metadata_netease"))
    expect(schemaOf("request_file_deletion_netease")).toEqual(schemaOf("get_metadata_netease"))
    expect(schemaOf("edit_metadata_netease")).toMatchObject({
      type: "object", required: ["trackId", "metadata"], additionalProperties: false,
      properties: { trackId: { type: "integer", minimum: 1 } } })
    const metadata = schemaOf("edit_metadata_netease").properties!.metadata! as JsonSchema
    expect(metadata.type).toBe("object")
    expect(metadata.additionalProperties).toBe(false)
    expect(Object.keys(metadata.properties!).sort()).toEqual(
      ["album", "albumArtist", "artist", "cover", "discNumber", "genre", "title", "trackNumber"])
    const props = metadata.properties!
    for (const key of ["title", "artist", "album", "albumArtist", "genre"]) expect(props[key]).toEqual({ type: "string", maxLength: 300 })
    for (const key of ["trackNumber", "discNumber"]) expect(props[key]).toEqual({ type: "integer", minimum: 1, maximum: 9999 })
    expect(props.cover!.type).toBe("string")
  })
})

test("会话守卫：缺 sessionID 与陌生 session 直接拒绝，不触达服务", async () => {
  const { service, calls } = makeFake()
  await withMcp(service, async mcp => {
    const missing = await callTool(mcp, "search_netease", { query: "晴天" }, null)
    expect(payload(missing)).toEqual({ isError: true, value: "缺少会话身份" })
    const stranger = await callTool(mcp, "search_netease", { query: "晴天" }, "ses_stranger")
    expect(payload(stranger)).toEqual({ isError: true, value: "无法验证会话" })
    expect(calls).toHaveLength(0)
  })
})

test("search_netease：happy path 透传候选（含 vip 标记）；多余键/非字符串查询拒绝", async () => {
  const { service, calls } = makeFake()
  await withMcp(service, async mcp => {
    const out = payload(await callTool(mcp, "search_netease", { query: "晴天" }))
    expect(out.isError).toBe(false)
    expect(out.value).toEqual(candidates)
    expect((out.value as NeteaseCandidate[])[1]!.vip).toBe(true)
    expect(calls).toEqual([{ tool: "search", owner: 7, args: { query: "晴天" } }])
    for (const bad of [{ query: "x", extra: 1 }, { query: 5 }, {}, { query: "x", trackId: 1 }]) {
      expect(payload(await callTool(mcp, "search_netease", bad))).toEqual({ isError: true, value: "请提供 1–160 个字符的搜索词。" })
    }
  })
})

test("start_import_netease：多余键拒绝；done 不带错误位、failed 带错误位；subdirectory 缺省空串", async () => {
  const { service, calls } = makeFake()
  await withMcp(service, async mcp => {
    expect(payload(await callTool(mcp, "start_import_netease", { url: "https://music.163.com/song?id=5264842", folderId: "1", junk: true })))
      .toEqual({ isError: true, value: "工具或参数不正确" })
    const out = payload(await callTool(mcp, "start_import_netease", { url: "https://music.163.com/song?id=5264842", folderId: "1" }))
    expect(out).toEqual({ isError: false, value: doneResult })
    expect(calls).toEqual([{ tool: "start", owner: 7, args: {
      session: "ses_owner", url: "https://music.163.com/song?id=5264842", folderId: "1", subdirectory: "" } }])
    const failed = makeFake({ start: Effect.succeed(failedResult) })
    await withMcp(failed.service, async mcp2 => {
      expect(payload(await callTool(mcp2, "start_import_netease", { url: "u", folderId: "1" })).isError).toBe(true)
    })
  })
})

test("get_metadata_netease：happy path；trackId 非正整数/多余键拒绝", async () => {
  const { service, calls } = makeFake()
  await withMcp(service, async mcp => {
    const out = payload(await callTool(mcp, "get_metadata_netease", { trackId: 42 }))
    expect(out).toEqual({ isError: false, value: infoResult })
    expect(calls).toEqual([{ tool: "info", owner: -1, args: { id: "42" } }])
    for (const bad of [{ trackId: 0 }, { trackId: -1 }, { trackId: 1.5 }, { trackId: "42" }, { trackId: 42, extra: 1 }, {}]) {
      expect(payload(await callTool(mcp, "get_metadata_netease", bad))).toEqual({ isError: true, value: "工具或参数不正确" })
    }
  })
})

test("edit_metadata_netease：只传要改的字段并透传 warnings；非法/多余 metadata 字段拒绝", async () => {
  const { service, calls } = makeFake()
  await withMcp(service, async mcp => {
    const out = payload(await callTool(mcp, "edit_metadata_netease", { trackId: 42, metadata: { title: "编辑后的标题", genre: "J-Pop", cover: "netease" } }))
    expect(out).toEqual({ isError: false, value: editedInfo })
    expect(calls).toEqual([{ tool: "edit", owner: 7, args: { id: "42", tags: { title: "编辑后的标题", genre: "J-Pop", cover: "netease" } } }])
    expect((out.value as NeteaseInfo).warnings).toEqual(["未能嵌入文件标签；保留原文件，指定的文字元数据已存入曲库。未转码。"])
    // 多余键 / 非法类型 / 越界数值 → 域 Schema 拒绝，MCP 面统一为一句可读错误
    for (const metadata of [{ title: "x", hacker: 1 }, { title: 5 }, { trackNumber: 0 }, { trackNumber: 10000 }, { title: " " }]) {
      expect(payload(await callTool(mcp, "edit_metadata_netease", { trackId: 42, metadata })))
        .toEqual({ isError: true, value: "元数据字段无效。" })
    }
    for (const bad of [{ trackId: 42 }, { trackId: 42, metadata: "x" }, { trackId: 42, metadata: [1] }, { trackId: 0, metadata: { title: "x" } }]) {
      expect(payload(await callTool(mcp, "edit_metadata_netease", bad))).toEqual({ isError: true, value: "工具或参数不正确" })
    }
  })
})

test("remove_from_library_netease：只报移出曲库，文件不动", async () => {
  const { service, calls } = makeFake()
  await withMcp(service, async mcp => {
    const out = payload(await callTool(mcp, "remove_from_library_netease", { trackId: 42 }))
    expect(out).toEqual({ isError: false, value: { trackId: 42, removedFromLibrary: true, fileDeleted: false } })
    expect(calls).toEqual([{ tool: "unindex", owner: 7, args: { id: "42" } }])
    expect(payload(await callTool(mcp, "remove_from_library_netease", { trackId: 42, keepFile: true })))
      .toEqual({ isError: true, value: "工具或参数不正确" })
  })
})

test("request_file_deletion_netease：只回人工确认链接，绝不携带 token", async () => {
  const { service, calls } = makeFake()
  await withMcp(service, async mcp => {
    const out = payload(await callTool(mcp, "request_file_deletion_netease", { trackId: 42 }))
    expect(out).toEqual({
      isError: false,
      value: {
        requestId: ticket.requestId, reviewPath: ticket.reviewPath, expiresAt: ticket.expiresAt,
        state: "awaiting_human", fileDeleted: false,
        link: `[核对并确认删除文件](${ticket.reviewPath})`,
      },
    })
    expect(Object.hasOwn(out.value as object, "token")).toBe(false)
    expect(calls).toEqual([{ tool: "request", owner: 7, args: { id: "42" } }])
    expect(payload(await callTool(mcp, "request_file_deletion_netease", { trackId: 42, confirm: true })))
      .toEqual({ isError: true, value: "工具或参数不正确" })
  })
})

test("不存在 confirm/review 类工具：任何确认语义的调用名都落在参数错误上", async () => {
  const { service } = makeFake()
  await withMcp(service, async mcp => {
    for (const name of ["confirm_file_deletion_netease", "review_deletion_netease", "delete_file_netease", "confirm_netease"]) {
      const out = payload(await callTool(mcp, name, { trackId: 42 }))
      expect(out.isError).toBe(true)
      expect(typeof out.value === "string" ? out.value : "").toContain("工具或参数不正确")
    }
    const unknownMethod = await rpc(mcp, { jsonrpc: "2.0", id: 3, method: "resources/list", params: {} })
    expect(unknownMethod.error?.code).toBe(-32601)
  })
})

test("错误映射：BadRequest 原文；导入类 NotFound→目录文案；管理类 NotFound→曲目文案；未知错误各自兜底", async () => {
  const { service } = makeFake({
    search: Effect.fail(new BadRequest({ message: "正在搜索，请稍后再试。" })),
    info: Effect.fail(notFound("netease_track", "42")),
    edit: Effect.fail(new BadRequest({ message: "已有标签修改进行中，请稍后重试。" })),
    unindex: Effect.fail(new Error("boom")),
    request: Effect.fail(notFound("netease_track", "42")),
  })
  await withMcp(service, async mcp => {
    expect(payload(await callTool(mcp, "search_netease", { query: "x" })))
      .toEqual({ isError: true, value: "正在搜索，请稍后再试。" })
    expect(payload(await callTool(mcp, "get_metadata_netease", { trackId: 42 })))
      .toEqual({ isError: true, value: "曲目不可用或不存在，请核对 trackId。" })
    expect(payload(await callTool(mcp, "edit_metadata_netease", { trackId: 42, metadata: { title: "t" } })))
      .toEqual({ isError: true, value: "已有标签修改进行中，请稍后重试。" })
    expect(payload(await callTool(mcp, "remove_from_library_netease", { trackId: 42 })))
      .toEqual({ isError: true, value: "网易云管理操作不可用，请稍后重试。" })
    expect(payload(await callTool(mcp, "request_file_deletion_netease", { trackId: 42 })))
      .toEqual({ isError: true, value: "曲目不可用或不存在，请核对 trackId。" })
  })
  const searchNotFound = makeFake({ search: Effect.fail(notFound("agent_session", "s")) })
  await withMcp(searchNotFound.service, async mcp => {
    expect(payload(await callTool(mcp, "search_netease", { query: "x" })))
      .toEqual({ isError: true, value: "目录或会话不可用，请重新查看曲库目录。" })
  })
})

test("请求体上限：>1 MiB 且 <6 MiB 的合法 edit_metadata 请求越过传输层到达业务校验与 handler", async () => {
  const { service, calls } = makeFake()
  await withMcp(service, async mcp => {
    // cover 是 domain NeteaseTags 允许的 data:image（≤5.6M 字符）；2M 字符的请求体
    // 旧 1 MiB 传输上限会在业务校验前被 413。fake edit 不触网不下载图片。
    const cover = `data:image/jpeg;base64,${"A".repeat(2 * 1024 * 1024)}`
    const out = payload(await callTool(mcp, "edit_metadata_netease", { trackId: 42, metadata: { cover } }))
    expect(out.isError).toBe(false)
    expect(out.value).toEqual(editedInfo)
    expect(String((calls[0]!.args as { tags: { cover?: string } }).tags.cover).length).toBeGreaterThan(2 * 1024 * 1024)
  })
})

test("interrupt：宿主打断按钮中止该会话 pending 的 start_import 调用", async () => {
  let aborted = false
  const hanging = Effect.promise<NeteaseImportResult>((signal) => new Promise((_, reject) => {
    signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")) }, { once: true })
  }))
  const { service, calls } = makeFake({ start: hanging })
  await withMcp(service, async mcp => {
    const pending = callTool(mcp, "start_import_netease", { url: "https://music.163.com/song?id=5264842", folderId: "1" })
    // 注册先于 await：轮询打断直到 fake 观察到中止信号
    for (let i = 0; i < 200 && !aborted; i++) { mcp.interrupt("ses_owner"); await Bun.sleep(10) }
    const out = payload(await pending)
    expect(aborted).toBe(true)
    expect(out.isError).toBe(true)
    expect(String(out.value)).toContain("网易云导入不可用")
    expect(calls[0]!.owner).toBe(7)
    // 无 pending 会话的打断是无操作
    mcp.interrupt("ses_stranger")
  })
})
