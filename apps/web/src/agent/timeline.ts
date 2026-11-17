import { settleTool, toolCalls, type AgentPart, type PendingQuestion, type AnsweredQuestion, type ToolCall } from "@openmusic/shared/agent-parts"
import type { AgentEventDto, AgentMessageDto } from "@/api/client"

type TextEntry = { type: "user" | "assistant"; id: string; text: string; streaming?: true }
export type ToolEntry = Extract<AgentPart, { type: "tool" }>
export type ActionEntry = { type: "action"; id: string; action: Extract<AgentEventDto, { type: "client-action" }> }
export type Entry = TextEntry | ToolEntry | ActionEntry
export interface Thread { entries: readonly Entry[]; busy: boolean }

const textId = (message: string, ordinal: number) => `text:${message}:${ordinal}`
const toolId = (message: string, call: string) => `tool:${message}:${call}`

export function historyEntries(messages: readonly AgentMessageDto[]): Entry[] {
  return messages.flatMap<Entry>((m) => {
    if (m.role === "user") return [{ type: "user", id: m.id, text: m.text }]
    // Old text-only responses remain readable; an explicitly empty parts list is not a bubble.
    return (m.parts ?? [{ type: "text" as const, ordinal: 0, text: m.text }]).map((p) => p.type === "text"
      ? { type: "assistant", id: textId(m.id, p.ordinal), text: p.text }
      : { ...p, id: toolId(m.id, p.id) })
  })
}

/** SSE may overtake the initial GET. Keep live-only rows (especially confirmations) at their
 * anchor and use durable completed text in preference to a partial stream joined mid-segment. */
export function mergeHistory(history: Entry[], live: readonly Entry[]): Entry[] {
  if (!live.length) return history
  const positions = new Map(history.map((entry, i) => [entry.id, i]))
  const merged = history.slice()
  // A stream joined mid-turn can observe B starting before a final update to A. GET's
  // order wins for shared IDs; only genuinely new IDs need a position between them.
  const gaps = new Map<number, Entry[]>()
  const first = live.find((entry) => positions.has(entry.id))
  let gap = first ? positions.get(first.id)! : history.length
  for (const entry of live) {
    const at = positions.get(entry.id)
    if (at === undefined) {
      const items = gaps.get(gap)
      if (items) items.push(entry)
      else gaps.set(gap, [entry])
      continue
    }
    gap = Math.max(gap, at + 1)
    const stored = history[at]!
    if (stored.type === "assistant" && stored.text) {
      if (entry.type === "assistant" && entry.streaming && entry.text.startsWith(stored.text)) merged[at] = entry
      continue
    }
    if (entry.type === "tool" && stored.type === "tool") {
      if (stored.status === "running") merged[at] = { ...entry, name: entry.name || stored.name }
    } else merged[at] = entry
  }
  return merged.flatMap((entry, i) => [...(gaps.get(i) ?? []), entry]).concat(gaps.get(history.length) ?? [])
}

function put(entries: readonly Entry[], index: number, entry: Entry): Entry[] {
  if (index < 0) return [...entries, entry]
  const next = entries.slice()
  next[index] = entry
  return next
}

export function finishThread(thread: Thread): Thread {
  return { busy: false, entries: thread.entries.map((entry) => entry.type === "tool" ? settleTool(entry)
    : entry.type === "assistant" && entry.streaming ? { type: entry.type, id: entry.id, text: entry.text } : entry) }
}

