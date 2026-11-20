/**
 * 集成测试：进程内 web handler + 真实 Postgres（openmusic_test 库）+ ffmpeg fixture。
 *
 * 前置：podman compose up -d db && podman exec openmusic-db createdb -U openmusic openmusic_test
 * 运行：bun test apps/server/test
 *
 * 用例按顺序共享状态（同一 handler/数据库），覆盖：
 * 认证 → 扫描 → 浏览/搜索 → 收藏/评分/播放记录 → 播放列表 → 媒体流/转码/封面
 * → Subsonic 兼容层 → 权限隔离 → 增量扫描 diff → 登出
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Context } from "effect"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { Pool } from "pg"
import {
  ADMIN,
  TEST_DB_URL,
  TestServer,
  buildFixture,
  migrateTestDb,
  startServer,
  truncateDomainTables,
} from "./helpers"

let server: TestServer
let fixtureRoot: string
let dispose: () => Promise<void>
let scaleRoot: string
let scaleFolderId: string

beforeAll(async () => {
  await migrateTestDb()
  // 全清（含 users）：dataDir 每次随机 → secret.key 每次不同 →
  // 必须让 bootstrap 用本次密钥重建 admin，否则 Subsonic 密文认证解不开
  await truncateDomainTables(true)
  const started = await startServer()
  server = new TestServer(started.handler)
  dispose = started.dispose
  // toWebHandler 惰性构建：预热触发管理员 bootstrap
  const warmup = await server.get("/api/v1/system/health")
  if (warmup.status !== 200) {
    throw new Error(`server warmup failed: ${warmup.status}（检查 openmusic_test 库是否已创建）`)
  }
  fixtureRoot = await buildFixture()
})

afterAll(async () => {
  await dispose()
  await fs.rm(fixtureRoot, { recursive: true, force: true }).catch(() => {})
})

describe("系统与认证", () => {
  test("health/version 开放访问", async () => {
    expect((await server.get("/api/v1/system/health")).status).toBe(200)
    expect((await server.get("/api/v1/system/version")).status).toBe(200)
  })

  test("未登录访问受保护端点 → 401", async () => {
    const saved = server.cookie
    server.cookie = null
    expect((await server.get("/api/v1/artists")).status).toBe(401)
    expect((await server.get("/api/v1/tracks/1/stream")).status).toBe(401)
    server.cookie = saved
  })

  test("错误密码 → 401；正确登录拿到会话", async () => {
    const saved = server.cookie
    server.cookie = null
    const bad = await server.call("POST", "/api/v1/auth/login", {
      body: { username: ADMIN.username, password: "wrong" },
      cookie: null,
    })
    expect(bad.status).toBe(401)
    await server.login()
    expect(server.cookie).toBeTruthy()
    const me = await server.get("/api/v1/auth/me")
    expect(me.status).toBe(200)
    expect((me.body as { username: string }).username).toBe(ADMIN.username)
    void saved
  })

  test("agent API：未启用（AGENT_ENABLED=false）→ 503，SSE 同样", async () => {
    expect((await server.post("/api/v1/agent/sessions", { title: "x" })).status).toBe(503)
    expect((await server.get("/api/v1/agent/sessions")).status).toBe(503)
    expect((await server.get("/api/v1/agent/events")).status).toBe(503)
  })
})

describe("音乐库与扫描", () => {
  test("添加文件夹并触发扫描（CJK 元数据 + 物化计数）", async () => {
    const created = await server.post("/api/v1/music-folders", {
      name: "Fixture",
      path: fixtureRoot,
    })
    expect(created.status).toBe(200)
    const folderId = (created.body as { id: string }).id
    expect(folderId).toBe("1")

    expect((await server.post("/api/v1/library/scan")).status).toBe(204)
    await server.waitScanIdle()

    const artists = (await server.get("/api/v1/artists?limit=50")).body as {
      items: Array<{ id: string; name: string; albumCount: number; trackCount: number }>
      total: number
    }
    expect(artists.total).toBe(3) // Artist A / 芸坊 / 芸坊 feat. 初音ミク
    const genFang = artists.items.find((artist) => artist.name === "芸坊")!
    expect(genFang.albumCount).toBe(1)
    expect(genFang.trackCount).toBe(1) // album_artist 维度的曲目数

    const albums = (await server.get("/api/v1/albums?limit=50")).body as {
      items: Array<{ name: string; trackCount: number; year: number | null; genre: string | null; hasCoverArt: boolean }>
      total: number
    }
    expect(albums.total).toBe(2)
    const yuuyue = albums.items.find((album) => album.name === "雨月")!
    expect(yuuyue.trackCount).toBe(2)
    expect(yuuyue.year).toBe(2023)
    expect(yuuyue.hasCoverArt).toBe(true) // 内嵌封面

    const tracks = (await server.get("/api/v1/tracks?limit=50")).body as {
      items: Array<{ id: string; title: string; codec: string }>
      total: number
    }
    expect(tracks.total).toBe(3)
    expect(tracks.items.map((track) => track.title).sort()).toEqual(["Song One", "無題", "雨月之歌"])

    const genres = (await server.get("/api/v1/genres")).body as Array<{ name: string }>
    expect(genres.map((genre) => genre.name).sort()).toEqual(["Ambient", "Rock"])
  })

  test("重复扫描增量（无变化 → processed=0）", async () => {
    await server.post("/api/v1/library/scan")
    await server.waitScanIdle()
    const status = (await server.get("/api/v1/library/scan-status")).body as {
      total: number
      processed: number
    }
    expect(status.total).toBe(3)
    expect(status.processed).toBe(0)
  })

  test("删除文件 → 扫描后曲目减少、孤儿清理", async () => {
    await fs.rm(path.join(fixtureRoot, "Artist A/2021 - Album One/01 - Song One.mp3"))
    await server.post("/api/v1/library/scan")
    await server.waitScanIdle()
    const tracks = (await server.get("/api/v1/tracks?limit=50")).body as { total: number }
    expect(tracks.total).toBe(2)
    const artists = (await server.get("/api/v1/artists")).body as { total: number }
    expect(artists.total).toBe(2) // Artist A 无曲目后被清理
  })

  test("无效文件夹路径 → 422", async () => {
    const bad = await server.post("/api/v1/music-folders", { name: "X", path: "relative/path" })
    expect(bad.status).toBe(422)
  })
})

describe("浏览与搜索", () => {
  test("艺人详情 / 专辑详情 / 曲目详情 404 语义", async () => {
    const artists = (await server.get("/api/v1/artists")).body as { items: Array<{ id: string; name: string }> }
    const genFang = artists.items.find((artist) => artist.name === "芸坊")!
    const detail = await server.get(`/api/v1/artists/${genFang.id}`)
    expect(detail.status).toBe(200)
    const albums = (await server.get(`/api/v1/artists/${genFang.id}/albums`)).body as {
      items: Array<{ id: string }>
    }
    const albumTracks = await server.get(`/api/v1/albums/${albums.items[0]!.id}/tracks`)
    expect((albumTracks.body as Array<{ title: string }>).map((track) => track.title)).toEqual([
      "雨月之歌",
      "無題",
    ])
    expect((await server.get("/api/v1/tracks/99999")).status).toBe(404)
  })

  test("search CJK 命中三路", async () => {
    const search = (await server.get(`/api/v1/search?q=${encodeURIComponent("雨月")}`)).body as {
      artists: unknown[]
      albums: Array<{ name: string }>
      tracks: Array<{ title: string }>
      albumCount: number
      trackCount: number
    }
    expect(search.albumCount).toBe(1)
    expect(search.albums[0]?.name).toBe("雨月")
    expect(search.tracks.map((track) => track.title)).toContain("雨月之歌")
  })

  test("random 与排序参数", async () => {
    const random = (await server.get("/api/v1/random?count=2")).body as Array<{ id: string }>
    expect(random).toHaveLength(2)
    const sorted = (await server.get("/api/v1/tracks?sort=-createdAt&limit=2")).body as {
      items: Array<{ createdAt: string }>
    }
    expect(new Date(sorted.items[0]!.createdAt).getTime()).toBeGreaterThanOrEqual(
      new Date(sorted.items[1]!.createdAt).getTime(),
    )
  })
})

describe("收藏 / 评分 / 播放记录", () => {
  test("收藏 → 列表 → 取消", async () => {
    const tracks = (await server.get("/api/v1/tracks")).body as { items: Array<{ id: string }> }
    const trackId = tracks.items[0]!.id
    expect((await server.put(`/api/v1/favorites/tracks/${trackId}`)).status).toBe(204)
    // starred 态随第一方查询下发（红心在列表页就能亮的取数保证）
    const detail = (await server.get(`/api/v1/tracks/${trackId}`)).body as { starred?: string }
    expect(typeof detail.starred).toBe("string")
    const favorites = (await server.get("/api/v1/favorites")).body as { items: Array<{ id: string }> }
    expect(favorites.items.map((track) => track.id)).toContain(trackId)
    expect((await server.del(`/api/v1/favorites/tracks/${trackId}`)).status).toBe(204)
    const after = (await server.get("/api/v1/favorites")).body as { items: unknown[] }
    expect(after.items).toHaveLength(0)
    const cleared = (await server.get(`/api/v1/tracks/${trackId}`)).body as { starred?: string }
    expect(cleared.starred).toBeUndefined()
  })

  test("播放上报 → 最近播放 / listenedSeconds / 10s 去重 / 统计 / most-played", async () => {
    const tracks = (await server.get("/api/v1/tracks")).body as {
      items: Array<{ id: string; title: string; durationSeconds: number }>
    }
    // 用 無題（items[1]）：雨月之歌 是后面 Subsonic scrobble 测试的目标，避开跨测试去重串扰
    const t = tracks.items[1]!
    expect((await server.post(`/api/v1/plays/${t.id}`, { listenedSeconds: 100 })).status).toBe(204)
    // 10s 窗口内同曲目重复上报被去重
    await server.post(`/api/v1/plays/${t.id}`, {})
    // 不带 listenedSeconds → 统计按曲目时长兜底；scrobble 带 time（60s 前，去重窗口外）
    await server.subsonic("scrobble", `&id=${t.id}&time=${Math.floor(Date.now() / 1000) - 60}`)

    const recent = (await server.get("/api/v1/plays/recent")).body as Array<{ track: { id: string } }>
    expect(recent[0]?.track.id).toBe(t.id)

    const summary = (await server.get("/api/v1/plays/summary")).body as {
      plays: number
      tracks: number
      listenedSeconds: number
    }
    expect(summary.plays).toBe(2)
    expect(summary.tracks).toBe(1)
    expect(summary.listenedSeconds).toBe(100 + t.durationSeconds)

    const mpTrack = (await server.get("/api/v1/plays/most-played?type=track")).body as Array<{
      kind: string
      track: { id: string }
      playCount: number
      listenedSeconds: number
    }>
    expect(mpTrack).toHaveLength(1)
    expect(mpTrack[0]?.track.id).toBe(t.id)
    expect(mpTrack[0]?.playCount).toBe(2)
    expect(mpTrack[0]?.listenedSeconds).toBe(100 + t.durationSeconds)
    expect(mpTrack[0]?.kind).toBe("track")

    const mpAlbum = (await server.get("/api/v1/plays/most-played?type=album")).body as Array<{
      kind: string
      album: { id: string }
    }>
    expect(mpAlbum).toHaveLength(1)
    expect(mpAlbum[0]?.kind).toBe("album")

    // period：40 天前的补报只进 all 不进 month
    await server.subsonic("scrobble", `&id=${t.id}&time=${Math.floor(Date.now() / 1000) - 40 * 24 * 3600}`)
    const count = async (period: string) => {
      const body = (await server.get(`/api/v1/plays/most-played?type=track${period}`)).body as Array<{
        track: { id: string }
        playCount: number
      }>
      return body.find((item) => item.track.id === t.id)?.playCount
    }
    expect(await count("&period=month")).toBe(2)
    expect(await count("")).toBe(3)

    const mpArtist = (await server.get("/api/v1/plays/most-played?type=artist")).body as Array<{
      kind: string
      artist: { id: string }
      playCount: number
    }>
    expect(mpArtist).toHaveLength(1)
    expect(mpArtist[0]?.kind).toBe("artist")
    expect(mpArtist[0]?.playCount).toBe(3)
  })

  test("首页最近播放先按曲目去重，再取最近 N 首；原始事件仍保留", async () => {
    const { items } = (await server.get("/api/v1/tracks")).body as { items: Array<{ id: string }> }
    const older = items[0]!.id, repeated = items[1]!.id
    await server.subsonic("scrobble", `&id=${older}&time=${Math.floor(Date.now() / 1000) - 300}`)
    type Entry = { track: { id: string }; playedAt: string }
    const events = (await server.get("/api/v1/plays/recent?limit=2")).body as Entry[]
    expect(events.map(e => e.track.id)).toEqual([repeated, repeated])
    const unique = (await server.get("/api/v1/plays/recent?distinct=track&limit=2")).body as Entry[]
    expect(unique.map(e => e.track.id)).toEqual([repeated, older])
    expect(unique[0]?.playedAt).toBe(events[0]?.playedAt)
    const page = async (offset: number, distinct = false) =>
      (await server.get(`/api/v1/plays/recent?limit=1&offset=${offset}${distinct ? "&distinct=track" : ""}`)).body
    expect(await page(1)).toEqual(events.slice(1))
    expect(await page(1, true)).toEqual(unique.slice(1))
    expect(await page(2, true)).toEqual([])
    for (const offset of [-1, 0.5]) {
      const {status} = await server.get(`/api/v1/plays/recent?offset=${offset}`)
      expect(status).toBeGreaterThanOrEqual(400)
      expect(status).toBeLessThan(500)
    }
  })
})

describe("播放列表", () => {
  test("创建 → 加歌 → 顺序 → 移除 → 改名 → 删除", async () => {
    const created = await server.post("/api/v1/playlists", { name: "集成测试列表" })
    expect(created.status).toBe(200)
    const playlist = created.body as { id: string }
    const tracks = (await server.get("/api/v1/tracks")).body as { items: Array<{ id: string }> }
    const ids = tracks.items.map((track) => track.id)

    expect((await server.post(`/api/v1/playlists/${playlist.id}/tracks`, { trackIds: ids })).status).toBe(204)
    let list = (await server.get(`/api/v1/playlists/${playlist.id}/tracks`)).body as Array<{ id: string }>
    expect(list.map((track) => track.id)).toEqual(ids)

    expect((await server.del(`/api/v1/playlists/${playlist.id}/tracks/0`)).status).toBe(204)
    list = (await server.get(`/api/v1/playlists/${playlist.id}/tracks`)).body as Array<{ id: string }>
    expect(list.map((track) => track.id)).toEqual(ids.slice(1))

    const reversed = [...list.map((track) => track.id)].reverse()
    expect((await server.patch(`/api/v1/playlists/${playlist.id}/tracks`, { order: reversed })).status).toBe(204)
    list = (await server.get(`/api/v1/playlists/${playlist.id}/tracks`)).body as Array<{ id: string }>
    expect(list.map((track) => track.id)).toEqual(reversed)

    const renamed = await server.patch(`/api/v1/playlists/${playlist.id}`, { name: "改名后" })
    expect((renamed.body as { name: string }).name).toBe("改名后")

    expect((await server.del(`/api/v1/playlists/${playlist.id}`)).status).toBe(204)
    expect((await server.get(`/api/v1/playlists/${playlist.id}`)).status).toBe(404)
  })
})

describe("媒体流", () => {
  test("直传 flac（magic bytes）+ Range 206", async () => {
    const tracks = (await server.get("/api/v1/tracks")).body as { items: Array<{ id: string; codec: string }> }
    const flac = tracks.items.find((track) => track.codec === "flac")!
    const direct = await server.get(`/api/v1/tracks/${flac.id}/stream`)
    expect(direct.status).toBe(200)
    expect(direct.headers.get("content-type")).toBe("audio/flac")
    expect(direct.headers.get("content-length")).toBe(String(direct.raw.byteLength))
    expect(new Uint8Array(direct.raw.slice(0, 4))).toEqual(new Uint8Array([0x66, 0x4c, 0x61, 0x43])) // fLaC

    const ranged = await server.call("GET", `/api/v1/tracks/${flac.id}/stream`, {
      headers: { range: "bytes=0-99" },
    })
    expect(ranged.status).toBe(206)
    expect(ranged.raw.byteLength).toBe(100)
    expect(ranged.headers.get("content-length")).toBe("100")
    expect(ranged.headers.get("content-range")).toMatch(/^bytes 0-99\/\d+$/)
  })

  test("后缀 Range（bytes=-50）→ 206 且为最后 50 字节", async () => {
    const tracks = (await server.get("/api/v1/tracks")).body as { items: Array<{ id: string; codec: string }> }
    const flac = tracks.items.find((track) => track.codec === "flac")!
    const full = await server.get(`/api/v1/tracks/${flac.id}/stream`)
    const suffix = await server.call("GET", `/api/v1/tracks/${flac.id}/stream`, {
      headers: { range: "bytes=-50" },
    })
    expect(suffix.status).toBe(206)
    expect(suffix.raw.byteLength).toBe(50)
    expect(new Uint8Array(suffix.raw)).toEqual(new Uint8Array(full.raw.slice(-50)))
  })

  test("finite media keeps an explicit byte length over an actual Bun HTTP connection", async () => {
    const tracks=(await server.get('/api/v1/tracks')).body as {items:{id:string;codec:string}[]}
    const id=tracks.items.find(t=>t.codec==='flac')!.id
    const http=Bun.serve({hostname:'127.0.0.1',port:0,fetch:req=>server.handler(req,Context.empty() as Context.Context<unknown>)})
    try {
      const url=new URL(`/api/v1/tracks/${id}/stream`,http.url), cookie=server.cookie!
      const full=await fetch(url,{headers:{cookie}}), bytes=await full.arrayBuffer()
      expect(full.status).toBe(200); expect(full.headers.get('content-length')).toBe(String(bytes.byteLength))
      const tail=await fetch(url,{headers:{cookie,range:'bytes=-1024'}})
      expect(tail.status).toBe(206); expect(tail.headers.get('content-length')).toBe('1024')
      expect(new Uint8Array(await tail.arrayBuffer())).toEqual(new Uint8Array(bytes.slice(-1024)))
    } finally {await http.stop(true)}
  })

  test("转码 flac→mp3（ID3 头）与缓存命中", async () => {
    const tracks = (await server.get("/api/v1/tracks")).body as { items: Array<{ id: string; codec: string }> }
    const flac = tracks.items.find((track) => track.codec === "flac")!
    const first = await server.get(`/api/v1/tracks/${flac.id}/stream?format=mp3&maxBitRate=96`)
    expect(first.status).toBe(200)
    expect(first.headers.get("content-type")).toBe("audio/mpeg")
    expect(new Uint8Array(first.raw.slice(0, 3))).toEqual(new Uint8Array([0x49, 0x44, 0x33])) // ID3
    const second = await server.get(`/api/v1/tracks/${flac.id}/stream?format=mp3&maxBitRate=96`)
    expect(second.raw.byteLength).toBe(first.raw.byteLength)
  })

  test("timeOffset 断点续播：转码/raw 拷贝都从偏移起，且不读不写缓存", async () => {
    const tracks = (await server.get("/api/v1/tracks")).body as {
      items: Array<{ id: string; codec: string; durationSeconds: number }>
    }
    const flac5 = tracks.items.find((t) => t.codec === "flac" && t.durationSeconds >= 5)!

    // 解码实测时长——流拷贝不重写 STREAMINFO，ffprobe 的 format duration 会是全长，不能信
    const decodedSeconds = async (raw: ArrayBuffer): Promise<number> => {
      const proc = Bun.spawn(["ffmpeg", "-v", "info", "-i", "pipe:0", "-f", "null", "-"], {
        stdin: "pipe",
        stderr: "pipe",
      })
      proc.stdin.write(new Uint8Array(raw))
      await proc.stdin.end()
      const stderr = await new Response(proc.stderr).text()
      await proc.exited
      const times = [...stderr.matchAll(/time=(\d+):(\d+):(\d+\.\d+)/g)]
      const last = times.at(-1)!
      return Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3])
    }

    // 全长转码（缓存基础）
    const full = await server.get(`/api/v1/tracks/${flac5.id}/stream?format=mp3&maxBitRate=96`)
    expect(full.status).toBe(200)
    expect(await decodedSeconds(full.raw)).toBeGreaterThan(4.4)

    // 转码 + timeOffset=2 → 从 2s 起
    const offsetTranscode = await server.get(
      `/api/v1/tracks/${flac5.id}/stream?format=mp3&maxBitRate=96&timeOffset=2`,
    )
    expect(offsetTranscode.status).toBe(200)
    expect(new Uint8Array(offsetTranscode.raw.slice(0, 3))).toEqual(new Uint8Array([0x49, 0x44, 0x33])) // ID3
    expect(await decodedSeconds(offsetTranscode.raw)).toBeGreaterThan(2.4)
    expect(await decodedSeconds(offsetTranscode.raw)).toBeLessThan(3.6)

    // raw + timeOffset=2 → fLaC 流拷贝（无转码）
    const offsetRaw = await server.get(`/api/v1/tracks/${flac5.id}/stream?timeOffset=2`)
    expect(offsetRaw.status).toBe(200)
    expect(offsetRaw.headers.get("content-type")).toBe("audio/flac")
    expect(new Uint8Array(offsetRaw.raw.slice(0, 4))).toEqual(new Uint8Array([0x66, 0x4c, 0x61, 0x43])) // fLaC
    expect(await decodedSeconds(offsetRaw.raw)).toBeGreaterThan(2.4)
    expect(await decodedSeconds(offsetRaw.raw)).toBeLessThan(3.6)

    // 断点流不得污染缓存：无 offset 的请求仍拿到完整转码产物
    const after = await server.get(`/api/v1/tracks/${flac5.id}/stream?format=mp3&maxBitRate=96`)
    expect(after.raw.byteLength).toBe(full.raw.byteLength)
  })

  test("download 与封面（内嵌封面惰性提取为 JPEG）", async () => {
    const tracks = (await server.get("/api/v1/tracks")).body as { items: Array<{ id: string; album: { id: string } }> }
    const track = tracks.items[0]!
    const download = await server.get(`/api/v1/tracks/${track.id}/download`)
    expect(download.status).toBe(200)
    expect(download.headers.get("content-disposition")).toContain("attachment")

    const cover = await server.get(`/api/v1/covers/al-${track.album.id}`)
    expect(cover.status).toBe(200)
    expect(cover.headers.get("content-type")).toBe("image/jpeg")
    expect(new Uint8Array(cover.raw.slice(0, 2))).toEqual(new Uint8Array([0xff, 0xd8])) // JPEG SOI
  })
})

describe("Subsonic 兼容层", () => {
  test("ping：token / 错 token 40 / legacy 明文 / enc:hex", async () => {
    const okResponse = await server.subsonic("ping")
    expect((okResponse.body as { "subsonic-response": { status: string; openSubsonic: boolean } })["subsonic-response"].status).toBe("ok")

    const salt = "testsalt"
    const badToken = Bun.CryptoHasher.hash("md5", "wrong" + salt, "hex") as string
    const bad = await server.get(`/rest/ping.view?u=admin&t=${badToken}&s=${salt}&v=1.13.0&c=T&f=json`)
    expect((bad.body as { "subsonic-response": { error: { code: number } } })["subsonic-response"].error.code).toBe(40)

    const plain = await server.get(`/rest/ping.view?u=${ADMIN.username}&p=${ADMIN.password}&v=1.13.0&c=T&f=json`)
    expect((plain.body as { "subsonic-response": { status: string } })["subsonic-response"].status).toBe("ok")

    const hex = Bun.CryptoHasher.hash("md5", ADMIN.password, "hex") as string
    const enc = await server.get(`/rest/ping.view?u=${ADMIN.username}&p=enc:${hex}&v=1.13.0&c=T&f=json`)
    expect((enc.body as { "subsonic-response": { status: string } })["subsonic-response"].status).toBe("ok")
  })

  test("浏览：getArtists 分组 / getArtist / getAlbum / getSong / getAlbumList2 / getGenres", async () => {
    const artists = (await server.subsonic("getArtists")).body as {
      "subsonic-response": { artists: { index: Array<{ name: string; artist: Array<{ id: string; name: string }> }> } }
    }
    const index = artists["subsonic-response"].artists.index
    expect(index.some((group) => group.name === "#")).toBeTrue() // CJK 归 #
    const genFang = index.flatMap((group) => group.artist).find((artist) => artist.name === "芸坊")!

    const artist = (await server.subsonic("getArtist", `&id=${genFang.id}`)).body as {
      "subsonic-response": { artist: { album: Array<{ id: string; songCount: number }> } }
    }
    const album = artist["subsonic-response"].artist.album[0]!
    expect(album.songCount).toBe(2)

    const albumDetail = (await server.subsonic("getAlbum", `&id=${album.id}`)).body as {
      "subsonic-response": { album: { song: Array<{ title: string; suffix: string; contentType: string }> } }
    }
    const songs = albumDetail["subsonic-response"].album.song
    expect(songs.map((song) => song.title)).toEqual(["雨月之歌", "無題"])
    expect(songs[0]!.suffix).toBe("flac")
    expect(songs[0]!.contentType).toBe("audio/flac")

    const list = (await server.subsonic("getAlbumList2", "&type=alphabeticalByName")).body as {
      "subsonic-response": { albumList2: { album: Array<{ id: string }> } }
    }
    expect(list["subsonic-response"].albumList2.album.length).toBeGreaterThan(0)

    const genres = (await server.subsonic("getGenres")).body as {
      "subsonic-response": { genres: { genre: Array<{ value: string }> } }
    }
    expect(genres["subsonic-response"].genres.genre.map((genre) => genre.value)).toContain("Ambient")
  })

  test("search3 CJK / star / getStarred2 / scrobble playCount", async () => {
    const search = (await server.subsonic("search3", `&query=${encodeURIComponent("雨月")}`)).body as {
      "subsonic-response": { searchResult3: { album: Array<{ name: string }>; song: Array<{ id: string; title: string }> } }
    }
    const result = search["subsonic-response"].searchResult3
    expect(result.album[0]?.name).toBe("雨月")
    const songId = result.song[0]!.id

    await server.subsonic("star", `&id=${songId}`)
    const starred = (await server.subsonic("getStarred2")).body as {
      "subsonic-response": { starred2: { song?: Array<{ id: string }> } }
    }
    expect(starred["subsonic-response"].starred2.song?.map((song) => song.id)).toContain(songId)
    await server.subsonic("unstar", `&id=${songId}`)

    const before = (await server.subsonic("getSong", `&id=${songId}`)).body as {
      "subsonic-response": { song: { playCount: number } }
    }
    const base = before["subsonic-response"].song.playCount
    // 10s 窗口去重：紧连两次同曲上报只记一次（docs/03 §2.7）
    await server.subsonic("scrobble", `&id=${songId}`)
    await server.subsonic("scrobble", `&id=${songId}`)
    // time 补报（60s 前，窗口外）正常落库
    await server.subsonic("scrobble", `&id=${songId}&time=${Math.floor(Date.now() / 1000) - 60}`)
    const after = (await server.subsonic("getSong", `&id=${songId}`)).body as {
      "subsonic-response": { song: { playCount: number } }
    }
    expect(after["subsonic-response"].song.playCount).toBe(base + 2)
  })

  test("播放列表 createPlaylist / updatePlaylist / getPlaylists / deletePlaylist", async () => {
    const tracks = (await server.subsonic("search3", `&query=${encodeURIComponent("無題")}`)).body as {
      "subsonic-response": { searchResult3: { song: Array<{ id: string }> } }
    }
    const songId = tracks["subsonic-response"].searchResult3.song[0]!.id

    const created = (await server.subsonic("createPlaylist", `&name=SubList&songId=${songId}`)).body as {
      "subsonic-response": { playlist: { id: string; songCount: number; entry: Array<{ id: string }> } }
    }
    const playlist = created["subsonic-response"].playlist
    expect(playlist.songCount).toBe(1)
    expect(playlist.entry[0]!.id).toBe(songId)

    await server.subsonic("updatePlaylist", `&playlistId=${playlist.id}&name=SubList2`)
    const lists = (await server.subsonic("getPlaylists")).body as {
      "subsonic-response": { playlists: { playlist: Array<{ id: string; name: string }> } }
    }
    expect(lists["subsonic-response"].playlists.playlist.find((item) => item.id === playlist.id)?.name).toBe("SubList2")

    await server.subsonic("deletePlaylist", `&id=${playlist.id}`)
    const after = (await server.subsonic("getPlaylists")).body as {
      "subsonic-response": { playlists: { playlist?: Array<{ id: string }> } }
    }
    expect(after["subsonic-response"].playlists.playlist?.find((item) => item.id === playlist.id)).toBeUndefined()
  })

  test("stream 转码 + getCoverArt + 文件夹浏览 + getScanStatus + 未实现兜底", async () => {
    const tracks = (await server.get("/api/v1/tracks")).body as { items: Array<{ id: string; album: { id: string } }> }
    const track = tracks.items[0]!

    const streamed = await server.subsonic("stream", `&id=${track.id}&format=mp3&maxBitRate=64`)
    expect(streamed.status).toBe(200)
    expect(new Uint8Array(streamed.raw.slice(0, 3))).toEqual(new Uint8Array([0x49, 0x44, 0x33]))

    const cover = await server.subsonic("getCoverArt", `&id=al-${track.album.id}`)
    expect(new Uint8Array(cover.raw.slice(0, 2))).toEqual(new Uint8Array([0xff, 0xd8]))

    const indexes = (await server.subsonic("getIndexes")).body as {
      "subsonic-response": { indexes: { index: Array<{ artist: Array<{ id: string; name: string }> }> } }
    }
    const topDir = indexes["subsonic-response"].indexes.index
      .flatMap((group) => group.artist)
      .find((entry) => entry.name === "芸坊")!
    const directory = (await server.subsonic("getMusicDirectory", `&id=${topDir.id}`)).body as {
      "subsonic-response": { directory: { child: Array<{ isDir: boolean; title: string }> } }
    }
    expect(directory["subsonic-response"].directory.child.some((child) => child.isDir && child.title === "雨月")).toBeTrue()

    const scanStatus = (await server.subsonic("getScanStatus")).body as {
      "subsonic-response": { scanStatus: { scanning: boolean } }
    }
    expect(scanStatus["subsonic-response"].scanStatus.scanning).toBeFalse()

    const unimplemented = (await server.subsonic("getChatMessages")).body as {
      "subsonic-response": { error: { code: number } }
    }
    expect(unimplemented["subsonic-response"].error.code).toBe(0)
  })
})

describe("权限与用户管理", () => {
  test("创建普通用户 → 登录 → 管理操作 403 → 数据隔离 → 删除", async () => {
    expect((await server.post("/api/v1/users", { username: "listener", password: "pass123" })).status).toBe(200)

    const listenerCookie = await server.loginFresh("listener", "pass123")
    const browse = await server.call("GET", "/api/v1/albums", { cookie: listenerCookie })
    expect(browse.status).toBe(200) // 普通用户可浏览
    const adminOp = await server.call("POST", "/api/v1/users", {
      body: { username: "hacker", password: "pass123" },
      cookie: listenerCookie,
    })
    expect(adminOp.status).toBe(403)
    const scan = await server.call("POST", "/api/v1/library/scan", { cookie: listenerCookie })
    expect(scan.status).toBe(403)

    // 数据隔离：listener 收藏不影响 admin
    const tracks = (await server.get("/api/v1/tracks")).body as { items: Array<{ id: string }> }
    await server.call("PUT", `/api/v1/favorites/tracks/${tracks.items[0]!.id}`, { cookie: listenerCookie })
    const adminFavorites = (await server.get("/api/v1/favorites")).body as { items: unknown[] }
    expect(adminFavorites.items).toHaveLength(0)

    const users = (await server.get("/api/v1/users")).body as { items: Array<{ id: string; username: string }> }
    const listener = users.items.find((user) => user.username === "listener")!
    expect((await server.del(`/api/v1/users/${listener.id}`)).status).toBe(204)
  })

  test("登出后旧会话失效", async () => {
    expect((await server.post("/api/v1/auth/logout")).status).toBe(204)
    expect((await server.get("/api/v1/auth/me")).status).toBe(401)
    await server.login()
  })
})

/** 墓碑设计（0003 迁移）：播放事件是不可变事实日志——
 *  目录注销（曲目级联消失）不得抹掉收听史；统计凭行上快照不回退，
 *  recent 保留墓碑行（track null + 打点时快照），导航面过滤死行 */
