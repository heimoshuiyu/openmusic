import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { BadRequest, Forbidden, NotFound } from "../../domain/errors"
import { AgentSettings, SettingsChange, ConsoleAttempt, ConsoleStatus } from "../../domain/agent-settings"
import { AgentUnavailable, AgentSession, AgentDelivery, AgentInbox } from "../../service/agent/agent-service"
import { SessionAuth } from "../middleware/session"
import { SqlProvider } from "../middleware/sql"

const call = { name: Schema.String, status: Schema.Literals(["running", "done", "failed", "stopped"]) }
const part = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), ordinal: Schema.Number, text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("tool"), id: Schema.String, ...call, calls: Schema.Array(Schema.Struct(call)),
    answered:Schema.optionalKey(Schema.Array(Schema.Struct({prompt:Schema.String,answers:Schema.Array(Schema.String)}))) }),
])

export class AgentMessageDto extends Schema.Class<AgentMessageDto>("AgentMessage")({
  id: Schema.String,
  role: Schema.Literals(["user", "assistant"]),
  text: Schema.String,
  parts: Schema.optionalKey(Schema.Array(part)),
  createdAt: Schema.String,
}) {}

export const AgentPromptRequest = Schema.Struct({
  text: Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(20_000))),
  delivery: Schema.optionalKey(AgentDelivery),
})

export const CreateAgentSessionRequest = Schema.Struct({
  title: Schema.optional(Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(200)))),
})

/** AI agent 会话（docs/08 §4）：内嵌宿主的会话经第一方 API 收发 */
export class AgentGroup extends HttpApiGroup.make("agent")
  .add(HttpApiEndpoint.post('answerQuestion','/agent/sessions/:id/questions/:question',{params:{id:Schema.String,question:Schema.String},
    payload:Schema.Struct({answers:Schema.Array(Schema.Array(Schema.NonEmptyString.check(Schema.isMaxLength(4000))).check(Schema.isMaxLength(64))).check(Schema.isMaxLength(64))}),
    success:HttpApiSchema.NoContent,error:[NotFound,BadRequest,AgentUnavailable]}))
  .add(HttpApiEndpoint.make('DELETE')('dismissQuestion','/agent/sessions/:id/questions/:question',{params:{id:Schema.String,question:Schema.String},
    success:HttpApiSchema.NoContent,error:[NotFound,BadRequest,AgentUnavailable]}))
  .add(HttpApiEndpoint.get("agentInbox", "/agent/sessions/:id/inbox", { params:{id:Schema.String}, success:AgentInbox, error:[NotFound,AgentUnavailable] }))
  .add(HttpApiEndpoint.patch("updatePending", "/agent/sessions/:id/inbox/:item", { params:{id:Schema.String,item:Schema.String}, payload:Schema.Struct({delivery:AgentDelivery}), success:HttpApiSchema.NoContent,error:[NotFound,AgentUnavailable] }))
  .add(HttpApiEndpoint.make("DELETE")("cancelPending", "/agent/sessions/:id/inbox/:item", { params:{id:Schema.String,item:Schema.String}, success:HttpApiSchema.NoContent,error:[NotFound,AgentUnavailable] }))
  .add(HttpApiEndpoint.get("agentSettings", "/admin/agent/settings", { success: AgentSettings, error: [Forbidden, AgentUnavailable] }))
  .add(HttpApiEndpoint.post("changeAgentSettings", "/admin/agent/settings", { payload: SettingsChange, success: HttpApiSchema.NoContent, error: [Forbidden, BadRequest, AgentUnavailable] }))
  .add(HttpApiEndpoint.post("consoleLogin", "/admin/agent/console", { success: ConsoleAttempt, error: [Forbidden, AgentUnavailable] }))
  .add(HttpApiEndpoint.get("consoleStatus", "/admin/agent/console/:id", { params: { id: Schema.NonEmptyString }, success: ConsoleStatus, error: [Forbidden, AgentUnavailable] }))
  .add(HttpApiEndpoint.make("DELETE")("cancelConsole", "/admin/agent/console/:id", { params: { id: Schema.NonEmptyString }, success: HttpApiSchema.NoContent, error: [Forbidden, AgentUnavailable] }))
  .add(
    HttpApiEndpoint.post("createSession", "/agent/sessions", {
      payload: CreateAgentSessionRequest,
      success: AgentSession,
      error: [AgentUnavailable],
    }),
  )
  .add(
    HttpApiEndpoint.get("listSessions", "/agent/sessions", {
      success: Schema.Array(AgentSession),
      error: [AgentUnavailable],
    }),
  )
  .add(
    HttpApiEndpoint.get("messages", "/agent/sessions/:id/messages", {
      params: { id: Schema.String },
      success: Schema.Array(AgentMessageDto),
      error: [AgentUnavailable, NotFound],
    }),
  )
  .add(
    HttpApiEndpoint.post("prompt", "/agent/sessions/:id/prompt", {
      params: { id: Schema.String },
      payload: AgentPromptRequest,
      // 发送即受理（异步生成）；消息经 SSE /api/v1/agent/events 或 GET messages 拉取
      success: HttpApiSchema.NoContent,
      error: [AgentUnavailable, NotFound],
    }),
  )
  .add(
    HttpApiEndpoint.post("interrupt", "/agent/sessions/:id/interrupt", {
      params: { id: Schema.String },
      success: HttpApiSchema.NoContent,
      error: [AgentUnavailable, NotFound],
    }),
  )
  .middleware(SessionAuth).middleware(SqlProvider)
  .prefix("/api/v1") {}
