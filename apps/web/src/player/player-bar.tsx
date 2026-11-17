import { useEffect, useRef } from "react"
import { Link } from "@tanstack/react-router"
import {
  ChevronUp,
  ListMusic,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward,
  Volume2,
} from "lucide-react"
import { formatDuration } from "@/api/client"
import { useCurrentTrack, usePlayer } from "@/player/store"
import { CoverArt } from "@/components/cover"
import { shouldSnap, useVerticalDrag } from "@/player/sheet-gesture"

/** 底部播放条（Apple Music 式）：顶部通栏细进度，中部传送，右侧音量/队列。
 *  向上拖 = 拉开正在播放（sheet 跟手；按钮/滑块/链接不受影响） */
export function PlayerBar() {
  const track = useCurrentTrack()
  const playing = usePlayer((s) => s.playing)
  const position = usePlayer((s) => s.position)
  const duration = usePlayer((s) => s.duration)
  const volume = usePlayer((s) => s.volume)
  const shuffle = usePlayer((s) => s.shuffle)
  const repeat = usePlayer((s) => s.repeat)
  const showQueue = usePlayer((s) => s.showQueue)
  const { toggle, next, previous, seek, setVolume, toggleShuffle, cycleRepeat, toggleQueue, toggleNowPlaying } =
    usePlayer.getState()
  const seekRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    Object.assign(usePlayer.getState())
  }, [])

  const seekFromEvent = (clientX: number) => {
    if (duration === 0 || !seekRef.current) return
    const rect = seekRef.current.getBoundingClientRect()
    seek(Math.min(duration, Math.max(0, ((clientX - rect.left) / rect.width) * duration)))
  }

  const onSeekKey = (event: React.KeyboardEvent) => {
    if (duration === 0) return
    if (event.key === "ArrowRight") seek(Math.min(duration, position + 5))
    if (event.key === "ArrowLeft") seek(Math.max(0, position - 5))
    if (event.key === "Home") seek(0)
    if (event.key === "End") seek(duration)
  }

  const pct = duration > 0 ? (position / duration) * 100 : 0
  const repeatTitle = repeat === "off" ? "关闭" : repeat === "all" ? "列表循环" : "单曲循环"

  // ---- 上拖拉开正在播放：进度 = -dy/视口高，跟手写 nowPlayingDrag；松手 snap ----
  const { setNowPlayingDrag } = usePlayer.getState()
  const dragHandlers = useVerticalDrag({
    onMove: (dy) => {
      if (dy >= 0) {
        if (usePlayer.getState().nowPlayingDrag !== null) setNowPlayingDrag(0)
        return
      }
      setNowPlayingDrag(Math.min(1, -dy / window.innerHeight))
    },
    onEnd: (dy, vEnd) => {
      const dragged = -dy / window.innerHeight
      // 打开方向：上拖位移比例 / 向上速度（vEnd 向下为正，取负）
      const openIt = shouldSnap(dragged, -vEnd)
      setNowPlayingDrag(null)
      usePlayer.setState({ showNowPlaying: openIt })
    },
  })

  return (
    <footer
      className="fixed inset-x-0 bottom-0 z-40 touch-none bg-shell shadow-[0_-1px_var(--color-line)]"
      style={{ touchAction: "none" }}
      {...dragHandlers}
    >
      {/* 通栏进度 */}
      <div
        ref={seekRef}
        role="slider"
        tabIndex={0}
        aria-label="播放进度"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(position)}
        onKeyDown={onSeekKey}
        onClick={(event) => seekFromEvent(event.clientX)}
        className="group relative h-3.5 cursor-pointer"
      >
        <div className="absolute inset-x-0 top-1/2 h-[2px] -translate-y-1/2 bg-line/80 transition-[height] group-hover:h-1">
          <div className="h-full bg-accent transition-[width] duration-150" style={{ width: `${pct}%` }} />
        </div>
        <div
          className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent opacity-0 shadow transition-opacity group-hover:opacity-100"
          style={{ left: `${pct}%` }}
        />
      </div>

      <div className="grid h-14 grid-cols-[1fr_auto_1fr] items-center gap-3 px-4">
        {/* 左：封面（点开正在播放）+ 曲目信息 */}
        <div className="flex min-w-0 items-center gap-3">
          {track ? (
            <>
              <button
                type="button"
                onClick={toggleNowPlaying}
                title="正在播放"
                className="relative shrink-0"
              >
                <CoverArt
                  albumId={track.album.id}
                  name={track.album.name}
                  hasCover={track.hasCoverArt}
                  className="h-10 w-10"
                  rounded="rounded-[4px]"
                  monogram={false}
                />
                <span className="absolute inset-0 flex items-center justify-center rounded-[4px] bg-black/50 opacity-0 transition-opacity hover:opacity-100">
                  <ChevronUp className="h-4 w-4 text-white" />
                </span>
              </button>
              <div className="min-w-0">
                <div className="truncate text-[13px] font-medium leading-tight">{track.title}</div>
                <div className="truncate text-xs leading-tight text-dim">
                  {track.artist.name}
                  <span className="text-faint"> · </span>
                  <Link to="/albums/$id" params={{ id: track.album.id }} className="hover:text-paper">
                    {track.album.name}
                  </Link>
                </div>
              </div>
            </>
          ) : (
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-[4px] bg-raised text-faint">
                <ListMusic className="h-4 w-4" />
              </div>
              <div className="hidden text-[13px] text-dim sm:block">未播放</div>
            </div>
          )}
        </div>

        {/* 中：传送 */}
        <div className="flex items-center gap-1 sm:gap-2">
          <button
            type="button"
            onClick={toggleShuffle}
            aria-pressed={shuffle}
            className={`rounded-md p-2 transition-colors hover:text-paper ${
              shuffle ? "text-accent" : "text-dim"
            }`}
            title="随机播放"
          >
            <Shuffle className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={previous}
            className="rounded-md p-2 text-paper transition-colors hover:text-accent"
            title="上一首"
          >
            <SkipBack className="h-[18px] w-[18px] fill-current" />
          </button>
          <button
            type="button"
            onClick={toggle}
            aria-label={playing ? "暂停" : "播放"}
            className="mx-1 flex h-9 w-10 items-center justify-center bg-paper text-shell hover:opacity-85"
            title={playing ? "暂停" : "播放"}
          >
            {playing ? (
              <Pause className="h-4 w-4 fill-current" />
            ) : (
              <Play className="ml-0.5 h-4 w-4 fill-current" />
            )}
          </button>
          <button
            type="button"
            onClick={next}
            className="rounded-md p-2 text-paper transition-colors hover:text-accent"
            title="下一首"
          >
            <SkipForward className="h-[18px] w-[18px] fill-current" />
          </button>
          <button
            type="button"
            onClick={cycleRepeat}
            className={`rounded-md p-2 transition-colors hover:text-paper ${
              repeat !== "off" ? "text-accent" : "text-dim"
            }`}
            title={`循环：${repeatTitle}`}
          >
            {repeat === "one" ? <Repeat1 className="h-4 w-4" /> : <Repeat className="h-4 w-4" />}
          </button>
        </div>

        {/* 右：时间码 / 音量 / 队列 */}
        <div className="flex flex-1 items-center justify-end gap-3">
          <span className="tnum hidden text-xs text-dim sm:block">
            {formatDuration(position)}
            <span className="text-faint"> / {formatDuration(duration)}</span>
          </span>
          <div className="hidden items-center gap-1.5 md:flex">
            <Volume2 className="h-3.5 w-3.5 text-faint" />
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={volume}
              onChange={(event) => setVolume(Number(event.target.value))}
              aria-label="音量"
              className="w-20 accent-accent"
            />
          </div>
          <button
            type="button"
            onClick={toggleQueue}
            className={`rounded-md p-2 transition-colors hover:text-paper ${
              showQueue ? "text-accent" : "text-dim"
            }`}
            title="播放队列"
          >
            <ListMusic className="h-4 w-4" />
          </button>
        </div>
      </div>
    </footer>
  )
}