describe("播放事件不可变", () => {
  test("注销音乐目录 → 曲目消失但播放事件存活、统计不回退、recent 出墓碑", async () => {
    const before = (await server.get("/api/v1/plays/summary")).body as {
      plays: number
      listenedSeconds: number
    }
    expect(before.plays).toBeGreaterThan(0)

    // 目录注销：music_folders 行删除 → tracks 级联消失（文件系统不动）
    const pool = new Pool({ connectionString: TEST_DB_URL })
    try {
      await pool.query("delete from music_folders")
    } finally {
      await pool.end()
    }

    const tracks = (await server.get("/api/v1/tracks")).body as { total: number }
    expect(tracks.total).toBe(0)

    // ① 统计不回退：打点数与累计秒数原样保留（快照兜底时长）
    const after = (await server.get("/api/v1/plays/summary")).body as {
      plays: number
      listenedSeconds: number
    }
    expect(after.plays).toBe(before.plays)
    expect(after.listenedSeconds).toBe(before.listenedSeconds)

    // ② recent：全部行变墓碑——track null，叙事来自打点时快照
    const recent = (await server.get("/api/v1/plays/recent")).body as Array<{
      track: unknown
      title: string
      artistName: string
      albumName: string
      durationSeconds: number
    }>
    expect(recent.length).toBeGreaterThan(0)
    const distinct = (await server.get("/api/v1/plays/recent?distinct=track")).body as typeof recent
    const key = (e: typeof recent[number]) => JSON.stringify([e.title,e.artistName,e.albumName,e.durationSeconds])
    expect(distinct.map(key)).toEqual([...new Set(recent.map(key))])
    for (const entry of recent) {
      expect(entry.track).toBeNull()
      expect(entry.title.length).toBeGreaterThan(0)
      expect(entry.artistName.length).toBeGreaterThan(0)
      expect(entry.albumName.length).toBeGreaterThan(0)
    }

    // ③ most-played track 型：导航面过滤死行 → 空
    const mpTrack = (await server.get("/api/v1/plays/most-played?type=track")).body as unknown[]
    expect(mpTrack).toHaveLength(0)
  })
})

