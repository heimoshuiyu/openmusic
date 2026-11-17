import { HttpApiBuilder } from "effect/unstable/httpapi"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { Effect } from "effect"
import { Conflict } from "../../domain/errors"
import { LoginResponse } from "../../domain/user"
import { Auth, SESSION_COOKIE } from "../../service/auth"
import { CurrentUser, requireAdmin } from "../middleware/session"
import { Api } from "./index"

const infra = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, Exclude<E, { readonly _tag: "SqlError" }>, R> =>
  Effect.catch(effect, (error) =>
    (error as { readonly _tag?: string })._tag === "SqlError"
      ? Effect.die(error)
      : Effect.fail(error as never)) as Effect.Effect<A, Exclude<E, { readonly _tag: "SqlError" }>, R>

const cookieOptions = (expiresAt: Date) => ({
  expires: expiresAt,
  httpOnly: true,
  sameSite: "lax" as const,
  path: "/",
})

export const AuthApiLive = HttpApiBuilder.group(Api, "auth", Effect.fn(function* (handlers) {
  const auth = yield* Auth
  return handlers.handleAll({
    login: ({ payload }) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const { user, token, expiresAt } = yield* auth.login(
          payload.username,
          payload.password,
          request.headers["user-agent"] ?? null,
        )
        const body = yield* Effect.orDie(
          HttpServerResponse.json(new LoginResponse({ user, expiresAt: expiresAt.toISOString() })),
        )
        return yield* Effect.orDie(
          HttpServerResponse.setCookie(body, SESSION_COOKIE, token, cookieOptions(expiresAt)),
        )
      }),
  })
}))

export const SessionApiLive = HttpApiBuilder.group(Api, "session", Effect.fn(function* (handlers) {
  const auth = yield* Auth
  return handlers.handleAll({
    logout: () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const token = request.cookies[SESSION_COOKIE]
        if (token !== undefined) {
          yield* Effect.orDie(auth.logout(token))
        }
        return yield* Effect.orDie(
          HttpServerResponse.setCookie(HttpServerResponse.empty(), SESSION_COOKIE, "", {
            expires: new Date(0),
            httpOnly: true,
            sameSite: "lax",
            path: "/",
          }),
        )
      }),
    me: () => CurrentUser,
  })
}))

export const UsersApiLive = HttpApiBuilder.group(Api, "users", Effect.fn(function* (handlers) {
  const auth = yield* Auth
  return handlers.handleAll({
    list: ({ query }) =>
      Effect.flatMap(
        requireAdmin,
        () => infra(Effect.flatMap(Auth, (auth) =>
          auth.listUsers({ limit: query.limit ?? 20, offset: query.offset ?? 0 }))),
      ),
    create: ({ payload }) =>
      Effect.flatMap(
        requireAdmin,
        () =>
          Effect.flatMap(
            infra(Effect.flatMap(Auth, (auth) => auth.usernameTaken(payload.username))),
            (taken) => {
              if (taken) {
                return Effect.fail(new Conflict({ message: `username taken: ${payload.username}` }))
              }
              return infra(Effect.flatMap(Auth, (auth) =>
                auth.createUser({
                  username: payload.username,
                  password: payload.password,
                  isAdmin: payload.isAdmin ?? false,
                })))
            },
          ),
      ),
    update: ({ params, payload }) =>
      Effect.flatMap(
        requireAdmin,
        () =>
          Effect.gen(function* () {
            if (payload.password !== undefined) {
              yield* infra(auth.setPassword(params.id, payload.password))
            }
            if (payload.isAdmin !== undefined) {
              yield* infra(auth.setRole(params.id, payload.isAdmin))
            }
            return yield* infra(auth.userById(params.id))
          }),
      ),
    delete: ({ params }) =>
      Effect.flatMap(requireAdmin, () => infra(Effect.flatMap(Auth, (auth) => auth.deleteUser(params.id)))),
  })
}))
