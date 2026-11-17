import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Effect } from "effect"
import { Api } from "./index"
import { AgentGroup, AgentMessageDto } from "./agent-schema"
import { AgentService } from "../../service/agent/agent-service"
import { CurrentUser, requireAdmin } from "../middleware/session"

/**
 * /api/v1/agent 处理器（docs/08 §4）。归属与可用性检查都在 AgentService
 * Port 里（非属主与不存在同回 NotFound；未启用回 AgentUnavailable/503），
 * handler 只做身份透传与 DTO 映射。
 */
export const AgentApiLive = HttpApiBuilder.group(Api, "agent", Effect.fn(function* (handlers) {
  const agent = yield* AgentService
  const uid = Effect.map(CurrentUser, (user) => Number(user.id))

  return handlers.handleAll({
    answerQuestion: ({params,payload}) => Effect.flatMap(uid,userId=>agent.settleQuestion({userId,sessionID:params.id,id:params.question,answers:payload.answers})),
    dismissQuestion: ({params}) => Effect.flatMap(uid,userId=>agent.settleQuestion({userId,sessionID:params.id,id:params.question,answers:null})),
    agentInbox: ({params}) => Effect.flatMap(uid,userId=>agent.inbox({userId,sessionID:params.id})),
    updatePending: ({params,payload}) => Effect.flatMap(uid,userId=>agent.changePending({userId,sessionID:params.id,inboxID:params.item,delivery:payload.delivery})),
    cancelPending: ({params}) => Effect.flatMap(uid,userId=>agent.changePending({userId,sessionID:params.id,inboxID:params.item,delivery:null})),
    agentSettings: () => Effect.flatMap(requireAdmin, () => agent.admin.settings()),
    changeAgentSettings: ({ payload }) => Effect.flatMap(requireAdmin, () => agent.admin.change(payload)),
    consoleLogin: () => Effect.flatMap(requireAdmin, () => agent.admin.consoleBegin()),
    consoleStatus: ({ params }) => Effect.flatMap(requireAdmin, () => agent.admin.consoleStatus(params.id)),
    cancelConsole: ({ params }) => Effect.flatMap(requireAdmin, () => agent.admin.consoleCancel(params.id)),
    createSession: ({ payload }) =>
      Effect.flatMap(uid, (userId) =>
        Effect.map(
          agent.createSession({ userId, title: payload.title }),
          (session) => session,
        )),
    listSessions: () =>
      Effect.flatMap(uid, (userId) => agent.listSessions({ userId })),
    messages: ({ params }) =>
      Effect.flatMap(uid, (userId) =>
        Effect.map(
          agent.messages({ userId, sessionID: params.id }),
          (messages) => messages.map((message) => new AgentMessageDto(message)),
        )),
    prompt: ({ params, payload }) =>
      Effect.flatMap(uid, (userId) =>
        Effect.as(
          agent.prompt({ userId, sessionID: params.id, text: payload.text, delivery:payload.delivery ?? "steer" }),
          undefined,
        )),
    interrupt: ({ params }) =>
      Effect.flatMap(uid, (userId) =>
        Effect.as(agent.interrupt({ userId, sessionID: params.id }), undefined)),
  })
}))
