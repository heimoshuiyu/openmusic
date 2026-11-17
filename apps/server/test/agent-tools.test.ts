import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Context, Effect, Layer, Redacted, Scope } from "effect"
import { PgClient } from "@effect/sql-pg"
import { SqlClient } from "effect/unstable/sql"
import { Pool } from "pg"
import { migrateTestDb, TEST_DB_URL, truncateDomainTables } from "./helpers"
import { PlayRepo } from "../src/repo/annotations"
import { PlaylistRepo } from "../src/repo/playlists"
import { runMusicTool } from "../src/service/agent/tools"

/**
 * music 工具面集成测试（A0，docs/08 §6）：真库跑通「解析 → repo → 投影」全链。
 * 直接 SQL 造最小库（不走扫描器——工具面只依赖 repo 层，与媒体文件无关）。
 */
const TestPg = PgClient.layer({ url: Redacted.make(TEST_DB_URL) })

let context: Context.Context<SqlClient.SqlClient> | undefined
let dispose: () => Promise<unknown> = async () => {}

const run = <A, E>(fx: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(Effect.provide(fx, context!))
const runFlip = <A, E>(fx: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(Effect.flip(Effect.provide(fx, context!)))

const userA = 1 // seed 顺序决定：agent-a 先插
const userB = 2
let albumId = ""
let alphaId = 0
let betaId = 0
let gammaId = 0
let bPlaylistId = 0

beforeAll(async () => {
  await migrateTestDb()
  await truncateDomainTables(true)

  const pool = new Pool({ connectionString: TEST_DB_URL })
  try {
    const one = async (query: string): Promise<Record<string, unknown>> =>
      (await pool.query(query)).rows[0] as Record<string, unknown>
    await pool.query(
      `insert into users (username, password_hash, subsonic_token_seed) values
        ('agent-a', 'x', 'x'), ('agent-b', 'x', 'x')`,
    )
    const folder = await one(`insert into music_folders (path, name) values ('/agent-test', 'agent-test') returning id`)
    const artist = await one(`insert into artists (name) values ('Miku Agent') returning id`)
    const album = await one(
      `insert into albums (artist_id, name, year, genre) values (${artist.id}, 'Tool Songs', 2026, 'Test') returning id`,
    )
    albumId = String(album.id)
    const track = (n: number, title: string, secs: number) =>
      pool.query(
        `insert into tracks (music_folder_id, album_id, artist_id, disc, track_no, title,
           duration_seconds, format, codec, size_bytes, path, mtime_ms)
         values (${folder.id}, ${album.id}, ${artist.id}, 1, ${n}, '${title}',
           ${secs}, 'flac', 'flac', 1000, 't${n}.flac', 0) returning id`,
      )
    alphaId = Number((await track(1, "Alpha Song", 100)).rows[0]!.id)
    betaId = Number((await track(2, "Beta Song", 200)).rows[0]!.id)
    gammaId = Number((await track(3, "Gamma Song", 300)).rows[0]!.id)
    bPlaylistId = Number(
      (await pool.query(`insert into playlists (owner_user_id, name) values (${userB}, 'B List') returning id`)).rows[0]!
        .id,
    )
  } finally {
    await pool.end()
  }

  // 共享一个 PgClient layer context（等价 test/effect.ts 的 layer() 外壳）
  const scope = Effect.runSync(Scope.make())
  context = await Effect.runPromise(
    Layer.buildWithScope(TestPg as unknown as Layer.Layer<SqlClient.SqlClient>, scope) as Effect.Effect<
      Context.Context<SqlClient.SqlClient>,
      never,
      never
    >,
  )
  dispose = () => Effect.runPromise(Scope.close(scope, Effect.void as never))
})

afterAll(async () => {
  await dispose()
})

describe("music 工具面（真库）", () => {
  test("music_search：标题命中 + 精简投影", async () => {
    const out = (await run(runMusicTool("music_search", { q: "Alpha" }, { userId: userA }))) as {
      tracks: Array<{ id: string; title: string; artist: string; album: string; durationSeconds: number }>
      albums: unknown[]
      artists: unknown[]
    }
    expect(out.tracks.map((t) => t.title)).toEqual(["Alpha Song"])
    expect(out.tracks[0]!.artist).toBe("Miku Agent")
    expect(out.tracks[0]!.album).toBe("Tool Songs")
    expect(out.albums).toHaveLength(0)
    expect(out.artists).toHaveLength(0)
  })

  test("music_facets：库词表（genre/年代清洗/top 艺人）", async () => {
    const out = (await run(runMusicTool("music_facets", {}, { userId: userA }))) as {
      genres: Array<{ genre: string; albums: number }>
      decades: Array<{ decade: number; albums: number }>
      topArtists: Array<{ name: string; albums: number }>
    }
    expect(out.genres.some((g) => g.genre === "Test")).toBe(true)
    expect(out.decades).toEqual([{ decade: 2020, albums: 1 }])
    expect(out.topArtists[0]!.name).toBe("Miku Agent")
  })

  test("music_search：结构化过滤（q 省略 + genre/year）", async () => {
    const out = (await run(
      runMusicTool("music_search", { genre: "Test", yearFrom: 2020, yearTo: 2030 }, { userId: userA }),
    )) as { tracks: Array<{ title: string }> }
    expect(out.tracks.map((t) => t.title)).toEqual(["Alpha Song", "Beta Song", "Gamma Song"])
  })

  test("music_search：artistId 过滤 + sortBy=plays（口味排序）", async () => {
    const artistOut = (await run(runMusicTool("music_search", { q: "Miku" }, { userId: userA }))) as {
      artists: Array<{ id: string; name: string }>
    }
    expect(artistOut.artists[0]!.name).toBe("Miku Agent")
    const out = (await run(
      runMusicTool("music_search", { artistId: artistOut.artists[0]!.id, sortBy: "plays" }, { userId: userA }),
    )) as { tracks: Array<{ title: string }> }
    expect(out.tracks).toHaveLength(3)
  })

  test("music_search：过滤守卫（无 q 无过滤 → BadRequest；过滤配 type≠track → BadRequest）", async () => {
    const err1 = await runFlip(runMusicTool("music_search", {}, { userId: userA }))
    expect((err1 as { message: string }).message).toContain("至少给一个过滤条件")
    const err2 = await runFlip(
      runMusicTool("music_search", { q: "Alpha", genre: "Test", type: "album" }, { userId: userA }),
    )
    expect((err2 as { message: string }).message).toContain("type 不能是 album/artist")
  })

  test("music_album_tracks：canonical 口径 + 碟内顺序", async () => {
    const out = (await run(runMusicTool("music_album_tracks", { albumId }, { userId: userA }))) as {
      tracks: Array<{ title: string }>
    }
    expect(out.tracks.map((t) => t.title)).toEqual(["Alpha Song", "Beta Song", "Gamma Song"])  })

  test("music_album_tracks：专辑不存在 → NotFound", async () => {
    const err = await runFlip(runMusicTool("music_album_tracks", { albumId: "999999" }, { userId: userA }))
    expect(err._tag).toBe("NotFound")
  })

  test("music_random：数量受控", async () => {
    const out = (await run(runMusicTool("music_random", { count: 2 }, { userId: userA }))) as {
      tracks: unknown[]
    }
    expect(out.tracks).toHaveLength(2)
  })

  test("music_recent_plays / music_most_played：事实日志取数", async () => {
    // 造播放事实（10s 去重窗口 → 时间戳拉开）
    const t0 = Date.now() - 60 * 60 * 1000
    await run(PlayRepo.record(userA, alphaId, new Date(t0), 100))
    await run(PlayRepo.record(userA, betaId, new Date(t0 + 60_000), 200))
    await run(PlayRepo.record(userA, alphaId, new Date(t0 + 120_000), 100))

    const recent = (await run(runMusicTool("music_recent_plays", { limit: 10 }, { userId: userA }))) as {
      plays: Array<{ trackId: number | null; title: string }>
    }
    expect(recent.plays).toHaveLength(3)
    expect(recent.plays[0]!.title).toBe("Alpha Song") // 最近一次

    const page = (offset: number, distinct?: "track", userId = userA) =>
      run(runMusicTool("music_recent_plays", {limit: 1, offset, distinct}, {userId})) as Promise<{
        plays: typeof recent.plays; nextOffset: number | null
      }>
    expect((await page(2)).plays[0]?.title).toBe("Alpha Song") // earlier play of the same track
    const first = await page(0, "track")
    expect(first.plays).toEqual(recent.plays.slice(0, 1))
    expect(first.nextOffset).toBe(1)
    const last = await page(first.nextOffset!, "track")
    expect(last.plays).toEqual(recent.plays.slice(1, 2))
    expect(last.nextOffset).toBeNull() // exactly one full final page
    expect(await page(2, "track")).toEqual({plays: [], nextOffset: null})
    expect(await page(0, "track", userB)).toEqual({plays: [], nextOffset: null})
    for (const invalid of [{offset:-1}, {offset:1.5}, {distinct:"title"}]) {
      expect((await runFlip(runMusicTool("music_recent_plays", invalid, {userId:userA})))._tag).toBe("BadRequest")
    }

    const tracks = (await run(runMusicTool("music_most_played", { type: "track" }, { userId: userA }))) as {
      items: Array<{ id: string; playCount: number; title: string }>
    }
    expect(tracks.items[0]!.title).toBe("Alpha Song")
    expect(tracks.items[0]!.playCount).toBe(2)

    const artists = (await run(runMusicTool("music_most_played", { type: "artist" }, { userId: userA }))) as {
      items: Array<{ name: string; playCount: number }>
    }
    expect(artists.items[0]!.name).toBe("Miku Agent")
    expect(artists.items[0]!.playCount).toBe(3)
  })

  test("music_star / music_favorites：收藏往返（canonical 归一在 repo 内）", async () => {
    const empty = (await run(runMusicTool("music_favorites", {}, { userId: userA }))) as { items: unknown[] }
    expect(empty.items).toHaveLength(0)

    await run(runMusicTool("music_star", { trackIds: [alphaId] }, { userId: userA }))
    const starred = (await run(runMusicTool("music_favorites", {}, { userId: userA }))) as {
      items: Array<{ id: string; title: string }>
    }
    expect(starred.items.map((t) => t.title)).toEqual(["Alpha Song"])

    await run(runMusicTool("music_star", { trackIds: [alphaId], starred: false }, { userId: userA }))
    const cleared = (await run(runMusicTool("music_favorites", {}, { userId: userA }))) as { items: unknown[] }
    expect(cleared.items).toHaveLength(0)
  })

  test("music_playlist_create / add：建表灌曲 + 计数", async () => {
    const created = (await run(
      runMusicTool("music_playlist_create", { name: "Agent List", trackIds: [alphaId, gammaId] }, { userId: userA }),
    )) as { playlistId: string; trackCount: number }
    expect(created.trackCount).toBe(2)

    const added = (await run(
      runMusicTool("music_playlist_add", { playlistId: Number(created.playlistId), trackIds: [betaId] }, { userId: userA }),
    )) as { addedCount: number }
    expect(added.addedCount).toBe(1)

    const row = await run(PlaylistRepo.byId(Number(created.playlistId)))
    expect(row.ownerUserId).toBe(userA)
    expect(row.songCount).toBe(3)
  })

  test("music_playlist_add：他人列表 → Forbidden（写类工具按属主鉴权）", async () => {
    const err = await runFlip(
      runMusicTool("music_playlist_add", { playlistId: bPlaylistId, trackIds: [alphaId] }, { userId: userA }),
    )
    expect(err._tag).toBe("Forbidden")
  })

  test("music_playlist_create：曲目不存在 → BadRequest 且不留空壳列表", async () => {
    const before = await run(PlaylistRepo.listFor(userA))
    const err = await runFlip(
      runMusicTool("music_playlist_create", { name: "Broken", trackIds: [999999] }, { userId: userA }),
    )
    expect(err._tag).toBe("BadRequest")
    const after = await run(PlaylistRepo.listFor(userA))
    expect(after.length).toBe(before.length)
  })

  test("music_play_now：按请求顺序解析 + clientAction 标记；坏 id → BadRequest", async () => {
    const out = (await run(
      runMusicTool("music_play_now", { trackIds: [gammaId, alphaId] }, { userId: userA }),
    )) as { action: string; tracks: Array<{ title: string }> }
    expect(out.action).toBe("play-now")
    expect(out.tracks.map((t) => t.title)).toEqual(["Gamma Song", "Alpha Song"])

    const err = await runFlip(runMusicTool("music_play_now", { trackIds: [alphaId, 999999] }, { userId: userA }))
    expect(err._tag).toBe("BadRequest")
  })

  test("music_enqueue：position 透传", async () => {
    const out = (await run(
      runMusicTool("music_enqueue", { trackIds: [betaId], position: "next" }, { userId: userA }),
    )) as { action: string; position: string }
    expect(out.action).toBe("enqueue")
    expect(out.position).toBe("next")
  })
})
