import { Context, Effect, Layer, Stream } from "effect"
import { Schema } from "effect"
import { NotFound } from "../../domain/errors"
import type { AgentPart } from "@openmusic/shared/agent-parts"
import type { AgentSettings, SettingsChange, ConsoleAttempt, ConsoleStatus } from "../../domain/agent-settings"
import type { BadRequest } from "../../domain/errors"

/**
 * AgentService —— AI agent 运行时的 Port（docs/08-ai-agent.md §3.1）。
 *
 * A0 只定义接口 + 占位实现；A1 起由内嵌 OpenCode 宿主（./embedded.ts，
 * @opencode/sdk Promise 边界）提供真实现。域层工具面在 ./tools.ts。
 * 身份显式进 Port：所有方法带 userId——归属不符与不存在同样回 NotFound
 * （不泄露存在性）；宿主侧故障统一 AgentUnavailable。
 */

export class AgentSession extends Schema.Class<AgentSession>("AgentSession")({
  id: Schema.String,
  title: Schema.String,
  createdAt: Schema.String,
}) {}

/** parts 保留宿主顺序；text 保留给只读正文的客户端。 */
export interface AgentMessage {
  readonly id: string
  readonly role: "user" | "assistant"
  readonly text: string
  readonly parts?: readonly AgentPart[]
  readonly createdAt: string
}

/** 宿主事件流的归一化投影 + 自产 client-action 事件（工具成功即推，前端确认卡片用）。
 *  流式文本事件（V2 实证）：宿主发的是细粒度 session.text.delta/ended（载荷在
 *  event.data）——delta 是增量、ended 的 text 是该分段全量，由 messageID + ordinal 定位。 */
export type AgentEvent =
  | { readonly type: 'questions.changed'; readonly sessionID:string }
  | { readonly type: "inbox.changed"; readonly sessionID: string; readonly delivered: boolean }
  | { readonly type: "session.renamed"; readonly sessionID: string; readonly title: string }
  | {
      readonly type: "message.delta"
      readonly sessionID: string
      readonly messageID: string
      readonly append: string
      readonly ordinal: number
    }
  | {
      readonly type: "message.snapshot"
      readonly sessionID: string
      readonly messageID: string
      readonly text: string
      readonly ordinal: number
    }
  | {
      readonly type: "client-action"
      readonly sessionID: string
      readonly kind: "play-now" | "enqueue"
      readonly position?: string
      readonly tracks: ReadonlyArray<Record<string, unknown>>
    }
  | { readonly type: "raw"; readonly event: { readonly type: string; readonly data: { readonly sessionID: string } & Record<string, unknown> } }

/** Agent 运行时未接入/宿主故障（HTTP 503） */
export class AgentUnavailable extends Schema.TaggedError<AgentUnavailable>()("AgentUnavailable", {
  message: Schema.String,
}, { httpApiStatus: 503 }) {}

export type AgentFailure = AgentUnavailable | NotFound
export const AgentDelivery = Schema.Literals(["steer", "queue"])
export type AgentDelivery = typeof AgentDelivery.Type
const question = Schema.Struct({id:Schema.String,messageID:Schema.String,callID:Schema.String,fields:Schema.Array(Schema.Struct({
  title:Schema.String,prompt:Schema.String,multiple:Schema.Boolean,options:Schema.Array(Schema.Struct({label:Schema.String,description:Schema.String})),
}))})
export const AgentInbox = Schema.Struct({ busy: Schema.Boolean, questions:Schema.Array(question), items: Schema.Array(Schema.Struct({
  id: Schema.String, text: Schema.String, delivery: AgentDelivery,
})) })

export interface AgentServiceInput {
  readonly userId: number
}

export class AgentService extends Context.Service<AgentService, {
  admin: {
    settings(): Effect.Effect<typeof AgentSettings.Type, AgentUnavailable>
    change(input: typeof SettingsChange.Type): Effect.Effect<void, BadRequest | AgentUnavailable>
    consoleBegin(): Effect.Effect<typeof ConsoleAttempt.Type, AgentUnavailable>
    consoleStatus(id: string): Effect.Effect<typeof ConsoleStatus.Type, AgentUnavailable>
    consoleCancel(id: string): Effect.Effect<void, AgentUnavailable>
  }
  createSession(
    input: AgentServiceInput & { readonly title?: string | undefined },
  ): Effect.Effect<AgentSession, AgentUnavailable>
  prompt(
    input: AgentServiceInput & { readonly sessionID: string; readonly text: string; readonly delivery?: AgentDelivery },
  ): Effect.Effect<void, AgentFailure>
  inbox(input: AgentServiceInput & {sessionID:string}): Effect.Effect<typeof AgentInbox.Type, AgentFailure>
  settleQuestion(input: AgentServiceInput & {sessionID:string; id:string; answers:readonly (readonly string[])[] | null}): Effect.Effect<void, AgentFailure | BadRequest>
  changePending(input: AgentServiceInput & {sessionID:string; inboxID:string; delivery:AgentDelivery|null}): Effect.Effect<void, AgentFailure>
  messages(
    input: AgentServiceInput & { readonly sessionID: string },
  ): Effect.Effect<ReadonlyArray<AgentMessage>, AgentFailure>
  interrupt(
    input: AgentServiceInput & { readonly sessionID: string },
  ): Effect.Effect<void, AgentFailure>
  listSessions(input: AgentServiceInput): Effect.Effect<ReadonlyArray<AgentSession>, AgentUnavailable>
  transcribe(input: AgentServiceInput & { mime: string; bytes: Uint8Array; sessionID?: string }): Effect.Effect<string, AgentFailure>
  events(input: AgentServiceInput): Stream.Stream<AgentEvent>
}>()("openmusic/AgentService") {}

const unavailable = () =>
  new AgentUnavailable({ message: "Agent 运行时未接入（AGENT_ENABLED 未开启，docs/08 §6）" })

/** A0/A-关态占位实现：开启内嵌宿主前的空实现 */
export const AgentServiceDisabled = Layer.succeed(
  AgentService,
  AgentService.of({
    admin: {
      settings: () => Effect.fail(unavailable()), change: () => Effect.fail(unavailable()),
      consoleBegin: () => Effect.fail(unavailable()), consoleStatus: () => Effect.fail(unavailable()), consoleCancel: () => Effect.fail(unavailable()),
    },
    createSession: () => Effect.fail(unavailable()),
    prompt: () => Effect.fail(unavailable()),
    inbox: () => Effect.fail(unavailable()), changePending: () => Effect.fail(unavailable()), settleQuestion: () => Effect.fail(unavailable()),
    messages: () => Effect.fail(unavailable()),
    interrupt: () => Effect.fail(unavailable()),
    listSessions: () => Effect.fail(unavailable()),
    transcribe: () => Effect.fail(unavailable()),
    events: () => Stream.empty,
  }),
)
