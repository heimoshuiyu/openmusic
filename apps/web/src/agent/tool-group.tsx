import { ChevronRight, CircleAlert, Loader2, Wrench } from "lucide-react"
import { memo } from "react"
import { describeTools, type ToolEntry } from "./timeline"

/** Native disclosure: mouse, touch and keyboard share one state, retained while the group grows. */
export const ToolGroup = memo(function ToolGroup({ tools, onToggle }: { tools: readonly ToolEntry[]; onToggle: () => void }) {
  const { calls, counts, failed, running } = describeTools(tools)
  return (
    <details className="group px-1 text-xs text-dim" onToggle={onToggle}>
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded py-1 hover:text-paper [&::-webkit-details-marker]:hidden">
        {failed ? <CircleAlert className="size-3.5 shrink-0 text-danger" /> : running
          ? <Loader2 className="size-3.5 shrink-0 motion-safe:animate-spin" /> : <Wrench className="size-3.5 shrink-0" />}
        <span className="min-w-0 flex-1">{Array.from(counts, ([name, count]) => `${name} ×${count}`).join("、")}</span>
        {failed && <span className="text-danger">有失败</span>}
        {running && <span>进行中</span>}
        <ChevronRight aria-hidden className="size-3.5 shrink-0 group-open:rotate-90" />
      </summary>
      <ol className="ml-1.5 mt-1 space-y-1.5 border-l border-line pl-4">
        {calls.map((call) => (
          <li key={call.id} className="flex items-baseline justify-between gap-2">
            <span className="min-w-0 break-all font-readout">{call.name || "工具调用"}</span>
            <span className={`shrink-0 ${call.status === "failed" ? "text-danger" : "text-dim"}`}>
              {{ failed: "失败", done: "完成", running: "进行中", stopped: "未完成" }[call.status]}
            </span>
          </li>
        ))}
      </ol>
      {tools.filter((tool) => tool.status === "failed" && tool.calls.length > 0).map((tool) => (
        <p key={tool.id} className="ml-6 mt-1 text-danger">{tool.name || "工具调用"} 执行失败</p>
      ))}
    </details>
  )
}, (a, b) => a.onToggle === b.onToggle && a.tools.length === b.tools.length && a.tools.every((tool, i) => tool === b.tools[i]))
