import { HttpApiBuilder, HttpApiScalar } from "effect/unstable/httpapi"
import { HttpMiddleware, HttpRouter } from "effect/unstable/http"
import { BunFileSystem, BunHttpServer, BunPath, BunRuntime } from "@effect/platform-bun"
import { Config, Effect, Layer, References } from "effect"
import { AppConfig, AppConfigLive } from "./config"
import { MigratorLive } from "./db/migrator"
import { PgLive } from "./db/pg"
import { AgentApiLive } from "./http/api/agent"
import { AuthApiLive, SessionApiLive, UsersApiLive } from "./http/api/auth"
import { BrowseApiLive } from "./http/api/browse"
import { Api } from "./http/api/index"
import { LibraryApiLive } from "./http/api/library"
import { YoutubeApiLive } from "./http/api/youtube"
import { NeteaseApiLive } from "./http/api/netease"
import { LyricsApiLive } from './http/api/lyrics'
import { YoutubeImports } from "./service/youtube/imports"
import { NeteaseImports } from "./service/netease/imports"
import { PlaysApiLive, PlaylistsApiLive, SocialApiLive } from "./http/api/social"
import { SystemApiLive } from "./http/api/system"
import { AgentEventsRoutesLive } from "./http/agent-events"
import { AgentVoiceRoutesLive } from "./http/agent-voice"
import { MediaRoutesLive } from "./http/media"
import { StaticRoutesLive } from "./http/static"
import { SessionAuthLive } from "./http/middleware/session"
import { SqlProviderLive } from "./http/middleware/sql"
import { Auth } from "./service/auth"
import { SubsonicRoutesLive } from "./http/subsonic/router"
import { AgentServiceDisabled, AgentService } from "./service/agent/agent-service"
import { agentServiceEmbedded } from "./service/agent/embedded"
import { Scanner } from "./service/scanner"
import { Stream } from "./service/stream"

// ---- Layer 组装（依赖方向：http → service → repo → db，见 docs/02 §3.2）----

const ApiRoutes = HttpApiBuilder.layer(Api, {
  openapiPath: "/api/docs/openapi.json",
}).pipe(
  // Provide all the handler Layers for the API.
  Layer.provide([
    SystemApiLive,
    AuthApiLive,
    // 中间件实现随各受保护 group 层提供（官方 fixture 模式：路由注册时上下文可见）
    SessionApiLive.pipe(Layer.provide([SessionAuthLive, SqlProviderLive])),
    UsersApiLive.pipe(Layer.provide([SessionAuthLive, SqlProviderLive])),
    LibraryApiLive.pipe(Layer.provide([SessionAuthLive, SqlProviderLive])),
    BrowseApiLive.pipe(Layer.provide([SessionAuthLive, SqlProviderLive])),
    SocialApiLive.pipe(Layer.provide([SessionAuthLive, SqlProviderLive])),
    PlaysApiLive.pipe(Layer.provide([SessionAuthLive, SqlProviderLive])),
    PlaylistsApiLive.pipe(Layer.provide([SessionAuthLive, SqlProviderLive])),
    AgentApiLive.pipe(Layer.provide([SessionAuthLive, SqlProviderLive])),
    YoutubeApiLive.pipe(Layer.provide(SessionAuthLive)),
    NeteaseApiLive.pipe(Layer.provide(SessionAuthLive)),
    LyricsApiLive.pipe(Layer.provide(SessionAuthLive)),
  ]),
)

/** Scalar OpenAPI 文档（与 v3 的 /api/docs 路径保持一致） */
const DocsRoutes = HttpApiScalar.layer(Api, { path: "/api/docs" })

const HttpServerLive = BunHttpServer.layerConfig(
  Config.all({
    port: Config.Int("PORT").pipe(Config.withDefault(3000)),
    hostname: Config.String("HOST").pipe(Config.withDefault("0.0.0.0")),
    // Bun.serve 默认 10s 无数据即掐连接：媒体元素的读-ahead 水位（~16MiB）一旦
    // 触发读端暂停，流式响应就被掐死且客户端无感知（播放冻结无 error）。
    // 0 = 禁用空闲超时（已实证）；可用 SERVER_IDLE_TIMEOUT 覆盖。
    // （ServeOptions 即原生 Bun.Serve 选项，idleTimeout 原样透传）
    idleTimeout: Config.Int("SERVER_IDLE_TIMEOUT").pipe(Config.withDefault(0)),
  }),
)

/** Agent 运行时按配置动态切换（docs/08：AGENT_ENABLED + 独立配置文件才开内嵌宿主） */
const AgentRuntimeLive = Layer.unwrap(
  Effect.map(AppConfig, (config) =>
    config.agentEnabled ? agentServiceEmbedded() : AgentServiceDisabled),
)

const ServerLive = HttpRouter.serve(
  Layer.mergeAll(
    ApiRoutes,
    DocsRoutes,
    SubsonicRoutesLive,
    MediaRoutesLive,
    StaticRoutesLive,
    AgentEventsRoutesLive,
    AgentVoiceRoutesLive,
  ),
  { middleware: HttpMiddleware.logger },
).pipe(
  Layer.provide(Auth.layer),
  Layer.provide(Stream.layer),
  // AgentRuntime（依赖 AppConfig + SqlClient）必须先于 PgLive/AppConfig 提供——
  // v4 provide 语义：后 provide 的层包在外面，才够得着它的依赖（Layer 记忆化去重）
  Layer.provide(AgentRuntimeLive),
  Layer.provide(YoutubeImports.layer),
  Layer.provide(NeteaseImports.layer),
  Layer.provide(Scanner.layer),
  Layer.provide(MigratorLive),
  Layer.provide(PgLive),
  Layer.provide(HttpServerLive),
  Layer.provide(BunFileSystem.layer),
  Layer.provide(BunPath.layer),
  Layer.provide(AppConfigLive),
)

BunRuntime.runMain(
  Effect.provide(
    Effect.flatMap(
      Effect.map(AppConfig, (config) => config.logLevel),
      (logLevel) =>
        // v4：最低日志级别是 Context.Reference（fiberCached）
        // （as：rc.115 把 group 构建期依赖标成请求期 Request 标记泄漏进 layer R，
        //   运行时无实际请求期需求——集成测试全绿证实；rc 后续版本修正后移除）
        Effect.provideService(
          Layer.launch(ServerLive as unknown as Layer.Layer<never, never, never>),
          References.MinimumLogLevel,
          logLevel,
        ),
    ),
    AppConfigLive,
  ),
)
