import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { Effect, Stream } from "effect"
import { AppConfig } from "../config"
import { Auth, SESSION_COOKIE } from "../service/auth"
import { AgentService } from "../service/agent/agent-service"

/**
 * Agent 事件流（SSE，docs/08 §4）：GET /api/v1/agent/events。
 * HttpApi DSL 不表 SSE，走低层 HttpRouter（media/subsonic 同款姿势）；
 * om_session cookie 鉴权，未启用回 503。
 */
export const AgentEventsRoutesLive = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const auth = yield* Auth
    const agent = yield* AgentService
    const appConfig = yield* AppConfig

    const sse = <A, E>(stream: Stream.Stream<A, E>) =>
      HttpServerResponse.stream(
        Stream.encodeText(Stream.map(stream, (event) => `data: ${JSON.stringify(event)}\n\n`)),
        {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "private, no-store",
            connection: "keep-alive",
          },
        },
      )

    yield* router.add("GET", "/api/v1/agent/events", () =>
      Effect.gen(function* () {
        if (!appConfig.agentEnabled) {
          return HttpServerResponse.jsonUnsafe(
            { error: { code: "agent_unavailable", message: "AGENT_ENABLED 未开启（docs/08）" } },
            { status: 503 },
          )
        }
        const request = yield* HttpServerRequest.HttpServerRequest
        const token = request.cookies[SESSION_COOKIE]
        if (token === undefined) return HttpServerResponse.empty({ status: 401 })
        const user = yield* Effect.exit(auth.bySession(token))
        if (user._tag !== "Success") return HttpServerResponse.empty({ status: 401 })
        const owner = user.value.id
        // A long-lived connection can outlive its cookie. Check once per outgoing batch,
        // without sliding expiry; never write another batch under a revoked/expired login.
        return sse(agent.events({ userId: Number(owner) }).pipe(
          Stream.chunks,
          Stream.takeWhileEffect(() => auth.sessionActive(token, owner)),
          Stream.flattenArray,
        ))
      }),
    )
  }),
)