/** 大目录规模化：unnest 批插（3 批/1100 文件）、消失文件分块删除（>65535 参数上限防护）、
 *  扫描取消（interrupt）、Subsonic 目录浏览 SQL 下推（不再全量拉路径） */
describe("大目录规模化", () => {
  // 模板必须活到套件末尾：01 - Song One.mp3 会被「删除文件」用例删掉，用 02 - 無題.flac
  const TEMPLATE = "芸坊/雨月/02 - 無題.flac"

  /** 每目录 550 份：前 300 带标签（同专辑），其余无标签裸文件——
   *  按 walk 顺序分块后最后一批 500 全是裸文件（trackNo/year/genre 全 null 数组），
   *  正是 sql-pg 数组参数无法推断 OID 的炸点（真实库的散文件场景） */
  async function fillScale(root: string, perDir: number): Promise<void> {
    const bare = path.join(root, ".bare-template.flac")
    const gen = Bun.spawnSync([
      "ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=770:duration=3",
      "-c:a", "flac", bare,
    ])
    if (gen.exitCode !== 0) throw new Error("bare template ffmpeg failed")
    for (const sub of ["a", "b"]) {
      await fs.mkdir(path.join(root, sub), { recursive: true })
      for (let i = 0; i < perDir; i++) {
        const src = i < 300 ? path.join(fixtureRoot, TEMPLATE) : bare
        await fs.copyFile(src, path.join(root, sub, `t${i}.flac`))
      }
    }
  }

  test("1100 文件：批插入库 → 空扫零处理 → 1100 消失分块删除 → Subsonic 目录下推", async () => {
    scaleRoot = await fs.mkdtemp(path.join(os.tmpdir(), "om-scale-"))
    await fillScale(scaleRoot, 550)
    const created = await server.post("/api/v1/music-folders", { name: "scale", path: scaleRoot })
    expect(created.status).toBe(200)
    const folderId = (created.body as { id: string }).id
    scaleFolderId = folderId

    expect((await server.post("/api/v1/library/scan")).status).toBe(204)
    await server.waitScanIdle(120_000)
    const status = (await server.get("/api/v1/library/scan-status")).body as {
      state: string
      phase: string | null
      total: number
      processed: number
      errors: string[]
    }
    expect(status.state).toBe("idle")
    expect(status.phase).toBeNull()
    expect(status.total).toBe(1100)
    expect(status.processed).toBe(1100)
    expect(status.errors).toHaveLength(0)

    // 1100 个路径、1 张专辑（雨月）、3 位艺人——批内 dedupe 保证 on conflict 不双命中。
    // 专辑归一：a/、b/ 各 300 份带标签模板 + 250 份裸模板同目录，标签唯一 →
    // 半标注传染把裸文件并入雨月（applyAlbumFallbacks），不再另立 Unknown Album。
    // 物理行数走 SQL 断言：/api/v1/tracks 列表态已是 canonical 口径（同槽位多副本塌缩，
    // 600 份雨月拷贝 → 1、双目录同名裸文件成对 → 250 行），不再等于物理总数
    const poolScale = new Pool({ connectionString: TEST_DB_URL })
    try {
      const physical = await poolScale.query(`select count(*)::int as n from tracks`)
      expect(physical.rows[0].n).toBe(1100)
    } finally {
      await poolScale.end()
    }
    const canonicalTotal = ((await server.get("/api/v1/tracks?limit=1")).body as { total: number }).total
    expect(canonicalTotal).toBe(251)
    const albums = (await server.get("/api/v1/albums?limit=1")).body as { total: number }
    expect(albums.total).toBe(1)

    // Subsonic 目录下推：getIndexes 只报顶层子目录，getMusicDirectory 逐层取
    const indexes = (await server.subsonic("getIndexes", `&musicFolderId=${folderId}`)).body as {
      "subsonic-response": { indexes: { index: Array<{ artist: Array<{ id: string; name: string }> }> } }
    }
    const names = indexes["subsonic-response"].indexes.index.flatMap((g) => g.artist).map((a) => a.name)
    expect(names).toContain("a")
    expect(names).toContain("b")
    const top = (await server.subsonic("getMusicDirectory", `&id=${folderId}`)).body as {
      "subsonic-response": { directory: { child: Array<{ id: string; isDir: boolean; title: string }> } }
    }
    expect(top["subsonic-response"].directory.child.some((c) => c.isDir && c.title === "a")).toBeTrue()
    const dirAId = top["subsonic-response"].directory.child.find((c) => c.title === "a")!.id
    const dirA = (await server.subsonic("getMusicDirectory", `&id=${dirAId}`)).body as {
      "subsonic-response": { directory: { child: Array<{ isDir: boolean }> } }
    }
    expect(dirA["subsonic-response"].directory.child).toHaveLength(550)
    expect(dirA["subsonic-response"].directory.child.every((c) => !c.isDir)).toBeTrue()

    // 空扫：未变更文件零解析零写入
    expect((await server.post("/api/v1/library/scan")).status).toBe(204)
    await server.waitScanIdle(120_000)
    const idle = (await server.get("/api/v1/library/scan-status")).body as { processed: number }
    expect(idle.processed).toBe(0)

    // 1100 个文件全部消失 → vanished 分块删除（500/块 × 3 条语句；此前一条 IN 1100 会超参数上限吗？不会，
    // 但 65k+ 必炸——此用例验证分块路径与计数正确性）
    await fs.rm(path.join(scaleRoot, "a"), { recursive: true, force: true })
    await fs.rm(path.join(scaleRoot, "b"), { recursive: true, force: true })
    expect((await server.post("/api/v1/library/scan")).status).toBe(204)
    await server.waitScanIdle(120_000)
    const after = (await server.get("/api/v1/library/scan-status")).body as { errors: string[] }
    expect(after.errors).toHaveLength(0)
    const emptied = (await server.get("/api/v1/tracks?limit=1")).body as { total: number }
    expect(emptied.total).toBe(0)
  })

  test("取消：interrupt 进行中的扫描，已完成批次保留、状态回 idle", async () => {
    await fillScale(scaleRoot, 550)

    expect((await server.post("/api/v1/library/scan")).status).toBe(204)
    // 1100 文件的扫描至少数秒——轮询必然能观察到 scanning 窗口
    const deadline = Date.now() + 10_000
    let seen: { state: string; phase: string | null } | null = null
    while (Date.now() < deadline) {
      const st = (await server.get("/api/v1/library/scan-status")).body as {
        state: string
        phase: string | null
      }
      seen = st
      if (st.state === "scanning") break
      await Bun.sleep(50)
    }
    expect(seen?.state).toBe("scanning")
    expect(seen?.phase === "walking" || seen?.phase === "indexing").toBeTrue()

    const cancel = await server.call("DELETE", "/api/v1/library/scan")
    expect(cancel.status).toBe(204)
    await server.waitScanIdle(60_000)
    const st = (await server.get("/api/v1/library/scan-status")).body as {
      state: string
      errors: string[]
    }
    expect(st.state).toBe("idle")
    expect(st.errors.some((e) => e.includes("已取消"))).toBeTrue()

    // 清理：注销目录（级联清 tracks）+ 删临时文件
    expect((await server.call("DELETE", `/api/v1/music-folders/${scaleFolderId}`)).status).toBe(204)
    await fs.rm(scaleRoot, { recursive: true, force: true })
    const final = (await server.get("/api/v1/tracks?limit=1")).body as { total: number }
    expect(final.total).toBe(0)
  })
})

