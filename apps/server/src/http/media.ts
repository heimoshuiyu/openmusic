import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { Effect } from "effect"
import { Auth, SESSION_COOKIE } from "../service/auth"
import { Stream } from "../service/stream"

/** Don't turn a BunFile response into a generic chunked stream at the final HTTP boundary.
 * Keep the scope/cancellation bridge for live ffmpeg output (there is no known length yet). */
const toMediaResponse = (response: Response) => response.headers.has('content-length')
  ? HttpServerResponse.raw(response, {status:response.status, headers:Object.fromEntries(response.headers)})
  : HttpServerResponse.fromWeb(response)

/**
 * 媒体端点（二进制响应，不走 HttpApi DSL；服务依赖在 use 回调里捕获为闭包）：
 * - GET /api/v1/tracks/:id/stream?format=&maxBitRate=
 * - GET /api/v1/tracks/:id/download
 * - GET /api/v1/covers/:id
 */
export const MediaRoutesLive = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const auth = yield* Auth
    const stream = yield* Stream

    /** 会话校验；未认证 → 401 */
    const withSession = <A, E>(
      handler: Effect.Effect<
        A,
        E,
        | HttpRouter.RouteContext
        | HttpServerRequest.HttpServerRequest
        | HttpServerRequest.ParsedSearchParams
      >,
    ) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const token = request.cookies[SESSION_COOKIE]
        if (token !== undefined) {
          const result = yield* Effect.exit(auth.bySession(token))
          if (result._tag === "Success") {
            return yield* handler
          }
        }
        return HttpServerResponse.empty({ status: 401 })
      })

    const notFoundResponse = HttpServerResponse.jsonUnsafe(
      { error: { code: "not_found", message: "not found" } },
      { status: 404 },
    )

    const streamHandler: Effect.Effect<HttpServerResponse.HttpServerResponse, never, HttpRouter.Provided> =
      Effect.catchTag(
        withSession(Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          const searchParams: Readonly<Record<string, string | ReadonlyArray<string>>> =
            yield* HttpServerRequest.ParsedSearchParams
          const route = yield* HttpRouter.RouteContext
          const first = (key: string) => {
            const value = searchParams[key]
            return Array.isArray(value) ? value[0] : value
          }
          const format = first("format")
          const bitRate = first("maxBitRate")
          const timeOffset = first("timeOffset")
          const response = yield* stream.stream(
            route.params["id"]!,
            {
              format: format ?? undefined,
              maxBitRate: bitRate !== undefined ? Number(bitRate) : undefined,
              timeOffset: timeOffset !== undefined ? Number(timeOffset) : undefined,
            },
            request.headers["range"],
          )
          return toMediaResponse(response)
        })),
        "NotFound",
        () => Effect.succeed(notFoundResponse),
      )

    const downloadHandler: Effect.Effect<HttpServerResponse.HttpServerResponse, never, HttpRouter.Provided> =
      Effect.catchTag(
        withSession(Effect.gen(function* () {
          const route = yield* HttpRouter.RouteContext
          const response = yield* stream.download(route.params["id"]!)
          return toMediaResponse(response)
        })),
        "NotFound",
        () => Effect.succeed(notFoundResponse),
      )

    const coverHandler: Effect.Effect<HttpServerResponse.HttpServerResponse, never, HttpRouter.Provided> =
      Effect.catchTag(
        withSession(Effect.gen(function* () {
          const route = yield* HttpRouter.RouteContext
          const response = yield* stream.cover(route.params["id"]!)
          return toMediaResponse(response)
        })),
        "NotFound",
        () => Effect.succeed(notFoundResponse),
      )

    yield* router.add("GET", "/api/v1/tracks/:id/stream", streamHandler)
    yield* router.add("GET", "/api/v1/tracks/:id/download", downloadHandler)
    yield* router.add("GET", "/api/v1/covers/:id", coverHandler)
  }))
