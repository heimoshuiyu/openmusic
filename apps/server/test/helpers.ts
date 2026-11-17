import { HttpApiBuilder } from "effect/unstable/httpapi"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { PgClient } from "@effect/sql-pg"
import { Context, Layer, Redacted } from "effect"
import * as fs from "node:fs/promises"
import { Pool } from "pg"
import * as os from "node:os"
import * as path from "node:path"
import { AppConfig } from "../src/config"
import { splitStatements } from "../src/db/migrator"
import { Api } from "../src/http/api/index"
import { AuthApiLive, SessionApiLive, UsersApiLive } from "../src/http/api/auth"
import { BrowseApiLive } from "../src/http/api/browse"
import { LibraryApiLive } from "../src/http/api/library"
import { YoutubeApiLive } from "../src/http/api/youtube"
import { LyricsApiLive } from '../src/http/api/lyrics'
import { YoutubeImports } from "../src/service/youtube/imports"
import { AgentApiLive } from "../src/http/api/agent"
import { PlaysApiLive, PlaylistsApiLive, SocialApiLive } from "../src/http/api/social"
import { SystemApiLive } from "../src/http/api/system"
import { MediaRoutesLive } from "../src/http/media"
import { SqlProviderLive } from "../src/http/middleware/sql"
import { SessionAuthLive } from "../src/http/middleware/session"
import { AgentEventsRoutesLive } from "../src/http/agent-events"
import { SubsonicRoutesLive } from "../src/http/subsonic/router"
import { Auth } from "../src/service/auth"
import { AgentServiceDisabled } from "../src/service/agent/agent-service"
import { Scanner } from "../src/service/scanner"
import { Stream } from "../src/service/stream"

const testUrl = process.env.OPENMUSIC_TEST_DB_URL
if (!testUrl || !new URL(testUrl).pathname.endsWith("_test")) {
  throw new Error("Set OPENMUSIC_TEST_DB_URL to a dedicated disposable database ending in _test")
}
export const TEST_DB_URL: string = testUrl

export const ADMIN = { username: "admin", password: crypto.randomUUID().replaceAll("-", "") }

/** 进程内 WebHandler：不起端口，直接 fetch（含 Subsonic/Media 路由） */
export async function startServer() {
  process.env.OPENMUSIC_ADMIN_USER = ADMIN.username
  process.env.OPENMUSIC_ADMIN_PASSWORD = ADMIN.password

  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "om-test-data-"))
  const transcodeDir = await fs.mkdtemp(path.join(os.tmpdir(), "om-test-transcode-"))

  const TestAppConfig = Layer.succeed(AppConfig, {
    host: "127.0.0.1",
    port: 3999,
    databaseUrl: TEST_DB_URL,
    dataDir,
    transcodeCacheDir: transcodeDir,
    transcodeCacheMaxBytes: 1024 * 1024,
    transcodeMaxConcurrency: 2,
    coversCacheMaxBytes: 1024 * 1024,
    logLevel: "Info",
    agentEnabled: false,
    agentConfigPath: "",
    musicFoldersSeed: process.env.MUSIC_FOLDERS ?? "",
  })

  const TestPg = PgClient.layer({ url: Redacted.make(TEST_DB_URL) })

  // v4：HttpApiBuilder.layer(Api) 产出路由 Layer；handler 层数组 provide，
  // SessionAuth 中间件实现 provideMerge（路由构建期即解析，需出现在输出侧）。
  // 迁移不进 layer（由 migrateTestDb() 用 pg 直跑，见下）
  const ApiRoutes = HttpApiBuilder.layer(Api, { openapiPath: "/api/docs/openapi.json" }).pipe(
    Layer.provide([
      SystemApiLive,
      AuthApiLive,
      SessionApiLive.pipe(Layer.provide([SessionAuthLive, SqlProviderLive])),
      UsersApiLive.pipe(Layer.provide([SessionAuthLive, SqlProviderLive])),
      LibraryApiLive.pipe(Layer.provide([SessionAuthLive, SqlProviderLive])),
      BrowseApiLive.pipe(Layer.provide([SessionAuthLive, SqlProviderLive])),
      SocialApiLive.pipe(Layer.provide([SessionAuthLive, SqlProviderLive])),
      PlaysApiLive.pipe(Layer.provide([SessionAuthLive, SqlProviderLive])),
      PlaylistsApiLive.pipe(Layer.provide([SessionAuthLive, SqlProviderLive])),
      AgentApiLive.pipe(Layer.provide([SessionAuthLive, SqlProviderLive])),
      YoutubeApiLive.pipe(Layer.provide(SessionAuthLive)),
      LyricsApiLive.pipe(Layer.provide(SessionAuthLive)),
    ]),
  )

  // toWebHandler 的 runtime context = layer 输出：
  // ApiRoutes / Subsonic / Media 路由请求时要 yield SqlClient/服务 → 依赖在输出侧可见
  const TestLayer = Layer.mergeAll(
    ApiRoutes,
    SubsonicRoutesLive,
    MediaRoutesLive,
    AgentEventsRoutesLive,
  ).pipe(
    Layer.provide(YoutubeImports.layer), Layer.provide(Scanner.layer),
    Layer.provide(Auth.layer),
    Layer.provide(Stream.layer),
    Layer.provide(AgentServiceDisabled),
    Layer.provide(TestPg),
    Layer.provide(TestAppConfig),
  )

  const web = HttpRouter.toWebHandler(
    // toWebHandler 需要的 HTTP 平台服务（无端口、进程内）
    TestLayer.pipe(Layer.provide(HttpServer.layerServices)),
  )
  return {
    handler: web.handler,
    dispose: async () => {
      await web.dispose()
      await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {})
      await fs.rm(transcodeDir, { recursive: true, force: true }).catch(() => {})
    },
  }
}