/** 未知身份（Unknown Artist/Album）与封面链路健壮性：
 *  内嵌封面样本必须选真正带图的文件（min(path) 可能无图，此前提取失败 → defect 500）、
 *  cover_file 失配（文件被删/跨目录错配）降级到内嵌或 404 而非 500、
 *  跨目录专辑与 Unknown Album 不挂文件夹封面、most-played 排除兜底身份 */
describe("未知身份与封面健壮性", () => {
  test("内嵌样本选取 / 失配降级 / 多目录跳过 / 统计排除", async () => {
    await server.login() // 过滤运行（-t）时没有更早的登录用例，幂等补登
    // 造库：Album X（内嵌图只在 02，min(path) 是无图的 01）、Multi Disc（同名专辑跨两目录、
    // 各有 cover.jpg）、根目录 loose.flac + cover.jpg（诱惑 Unknown Album 挂封面）
    const covRoot = await fs.mkdtemp(path.join(os.tmpdir(), "om-cov-"))
    const gen = (args: ReadonlyArray<string>) => {
      const proc = Bun.spawnSync(["ffmpeg", "-y", "-v", "error", ...args])
      if (proc.exitCode !== 0) throw new Error(`ffmpeg: ${proc.stderr.toString().slice(0, 200)}`)
    }
    const pic = path.join(covRoot, "pic.png")
    gen(["-f", "lavfi", "-i", "testsrc2=size=120x120:duration=0.1", "-frames:v", "1", pic])

    await fs.mkdir(path.join(covRoot, "Album X"), { recursive: true })
    gen(["-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-metadata", "title=First",
      "-metadata", "artist=Artist X", "-metadata", "album=Album X",
      path.join(covRoot, "Album X/01 - first.flac")])
    gen(["-f", "lavfi", "-i", "sine=frequency=550:duration=2", "-i", pic,
      "-map", "0:a", "-map", "1:v", "-c:a", "flac", "-c:v", "copy", "-disposition:v", "attached_pic",
      "-metadata", "title=Second", "-metadata", "artist=Artist X", "-metadata", "album=Album X",
      path.join(covRoot, "Album X/02 - second.flac")])

    for (const sub of ["MultiA", "MultiB"] as const) {
      await fs.mkdir(path.join(covRoot, sub), { recursive: true })
      gen(["-f", "lavfi", "-i", "testsrc2=size=100x100:duration=0.1", "-frames:v", "1", "-q:v", "4",
        path.join(covRoot, sub, "cover.jpg")])
      gen(["-f", "lavfi", "-i", "sine=frequency=660:duration=2", "-metadata", `title=${sub}`,
        "-metadata", "artist=Multi Artist", "-metadata", "album=Multi Disc",
        path.join(covRoot, sub, `${sub}.flac`)])
    }
    gen(["-f", "lavfi", "-i", "testsrc2=size=100x100:duration=0.1", "-frames:v", "1", "-q:v", "4",
      path.join(covRoot, "cover.jpg")])
    gen(["-f", "lavfi", "-i", "sine=frequency=770:duration=2", path.join(covRoot, "loose.flac")])

    const created = await server.post("/api/v1/music-folders", { name: "cov", path: covRoot })
    expect(created.status).toBe(200)
    const covFolderId = (created.body as { id: string }).id
    expect((await server.post("/api/v1/library/scan")).status).toBe(204)
    await server.waitScanIdle(60_000)

    const pool = new Pool({ connectionString: TEST_DB_URL })
    const idOf = async (table: "albums" | "artists", name: string): Promise<string> => {
      const r = await pool.query(`select id from ${table} where name = $1`, [name])
      if (r.rows.length === 0) throw new Error(`${table} "${name}" not found`)
      return String(r.rows[0].id)
    }

    try {
      const albumX = await idOf("albums", "Album X")
      const multiDisc = await idOf("albums", "Multi Disc")
      const unknownAlbum = await idOf("albums", "Unknown Album")

      // ① 内嵌封面：样本选带图的 02（min(path)=01 无图），此前对无图文件提取会 defect 500
      const embedded = await server.get(`/api/v1/covers/al-${albumX}`)
      expect(embedded.status).toBe(200)
      expect(new Uint8Array(embedded.raw.slice(0, 2))).toEqual(new Uint8Array([0xff, 0xd8]))

      // ①' 曲目封面链（tr-）：自身无图但同专辑兄弟带图 → 兜底到专辑内嵌样本；
      //    自身带图 → tr- 缓存出自己的图；全无 → 404（loose.flac）
      const trackIds = await pool.query(
        `select (select id from tracks where path = 'Album X/01 - first.flac') as t01,
                (select id from tracks where path = 'Album X/02 - second.flac') as t02,
                (select id from tracks where path = 'loose.flac') as tloose`)
      const { t01, t02, tloose } = trackIds.rows[0]
      const trFallback = await server.get(`/api/v1/covers/tr-${t01}`)
      expect(trFallback.status).toBe(200)
      expect(new Uint8Array(trFallback.raw.slice(0, 2))).toEqual(new Uint8Array([0xff, 0xd8]))
      const trOwn = await server.get(`/api/v1/covers/tr-${t02}`)
      expect(trOwn.status).toBe(200)
      expect(new Uint8Array(trOwn.raw.slice(0, 2))).toEqual(new Uint8Array([0xff, 0xd8]))
      expect((await server.get(`/api/v1/covers/tr-${tloose}`)).status).toBe(404)
      // 第一方 hasCoverArt 语义拓宽：01 自身无图、专辑有图（兄弟内嵌）→ true
      const axTracks = (await server.get(`/api/v1/albums/${albumX}/tracks`)).body as Array<{
        title: string
        hasCoverArt: boolean
      }>
      expect(axTracks.find((t) => t.title === "First")?.hasCoverArt).toBe(true)

      // ② 文件夹封面挂载：跨目录专辑与 Unknown Album 不挂（根目录有 cover.jpg 也不挂）
      const coverRows = await pool.query(
        "select name, cover_file from albums where name = any($1)",
        [["Multi Disc", "Unknown Album"]],
      )
      const coverMap = new Map(
        coverRows.rows.map((r) => [r.name as string, r.cover_file as string | null]),
      )
      expect(coverMap.get("Multi Disc")).toBeNull()
      expect(coverMap.get("Unknown Album")).toBeNull()
      expect((await server.get(`/api/v1/covers/al-${multiDisc}`)).status).toBe(404)
      expect((await server.get(`/api/v1/covers/al-${unknownAlbum}`)).status).toBe(404)

      // ③ cover_file 失配（文件被删/跨 folder 错配）→ 降级而非 500：
      //    Album X 落到内嵌兜底 → 200；Multi Disc 无内嵌 → 404
      await pool.query("update albums set cover_file = 'gone/nope.jpg' where name = any($1)", [
        ["Album X", "Multi Disc"],
      ])
      const degraded = await server.get(`/api/v1/covers/al-${albumX}`)
      expect(degraded.status).toBe(200)
      expect(new Uint8Array(degraded.raw.slice(0, 2))).toEqual(new Uint8Array([0xff, 0xd8]))
      expect((await server.get(`/api/v1/covers/al-${multiDisc}`)).status).toBe(404)

      // ④ most-played 排除兜底身份：Unknown 的播放不进 album/artist 榜（track 型照常列出）
      await pool.query(`
        insert into plays (user_id, track_id, played_at, title, artist_name, album_name,
                           duration_seconds, artist_id, album_id)
        select 1, t.id, now() - (i || ' hours')::interval, t.title, ar.name, al.name,
               t.duration_seconds, ar.id, al.id
        from tracks t
          join albums al on al.id = t.album_id
          join artists ar on ar.id = t.artist_id,
          generate_series(1, 3) i
        where t.path = 'loose.flac'`)
      await pool.query(`
        insert into plays (user_id, track_id, played_at, title, artist_name, album_name,
                           duration_seconds, artist_id, album_id)
        select 1, t.id, now() - interval '1 hour', t.title, ar.name, al.name,
               t.duration_seconds, ar.id, al.id
        from tracks t
          join albums al on al.id = t.album_id
          join artists ar on ar.id = t.artist_id
        where t.id = (select id from tracks where path = 'Album X/01 - first.flac')`)

      const mpAlbum = (await server.get("/api/v1/plays/most-played?type=album&limit=20")).body as Array<{
        album: { name: string }
      }>
      const albumNames = mpAlbum.map((e) => e.album.name)
      expect(albumNames).toContain("Album X")
      expect(albumNames).not.toContain("Unknown Album")

      const mpArtist = (await server.get("/api/v1/plays/most-played?type=artist&limit=20")).body as Array<{
        artist: { name: string }
      }>
      const artistNames = mpArtist.map((e) => e.artist.name)
      expect(artistNames).toContain("Artist X")
      expect(artistNames).not.toContain("Unknown Artist")

      const mpTrack = (await server.get("/api/v1/plays/most-played?type=track&limit=20")).body as Array<{
        track: { title: string }
      }>
      expect(mpTrack.map((e) => e.track.title)).toContain("loose")
    } finally {
      await pool.end()
      await server.call("DELETE", `/api/v1/music-folders/${covFolderId}`)
      await fs.rm(covRoot, { recursive: true, force: true })
    }
  })
})

