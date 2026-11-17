import { expect } from "bun:test"
import { Effect, Fiber, Stream } from "effect"
import type { OpenCodeEvent } from "@opencode/sdk"
import { effect } from "../../../test/effect"
import { makeEventBridge } from "./event-bridge"

const base = { id: "e", created: 1, durable: { aggregateID: "s", seq: 1, version: 1 as const } }
const execution = (type: "session.execution.started" | "session.execution.succeeded", sessionID: string): OpenCodeEvent =>
  ({ ...base, type, data: { sessionID } })
const delta = (sessionID: string, delta: string): OpenCodeEvent => ({ ...base, type: "session.text.delta",
  data: { sessionID, assistantMessageID: "m", ordinal: 0, delta } })

effect("SSE bridge fails closed on missing/failed ownership; only projection fields are public", Effect.scoped(Effect.gen(function* () {
  const bridge = yield* makeEventBridge(
    (id) => id === "unavailable" ? Effect.fail("lookup failed") : Effect.succeed(id === "mine" ? 1 : null),
    (id) => Effect.succeed(id === "mine" ? { ownerUserId: 1 } : null),
  )
  const collected = yield* bridge.events({ userId: 1 }).pipe(Stream.takeUntil((e) => e.type === "client-action"),
    Stream.runCollect, Effect.forkChild({ startImmediately: true }))
  for (const id of ["unknown", "unavailable", "mine"]) {
    yield* bridge.hostEvent(execution("session.execution.started", id))
    yield* bridge.hostEvent(delta(id, id))
  }
  yield* bridge.hostEvent({ ...base, type: "session.tool.progress", data: { sessionID: "mine", assistantMessageID: "m", id: "c",
    metadata: { secret: "private", toolCalls: [{ tool: "music_search", status: "completed", input: { q: "private" } }] } } })
  yield* bridge.hostEvent({ ...base, type: "session.reasoning.delta", data: { sessionID: "mine", assistantMessageID: "m", ordinal: 0, delta: "private" } })
  yield* bridge.hostEvent(execution("session.execution.succeeded", "mine"))
  yield* bridge.hostEvent(delta("mine", "after execution"))
  for (const sessionID of ["unknown","unavailable","mine"]) {
    yield* bridge.hostEvent({ ...base, type:"session.inbox.enqueued", data:{sessionID,inboxID:"p",item:{type:"user",delivery:"queue",payload:{text:"private queued prompt"}}} })
  }
  for (const sessionID of ["unknown", "mine"]) {
    yield* bridge.hostEvent({ ...base, type: "session.renamed", data: { sessionID, title: sessionID } })
    yield* bridge.hostEvent({ ...base, type: 'form.created', data: {form:{id:'frm_a',sessionID,title:'private',fields:[{key:'q0',type:'string'}],metadata:{kind:'question'}}} })
    yield* bridge.hostEvent({ ...base, type: 'form.replied', data: {id:'frm_a',sessionID,answer:{q0:'private'}} })
  }
  yield* bridge.clientAction(1, { type: "client-action", sessionID: "mine", kind: "enqueue", tracks: [] })
  const events = yield* Fiber.join(collected)
  expect(events.map((e) => e.type === "raw" ? e.event.type : e.type)).toEqual([
    "session.execution.started", "message.delta", "session.tool.progress", "session.execution.succeeded", "inbox.changed", "session.renamed", "questions.changed", "questions.changed", "client-action",
  ])
  expect(events[1]).toMatchObject({ sessionID: "mine", append: "mine" })
  expect(events[4]).toEqual({type:"inbox.changed",sessionID:"mine",delivered:false})
  expect(events[5]).toEqual({ type: "session.renamed", sessionID: "mine", title: "mine" })
  expect(JSON.stringify(events)).not.toContain("private")
})))
