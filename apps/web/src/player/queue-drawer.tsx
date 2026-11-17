import { useEffect, useState } from "react"
import { ListMusic, X } from "lucide-react"
import { formatDuration } from "@/api/client"
import { useCurrentTrack, usePlayer } from "@/player/store"
import { CoverArt } from "@/components/cover"
import {
  AUDIO_CACHE_CHANGED,
  audioCacheStats,
  clearAudioCache,
  type AudioCacheStats,
} from "@/player/audio-cache"

const formatBytes = (bytes: number): string => {
  if (bytes < 1024 * 1024) return `${Math.max(0, Math.round(bytes / 1024))} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export function QueueDrawer() {
  const showQueue = usePlayer((s) => s.showQueue)
  const queue = usePlayer((s) => s.queue)
  const index = usePlayer((s) => s.index)
  const { jumpTo, removeFromQueue, clearQueue, toggleQueue } = usePlayer.getState()
  const current = useCurrentTrack()
  const [cache, setCache] = useState<AudioCacheStats>({ entries: 0, bytes: 0 })

  useEffect(() => {
    if (!showQueue) return
    let disposed = false
    const refresh = () => {
      void audioCacheStats().then((stats) => {
        if (!disposed) setCache(stats)
      })
    }
    refresh()
    window.addEventListener(AUDIO_CACHE_CHANGED, refresh)
    return () => {
      disposed = true
      window.removeEventListener(AUDIO_CACHE_CHANGED, refresh)
    }
  }, [showQueue])

  if (!showQueue) return null

  return (
    <aside aria-label="播放队列" className="fixed right-0 top-0 z-30 flex h-[calc(100%-4.375rem)] w-96 max-w-full flex-col border-l border-line bg-shell shadow-lg">
      <div className="flex items-center justify-between border-b border-paper px-4 py-4">
        <span className="flex items-center gap-2 text-sm font-medium text-paper">
          <ListMusic className="h-4 w-4 text-dim" />
          播放队列
          <span className="tnum text-xs text-faint">{queue.length}</span>
        </span>
        <div className="flex gap-3 text-xs text-faint">
          <button type="button" className="transition-colors hover:text-paper" onClick={clearQueue}>
            清空
          </button>
          <button type="button" className="transition-colors hover:text-paper" onClick={toggleQueue}>
            关闭
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        {queue.length === 0 && (
          <div className="p-4 text-sm text-dim">队列为空</div>
        )}
        {queue.map((track, position) => {
          const isCurrent = current?.id === track.id && position === index
          return (
            <div
              key={`${track.id}-${position}`}
              className={`group relative flex items-center gap-2 px-3 py-2 text-sm transition-colors ${
                isCurrent ? "bg-raised/70" : "hover:bg-raised/40"
              }`}
            >
              {isCurrent && (
                <span
                  className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-accent"
                  aria-hidden
                />
              )}
              <button
                type="button"
                onClick={() => jumpTo(position)}
                className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
              >
                <CoverArt
                  albumId={track.album.id}
                  name={track.album.name}
                  hasCover={track.hasCoverArt}
                  className="h-9 w-9"
                  rounded="rounded-[2px]"
                  monogram={false}
                />
                <div className="min-w-0">
                  <div className={`truncate ${isCurrent ? "text-accent" : "text-paper"}`}>
                    {track.title}
                  </div>
                  <div className="truncate text-xs text-dim">
                    {track.artist.name}
                    <span className="tnum text-[10px] text-faint">
                      {" "}
                      {formatDuration(track.durationSeconds)}
                    </span>
                  </div>
                </div>
              </button>
              <button
                type="button"
                className="p-2 text-faint hover:text-paper hoverable:opacity-0 hoverable:group-hover:opacity-100 focus-visible:opacity-100"
                onClick={() => removeFromQueue(position)}
                title="移除"
                aria-label={`移除 ${track.title}`}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )
        })}
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-line/60 px-4 py-2.5 text-[11px] text-faint">
        <span className="font-readout tnum">
          缓存 {cache.entries} 首 · {formatBytes(cache.bytes)}
        </span>
        <button
          type="button"
          className="shrink-0 transition-colors hover:text-paper"
          onClick={() => {
            void clearAudioCache().then(() => audioCacheStats()).then(setCache)
          }}
        >
          清空缓存
        </button>
      </div>
    </aside>
  )
}