/** 瞬时读错误安全（walk 部分失败）：远程 FS（NFS stale handle / SMB 重连 / sshfs
 *  超时）扫描数小时里一次读错误很平常——「看不见」不得被当成「已消失」，
 *  消失清理只在 walk 零错误时执行（索引侧照常：可读部分继续入库） */
describe("瞬时读错误不清库", () => {
  test("子目录/根不可读：记错误跳过、曲目保留；恢复后自愈；完整扫描清理照常", async () => {
    const flakyRoot = await fs.mkdtemp(path.join(os.tmpdir(), "om-flaky-"))
    const gen = (args: ReadonlyArray<string>) => {
      const proc = Bun.spawnSync(["ffmpeg", "-y", "-v", "error", ...args])
      if (proc.exitCode !== 0) throw new Error(`ffmpeg: ${proc.stderr.toString().slice(0, 200)}`)
    }
    for (const sub of ["A", "B"] as const) {
      await fs.mkdir(path.join(flakyRoot, sub), { recursive: true })
      gen(["-f", "lavfi", "-i", "sine=frequency=440:duration=2",
        "-metadata", `title=Song ${sub}`, "-metadata", "artist=Flaky Artist",
        "-metadata", "album=Flaky Album",
        path.join(flakyRoot, sub, `song-${sub.toLowerCase()}.flac`)])
    }
    const created = await server.post("/api/v1/music-folders", { name: "flaky", path: flakyRoot })
    expect(created.status).toBe(200)
    const flakyFolderId = (created.body as { id: string }).id

    const trackTotal = async () =>
      ((await server.get("/api/v1/tracks?limit=1")).body as { total: number }).total
    const scanErrors = async () =>
      ((await server.get("/api/v1/library/scan-status")).body as {
        errors: ReadonlyArray<string>
      }).errors
    const rescan = async () => {
      expect((await server.post("/api/v1/library/scan")).status).toBe(204)
      await server.waitScanIdle()
    }

    try {
      await rescan()
      expect(await trackTotal()).toBe(2)

      // ① 子目录瞬时不可读（NFS stale handle / SMB 重连窗口的等价物）：
      //    可读部分照常索引，但任何曲目都不得被当作消失清除
      await fs.chmod(path.join(flakyRoot, "B"), 0o000)
      await rescan()
      expect(await trackTotal()).toBe(2) // 修复前：整个目录被清空（0）
      expect((await scanErrors()).join("\n")).toContain(path.join(flakyRoot, "B"))

      // ② 恢复后自愈：错误清空，曲目原封
      await fs.chmod(path.join(flakyRoot, "B"), 0o755)
      await rescan()
      expect(await trackTotal()).toBe(2)
      expect(await scanErrors()).toEqual([])

      // ③ 完整 walk 下消失清理照常工作（门控不能矫枉过正）
      await fs.rm(path.join(flakyRoot, "B", "song-b.flac"))
      await rescan()
      expect(await trackTotal()).toBe(1)
      expect(await scanErrors()).toEqual([])

      // ④ 根不可达（= 远程挂载断开）：同样不清库，报错了事
      await fs.chmod(flakyRoot, 0o000)
      await rescan()
      expect(await trackTotal()).toBe(1)
      expect((await scanErrors()).join("\n")).toContain(flakyRoot)
    } finally {
      await fs.chmod(flakyRoot, 0o755).catch(() => {})
      await fs.chmod(path.join(flakyRoot, "B"), 0o755).catch(() => {})
      await server.call("DELETE", `/api/v1/music-folders/${flakyFolderId}`)
      await fs.rm(flakyRoot, { recursive: true, force: true })
    }
  })
})