export function applyEvent(thread: Thread, session: string | null, event: AgentEventDto, actionId: () => string): Thread {
  const { entries } = thread
  if (event.type === "session.renamed" || event.type === "inbox.changed" || event.type === 'questions.changed') return thread
  if (event.type !== "raw" && event.sessionID !== session) return thread
  if (event.type === "client-action") return event.tracks.length
    ? { ...thread, entries: [...entries, { type: "action", id: actionId(), action: event }] } : thread

  if (event.type === "message.delta" || event.type === "message.snapshot") {
    if (!event.messageID) return thread
    const id = textId(event.messageID, event.ordinal ?? 0)
    const index = entries.findIndex((entry) => entry.id === id)
    const prior = entries[index]
    const text = event.type === "message.snapshot" ? event.text : (prior?.type === "assistant" ? prior.text : "") + event.append
    return { busy: true, entries: put(entries, index, { type: "assistant", id, text, ...(event.type === "message.delta" && { streaming: true }) }) }
  }

  const data = event.event.data as Record<string, unknown> | undefined
  if (!data || data.sessionID !== session) return thread
  const type = event.event.type
  if (type === "session.execution.started") return { ...thread, busy: true }
  if (["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"].includes(type)) {
    return finishThread(thread)
  }
  const message = data.assistantMessageID
  if (typeof message !== "string" || !message) return thread
  if (type === "session.text.started" && typeof data.ordinal === "number") {
    const id = textId(message, data.ordinal)
    // Reserve the position before the first (batched) delta arrives.
    if (entries.some((entry) => entry.id === id)) return thread
    return { entries: [...entries, { type: "assistant", id, text: "" }], busy: true }
  }
  if (!["session.tool.input.started", "session.tool.progress", "session.tool.success", "session.tool.failed"].includes(type)
      || typeof data.id !== "string" || !data.id) return thread
  const id = toolId(message, data.id)
  const index = entries.findIndex((entry) => entry.id === id)
  const previous = entries[index]
  const tool = previous?.type === "tool" ? previous : undefined
  const calls = toolCalls(data.metadata)
  const metadata = data.metadata as { error?: boolean } | undefined
  const status = type === "session.tool.failed" || metadata?.error === true ? "failed"
    : type === "session.tool.success" ? "done" : "running"
  const next: ToolEntry = { type: "tool", id, status,
    name: typeof data.name === "string" ? data.name : tool?.name ?? "",
    calls: calls.length ? calls : tool?.calls ?? [],
  }
  return { busy: true, entries: put(entries, index, status === "running" ? next : settleTool(next)) }
}

type ToolGroup = { type: "group"; id: string; tools: ToolEntry[] }
type QuestionRow = {type:'question';id:string;question:PendingQuestion} | {type:'answered';id:string;answered:readonly AnsweredQuestion[]}
export function timelineRows(entries: readonly Entry[], questions:readonly PendingQuestion[]=[]): Array<TextEntry | ToolGroup | ActionEntry | QuestionRow> {
  const rows: Array<TextEntry | ToolGroup | ActionEntry | QuestionRow> = []
  const pending=new Map(questions.map(q=>[toolId(q.messageID,q.callID),q]))
  for (const entry of entries) {
    if (entry.type === "assistant" && !entry.text.trim()) continue
    if (entry.type !== "tool") { rows.push(entry); continue }
    const question=pending.get(entry.id)
    if (question) { rows.push({type:'question',id:question.id,question}); pending.delete(entry.id); continue }
    if (entry.answered) { rows.push({type:'answered',id:entry.id,answered:entry.answered}); continue }
    const last = rows.at(-1)
    if (last?.type === "group") last.tools.push(entry)
    else rows.push({ type: "group", id: entry.id, tools: [entry] })
  }
  for(const question of pending.values()) rows.push({type:'question',id:question.id,question})
  return rows
}

const categories: Record<string, string> = {
  music_search: "曲库查询", music_facets: "曲库查询", music_artist_top: "曲库查询", music_album_tracks: "曲库查询", music_random: "曲库查询",
  music_recent_plays: "收听记录", music_most_played: "收听记录", music_favorites: "收藏", music_star: "收藏",
  music_enqueue: "播放队列", music_play_now: "播放队列", music_playlist_create: "歌单", music_playlist_add: "歌单",
}

export function describeTools(tools: readonly ToolEntry[]) {
  const calls = tools.flatMap((tool) => {
    // Count actual calls, not the execute wrapper twice. Surface a wrapper failure even if its children succeeded.
    const children: readonly ToolCall[] = tool.calls.length ? tool.calls : [tool]
    return children.map((call, i) => ({ ...call, id: `${tool.id}:${i}` }))
  })
  const counts = new Map<string, number>()
  for (const call of calls) {
    const category = categories[call.name] ?? "工具调用"
    counts.set(category, (counts.get(category) ?? 0) + 1)
  }
  return { calls, counts, failed: tools.some((tool) => tool.status === "failed") || calls.some((call) => call.status === "failed"),
    running: tools.some((tool) => tool.status === "running") }
}
