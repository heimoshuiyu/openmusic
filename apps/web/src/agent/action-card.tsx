import { formatDuration } from "@/api/client"
import { useAgentStore } from "./store"
import type { ActionEntry } from "./timeline"

export function ActionCard({ entry: { id, action } }: { entry: ActionEntry }) {
  const { acceptPending, dismissPending } = useAgentStore.getState()
  return (
    <div className="rounded-lg border border-line/60 bg-raised/60 p-3">
      <p className="mb-2 text-xs text-dim">
        {action.kind === "play-now" ? "助手想立即播放：" : "助手想加入队列："}
        <span className="tnum ml-1 text-faint">{action.tracks.length} 首</span>
      </p>
      <ul className="mb-3 max-h-32 space-y-1 overflow-y-auto text-xs">
        {action.tracks.slice(0, 8).map((track, i) => (
          <li key={`${track.id}:${i}`} className="flex items-baseline justify-between gap-2">
            <span className="truncate text-paper">{track.title}<span className="text-faint"> · {track.artist}</span></span>
            <span className="tnum shrink-0 text-faint">{formatDuration(track.durationSeconds)}</span>
          </li>
        ))}
        {action.tracks.length > 8 && <li className="tnum text-faint">… 共 {action.tracks.length} 首</li>}
      </ul>
      <div className="flex gap-2">
        <button type="button" className="rounded-md bg-paper px-3 py-1.5 text-xs font-medium text-shell hover:brightness-90" onClick={() => void acceptPending(id)}>
          {action.kind === "play-now" ? "立即播放" : "加入队列"}
        </button>
        <button type="button" className="rounded-md border border-line/60 px-3 py-1.5 text-xs text-dim hover:text-paper" onClick={() => dismissPending(id)}>忽略</button>
      </div>
    </div>
  )
}