/** CUE 整轨虚拟分轨（docs/03 §2.9）与超长时长加固：
 *  - 整轨 + cue → 虚拟行（合成路径/分段 offset/时长），镜像不物理入库
 *  - 分轨 + 遗留 cue（FILE 引用不存在的镜像）→ cue 无害跳过
 *  - 每 FILE 一轨的 cue → 物理索引，不虚拟化（防同内容双份）
 *  - 虚拟分段流：-t 卡边界、timeOffset 段内换算、转码、打点、文件夹封面
 *  - cue 删除 → 虚拟行消失、物理镜像行回归（自然迁移）
 *  - opus 快速解析拿不到时长 → 重解析兜底 */
describe("CUE 虚拟分轨与超长时长", () => {
  test("整轨虚拟化全链路 + cue 增删迁移 + opus 时长重试", async () => {
    const cueRoot = await fs.mkdtemp(path.join(os.tmpdir(), "om-cue-"))
    const gen = (args: ReadonlyArray<string>) => {
      const proc = Bun.spawnSync(["ffmpeg", "-y", "-v", "error", ...args])
      if (proc.exitCode !== 0) throw new Error(`ffmpeg: ${proc.stderr.toString().slice(0, 200)}`)
    }
    const write = (rel: string, text: string) =>
      fs.writeFile(path.join(cueRoot, rel), text, "utf8")

    // ① 整轨：33s 无 tag 镜像 + 3 段 cue（0/11/22s）+ cover.jpg（身份全靠 cue）
    await fs.mkdir(path.join(cueRoot, "Cue Album"), { recursive: true })
    gen(["-f", "lavfi", "-i", "sine=frequency=440:duration=33",
      path.join(cueRoot, "Cue Album", "image.flac")])
    gen(["-f", "lavfi", "-i", "testsrc2=size=100x100:duration=0.1", "-frames:v", "1", "-q:v", "4",
      path.join(cueRoot, "Cue Album", "cover.jpg")])
    await write("Cue Album/image.cue", [
      'REM ALBUMARTIST "Cue Album Artist"',
      'PERFORMER "Cue Performer"',
      'TITLE "Cue Album Title"',
      'FILE "image.flac" WAVE',
      "  TRACK 01 AUDIO",
      '    TITLE "Part One"',
      '    PERFORMER "Track Artist A"',
      "    INDEX 01 00:00:00",
      "  TRACK 02 AUDIO",
      '    TITLE "Part Two"',
      "    INDEX 01 00:11:00",
      "  TRACK 03 AUDIO",
      '    TITLE "Part Three"',
      "    INDEX 01 00:22:00",
      "",
    ].join("\n"))

    // ② 分轨 + 遗留 cue（FILE 指向不存在的镜像）：cue 必须无害跳过
    await fs.mkdir(path.join(cueRoot, "Split Keep"), { recursive: true })
    for (const [i, freq] of ["330", "550"].entries()) {
      gen(["-f", "lavfi", `-i`, `sine=frequency=${freq}:duration=2`,
        "-metadata", `title=Split ${i + 1}`, "-metadata", "artist=Split Artist",
        "-metadata", "album=Split Album",
        path.join(cueRoot, "Split Keep", `0${i + 1}.flac`)])
    }
    await write("Split Keep/legacy.cue", [
      'FILE "CDImage.flac" WAVE',
      "  TRACK 01 AUDIO",
      "    INDEX 01 00:00:00",
      "",
    ].join("\n"))

    // ③ 每 FILE 一轨（分轨自带 cue）：物理索引，防同内容双份
    await fs.mkdir(path.join(cueRoot, "PerFile"), { recursive: true })
    for (const [i, freq] of ["360", "620"].entries()) {
      gen(["-f", "lavfi", `-i`, `sine=frequency=${freq}:duration=2`,
        "-metadata", `title=Per ${i + 1}`, "-metadata", "artist=Per Artist",
        "-metadata", "album=Per Album",
        path.join(cueRoot, "PerFile", `0${i + 1}.flac`)])
    }
    await write("PerFile/perfile.cue", [
      'FILE "01.flac" WAVE',
      "  TRACK 01 AUDIO",
      "    INDEX 01 00:00:00",
      'FILE "02.flac" WAVE',
      "  TRACK 02 AUDIO",
      "    INDEX 01 00:00:00",
      "",
    ].join("\n"))

    // ④ opus：快速解析拿不到时长（granule 在最后一页）→ 重解析兜底
    gen(["-f", "lavfi", "-i", "sine=frequency=300:duration=8", "-c:a", "libopus",
      path.join(cueRoot, "granule.opus")])

    const created = await server.post("/api/v1/music-folders", { name: "cue", path: cueRoot })
    expect(created.status).toBe(200)
    const cueFolderId = (created.body as { id: string }).id
    const rescan = async () => {
      expect((await server.post("/api/v1/library/scan")).status).toBe(204)
      await server.waitScanIdle(60_000)
    }

    const pool = new Pool({ connectionString: TEST_DB_URL })
    const rowsOf = async (sql: string, params: ReadonlyArray<unknown> = []) =>
      (await pool.query(sql, [...params] as Array<unknown>)).rows as Array<Record<string, unknown>>
    // 解码实测时长（流拷贝不重写 STREAMINFO，format duration 不可信——同媒体流用例）
    const decodedSeconds = async (raw: ArrayBuffer): Promise<number> => {
      const proc = Bun.spawn(["ffmpeg", "-v", "info", "-i", "pipe:0", "-f", "null", "-"], {
        stdin: "pipe",
        stderr: "pipe",
      })
      proc.stdin.write(new Uint8Array(raw))
      await proc.stdin.end()
      const stderr = await new Response(proc.stderr).text()
      await proc.exited
      const times = [...stderr.matchAll(/time=(\d+):(\d+):(\d+\.\d+)/g)]
      const last = times.at(-1)!
      return Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3])
    }

    try {
      await rescan()

      // ── 虚拟行落库 ──
      const virtuals = await rowsOf(
        `select path, title, offset_ms, duration_seconds, is_virtual from tracks
         where music_folder_id = $1 and is_virtual order by path`,
        [cueFolderId],
      )
      expect(virtuals).toHaveLength(3)
      expect(virtuals.map((r) => r.path)).toEqual([
        "Cue Album/image.flac#001",
        "Cue Album/image.flac#002",
        "Cue Album/image.flac#003",
      ])
      expect(Number(virtuals[0]!.offset_ms)).toBe(0)
      expect(Number(virtuals[1]!.offset_ms)).toBe(11_000)
      expect(Number(virtuals[2]!.offset_ms)).toBe(22_000)
      for (const v of virtuals) expect(Number(v.duration_seconds)).toBeGreaterThan(9)
      expect(virtuals[1]!.title).toBe("Part Two")
      // 镜像不物理入库
      expect(await rowsOf(
        `select 1 from tracks where music_folder_id = $1 and path = 'Cue Album/image.flac'`,
        [cueFolderId],
      )).toEqual([])
      // 专辑身份来自 cue（镜像无 tag）；物化计数 = 虚拟行数
      const album = (await rowsOf(
        `select a.track_count, a.duration_seconds, ar.name as artist from albums a
         join artists ar on ar.id = a.artist_id where a.name = 'Cue Album Title'`,
      ))[0]!
      expect(Number(album.track_count)).toBe(3)
      expect(album.artist).toBe("Cue Album Artist")
      // 分轨目录：cue 无害跳过；每 FILE 一轨：物理索引
      expect(await rowsOf(
        `select count(*)::int as n from tracks where music_folder_id = $1 and path like 'Split Keep/%'`,
        [cueFolderId],
      )).toEqual([{ n: 2 }])
      expect(await rowsOf(
        `select count(*)::int as n from tracks where music_folder_id = $1 and path like 'PerFile/%'`,
        [cueFolderId],
      )).toEqual([{ n: 2 }])
      // opus 时长重试
      const opus = (await rowsOf(
        `select duration_seconds from tracks where music_folder_id = $1 and path = 'granule.opus'`,
        [cueFolderId],
      ))[0]!
      expect(Number(opus.duration_seconds)).toBeGreaterThanOrEqual(7)

      // ── 虚拟分段流：raw 流拷贝 -t 卡边界 ──
      const idRows = await rowsOf(
        `select id from tracks where music_folder_id = $1 and path = 'Cue Album/image.flac#002'`,
        [cueFolderId],
      )
      const part2Id = String(idRows[0]!.id)
      const rawSeg = await server.get(`/api/v1/tracks/${part2Id}/stream`)
      expect(rawSeg.status).toBe(200)
      expect(rawSeg.headers.get("content-type")).toBe("audio/flac")
      expect(await decodedSeconds(rawSeg.raw)).toBeGreaterThan(10)
      expect(await decodedSeconds(rawSeg.raw)).toBeLessThan(12.6)

      // 段内 timeOffset=5 → 剩余 ~6s（换算对客户端透明）
      const segOffset = await server.get(`/api/v1/tracks/${part2Id}/stream?timeOffset=5`)
      expect(segOffset.status).toBe(200)
      expect(await decodedSeconds(segOffset.raw)).toBeGreaterThan(5)
      expect(await decodedSeconds(segOffset.raw)).toBeLessThan(6.6)

      // 转码路径同边界
      const mp3Seg = await server.get(`/api/v1/tracks/${part2Id}/stream?format=mp3&maxBitRate=96`)
      expect(mp3Seg.status).toBe(200)
      expect(new Uint8Array(mp3Seg.raw.slice(0, 3))).toEqual(new Uint8Array([0x49, 0x44, 0x33])) // ID3
      expect(await decodedSeconds(mp3Seg.raw)).toBeGreaterThan(10)
      expect(await decodedSeconds(mp3Seg.raw)).toBeLessThan(12.6)

      // ── 打点按虚拟曲身份 ──
      expect((await server.post(`/api/v1/plays/${part2Id}`, { listenedSeconds: 5 })).status).toBe(204)
      const mp = (await server.get("/api/v1/plays/most-played?type=track&limit=50")).body as Array<{
        track: { title: string }
      }>
      expect(mp.map((e) => e.track.title)).toContain("Part Two")

      // ── 文件夹封面不被虚拟行挡 ──
      const cueAlbumId = (await rowsOf(`select id from albums where name = 'Cue Album Title'`))[0]!
      const cover = await server.get(`/api/v1/covers/al-${cueAlbumId.id}`)
      expect(cover.status).toBe(200)
      expect(new Uint8Array(cover.raw.slice(0, 2))).toEqual(new Uint8Array([0xff, 0xd8])) // JPEG SOI

      // ── 幂等：再扫一遍不翻倍 ──
      await rescan()
      expect(await rowsOf(
        `select count(*)::int as n from tracks where music_folder_id = $1 and is_virtual`,
        [cueFolderId],
      )).toEqual([{ n: 3 }])

      // ── cue 删除 → 虚拟行消失、物理镜像回归 ──
      await fs.rm(path.join(cueRoot, "Cue Album", "image.cue"))
      await rescan()
      expect(await rowsOf(
        `select count(*)::int as n from tracks where music_folder_id = $1 and is_virtual`,
        [cueFolderId],
      )).toEqual([{ n: 0 }])
      expect(await rowsOf(
        `select count(*)::int as n from tracks where music_folder_id = $1 and path = 'Cue Album/image.flac'`,
        [cueFolderId],
      )).toEqual([{ n: 1 }])
    } finally {
      await pool.end()
      await server.call("DELETE", `/api/v1/music-folders/${cueFolderId}`)
      await fs.rm(cueRoot, { recursive: true, force: true })
    }
  })
})

