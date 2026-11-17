/** Only the presentation fields cross the history API; never copy tool input/output or reasoning. */
export type ToolStatus = "running" | "done" | "failed" | "stopped"
export interface ToolCall {
  name: string
  status: ToolStatus
}
export interface PendingQuestion {
  id: string
  messageID: string
  callID: string
  fields: readonly { title: string; prompt: string; multiple: boolean; options: readonly {label:string; description:string}[] }[]
}
export interface AnsweredQuestion { prompt: string; answers: readonly string[] }
export type AgentPart =
  | { type: "text"; ordinal: number; text: string }
  | ({ type: "tool"; id: string; calls: readonly ToolCall[]; answered?: readonly AnsweredQuestion[] } & ToolCall)
type ToolPart = Extract<AgentPart, { type: "tool" }>

/** A terminated execution may never send the last progress update for an inner call. */
export function settleTool(tool: ToolPart): ToolPart {
  if (tool.status !== "running" && !tool.calls.some((call) => call.status === "running")) return tool
  return {
    ...tool,
    status: tool.status === "running" ? "stopped" : tool.status,
    calls: tool.calls.map((call) => call.status === "running" ? { ...call, status: "stopped" } : call),
  }
}

export function toolStatus(status: unknown): ToolStatus {
  return status === "completed" ? "done" : status === "error" ? "failed" : "running"
}

/** Code Mode publishes a cumulative list in both progress and the final tool metadata. */
export function toolCalls(metadata: unknown): ToolCall[] {
  if (!metadata || typeof metadata !== "object" || !("toolCalls" in metadata) || !Array.isArray(metadata.toolCalls)) return []
  return metadata.toolCalls.flatMap((call) => typeof call?.tool === "string"
    ? [{ name: call.tool, status: toolStatus(call.status) }]
    : [])
}
