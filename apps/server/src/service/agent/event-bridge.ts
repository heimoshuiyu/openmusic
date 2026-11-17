import { Effect, Option, PubSub, Schema, Stream } from "effect"
import type { OpenCodeEvent } from "@opencode/sdk"
import type { AgentEvent } from "./agent-service"

const decodeCalls = Schema.decodeUnknownOption(Schema.Array(Schema.Struct({
  tool: Schema.String, status: Schema.Literals(["running", "completed", "error"]),
})))

/** Only UI events with a known session and explicitly selected fields leave the host. In
 * particular, tool input, output, reasoning, provider events and arbitrary metadata do not. */
function project(event: OpenCodeEvent): AgentEvent | undefined {
  switch (event.type) {
    case "session.text.delta": {
      const { sessionID, assistantMessageID: messageID, ordinal, delta: append } = event.data
      return { type: "message.delta", sessionID, messageID, ordinal, append }
    }
    case "session.text.ended": {
      const { sessionID, assistantMessageID: messageID, ordinal, text } = event.data
      return { type: "message.snapshot", sessionID, messageID, ordinal, text }
    }
    case "session.text.started": {
      const { sessionID, assistantMessageID, ordinal } = event.data
      return { type: "raw", event: { type: event.type, data: { sessionID, assistantMessageID, ordinal } } }
    }
    case "session.tool.input.started": {
      const { sessionID, assistantMessageID, id, name } = event.data
      return { type: "raw", event: { type: event.type, data: { sessionID, assistantMessageID, id, name } } }
    }
    case "session.tool.progress":
    case "session.tool.success":
    case "session.tool.failed": {
      const { sessionID, assistantMessageID, id, metadata } = event.data
      const calls = Option.getOrElse(decodeCalls(metadata?.toolCalls), () => [])
      return { type: "raw", event: { type: event.type, data: {
        sessionID, assistantMessageID, id, metadata: { toolCalls: calls, error: metadata?.error === true },
      } } }
    }
    case "session.execution.started":
    case "session.execution.succeeded":
    case "session.execution.interrupted":
    case "session.execution.failed":
      return { type: "raw", event: { type: event.type, data: { sessionID: event.data.sessionID } } }
  }
}

export const makeEventBridge = <E>(
  ownerOf: (sessionID: string) => Effect.Effect<number | null, E>,
  saveTitle: (sessionID: string, title: string) => Effect.Effect<{ ownerUserId: number } | null, E>,
) => Effect.gen(function* () {
  const bus = yield* Effect.acquireRelease(PubSub.unbounded<{ owner: number; event: AgentEvent }>(), PubSub.shutdown)
  // Registration in PG is immutable. Resolve it once per execution, not once per token or
  // subscriber. Host events are consumed serially; an unregistered execution has no route.
  const active = new Map<string, number>()
  const hostEvent = Effect.fnUntraced(function* (host: OpenCodeEvent) {
    if (host.type === 'form.created' || host.type === 'form.cancelled' || host.type === 'form.replied') {
      if (host.type === 'form.created' && host.data.form.metadata?.kind !== 'question') return
      const id = host.type === 'form.created' ? host.data.form.sessionID : host.data.sessionID
      const owner = active.get(id) ?? (yield* ownerOf(id).pipe(Effect.orElseSucceed(()=>null)))
      // Invalidate only. The owned inbox re-reads pending questions; never relay raw form events/answers.
      if (owner !== null) yield* PubSub.publish(bus,{owner,event:{type:'questions.changed',sessionID:id}})
      return
    }
    if (host.type === "session.inbox.enqueued" || host.type === "session.inbox.delivery.changed" ||
        host.type === "session.inbox.cancelled" || host.type === "session.inbox.delivered") {
      // Enqueue can precede execution.started. Recheck ownership outside the active map;
      // never broadcast SDK inbox payloads (attachments, synthetic messages, metadata).
      const id = host.data.sessionID
      const owner = active.get(id) ?? (yield* ownerOf(id).pipe(Effect.orElseSucceed(()=>null)))
      if (owner !== null) yield* PubSub.publish(bus,{owner,event:{type:"inbox.changed",sessionID:id,delivered:host.type === "session.inbox.delivered"}})
      return
    }
    if (host.type === "session.renamed") {
      const { sessionID, title } = host.data
      if (!sessionID || !title.trim()) return
      const row = yield* saveTitle(sessionID, title).pipe(Effect.catch(() =>
        Effect.as(Effect.logWarning("Agent title update failed; skipping notification"), null)))
      if (row) yield* PubSub.publish(bus, { owner: row.ownerUserId, event: { type: "session.renamed", sessionID, title } })
      return
    }
    const event = project(host)
    if (!event) return
    const id = event.type === "raw" ? event.event.data.sessionID : event.sessionID
    if (!id) return
    if (host.type === "session.execution.started") {
      active.delete(id)
      // A lookup failure must neither deliver the event nor kill the global pump.
      const owner = yield* ownerOf(id).pipe(Effect.catch(() =>
        Effect.as(Effect.logWarning("Agent SSE ownership lookup failed; dropping this execution"), null)))
      if (owner !== null) active.set(id, owner)
    }
    const owner = active.get(id)
    if (owner === undefined) return
    if (host.type === "session.execution.succeeded" || host.type === "session.execution.interrupted" || host.type === "session.execution.failed") active.delete(id)
    yield* PubSub.publish(bus, { owner, event })
  })
  return {
    hostEvent,
    clientAction: (owner: number, event: Extract<AgentEvent, { type: "client-action" }>) => PubSub.publish(bus, { owner, event }),
    events: ({ userId }: { userId: number }) => Stream.fromPubSub(bus).pipe(
      Stream.filter((item) => item.owner === userId), Stream.map((item) => item.event),
    ),
  }
})