/** 专辑归组推断（docs/02 §5 / docs/03 §2.1）：albumartist 缺失的合辑不得炸成
 *  单曲专辑——跨文件证据裁决 VA/单艺人/显式众数；碟号目录还原 DISCNUMBER；
 *  多碟专辑的专辑根封面照挂；空专辑的 play/收藏锚点不按名字迁移；
 *  force=true 跳过 mtime 基线全量重解析（修存量的入口） */
describe("专辑归组推断", () => {
  test("VA 合并 / 碟号目录 / 根封面 / 保留历史身份 / force 重扫", async () => {
    await server.login() // 过滤运行（-t）时没有更早的登录用例，幂等补登
    const grpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "om-grp-"))
    const gen = (args: ReadonlyArray<string>) => {
      const proc = Bun.spawnSync(["ffmpeg", "-y", "-v", "error", ...args])
      if (proc.exitCode !== 0) throw new Error(`ffmpeg: ${proc.stderr.toString().slice(0, 200)}`)
    }
    // VA Album：双碟三名曲作者、无 albumartist / 无 DISCNUMBER、cover.jpg 在专辑根
    // ——Re:Start 事故的最小复刻
    for (const [dir, tracks] of [
      ["Disc 1", [["01", "甲", "T1"], ["02", "乙", "T2"]]],
      ["Disc 2", [["01", "丙", "T3"]]],
    ] as const) {
      await fs.mkdir(path.join(grpRoot, "VA Album", dir), { recursive: true })
      for (const [no, artist, title] of tracks) {
        gen(["-f", "lavfi", "-i", "sine=frequency=440:duration=2",
          "-metadata", `title=${title}`, "-metadata", `artist=${artist}`,
          "-metadata", "album=VA Album", "-metadata", `track=${no}`,
          path.join(grpRoot, "VA Album", dir, `${no}.flac`)])
      }
    }
    gen(["-f", "lavfi", "-i", "testsrc2=size=100x100:duration=0.1", "-frames:v", "1", "-q:v", "4",
      path.join(grpRoot, "VA Album", "cover.jpg")])
    // Solo Album：同艺人两首、无 albumartist → 还原艺人名下
    await fs.mkdir(path.join(grpRoot, "Solo Album"), { recursive: true })
    for (const [no, title] of [["01", "S1"], ["02", "S2"]] as const) {
      gen(["-f", "lavfi", "-i", "sine=frequency=550:duration=2",
        "-metadata", `title=${title}`, "-metadata", "artist=丁",
        "-metadata", "album=Solo Album", "-metadata", `track=${no}`,
        path.join(grpRoot, "Solo Album", `${no}.flac`)])
    }
    // Semi Album：01 显式 albumartist=Various Artists，02 无标注 → 并入同一行
    await fs.mkdir(path.join(grpRoot, "Semi Album"), { recursive: true })
    gen(["-f", "lavfi", "-i", "sine=frequency=660:duration=2",
      "-metadata", "title=Se1", "-metadata", "artist=戊",
      "-metadata", "album=Semi Album", "-metadata", "album_artist=Various Artists",
      "-metadata", "track=1", path.join(grpRoot, "Semi Album", "01.flac")])
    gen(["-f", "lavfi", "-i", "sine=frequency=770:duration=2",
      "-metadata", "title=Se2", "-metadata", "artist=己",
      "-metadata", "album=Semi Album", "-metadata", "track=2",
      path.join(grpRoot, "Semi Album", "02.flac")])
    // Liar Album：ripper 逐曲把表演者写进 albumartist（VOCALO.ID 病灶）→ 整组 VA
    await fs.mkdir(path.join(grpRoot, "Liar Album"), { recursive: true })
    for (const [no, who] of [["01", "庚"], ["02", "辛"], ["03", "壬"]] as const) {
      gen(["-f", "lavfi", "-i", "sine=frequency=880:duration=2",
        "-metadata", `title=L${no}`, "-metadata", `artist=${who}`,
        "-metadata", "album=Liar Album", "-metadata", `album_artist=${who}`,
        "-metadata", `track=${no}`, path.join(grpRoot, "Liar Album", `${no}.flac`)])
    }
    // Blank Album：空串标签（artist=""/album=""）→ 走 Unknown 兜底而非落空名艺人
    await fs.mkdir(path.join(grpRoot, "Blank Album"), { recursive: true })
    gen(["-f", "lavfi", "-i", "sine=frequency=990:duration=2",
      "-metadata", "title=Blank", "-metadata", "artist=", "-metadata", "album=",
      path.join(grpRoot, "Blank Album", "01.flac")])

    const created = await server.post("/api/v1/music-folders", { name: "grp", path: grpRoot })
    expect(created.status).toBe(200)
    const grpFolderId = (created.body as { id: string }).id
    expect((await server.post("/api/v1/library/scan")).status).toBe(204)
    await server.waitScanIdle(60_000)

    const pool = new Pool({ connectionString: TEST_DB_URL })
    try {
      // ① VA Album：单行、Various Artists、3 曲、封面挂专辑根
      const va = await pool.query(`
        select al.id, ar.name as artist, al.track_count, al.cover_file
        from albums al join artists ar on ar.id = al.artist_id
        where al.name = 'VA Album'`)
      expect(va.rows).toHaveLength(1)
      expect(va.rows[0].artist).toBe("Various Artists")
      expect(Number(va.rows[0].track_count)).toBe(3)
      expect(va.rows[0].cover_file).toBe("VA Album/cover.jpg")

      // ② 碟号目录还原：Disc 1 → 2 曲 / Disc 2 → 1 曲（此前双碟全落 disc=1）
      const discs = await pool.query(
        `select disc, count(*)::int as n from tracks where album_id = $1 group by disc order by disc`,
        [va.rows[0].id])
      expect(discs.rows).toEqual([{ disc: 1, n: 2 }, { disc: 2, n: 1 }])
      const byDiscTrack = await pool.query(
        `select title from tracks where album_id = $1 order by disc, track_no`, [va.rows[0].id])
      expect(byDiscTrack.rows.map((r) => r.title)).toEqual(["T1", "T2", "T3"])

      // ③ Solo：还原为艺人丁名下
      const solo = await pool.query(`
        select ar.name as artist, al.track_count from albums al
        join artists ar on ar.id = al.artist_id where al.name = 'Solo Album'`)
      expect(solo.rows).toHaveLength(1)
      expect(solo.rows[0].artist).toBe("丁")
      expect(Number(solo.rows[0].track_count)).toBe(2)

      // ④ Semi：未标注行并入显式 Various Artists
      const semi = await pool.query(`
        select ar.name as artist, al.track_count from albums al
        join artists ar on ar.id = al.artist_id where al.name = 'Semi Album'`)
      expect(semi.rows).toHaveLength(1)
      expect(semi.rows[0].artist).toBe("Various Artists")
      expect(Number(semi.rows[0].track_count)).toBe(2)

      // ④' Liar：逐曲 albumartist 对立（谎话标签）→ 整组 VA 单行
      const liar = await pool.query(`
        select ar.name as artist, al.track_count from albums al
        join artists ar on ar.id = al.artist_id where al.name = 'Liar Album'`)
      expect(liar.rows).toHaveLength(1)
      expect(liar.rows[0].artist).toBe("Various Artists")
      expect(Number(liar.rows[0].track_count)).toBe(3)

      // ④'' Blank：空串标签走 Unknown 兜底（不落空名艺人）
      const blank = await pool.query(`
        select ar.name as artist from albums al
        join artists ar on ar.id = al.artist_id where al.name = 'Unknown Album'`)
      expect(blank.rows.map((r) => r.artist)).not.toContain("")
      const emptyNameArtists = await pool.query(
        `select count(*)::int as n from artists where btrim(name) = ''`)
      expect(emptyNameArtists.rows[0].n).toBe(0)
      const blankTrack = await pool.query(`
        select ar.name as artist from tracks t join artists ar on ar.id = t.artist_id
        where t.title = 'Blank'`)
      expect(blankTrack.rows[0].artist).toBe("Unknown Artist")

      // ⑤ 同名并非合并证据：空专辑和其历史/收藏保留原 id，但从曲库隐藏。
      const ghostArtist = await pool.query(
        `insert into artists (name) values ('Grp Ghost') returning id`)
      const ghostAlbum = await pool.query(
        `insert into albums (artist_id, name) values ($1, 'VA Album') returning id`,
        [ghostArtist.rows[0].id])
      const ghostId = ghostAlbum.rows[0].id
      await pool.query(`
        insert into plays (user_id, track_id, played_at, title, artist_name, album_name,
                           duration_seconds, artist_id, album_id)
        values (1, null, now() - interval '2 hours', 'T1', '甲', 'VA Album', 2, $1, $2)`,
        [ghostArtist.rows[0].id, ghostId])
      await pool.query(`
        insert into annotations (user_id, item_type, item_id, starred_at)
        values (1, 'album', $1, now())`, [ghostId])
      expect((await server.post("/api/v1/library/scan")).status).toBe(204)
      await server.waitScanIdle(60_000)
      const play = await pool.query(`select album_id from plays where title = 'T1' and track_id is null`)
      expect(play.rows).toHaveLength(1)
      expect(String(play.rows[0].album_id)).toBe(String(ghostId))
      const star = await pool.query(
        `select item_id from annotations where item_type = 'album' and user_id = 1 and starred_at is not null`)
      expect(star.rows.map((r) => String(r.item_id))).toContain(String(ghostId))
      expect((await pool.query(`select id from albums where id=$1`,[ghostId])).rowCount).toBe(1)
      expect((await server.get(`/api/v1/albums/${ghostId}`)).status).toBe(404)

      // ⑥ force 全量重扫：跳过 mtime 基线，processed=total（此前空扫 processed=0）
      expect((await server.post("/api/v1/library/scan?force=true")).status).toBe(204)
      await server.waitScanIdle(60_000)
      const st = (await server.get("/api/v1/library/scan-status")).body as {
        total: number
        processed: number
      }
      expect(st.total).toBeGreaterThanOrEqual(6)
      expect(st.processed).toBe(st.total)
      // 重扫后归组结论不变（幂等）
      const va2 = await pool.query(`
        select count(*)::int as n from albums al
        join artists ar on ar.id = al.artist_id
        where al.name = 'VA Album' and ar.name = 'Various Artists'`)
      expect(va2.rows[0].n).toBe(1)
    } finally {
      await pool.end()
      await server.call("DELETE", `/api/v1/music-folders/${grpFolderId}`)
      await fs.rm(grpRoot, { recursive: true, force: true })
    }
  })
})

