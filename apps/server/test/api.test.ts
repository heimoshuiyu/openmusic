/**
 * HttpApi handler 测试——v4 官方姿势（ai-docs/src/51_http-server/20_testing.ts）：
 * HttpApiTest.groups 构建内存类型化客户端，走与真实服务器相同的请求编码、
 * 路由、响应解码，但不经过 HTTP 传输层；断言的是**类型化结果**（错误经
 * Effect.flip 断言 _tag）。
 *
 * 依赖策略（与官方示例一致：换中间件实现、保留真依赖）：
 * - SqlClient 仍是真 PG（openmusic_test 库）——mock SQL 等于 mock 被测对象
 * - SessionAuth 换成测试实现（免 cookie、CurrentUser 可按用例切换 admin/普通用户）
 * - SqlProvider 同理用构建期捕获的测试客户端
 *
 * HTTP 传输边界（状态码/cookie/JSON 形状/Subsonic/媒体流/扫描）由
 * integration.test.ts 黑盒套件补充——那是官方姿势测不到的部分。
 */
import { beforeAll, expect } from "bun:test"
import { Effect, Layer, Redacted } from "effect"
import { PgClient } from "@effect/sql-pg"
import { SqlClient } from "effect/unstable/sql"
import { HttpServer } from "effect/unstable/http"
import { HttpApiTest } from "effect/unstable/httpapi"
import { Pool } from "pg"
import { AppConfig } from "../src/config"
import { Api } from "../src/http/api/index"
import { UsersApiLive } from "../src/http/api/auth"
import { AgentApiLive } from "../src/http/api/agent"
import { AgentServiceDisabled } from "../src/service/agent/agent-service"
import { BrowseApiLive } from "../src/http/api/browse"
import { PlaysApiLive, PlaylistsApiLive, SocialApiLive } from "../src/http/api/social"
import { CurrentUser, SessionAuth } from "../src/http/middleware/session"
import { SqlProvider } from "../src/http/middleware/sql"
import { Auth } from "../src/service/auth"
import { UserPublic } from "../src/domain/user"
import { TEST_DB_URL, migrateTestDb, truncateDomainTables } from "./helpers"
import { layer } from "./effect"

// ---- 可变当前用户（中间件闭包在请求时读取——按用例切换身份） ----
const ADMIN = new UserPublic({
  id: "1",
  username: "admin",
  isAdmin: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  lastSeenAt: null,
})
const BOB = new UserPublic({
  id: "2",
  username: "bob",
  isAdmin: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  lastSeenAt: null,
})
let currentUser: UserPublic = ADMIN

const TestPg = PgClient.layer({ url: Redacted.make(TEST_DB_URL) })

/** 最小配置（users 已播种 → Auth 的 bootstrap admin 分支不会触发） */
const TestCfg = Layer.succeed(AppConfig, {
  host: "127.0.0.1",
  port: 3998,
  databaseUrl: TEST_DB_URL,
  dataDir: "/tmp/om-api-test-data",
  transcodeCacheDir: "/tmp/om-api-test-transcode",
  transcodeCacheMaxBytes: 1024 * 1024,
  transcodeMaxConcurrency: 1,
  coversCacheMaxBytes: 1024 * 1024,
  logLevel: "Info" as const,
  agentEnabled: false,
  agentConfigPath: "",
  musicFoldersSeed: "",
  neteaseRealIp: "",
})

/** SessionAuth 测试实现：不做 cookie 校验，直接注入可切换的 CurrentUser。
 * （Effect.suspend 必不可少：中间件函数在路由注册期被调用一次，
 *  不 suspend 的话 currentUser 会在构建期固化为初始值） */
const SessionAuthTest = Layer.succeed(
  SessionAuth,
  SessionAuth.of((httpEffect) =>
    Effect.suspend(() => Effect.provideService(httpEffect, CurrentUser, currentUser))),
)

