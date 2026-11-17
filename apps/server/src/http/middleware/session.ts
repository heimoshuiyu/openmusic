import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { HttpServerRequest } from "effect/unstable/http"
import { Context, Effect, Layer } from "effect"
import { Unauthorized, Forbidden } from "../../domain/errors"
import { UserPublic } from "../../domain/user"
import { Auth, SESSION_COOKIE } from "../../service/auth"

/** 受保护端点内可注入的当前用户 */
export class CurrentUser extends Context.Service<CurrentUser, UserPublic>()("openmusic/CurrentUser") {}

/** 会话中间件：读取 om_session cookie → 校验/续期 → 提供 CurrentUser；失败 401 */
export class SessionAuth extends HttpApiMiddleware.Service<SessionAuth, {
  provides: CurrentUser
  requires: never
}>()("openmusic/SessionAuth", {
  error: Unauthorized,
}) {}

export const SessionAuthLive = Layer.effect(
  SessionAuth,
  Effect.gen(function* () {
    const auth = yield* Auth
    // v4：中间件服务 = (httpEffect, options) => Effect，在请求上下文中执行。
    // SqlClient 等依赖在运行时由 api 构建上下文注入。
    return SessionAuth.of((httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const token = request.cookies[SESSION_COOKIE]
        if (token === undefined) {
          return yield* new Unauthorized({ message: "no session" })
        }
        const user = yield* auth.bySession(token)
        return yield* Effect.provideService(httpEffect, CurrentUser, user)
      }))
  }),
)

/** 管理员校验（用于 mutation 端点），失败 403 */
export const requireAdmin = Effect.flatMap(
  CurrentUser,
  (user) => user.isAdmin ? Effect.void : Effect.fail(new Forbidden({ message: "admin only" })),
)
