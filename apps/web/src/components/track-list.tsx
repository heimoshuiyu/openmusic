import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useVirtualizer } from "@tanstack/react-virtual"
import { Heart, Play, Plus } from "lucide-react"
import { api, formatDuration } from "@/api/client"
import { usePlayer, useCurrentTrack } from "@/player/store"
import { CoverArt } from "@/components/cover"
import type { TrackSummary } from "@/api/client"

/** 墓碑行：曲目已不在库中（plays 事件快照，docs/04 §2.8）——灰显、不可播 */
export interface DeletedTrackRow {
  readonly deleted: true
  readonly title: string
  readonly artistName: string
  readonly albumName: string
  readonly durationSeconds: number
}

/**
 * 虚拟化曲目列表：万级曲目/巨型合辑（散文件聚合的 Unknown Album）只渲染可视行。
 * 滚动容器 = 最近的 <main>（app-layout 的 overflow-y-auto）；表格语义以 CSS grid 复刻。
 */
const compactColumns = "grid-cols-[1.9rem_minmax(0,1.8fr)_minmax(0,1fr)_3.5rem]"

export function TrackList({
  tracks,
  showAlbum = true,
}: {
  tracks: ReadonlyArray<TrackSummary | DeletedTrackRow>
  showAlbum?: boolean
}) {
  const playNow = usePlayer((s) => s.playNow)
  const enqueue = usePlayer((s) => s.enqueue)
  const queryClient = useQueryClient()
  const current = useCurrentTrack()
  const playingId = current?.id
  const columns = `${compactColumns} ${showAlbum ? "md:grid-cols-[2.5rem_minmax(0,1.8fr)_minmax(0,1.2fr)_minmax(0,1.2fr)_4rem_5rem]" : "md:grid-cols-[2.5rem_minmax(0,1.8fr)_minmax(0,1.2fr)_4rem_5rem]"}`

  const toggleStar = (track: TrackSummary) => {
    const call = track.starred
      ? api.unfavorite("tracks", track.id)
      : api.favorite("tracks", track.id)
    // starred 态随列表查询下发（album/artist/tracks/search/random），全部失效才回得来
    void call.then(() => queryClient.invalidateQueries())
  }

  // 播放队列只含活曲（墓碑不可播）
  const aliveTracks = tracks.filter((t): t is TrackSummary => !("deleted" in t))

  const listRef = useRef<HTMLDivElement | null>(null)
  const [scrollMargin, setScrollMargin] = useState(0)
  useLayoutEffect(() => {
    const el = listRef.current
    const main = el?.closest("main")
    if (el !== null && main !== null && main !== undefined) {
      setScrollMargin(el.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop)
    }
  }, [])
  const virtualizer = useVirtualizer({
    count: tracks.length,
    getScrollElement: () => (listRef.current?.closest("main") as HTMLElement | null),
    estimateSize: () => 45,
    overscan: 12,
    scrollMargin,
  })
  const virtualItems = virtualizer.getVirtualItems()

  return (
    <div className="w-full text-sm">
      <div
        className={`track-columns grid ${columns} items-center border-y border-line py-2 pl-2 pr-3 text-left text-xs text-faint`}
      >
        <span className="font-normal">#</span>
        <span className="font-normal">标题</span>
        <span className="font-normal">艺人</span>
        {showAlbum && <span className="hidden font-normal md:block">专辑</span>}
        <span className="hidden font-normal md:block">时长</span>
        <span className="font-normal" aria-label="操作" />
      </div>
      <div ref={listRef} className="relative" style={{ height: virtualizer.getTotalSize() }}>
        {/* 行锚定容器：vi.start 以滚动内容顶部为原点，行内各自减 scrollMargin
            换算成容器内偏移（官方窗口滚动模式的逐行 transform，勿合并进容器） */}
        <div className="absolute left-0 top-0 w-full">
          {virtualItems.map((vi) => {
            const row = tracks[vi.index]!
            if ("deleted" in row) {
              return (
                <div
                  key={`tomb-${vi.key}`}
                  data-index={vi.index}
                  ref={virtualizer.measureElement}
                  style={{ transform: `translateY(${vi.start - scrollMargin}px)` }}
                  className={`absolute left-0 top-0 grid w-full ${columns} items-center border-b border-line/40 py-1.5 pl-2 pr-3`}
                >
                  <span aria-hidden />
                  <span className="flex min-w-0 items-center gap-2.5">
                    {/* 虚线空框 = 封面已无处可取；空即信息 */}
                    <span className="h-8 w-8 shrink-0 rounded-[3px] border border-dashed border-line" aria-hidden />
                    <span className="truncate text-dim">{row.title}</span>
                    <span className="shrink-0 rounded-sm border border-line px-1 text-[10px] leading-4 text-faint">
                      已删除
                    </span>
                  </span>
                  <span className="truncate text-faint">{row.artistName}</span>
                  {showAlbum && <span className="hidden truncate text-faint md:block">{row.albumName}</span>}
                  <span className="tnum hidden text-xs text-faint md:block">
                    {formatDuration(row.durationSeconds)}
                  </span>
                  <span />
                </div>
              )
            }
            const track = row
            const index = vi.index
            const isCurrent = track.id === playingId
            const aliveIndex = tracks.slice(0, index).filter((t) => !("deleted" in t)).length
            return (
              <div
                key={`${track.id}-${vi.key}`}
                data-index={vi.index}
                ref={virtualizer.measureElement}
                style={{ transform: `translateY(${vi.start - scrollMargin}px)` }}
                className={`group absolute left-0 top-0 grid w-full ${columns} items-center border-b border-line/40 py-1.5 pl-2 pr-3 transition-colors hover:bg-raised/50`}
                onDoubleClick={() => playNow(aliveTracks, aliveIndex)}
              >
                <span className="relative flex h-4 items-center text-xs text-faint">
                  <button
                    type="button"
                    aria-label={`播放 ${track.title}`}
                    className="absolute -left-1 flex h-8 w-7 items-center justify-start transition-opacity hoverable:opacity-0 hoverable:group-hover:opacity-100 focus-visible:opacity-100"
                    onClick={() => playNow(aliveTracks, aliveIndex)}
                    title="播放"
                  >
                    <Play className="h-3.5 w-3.5 fill-current text-paper" />
                  </button>
                  {isCurrent ? (
                    <span className="pointer-events-none hidden h-3.5 items-end gap-[2px] hoverable:flex hoverable:group-hover:hidden" aria-label="正在播放">
                      {[0, 1, 2].map((bar) => (
                        <span
                          key={bar}
                          className="eq-bar h-3 w-[2.5px] rounded-[1px] bg-accent"
                          style={{ animationDelay: `${bar * 0.18}s` }}
                        />
                      ))}
                    </span>
                  ) : (
                    <span className="pointer-events-none hidden hoverable:block hoverable:group-hover:hidden">{track.track ?? index + 1}</span>
                  )}
                </span>
                <span className="flex min-w-0 items-center gap-2.5">
                  <CoverArt
                    albumId={track.album.id}
                    name={track.album.name}
                    hasCover={track.hasCoverArt}
                    className="h-8 w-8"
                    rounded="rounded-[3px]"
                    monogram={false}
                  />
                  <span className={`truncate ${isCurrent ? "text-accent" : ""}`}>{track.title}</span>
                  {track.versionCount !== undefined && track.versionCount > 1 && (
                    <VersionBadge
                      track={track}
                      onPick={(version) => {
                        // 以选中的副本顶替本行起播：队列里这首就是用户挑的那份
                        const swapped = aliveTracks.map((t, i) => (i === aliveIndex ? version : t))
                        playNow(swapped, aliveIndex)
                      }}
                    />
                  )}
                </span>
                <Link
                  to="/artists/$id"
                  params={{ id: track.artist.id }}
                  className="truncate text-dim transition-colors hover:text-paper"
                  onClick={(event) => event.stopPropagation()}
                >
                  {track.artist.name}
                </Link>
                {showAlbum && (
                  <Link
                    to="/albums/$id"
                    params={{ id: track.album.id }}
                    className="hidden truncate text-dim transition-colors hover:text-paper md:block"
                    onClick={(event) => event.stopPropagation()}
                  >
                    {track.album.name}
                  </Link>
                )}
                <span className="tnum hidden text-xs text-dim md:block">
                  {formatDuration(track.durationSeconds)}
                </span>
                <span className="flex items-center justify-end gap-1">
                  <button
                    type="button"
                    aria-label={track.starred ? "取消收藏" : "收藏"}
                    title={track.starred ? "取消收藏" : "收藏"}
                    className={`p-1 transition-opacity hoverable:hover:text-accent ${
                      track.starred
                        ? "text-accent"
                        : "text-faint hoverable:opacity-0 hoverable:group-hover:opacity-100"
                    }`}
                    onClick={() => toggleStar(track)}
                  >
                    <Heart className={`h-4 w-4 ${track.starred ? "fill-current" : ""}`} />
                  </button>
                  <button
                    type="button"
                    className="p-1 text-faint transition-opacity hoverable:hover:text-paper hoverable:opacity-0 hoverable:group-hover:opacity-100"
                    onClick={() => enqueue([track])}
                    title="加入队列"
                    aria-label={`将 ${track.title} 加入队列`}
                  >
                    <Plus className="h-4 w-4" />
                  </button>
                </span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

/** 版本徽标（×N）：点击弹出该槽位全部物理副本（懒加载 /tracks/:id/versions），
 *  首位 = 当前标准版本；点选副本即以它顶替本行起播。来源目录帮助辨认拷贝 */
function VersionBadge({
  track,
  onPick,
}: {
  track: TrackSummary
  onPick: (version: TrackSummary) => void
}) {
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState({ x: 0, y: 0 })
  const [versions, setVersions] = useState<TrackSummary[] | null>(null)
  const badgeRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (!open || versions !== null) return
    void api.trackVersions(track.id).then(setVersions).catch(() => setVersions([]))
  }, [open, versions, track.id])

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => {
      if (!(event.target as HTMLElement).closest(".version-popover, .version-badge")) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false)
    }
    window.addEventListener("mousedown", close)
    window.addEventListener("keydown", onKey)
    return () => {
      window.removeEventListener("mousedown", close)
      window.removeEventListener("keydown", onKey)
    }
  }, [open])

  const dirOf = (path: string | undefined) => {
    if (path === undefined) return ""
    const segs = path.split("/")
    return segs.slice(0, -1).slice(-3).join("/")
  }

  return (
    <>
      <button
        ref={badgeRef}
        type="button"
        className="version-badge tnum shrink-0 rounded-sm bg-raised/80 px-1 py-px text-[10px] text-dim transition-colors hover:bg-raised hover:text-paper"
        title={`同一首歌有 ${track.versionCount} 份拷贝（不同来源/音质）——点击选择播放版本`}
        onClick={(event) => {
          event.stopPropagation()
          const rect = badgeRef.current!.getBoundingClientRect()
          setAnchor({ x: rect.left, y: rect.bottom + 6 })
          setOpen((v) => !v)
        }}
      >
        ×{track.versionCount}
      </button>
      {open && (
        <div
          className="version-popover fixed z-50 w-72 rounded-md border border-line bg-panel p-1 shadow-xl"
          style={{ left: Math.min(anchor.x, window.innerWidth - 300), top: anchor.y }}
        >
          <div className="px-2 py-1 text-[11px] text-faint">选择播放版本</div>
          {(versions ?? []).map((version, index) => (
            <button
              key={version.id}
              type="button"
              className="flex w-full flex-col gap-0.5 rounded px-2 py-1.5 text-left transition-colors hover:bg-raised/70"
              onClick={() => {
                setOpen(false)
                onPick(version)
              }}
            >
              <span className="flex items-center gap-2 text-xs">
                <span className="uppercase text-dim">{version.codec}</span>
                <span className="tnum text-dim">
                  {version.sampleRateHz / 1000}kHz · {version.bitrateKbps}k
                </span>
                {index === 0 && <span className="text-[10px] text-accent">标准版</span>}
              </span>
              <span className="truncate text-[10px] text-faint" title={version.path}>
                {dirOf(version.path) || "—"}
              </span>
            </button>
          ))}
          {versions !== null && versions.length === 0 && (
            <div className="px-2 py-1.5 text-xs text-faint">版本信息不可用</div>
          )}
        </div>
      )}
    </>
  )
}