const SqlProviderTest = Layer.effect(
  SqlProvider,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return SqlProvider.of((httpEffect) => Effect.provideService(httpEffect, SqlClient.SqlClient, sql))
  }),
)

const withTestMw = (l: Layer.Layer<any, any, any>) =>
  l.pipe(Layer.provide([SessionAuthTest, SqlProviderTest]))

const TestLayer = Layer.mergeAll(
  // 中间件实现必须在输出侧：HttpApiTest 在 yield 处用当前 context 重建
  // 未选中组（system/auth/session）的路由，那里也要解析 SessionAuth
  SessionAuthTest,
  SqlProviderTest,
  // SqlClient 也在输出侧：部分用例在测试体内直接执行 SQL（补播 40 天前记录）
  TestPg,
  withTestMw(SocialApiLive),
  withTestMw(PlaysApiLive),
  withTestMw(PlaylistsApiLive),
  withTestMw(UsersApiLive),
  withTestMw(AgentApiLive.pipe(Layer.provide(AgentServiceDisabled))),
  withTestMw(BrowseApiLive),
  HttpServer.layerServices,
).pipe(
  // UsersApiLive 构建期捕获 Auth（真实实现 + 真 PG；bootstrap 因已播种用户而跳过）
  Layer.provide(Auth.layer),
  Layer.provide(TestPg),
  Layer.provide(TestCfg),
)

/** 内存类型化客户端（social/plays/playlists/users/browse 五个组） */
const makeClient = HttpApiTest.groups(Api, ["social", "plays", "playlists", "users", "browse"])

beforeAll(async () => {
  await migrateTestDb()
  await truncateDomainTables(true)
  // 直接 SQL 播种最小音乐数据（handler 逻辑测试不需要扫描器/ffmpeg）
  const pool = new Pool({ connectionString: TEST_DB_URL })
  try {
    await pool.query(`insert into music_folders (name, path) values ('seed', '/seed')`)
    await pool.query(`insert into artists (name) values ('Seed Artist')`)
    await pool.query(
      `insert into albums (artist_id, name, year, genre, track_count, duration_seconds)
       values (1, 'Seed Album', 2026, 'Tests', 3, 12)`,
    )
    await pool.query(
      `insert into tracks (music_folder_id, album_id, artist_id, title, duration_seconds, format, codec, size_bytes, path, mtime_ms)
       values
         (1, 1, 1, 'Seed One', 3, 'audio/flac', 'flac', 100, 'one.flac', 0),
         (1, 1, 1, 'Seed Two', 4, 'audio/flac', 'flac', 200, 'two.flac', 0),
         (1, 1, 1, 'Seed Three', 5, 'audio/flac', 'flac', 300, 'three.flac', 0)`,
    )
    // 两个用户：plays/annotations 的 FK 目标 + 权限用例
    await pool.query(
      `insert into users (username, password_hash, subsonic_token_seed, is_admin)
       values ('admin', 'x', 'x', true), ('bob', 'x', 'x', false)`,
    )
  } finally {
    await pool.end()
  }
})

