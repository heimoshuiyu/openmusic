import { Effect, Stream } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { Auth, SESSION_COOKIE } from "../service/auth"
import { AgentService } from "../service/agent/agent-service"
import { maxVoiceBytes, voiceTypes } from "../service/agent/voice"

const reply = (status: number, message: string) => HttpServerResponse.jsonUnsafe({ message }, { status, headers: { "cache-control": "no-store" } })

export const AgentVoiceRoutesLive = HttpRouter.use((router) => Effect.gen(function* () {
  const auth = yield* Auth
  const agent = yield* AgentService
  const active = new Set<number>()
  const handle = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const { params } = yield* HttpRouter.RouteContext
    const token = request.cookies[SESSION_COOKIE]
    if (!token) return reply(401, "请先登录。")
    const user = yield* auth.bySession(token).pipe(Effect.option)
    if (user._tag === "None") return reply(401, "请重新登录。")
    const mime = request.headers["content-type"]?.split(";")[0]?.toLowerCase()
    if (!mime || !voiceTypes.includes(mime)) return reply(415, "不支持这种录音格式。")
    if (Number(request.headers["content-length"]) > maxVoiceBytes) return reply(413, "录音太大，请缩短后重试。")
    const userId = Number(user.value.id)
    if (active.has(userId) || active.size >= 3) return reply(429, "正在处理其他录音，请稍后再试。")
    return yield* Effect.acquireUseRelease(Effect.sync(() => active.add(userId)), () => Effect.gen(function* () {
      const chunks: Uint8Array[] = []; let size = 0
      const read = yield* Stream.runForEach(request.stream, chunk => {
        size += chunk.length
        if (size > maxVoiceBytes) return Effect.fail("too-large" as const)
        chunks.push(chunk); return Effect.void
      }).pipe(Effect.timeout("20 seconds"), Effect.option)
      if (size > maxVoiceBytes) return reply(413, "录音太大，请缩短后重试。")
      if (!size || read._tag === "None") return reply(400, "未收到完整录音。")
      const b = Buffer.concat(chunks, size)
      const valid = mime === "audio/webm" ? b.subarray(0, 4).toString("hex") === "1a45dfa3"
        : mime === "audio/mp4" ? b.toString("ascii",4,8) === "ftyp" : b.toString("ascii",0,4) === "OggS"
      if (!valid) return reply(400, "无效的录音文件。")
      return yield* agent.transcribe({ userId, mime, ...(params.id !== undefined && {sessionID:params.id}), bytes:new Uint8Array(b.buffer, b.byteOffset, b.byteLength) }).pipe(Effect.match({
        onFailure: e => e._tag === 'NotFound' ? reply(404, '会话不存在。') : reply(503, e.message),
        onSuccess: text => HttpServerResponse.jsonUnsafe({ text }, { headers: { "cache-control":"no-store" } }),
      }))
    }), () => Effect.sync(() => active.delete(userId)))
  })
  yield* router.add("POST", "/api/v1/agent/sessions/:id/transcribe", () => handle)
  yield* router.add("POST", "/api/v1/agent/transcribe", () => handle)
}))
