import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { BadRequest } from "../../domain/errors"
import { musicToolMetas, runMusicTool } from "./tools"

/**
 * 纯单测：入参守卫与注册表形状（不触数据库）。
 * SqlClient 以哨兵值满足类型——守卫失败路径永不触碰，误触立即抛错暴露。
 */
const sentinel = Symbol("sql-sentinel")
const provideSentinel = Effect.provideService(SqlClient.SqlClient, sentinel as never)

const flipTag = (name: string, input: unknown) =>
  Effect.runPromise(runMusicTool(name, input, { userId: 1 }).pipe(provideSentinel, Effect.flip))

describe("music 工具面：入参守卫", () => {
  test("未知工具 → BadRequest", async () => {
    const err = await flipTag("music_nope", {})
    expect(err).toBeInstanceOf(BadRequest)
    expect((err as BadRequest).message).toContain("未知工具")
  })

  test("music_search 缺 q / 空 q / 非对象 → BadRequest", async () => {
    expect((await flipTag("music_search", {}))._tag).toBe("BadRequest")
    expect((await flipTag("music_search", { q: "  " }))._tag).toBe("BadRequest")
    expect((await flipTag("music_search", "text"))._tag).toBe("BadRequest")
  })

  test("music_search type 枚举外 → BadRequest", async () => {
    expect((await flipTag("music_search", { q: "x", type: "genre" }))._tag).toBe("BadRequest")
  })

  test("music_play_now trackIds 空/非整数/超上限 → BadRequest", async () => {
    expect((await flipTag("music_play_now", { trackIds: [] }))._tag).toBe("BadRequest")
    expect((await flipTag("music_play_now", { trackIds: ["1"] }))._tag).toBe("BadRequest")
    expect((await flipTag("music_play_now", { trackIds: [1.5] }))._tag).toBe("BadRequest")
    expect((await flipTag("music_play_now", { trackIds: Array.from({ length: 501 }, (_, i) => i + 1) }))._tag)
      .toBe("BadRequest")
  })

  test("music_star trackIds 非数组 → BadRequest", async () => {
    expect((await flipTag("music_star", { trackIds: 1 }))._tag).toBe("BadRequest")
  })

  test("music_playlist_create name 缺失/超长 → BadRequest", async () => {
    expect((await flipTag("music_playlist_create", {}))._tag).toBe("BadRequest")
    expect((await flipTag("music_playlist_create", { name: "x".repeat(201) }))._tag).toBe("BadRequest")
  })
})

describe("music 工具面：注册表形状（A1 插件注册的契约）", () => {
  test("全部工具 music_ 前缀 + 描述 + object 输入 schema", () => {
    expect(musicToolMetas.length).toBe(13)
    for (const meta of musicToolMetas) {
      expect(meta.name.startsWith("music_")).toBe(true)
      expect(meta.description.length).toBeGreaterThan(8)
      expect(meta.input.type).toBe("object")
      // music_facets 无参（库词表）——properties 允许为空，但字段必须存在
      expect(meta.input.properties).toBeDefined()
    }
  })

  test("名字唯一", () => {
    const names = musicToolMetas.map((meta) => meta.name)
    expect(new Set(names).size).toBe(names.length)
  })

  test("播放类工具带 clientAction 标记（A2 确认卡片依据）", () => {
    const actions = new Map(
      musicToolMetas.filter((m) => m.clientAction !== undefined).map((m) => [m.name, m.clientAction]),
    )
    expect(actions.get("music_play_now")).toBe("play-now")
    expect(actions.get("music_enqueue")).toBe("enqueue")
    expect(actions.size).toBe(2)
  })
})