layer(TestLayer)("HttpApi handler（官方姿势：HttpApiTest 类型化客户端）", (it) => {
  it("助手管理端点在访问宿主前统一鉴别管理员", Effect.gen(function* () {
    const { agent } = yield* HttpApiTest.groups(Api, ["agent"])
    currentUser = BOB
    try {
      expect((yield* Effect.flip(agent.agentSettings()))._tag).toBe("Forbidden")
      expect((yield* Effect.flip(agent.changeAgentSettings({ payload: { type: "model", id: "x", providerID: "y" } })))._tag).toBe("Forbidden")
      expect((yield* Effect.flip(agent.consoleLogin()))._tag).toBe("Forbidden")
      expect((yield* Effect.flip(agent.consoleStatus({ params: { id: "x" } })))._tag).toBe("Forbidden")
      expect((yield* Effect.flip(agent.cancelConsole({ params: { id: "x" } })))._tag).toBe("Forbidden")
    } finally { currentUser = ADMIN }
    expect((yield* Effect.flip(agent.agentSettings()))._tag).toBe("AgentUnavailable")
  }))
  it("分页默认值在 handler 兜底：空 query → limit=20 / offset=0", Effect.gen(function* () {
    const client = yield* makeClient
    const page = yield* client.browse.tracks({ query: {} })
    expect(page.limit).toBe(20)
    expect(page.offset).toBe(0)
    expect(page.total).toBe(3)
    const explicit = yield* client.browse.tracks({ query: { limit: 2, offset: 1 } })
    expect(explicit.items).toHaveLength(2)
  }))

  it("search 类型化结果 + random 默认 count=20（库内只有 3 首）", Effect.gen(function* () {
    const client = yield* makeClient
    const search = yield* client.browse.search({ query: { q: "Seed" } })
    expect(search.trackCount).toBe(3)
    expect(search.albumCount).toBe(1)
    expect(search.artistCount).toBe(1)
    const random = yield* client.browse.random({ query: {} })
    expect(random).toHaveLength(3)
  }))

  it("收藏 → 列表 → 取消", Effect.gen(function* () {
    currentUser = ADMIN
    const client = yield* makeClient
    yield* client.social.favorite({ params: { type: "tracks", id: "2" } })
    const favorites = yield* client.social.favorites({ query: {} })
    expect(favorites.items.map((track) => track.id)).toContain("2")
    expect(favorites.total).toBe(1)
    yield* client.social.unfavorite({ params: { type: "tracks", id: "2" } })
    const after = yield* client.social.favorites({ query: {} })
    expect(after.items).toHaveLength(0)
  }))

  it("播放上报：listenedSeconds + 10s 去重 + 统计 + most-played 类型化条目 + period 过滤", Effect.gen(function* () {
    currentUser = ADMIN
    const client = yield* makeClient
    const sql = yield* SqlClient.SqlClient

    yield* client.plays.record({ params: { id: "1" }, payload: { listenedSeconds: 100 } })
    // 10s 窗口内同曲重复上报 → 去重
    yield* client.plays.record({ params: { id: "1" }, payload: {} })
    // 不带 listenedSeconds → 统计按曲目时长兜底
    yield* client.plays.record({ params: { id: "2" }, payload: {} })

    const summary = yield* client.plays.summary()
    expect(summary.plays).toBe(2)
    expect(summary.tracks).toBe(2)
    expect(summary.listenedSeconds).toBe(100 + 4)

    const recent = yield* client.plays.recent({ query: {} })
    expect(recent[0]!.track?.title).toBe("Seed Two")

    // 40 天前的补报（直接 SQL；快照列按 0003 后的生产写路径带上）：只进 all 不进 month
    yield* sql`insert into plays (user_id, track_id, played_at, title, artist_name, album_name,
                                    duration_seconds, artist_id, album_id)
              values (1, 1, now() - interval '40 days', 'Seed One', 'Seed Artist', 'Seed Album', 3, 1, 1)`

    const all = yield* client.plays.mostPlayed({ query: {} })
    const trackOne = all.find((item) => item.kind === "track" && item.track.id === "1")
    if (trackOne === undefined || trackOne.kind !== "track") throw new Error("most-played missing track 1")
    expect(trackOne.playCount).toBe(2)
    expect(trackOne.listenedSeconds).toBe(100 + 3)

    const month = yield* client.plays.mostPlayed({ query: { period: "month" } })
    const monthOne = month.find((item) => item.kind === "track" && item.track.id === "1")
    if (monthOne === undefined || monthOne.kind !== "track") throw new Error("month most-played missing track 1")
    expect(monthOne.playCount).toBe(1)
  }))

  it("播放事件不可变：曲目删除后统计不回退、recent 出墓碑、most-played 过滤死行", Effect.gen(function* () {
    currentUser = ADMIN
    const client = yield* makeClient
    const sql = yield* SqlClient.SqlClient

    // 上一用例的裸 SQL 补报行没走 record() 写路径（无快照）——
    // 按 0003 迁移的方式回填（生产数据要么被迁移回填、要么生而带快照）
    yield* sql`update plays p set title = t.title, artist_name = ar.name, album_name = al.name,
                  duration_seconds = t.duration_seconds, artist_id = ar.id, album_id = al.id
              from tracks t
                join albums al on al.id = t.album_id
                join artists ar on ar.id = t.artist_id
              where p.track_id = t.id and p.title is null`

    const before = yield* client.plays.summary()
    expect(before.plays).toBe(3) // 上一用例：track1×2（10s 去重后 1 行 + 40 天前补报 1 行）+ track2
    expect(before.listenedSeconds).toBe(100 + 4 + 3)

    // 曲目 1 从库中消失（目录注销级联 / 扫描清理的等价路径）——事件必须存活
    yield* sql`delete from tracks where id = 1`

    // ① 统计不回退：打点数与累计秒数凭事件行快照原样保留（track 计数只算活行）
    const after = yield* client.plays.summary()
    expect(after.plays).toBe(before.plays)
    expect(after.listenedSeconds).toBe(before.listenedSeconds)
    expect(after.tracks).toBe(before.tracks - 1)

    // ② recent：死行保留为墓碑——叙事来自打点时快照
    const recent = yield* client.plays.recent({ query: {} })
    const tombstones = recent.filter((entry) => entry.track === null)
    expect(tombstones.map((entry) => entry.title)).toEqual(["Seed One", "Seed One"])
    const tomb = tombstones[0]!
    expect(tomb.artistName).toBe("Seed Artist")
    expect(tomb.albumName).toBe("Seed Album")
    expect(tomb.durationSeconds).toBe(3)
    const alive = recent.find((entry) => entry.track !== null)
    if (alive === undefined) throw new Error("expected alive entry")
    expect(alive.track?.title).toBe("Seed Two")

    // ②' 兜底：快照缺失的行（迁移前遗留）显示为「未知曲目」——叙事不崩
    yield* sql`insert into plays (user_id, track_id, played_at) values (1, null, now())`
    const withLegacy = yield* client.plays.recent({ query: {} })
    expect(withLegacy[0]?.track).toBeNull()
    expect(withLegacy[0]?.title).toBe("未知曲目")

    // ③ most-played track 型过滤死行；album/artist 型按快照 id 分组照常统计
    const most = yield* client.plays.mostPlayed({ query: {} })
    expect(most.some((item) => item.kind === "track" && item.track.id === "1")).toBe(false)
    const albumMost = yield* client.plays.mostPlayed({ query: { type: "album" } })
    expect(albumMost.length).toBeGreaterThan(0)

    // 复原曲目 1（后续用例的 FK / 列表目标）；已 SET NULL 的播放事件不回链（保持墓碑）
    yield* sql`insert into tracks (id, music_folder_id, album_id, artist_id, title,
        duration_seconds, format, codec, size_bytes, path, mtime_ms)
      overriding system value
      values (1, 1, 1, 1, 'Seed One', 3, 'audio/flac', 'flac', 100, 'one.flac', 0)`
  }))

  it("playCount 排序走聚合 join：顺序与计数正确（大库免全表相关子查询探测）", Effect.gen(function* () {
    currentUser = ADMIN
    const client = yield* makeClient
    const sql = yield* SqlClient.SqlClient

    // 直插两条历史播放给曲目 3（绕开 10s 去重窗口；快照列按生产写路径带全）
    // —— 此时 play_count：track3=2、track2=1、track1=0（旧打点已解引用为墓碑）
    for (const days of [5, 6]) {
      yield* sql`insert into plays (user_id, track_id, played_at, title, artist_name, album_name,
                                    duration_seconds, artist_id, album_id)
                select 1, t.id, now() - ${days} * interval '1 day',
                       t.title, ar.name, al.name, t.duration_seconds, ar.id, al.id
                from tracks t
                  join albums al on al.id = t.album_id
                  join artists ar on ar.id = t.artist_id
                where t.id = 3`
    }

    const desc = yield* client.browse.tracks({ query: { sort: "-playCount", limit: 10 } })
    expect(desc.total).toBe(3)
    expect(desc.items.map((t) => t.id)).toEqual(["3", "2", "1"])
    expect(desc.items[0]?.playCount).toBe(2)

    const asc = yield* client.browse.tracks({ query: { sort: "playCount", limit: 10 } })
    expect(asc.items.map((t) => t.id)).toEqual(["1", "2", "3"])
  }))

  it("播放列表：创建 → 加歌 → 顺序 → 重排 → 移除 → 删除；非 owner Forbidden、缺失 NotFound", Effect.gen(function* () {
    currentUser = ADMIN
    const client = yield* makeClient
    const created = yield* client.playlists.create({ payload: { name: "Typed List" } })
    expect(created.isMine).toBe(true)
    expect(created.songCount).toBe(0)

    yield* client.playlists.addTracks({ params: { id: created.id }, payload: { trackIds: ["1", "2", "3"] } })
    let tracks = yield* client.playlists.tracks({ params: { id: created.id } })
    expect(tracks.map((track) => track.title)).toEqual(["Seed One", "Seed Two", "Seed Three"])

    // 设为 public 后：bob 可见但非 owner → Forbidden（visible 先于 owner 检查，
    // 私有列表对 bob 是 NotFound——那是 detail 用例的语义）
    yield* client.playlists.update({ params: { id: created.id }, payload: { isPublic: true } })
    currentUser = BOB
    const forbidden = yield* Effect.flip(
      client.playlists.update({ params: { id: created.id }, payload: { name: "Hijacked" } }),
    )
    expect(forbidden._tag).toBe("Forbidden")

    currentUser = ADMIN
    // bob 对私有语义复测：admin 的私有新列表对 bob 不可见 → NotFound
    const privateList = yield* client.playlists.create({ payload: { name: "Admin Private" } })
    expect(privateList.isMine).toBe(true)
    currentUser = BOB
    const missingForBob = yield* Effect.flip(
      client.playlists.detail({ params: { id: privateList.id } }),
    )
    expect(missingForBob._tag).toBe("NotFound")

    currentUser = ADMIN
    yield* client.playlists.reorder({ params: { id: created.id }, payload: { order: ["3", "1", "2"] } })
    tracks = yield* client.playlists.tracks({ params: { id: created.id } })
    expect(tracks.map((track) => track.title)).toEqual(["Seed Three", "Seed One", "Seed Two"])

    yield* client.playlists.removeTrack({ params: { id: created.id, position: 0 } })
    tracks = yield* client.playlists.tracks({ params: { id: created.id } })
    expect(tracks).toHaveLength(2)

    yield* client.playlists.delete({ params: { id: created.id } })
    const missing = yield* Effect.flip(client.playlists.detail({ params: { id: created.id } }))
    expect(missing._tag).toBe("NotFound")
  }))

  it("用户管理：admin 列表/建号；普通用户 Forbidden；重名 Conflict", Effect.gen(function* () {
    currentUser = ADMIN
    const client = yield* makeClient
    const list = yield* client.users.list({ query: {} })
    expect(list.items.map((user) => user.username)).toContain("bob")

    const created = yield* client.users.create({
      payload: { username: "carol", password: "carolpass1", isAdmin: false },
    })
    expect(created.isAdmin).toBe(false)

    const conflict = yield* Effect.flip(
      client.users.create({ payload: { username: "bob", password: "bobpass123", isAdmin: false } }),
    )
    expect(conflict._tag).toBe("Conflict")

    currentUser = BOB
    const forbidden = yield* Effect.flip(client.users.list({ query: {} }))
    expect(forbidden._tag).toBe("Forbidden")

    currentUser = ADMIN
    yield* client.users.delete({ params: { id: created.id } })
  }))
})
