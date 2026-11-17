import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { SqlClient } from "effect/unstable/sql"
import { Effect, Layer } from "effect"

/**
 * v4：repo 函数在请求期 yield SqlClient（R=SqlClient），而路由要求请求期依赖为零。
 * 以 HttpApiMiddleware（provides: SqlClient）在构建期捕获客户端、请求期 provide——
 * 类型级把 SqlClient 从各 group 的请求期需求中扣除（ExcludeProvided）。
 * 各受保护 group 链式挂载：.middleware(SessionAuth).middleware(SqlProvider)。
 */
export class SqlProvider extends HttpApiMiddleware.Service<SqlProvider, {
  provides: SqlClient.SqlClient
  requires: never
}>()("openmusic/SqlProvider") {}

export const SqlProviderLive = Layer.effect(
  SqlProvider,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return SqlProvider.of((httpEffect) =>
      Effect.provideService(httpEffect, SqlClient.SqlClient, sql))
  }),
)