/** ffmpeg 生成 CJK fixture 音乐库（含内嵌封面），返回目录路径 */
export async function buildFixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "om-test-music-"))
  const run = (args: ReadonlyArray<string>) => {
    const proc = Bun.spawnSync(["ffmpeg", "-y", "-v", "error", ...args])
    if (proc.exitCode !== 0) {
      throw new Error(`ffmpeg failed: ${proc.stderr.toString().slice(0, 200)}`)
    }
  }

  // Artist A / Album One：mp3
  await fs.mkdir(path.join(root, "Artist A/2021 - Album One"), { recursive: true })
  run([
    "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
    "-metadata", "title=Song One", "-metadata", "artist=Artist A",
    "-metadata", "album=Album One", "-metadata", "album_artist=Artist A",
    "-metadata", "track=1", "-metadata", "date=2021", "-metadata", "genre=Rock",
    path.join(root, "Artist A/2021 - Album One/01 - Song One.mp3"),
  ])

  // 芸坊 / 雨月：flac ×2，第一首带内嵌封面
  await fs.mkdir(path.join(root, "芸坊/雨月"), { recursive: true })
  const cover = path.join(root, "cover.png")
  run(["-f", "lavfi", "-i", "testsrc2=size=300x300:duration=0.1", "-frames:v", "1", cover])
  const tmpFlac = path.join(root, "芸坊/雨月/.tmp01.flac")
  run([
    "-f", "lavfi", "-i", "sine=frequency=550:duration=4",
    "-i", cover,
    "-map", "0:a", "-map", "1:v", "-c:a", "flac", "-c:v", "copy", "-disposition:v", "attached_pic",
    "-metadata", "title=雨月之歌", "-metadata", "artist=芸坊",
    "-metadata", "album=雨月", "-metadata", "album_artist=芸坊",
    "-metadata", "track=1", "-metadata", "date=2023", "-metadata", "genre=Ambient",
    tmpFlac,
  ])
  await fs.rename(tmpFlac, path.join(root, "芸坊/雨月/01 - 雨月之歌.flac"))
  run([
    "-f", "lavfi", "-i", "sine=frequency=660:duration=5",
    "-metadata", "title=無題", "-metadata", "artist=芸坊 feat. 初音ミク",
    "-metadata", "album=雨月", "-metadata", "album_artist=芸坊",
    "-metadata", "track=2", "-metadata", "date=2023", "-metadata", "genre=Ambient",
    path.join(root, "芸坊/雨月/02 - 無題.flac"),
  ])
  await fs.rm(cover).catch(() => {})
  return root
}

//** 用 pg 直跑迁移（等价 Migrator 语义：记录表 + 逐文件事务执行） */
export async function migrateTestDb(): Promise<void> {
  const dir = path.join(import.meta.dir, "../src/db/migrations")
  const files = Array.from(new Bun.Glob("*.sql").scanSync({ cwd: dir })).sort()
  const pool = new Pool({ connectionString: TEST_DB_URL })
  try {
    await pool.query(`create table if not exists effect_sql_migrations (
      migration_id integer primary key, name text, created_at timestamptz default now())`)
    const applied = new Set(
      (await pool.query("select migration_id from effect_sql_migrations")).rows.map(
        (row) => Number(row.migration_id),
      ),
    )
    for (const file of files) {
      const id = Number(file.split("-")[0])
      if (applied.has(id)) continue
      const text = await Bun.file(path.join(dir, file)).text()
      const client = await pool.connect()
      try {
        await client.query("begin")
        for (const statement of splitStatements(text)) {
          await client.query(statement)
        }
        await client.query("insert into effect_sql_migrations (migration_id, name) values ($1, $2)", [
          id,
          file.replace(/\.sql$/, ""),
        ])
        await client.query("commit")
      } catch (error) {
        await client.query("rollback")
        throw error
      } finally {
        client.release()
      }
    }
  } finally {
    await pool.end()
  }
}