/** 标准版本视图（docs/03 §2.5）：同一专辑多份物理拷贝（不同来源/音质）在
 *  浏览面只出一份最优 + version_count；物理行全保留（播放/引用不受影响）；
 *  物化计数（album.track_count / duration、artist.track_count）走 canonical 口径 */
describe("重复拷贝的标准版本视图", () => {
  test("双拷贝专辑：专辑页去重 + versionCount + 最优选择 + Subsonic 同步", async () => {
    await server.login()
    const twinRoot = await fs.mkdtemp(path.join(os.tmpdir(), "om-twin-"))
    const gen = (args: ReadonlyArray<string>) => {
      const proc = Bun.spawnSync(["ffmpeg", "-y", "-v", "error", ...args])
      if (proc.exitCode !== 0) throw new Error(`ffmpeg: ${proc.stderr.toString().slice(0, 200)}`)
    }
    // 同一专辑两份完整拷贝：TwinA=FLAC（无损），TwinB=MP3 320k；标签一致
    for (const [dir, codec] of [["TwinA", "flac"], ["TwinB", "mp3"]] as const) {
      await fs.mkdir(path.join(twinRoot, dir), { recursive: true })
      for (const [no, title, hz] of [["01", "A Song", 440], ["02", "B Song", 550]] as const) {
        gen(["-f", "lavfi", "-i", `sine=frequency=${hz}:duration=3`,
          ...(codec === "mp3" ? ["-codec:a", "libmp3lame", "-b:a", "320k"] : ["-codec:a", "flac"]),
          "-metadata", `title=${title}`, "-metadata", "artist=壬",
          "-metadata", "album=Twin Album", "-metadata", "album_artist=壬",
          "-metadata", `track=${no}`,
          path.join(twinRoot, dir, `${no}.${codec === "mp3" ? "mp3" : "flac"}`)])
      }
    }
    const created = await server.post("/api/v1/music-folders", { name: "twin", path: twinRoot })
    expect(created.status).toBe(200)
    const twinFolderId = (created.body as { id: string }).id
    expect((await server.post("/api/v1/library/scan")).status).toBe(204)
    await server.waitScanIdle(60_000)

    const pool = new Pool({ connectionString: TEST_DB_URL })
    try {
      // 合并为一行（显式 albumartist 一致），物化计数走 canonical：2 首
      const album = await pool.query(`
        select al.id, al.track_count from albums al
        join artists ar on ar.id = al.artist_id
        where al.name = 'Twin Album' and ar.name = '壬'`)
      expect(album.rows).toHaveLength(1)
      expect(Number(album.rows[0].track_count)).toBe(2)
      const albumId = String(album.rows[0].id)

      // 专辑页曲目：2 行、各带 versionCount=2、canonical 选中的是 FLAC 拷贝
      const tracks = (await server.get(`/api/v1/albums/${albumId}/tracks`)).body as Array<{
        id: string
        title: string
        codec: string
        versionCount?: number
      }>
      expect(tracks).toHaveLength(2)
      expect(tracks.every((t) => t.codec === "flac")).toBe(true)
      expect(tracks.every((t) => t.versionCount === 2)).toBe(true)

      // 曲目列表页与随机：不重复
      const list = (await server.get(`/api/v1/tracks?albumId=${albumId}&limit=50`)).body as {
        items: ReadonlyArray<{ title: string }>
        total: number
      }
      expect(list.total).toBe(2)
      const random = (await server.get(`/api/v1/random?count=50`)).body as ReadonlyArray<{ title: string }>
      const aCount = random.filter((t) => t.title === "A Song").length
      expect(aCount).toBeLessThanOrEqual(1)

      // Subsonic getAlbum 同口径
      const sub = (await server.subsonic("getAlbum", `&id=${albumId}`)).body as {
        "subsonic-response": { album: { songCount: number; song: ReadonlyArray<{ id: string }> } }
      }
      const sa = sub["subsonic-response"].album
      expect(Number(sa.songCount)).toBe(2)
      expect(sa.song).toHaveLength(2)

      // 物理行全在（4 行）——播放/引用不受浏览面去重影响
      const physical = await pool.query(
        `select count(*)::int as n from tracks t join albums al on al.id = t.album_id
         where al.name = 'Twin Album'`)
      expect(physical.rows[0].n).toBe(4)

      // 版本端点：槽内任意 id 皆可查；canonical（FLAC）在首位
      const flacRow = await pool.query(
        `select t.id from tracks t join albums al on al.id = t.album_id
         where al.name = 'Twin Album' and t.codec = 'flac' and t.track_no = 1`)
      const mp3Row = await pool.query(
        `select t.id from tracks t join albums al on al.id = t.album_id
         where al.name = 'Twin Album' and t.codec = 'mp3' and t.track_no = 1`)
      const flacId = String(flacRow.rows[0].id)
      const mp3Id = String(mp3Row.rows[0].id)

      const versions = (await server.get(`/api/v1/tracks/${mp3Id}/versions`)).body as Array<{
        id: string
        codec: string
        path?: string
      }>
      expect(versions).toHaveLength(2)
      expect(versions[0]!.codec).toBe("flac")
      expect(versions.every((v) => typeof v.path === "string" && v.path.length > 0)).toBe(true)

      // 收藏归一：收藏 MP3 副本 → 注解落在 canonical（FLAC）那行；从 MP3 取消同样命中
      expect((await server.put(`/api/v1/favorites/tracks/${mp3Id}`)).status).toBe(204)
      const starred = await pool.query(
        `select item_id from annotations where user_id = 1 and item_type = 'track' and starred_at is not null`)
      expect(starred.rows.map((r) => String(r.item_id))).toContain(flacId)
      expect(starred.rows.map((r) => String(r.item_id))).not.toContain(mp3Id)
      expect((await server.del(`/api/v1/favorites/tracks/${mp3Id}`)).status).toBe(204)
      const afterUnstar = await pool.query(
        `select count(*)::int as n from annotations where user_id = 1 and item_type = 'track' and starred_at is not null`)
      expect(afterUnstar.rows[0].n).toBe(0)

      // Subsonic star 同走归一
      await server.subsonic("star", `&id=${mp3Id}`)
      const subStar = await pool.query(
        `select item_id from annotations where user_id = 1 and item_type = 'track' and starred_at is not null`)
      expect(subStar.rows.map((r) => String(r.item_id))).toEqual([flacId])
    } finally {
      await pool.end()
      await server.call("DELETE", `/api/v1/music-folders/${twinFolderId}`)
      await fs.rm(twinRoot, { recursive: true, force: true })
    }
  })
})
