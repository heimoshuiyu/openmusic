import { Config, Context, Layer, LogLevel } from "effect"

/**
 * 应用配置（环境变量 → Effect Config）。
 *
 * 环境变量清单见 docs/02-architecture.md §7 与根目录 .env.example。
 */
export interface AppConfigShape {
  readonly host: string
  readonly port: number
  readonly databaseUrl: string
  readonly dataDir: string
  readonly transcodeCacheDir: string
  readonly transcodeCacheMaxBytes: number
  readonly transcodeMaxConcurrency: number
  readonly coversCacheMaxBytes: number
  readonly logLevel: LogLevel.LogLevel
  /** AI agent 线（docs/08）：内嵌 OpenCode 宿主开关——默认关，需配置文件才开 */
  readonly agentEnabled: boolean
  /** agent 独立配置文件路径（JSON，作为 OpenCode config.content 内联）；空 = <dataDir>/agent-config.json */
  readonly agentConfigPath: string
}

export class AppConfig extends Context.Service<AppConfig, AppConfigShape>()("openmusic/AppConfig") {}

export const AppConfigLive = Layer.effect(
  AppConfig,
  Config.all({
    host: Config.String("HOST").pipe(Config.withDefault("0.0.0.0")),
    port: Config.Int("PORT").pipe(Config.withDefault(3000)),
    databaseUrl: Config.String("DATABASE_URL"),
    dataDir: Config.String("DATA_DIR").pipe(Config.withDefault("./data")),
    transcodeCacheDir: Config.String("TRANSCODE_CACHE_DIR").pipe(
      Config.withDefault("/tmp/openmusic/transcode"),
    ),
    transcodeCacheMaxBytes: Config.Int("TRANSCODE_CACHE_MAX_BYTES").pipe(
      Config.withDefault(5 * 1024 * 1024 * 1024),
    ),
    transcodeMaxConcurrency: Config.Int("TRANSCODE_MAX_CONCURRENCY").pipe(Config.withDefault(4)),
    coversCacheMaxBytes: Config.Int("COVERS_CACHE_MAX_BYTES").pipe(
      Config.withDefault(512 * 1024 * 1024),
    ),
    logLevel: Config.LogLevel("LOG_LEVEL").pipe(Config.withDefault("Info" as const)),
    agentEnabled: Config.Boolean("AGENT_ENABLED").pipe(Config.withDefault(false)),
    agentConfigPath: Config.String("AGENT_CONFIG").pipe(Config.withDefault("")),
  }),
)