/** 清空域数据；includeUsers=true 时连 users 一起清（用于跨运行残留——
 * dataDir 每次随机，旧 admin 的 Subsonic 密文用旧 secret.key 加密，必须重建） */
export async function truncateDomainTables(includeUsers = false): Promise<void> {
  const pg = (await import("pg")).default
  const pool = new pg.Pool({ connectionString: TEST_DB_URL })
  try {
    await pool.query(
      "truncate annotations, playlist_tracks, playlists, plays, lyric_documents, tracks, albums, artists, music_folders, sessions restart identity cascade",
    )
    if (includeUsers) {
      await pool.query("truncate users restart identity cascade")
    } else {
      await pool.query("delete from users where username <> $1", ["admin"])
    }
  } finally {
    await pool.end()
  }
}

// ---- fetch 便捷封装 ----

export interface ApiResponse {
  status: number
  headers: Headers
  body: unknown
  raw: ArrayBuffer
}

export class TestServer {
  cookie: string | null = null

  constructor(
    /** v4 toWebHandler 的 handler 需要请求期 context（Request 标记在运行时由 api 中间件机制满足） */
    public handler: (request: Request, context: Context.Context<unknown>) => Promise<Response>,
  ) {}

  async call(
    method: string,
    url: string,
    options: { body?: unknown; cookie?: string | null; headers?: Record<string, string> } = {},
  ): Promise<ApiResponse> {
    const cookie = options.cookie !== undefined ? options.cookie : this.cookie
    const response = await this.handler(
      new Request(`http://test${url}`, {
        method,
        headers: {
          ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
          ...(cookie ? { cookie } : {}),
          ...options.headers,
        },
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      }),
      // v4：请求期依赖由 api 中间件机制在路由内部满足，此处传空 context
      Context.empty() as Context.Context<unknown>,
    )
    const setCookie = response.headers.get("set-cookie")
    if (setCookie?.startsWith("om_session=") && options.cookie === undefined) {
      this.cookie = setCookie.split(";")[0] ?? null
    }
    const raw = await response.arrayBuffer()
    let body: unknown = null
    const text = new TextDecoder().decode(raw)
    if (text !== "") {
      try {
        body = JSON.parse(text)
      } catch {
        body = text
      }
    }
    return { status: response.status, headers: response.headers, body, raw }
  }

  get(url: string, headers?: Record<string, string>) {
    return this.call("GET", url, headers === undefined ? {} : { headers })
  }
  post(url: string, body?: unknown) {
    return this.call("POST", url, { body })
  }
  put(url: string, body?: unknown) {
    return this.call("PUT", url, { body })
  }
  patch(url: string, body?: unknown) {
    return this.call("PATCH", url, { body })
  }
  del(url: string) {
    return this.call("DELETE", url)
  }

  /** Subsonic 便捷调用（token 认证） */
  subsonic(endpoint: string, extra = "", password = ADMIN.password) {
    const salt = "testsalt"
    // 标准 Subsonic token：md5(hex(md5(password)) + salt)（docs/05 §3）
    const md5hex = Bun.CryptoHasher.hash("md5", password, "hex") as string
    const token = Bun.CryptoHasher.hash("md5", md5hex + salt, "hex") as string
    const auth = `u=${ADMIN.username}&t=${token}&s=${salt}&v=1.13.0&c=TestRunner&f=json`
    return this.get(`/rest/${endpoint}.view?${auth}${extra}`)
  }

  async login(username = ADMIN.username, password = ADMIN.password): Promise<void> {
    const response = await this.call("POST", "/api/v1/auth/login", {
      body: { username, password },
      // 不传 cookie 字段（undefined）→ call 会捕获 set-cookie
    })
    if (response.status !== 200) {
      throw new Error(`login failed: ${response.status} ${JSON.stringify(response.body)}`)
    }
  }

  async loginFresh(username: string, password: string): Promise<string> {
    const saved = this.cookie
    this.cookie = null
    await this.login(username, password)
    const fresh = this.cookie
    this.cookie = saved
    return fresh!
  }

  async waitScanIdle(timeoutMs = 30_000): Promise<void> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const response = await this.get("/api/v1/library/scan-status")
      const state = (response.body as { state: string }).state
      if (state === "idle") return
      await Bun.sleep(150)
    }
    throw new Error("scan did not finish in time")
  }
}
