import { expect, test } from "bun:test"
import type { AgentEventDto } from "../src/api/client"
import { applyEvent, describeTools, historyEntries, mergeHistory, timelineRows, type Thread } from "../src/agent/timeline"

const raw = (type: string, data = {}): AgentEventDto => ({ type: "raw", event: { type, data: { sessionID: "s", assistantMessageID: "m", ...data } } })
const delta = (ordinal: number, append: string): AgentEventDto => ({ type: "message.delta", sessionID: "s", messageID: "m", ordinal, append })
const snapshot = (ordinal: number, text: string): AgentEventDto => ({ type: "message.snapshot", sessionID: "s", messageID: "m", ordinal, text })
const start = (id: string, name = "execute") => raw("session.tool.input.started", { id, name })
const call = (tool: string, status = "completed") => ({ tool, status })
const progress = (id: string, ...toolCalls: ReturnType<typeof call>[]) => raw("session.tool.progress", { id, metadata: { toolCalls } })
const action: AgentEventDto = { type: "client-action", sessionID: "s", kind: "enqueue",
  tracks: [{ id: "7", title: "A", artist: "B", album: "C", durationSeconds: 60 }] }
function stream(...events: AgentEventDto[]) {
  let seq = 0
  return events.reduce<Thread>((thread, event) => applyEvent(thread, "s", event, () => `action-${++seq}`), { entries: [], busy: false })
}

test("delayed deltas and snapshots target the reserved segment, not the whole assistant message", () => {
  const thread = stream(raw("session.text.started", { ordinal: 0 }), start("a"), delta(0, "前"), delta(1, "后一"),
    snapshot(0, "前文"), delta(1, "二"), snapshot(1, "后文"), snapshot(2, ""))
  expect(timelineRows(thread.entries).map((r) => r.type === "assistant" ? r.text : r.type)).toEqual(["前文", "group", "后文"])
  expect(stream(delta(0, "草稿"), snapshot(0, "")).entries[0]).toMatchObject({ text: "" })
})

test("interleaved execute progress is scoped to its parent; repeated cumulative updates don't reorder or double-count", () => {
  const thread = stream(start("a"), start("b"), progress("a", call("music_search", "running")),
    progress("b", call("music_enqueue")), start("a"), progress("a", call("music_search"), call("music_search")),
    raw("session.tool.success", { id: "a", metadata: { toolCalls: [call("music_search"), call("music_search")] } }),
    raw("session.tool.failed", { id: "b" }), raw("session.execution.succeeded"))
  const rows = timelineRows(thread.entries)
  expect(rows).toHaveLength(1)
  const group = rows[0]!
  if (group.type !== "group") throw Error("expected tool group")
  const summary = describeTools(group.tools)
  expect(summary.calls.map((c) => c.name)).toEqual(["music_search", "music_search", "music_enqueue"])
  expect([...summary.counts]).toEqual([["曲库查询", 2], ["播放队列", 1]])
  expect(summary.failed).toBe(true)
  expect(summary.running).toBe(false)
})

test("confirmations aren't collapsed or overwritten, later turns retain earlier activity, foreign events are ignored", () => {
  const thread = stream(start("a"), action, start("b"), action, raw("session.execution.interrupted"),
    raw("session.execution.started"), { ...delta(0, "ignored"), sessionID: "other" } as AgentEventDto,
    raw("session.tool.input.started", { id: "c", name: "x", sessionID: "other" }))
  expect(timelineRows(thread.entries).map((r) => r.type)).toEqual(["group", "action", "group", "action"])
  expect(thread.entries[0]).toMatchObject({ status: "stopped" })
  expect(thread.entries[1]!.id).not.toBe(thread.entries[3]!.id)
})

test("history and SSE project to identical rows; overlapping GET doesn't duplicate text or displace a live card", () => {
  const history = historyEntries([
    { id: "u", role: "user", createdAt: "", text: "找歌" },
    { id: "m", role: "assistant", createdAt: "", text: "查找\n找到了", parts: [
      { type: "text", text: "查找", ordinal: 0 },
      { type: "tool", id: "a", status: "done", name: "music_search", calls: [] },
      { type: "text", text: "找到了", ordinal: 1 },
    ] },
  ])
  const live = stream(delta(0, "查找"), start("a", "music_search"), raw("session.tool.success", { id: "a" }), snapshot(1, "找到了"), raw("session.execution.succeeded"))
  expect(timelineRows(history.slice(1))).toEqual(timelineRows(live.entries))
  const partial = stream(start("a", "music_search"), action, delta(1, "到了"))
  const rows = timelineRows(mergeHistory(history, partial.entries))
  expect(rows.map((r) => r.type === "assistant" ? r.text : r.type)).toEqual(["user", "查找", "group", "action", "找到了"])
  expect(mergeHistory(history, stream(start("a"), snapshot(0, "查找")).entries)).toEqual(history)
})

test("only open delta segments animate; a snapshot or interruption settles them", () => {
  const thread = stream(delta(0, "**文"), snapshot(0, "**正文**"), delta(1, "后续"))
  expect(thread.entries[0]).not.toHaveProperty("streaming")
  expect(thread.entries[1]).toHaveProperty("streaming", true)
  const stopped = applyEvent(thread, "s", raw("session.execution.interrupted"), () => "unused")
  expect(stopped.entries[1]).not.toHaveProperty("streaming")
  expect(stopped.entries[1]).toMatchObject({ text: "后续" })
})

test('a pending question stays at its tool position, outside collapsed groups; history is read-only',()=>{
  const pending={id:'frm_one',messageID:'m',callID:'b',fields:[]}
  const thread=stream(start('a'),start('b','question'),start('c'),action)
  expect(timelineRows(thread.entries,[pending]).map(r=>r.type)).toEqual(['group','question','group','action'])
  expect(timelineRows([], [pending])[0]?.type).toBe('question') // reconnect before history
  const entries=historyEntries([{role:'assistant',id:'m',text:'',createdAt:'',parts:[{type:'tool',id:'b',name:'question',
    calls:[],status:'done',answered:[{prompt:'版本？',answers:['原版']}]}]}])
  expect(timelineRows(mergeHistory(entries,thread.entries)).map(r=>r.type)).toEqual(['group','answered','group','action'])
})

test("legacy history has no invented tool/empty assistant bubbles and grouping never crosses a user prompt", () => {
  const textOnly = historyEntries([{ role: "assistant", id: "old", text: "旧回复", createdAt: "" },
    { role: "assistant", id: "empty", text: "", createdAt: "" }])
  expect(timelineRows(textOnly)).toHaveLength(1)
  const tool = stream(start("a"))
  expect(timelineRows([...tool.entries, { type: "user", id: "u", text: "下一轮" }, ...tool.entries]).map((r) => r.type))
    .toEqual(["group", "user", "group"])
})
