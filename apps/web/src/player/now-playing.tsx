import { useEffect, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import {
  Bot,
  ChevronDown,
  Heart,
  ListMusic,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward,
  X,
} from "lucide-react"
import { api, formatDuration } from "@/api/client"
import { useCurrentTrack, usePlayer } from "@/player/store"
import { CoverArt } from "@/components/cover"
import { GrooveMeter } from "./groove-meter"
import { LyricsPanel } from './lyrics-panel'
import { shouldSnap, useVerticalDrag } from "@/player/sheet-gesture"

/**
 * 正在播放（全屏）：旋转的专辑圆标，底层以同一张封面在当前明暗主题上着色。
 * 进入：点播放条封面/上箭头，或**播放栏向上拖**（sheet 跟手）；退出：Esc、
 * 收起按钮，或**层内向下拉**。拖动期位移由 store.nowPlayingDrag 驱动（跟手、
 * 无过渡），松手清 null 交给 showNowPlaying + CSS 过渡 snap——两态接力。
 */
export function NowPlaying() {
  const show = usePlayer((s) => s.showNowPlaying)
  const drag = usePlayer((s) => s.nowPlayingDrag)
  const track = useCurrentTrack()
  const playing = usePlayer((s) => s.playing)
  const position = usePlayer((s) => s.position)
  const duration = usePlayer((s) => s.duration)
  const volume = usePlayer((s) => s.volume)
  const shuffle = usePlayer((s) => s.shuffle)
  const repeat = usePlayer((s) => s.repeat)
  const showQueue = usePlayer((s) => s.showQueue)
  const queryClient = useQueryClient()
  // 收藏乐观覆盖：队列里的 TrackSummary 是入队时的快照，星标以覆盖表为准
  const [starOverride, setStarOverride] = useState<Record<string, boolean>>({})
  const [lyricsOpen,setLyricsOpen]=useState(false)
  const {
    toggle,
    next,
    previous,
    seek,
    setVolume,
    toggleShuffle,
    cycleRepeat,
    toggleNowPlaying,
  } = usePlayer.getState()

  useEffect(() => {
    if (!show) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") toggleNowPlaying()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [show, toggleNowPlaying])

  // ---- 下拉关闭（sheet 手势）：向下拖 → drag 递减跟手；松手双判定（位移/速度） ----
  const { setNowPlayingDrag } = usePlayer.getState()
  const dragHandlers = useVerticalDrag({
    onMove: (dy) => {
      if (dy <= 0) {
        if (usePlayer.getState().nowPlayingDrag !== null) setNowPlayingDrag(1)
        return
      }
      setNowPlayingDrag(Math.max(0, 1 - dy / window.innerHeight))
    },
    onEnd: (dy, vEnd) => {
      const dragged = dy / window.innerHeight
      // 关闭方向：下拖位移比例 / 向下速度（vEnd 向下为正）
      const close = shouldSnap(dragged, vEnd)
      setNowPlayingDrag(null)
      usePlayer.setState({ showNowPlaying: close ? false : true })
    },
  })

  // 显隐合成：拖动期完全由 drag 驱动；否则按 show 落位（CSS 过渡 snap）
  const dragging = drag !== null
  const open = dragging ? drag! : show ? 1 : 0
  const visible = open > 0.001
  const translateY = `${(1 - open) * 100}%`
  // 视差（Apple Music 招牌）：黑胶与信息区随打开度缩放/显隐——层滑入时内容
  // 先小后大「落座」，滑出时先退场。跟手映射（拖动的直接结果），非自主动画
  const discScale = 0.94 + 0.06 * open
  const infoOpacity = 0.55 + 0.45 * open

  if (!track) return null

  const pct = duration > 0 ? (position / duration) * 100 : 0
  const repeatTitle = repeat === "off" ? "关闭" : repeat === "all" ? "列表循环" : "单曲循环"

  return (
    <div
      className="np-sheet fixed inset-0 z-50 overflow-hidden bg-shell"
      data-dragging={dragging || undefined}
      style={{
        transform: `translateY(${translateY})`,
        visibility: visible ? "visible" : "hidden",
        touchAction: lyricsOpen ? "pan-y" : "none",
      }}
      role="dialog"
      aria-label="正在播放"
      {...dragHandlers}
    >
      <div aria-hidden="true" className="playback-wash">
        <CoverArt albumId={track.album.id} name={track.album.name} hasCover={track.hasCoverArt}
          monogram={false} className="h-full w-full" />
      </div>
      <div className="relative flex h-full flex-col">
        {/* 顶栏 */}
        <div className="flex shrink-0 items-center justify-between border-b border-line px-4 py-2 sm:px-8 sm:py-4">
          <button
            type="button"
            onClick={toggleNowPlaying}
            className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-dim transition-colors hover:text-paper"
            title="收起（Esc）"
          >
            <ChevronDown className="h-4 w-4" />
            收起
          </button>
          <span className="text-xs text-faint">正在播放</span>
          <div className="flex items-center gap-1"><button aria-pressed={lyricsOpen} onClick={()=>setLyricsOpen(!lyricsOpen)} className={`px-2 py-1.5 text-xs ${lyricsOpen?'text-accent':'text-dim'}`}>歌词</button><Link to="/assistant" onClick={toggleNowPlaying} aria-label="打开音乐助手" title="打开音乐助手" className="rounded-md p-2 text-dim hover:text-paper"><Bot className="size-4" /></Link>
          <button
            type="button"
            onClick={()=>{toggleNowPlaying();usePlayer.setState({showQueue:true})}}
            className={`rounded-md p-2 transition-colors hover:text-paper ${
              showQueue ? "text-accent" : "text-dim"
            }`}
            title="播放队列"
          >
            <ListMusic className="h-4 w-4" />
          </button></div>
        </div>

        {/* 主区：黑胶 + 信息（拖动视差：随 open 缩放/显影） */}
        <div className="playback-spread">
          {lyricsOpen ? (visible && <LyricsPanel id={track.id} position={position}/>) : <div className="playback-pressing" aria-hidden style={{ transform: `scale(${discScale})` }}>
            <div
              className={`playback-disc ${
                playing && visible ? "disc-spin" : "disc-spin disc-paused"
              }`}
            >
              <div className="absolute inset-[11%] overflow-hidden rounded-full ring-1 ring-white/20">
                <CoverArt albumId={track.album.id} name={track.album.name} hasCover={track.hasCoverArt} className="h-full w-full"/>
              </div>
              {/* 中孔 */}
              <div className="absolute left-1/2 top-1/2 size-[3%] -translate-x-1/2 -translate-y-1/2 rounded-full bg-shell ring-1 ring-black/35" />
              <GrooveMeter active={playing && visible}/>
            </div>
          </div>}

          {/* 信息 + 控制 */}
          <div
            className="playback-info flex w-full min-w-0 max-w-md flex-col items-stretch gap-5"
            style={{ opacity: infoOpacity }}
          >
            <div className="min-w-0">
              <h2 className="truncate font-display text-2xl font-bold tracking-tight md:text-3xl">
                {track.title}
              </h2>
              {/* 艺人/专辑名可点进入对应页；全屏层是 overlay，导航前先收层 */}
              <p className="mt-2 truncate text-base text-dim">
                <Link
                  to="/artists/$id"
                  params={{ id: track.artist.id }}
                  className="transition-colors hover:text-paper"
                  onClick={() => toggleNowPlaying()}
                >
                  {track.artist.name}
                </Link>
                <span className="text-faint"> · </span>
                <Link
                  to="/albums/$id"
                  params={{ id: track.album.id }}
                  className="transition-colors hover:text-paper"
                  onClick={() => toggleNowPlaying()}
                >
                  {track.album.name}
                </Link>
              </p>
            </div>

            <div className="w-full">
              {/* 进度 */}
              <div
                role="slider"
                tabIndex={0}
                aria-label="播放进度"
                aria-valuemin={0}
                aria-valuemax={Math.round(duration)}
                aria-valuenow={Math.round(position)}
                onClick={(event) => {
                  if (duration === 0) return
                  const rect = event.currentTarget.getBoundingClientRect()
                  seek(((event.clientX - rect.left) / rect.width) * duration)
                }}
                onKeyDown={(event) => {
                  if (duration === 0) return
                  if (event.key === "ArrowRight") seek(Math.min(duration, position + 5))
                  if (event.key === "ArrowLeft") seek(Math.max(0, position - 5))
                }}
                className="group relative h-5 cursor-pointer"
              >
                <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 overflow-hidden bg-line">
                  <div
                    className="h-full rounded-full bg-accent transition-[width] duration-150"
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
              <div className="tnum mt-1 flex justify-between text-[11px] text-faint">
                <span>{formatDuration(position)}</span>
                <span>-{formatDuration(Math.max(0, duration - position))}</span>
              </div>
            </div>

            <div className="relative flex w-full items-center justify-center gap-4">
              <button
                type="button"
                onClick={toggleShuffle}
                aria-pressed={shuffle}
                className={`rounded-md p-2 transition-colors hover:text-paper ${
                  shuffle ? "text-accent" : "text-dim"
                }`}
                title="随机播放"
              >
                <Shuffle className="h-5 w-5" />
              </button>
              <button
                type="button"
                onClick={previous}
                className="p-2 text-paper transition-colors hover:text-accent"
                title="上一首"
              >
                <SkipBack className="h-6 w-6 fill-current" />
              </button>
              <button
                type="button"
                onClick={toggle}
                aria-label={playing ? "暂停" : "播放"}
                className="mx-1 flex h-14 w-14 items-center justify-center rounded-full bg-paper text-shell transition-[filter] hover:brightness-90"
              >
                {playing ? (
                  <Pause className="h-6 w-6 fill-current" />
                ) : (
                  <Play className="ml-0.5 h-6 w-6 fill-current" />
                )}
              </button>
              <button
                type="button"
                onClick={next}
                className="p-2 text-paper transition-colors hover:text-accent"
                title="下一首"
              >
                <SkipForward className="h-6 w-6 fill-current" />
              </button>
              <button
                type="button"
                onClick={cycleRepeat}
                className={`rounded-md p-2 transition-colors hover:text-paper ${
                  repeat !== "off" ? "text-accent" : "text-dim"
                }`}
                title={`循环：${repeatTitle}`}
              >
                {repeat === "one" ? <Repeat1 className="h-5 w-5" /> : <Repeat className="h-5 w-5" />}
              </button>
              {/* 收藏：靠右对齐；琥珀=已收藏（语义：声音/激活态才用 accent） */}
              {(() => {
                const starred = starOverride[track.id] ?? Boolean(track.starred)
                return (
                  <button
                    type="button"
                    aria-label={starred ? "取消收藏" : "收藏"}
                    aria-pressed={starred}
                    title={starred ? "取消收藏" : "收藏"}
                    className={`absolute right-0 rounded-md p-2 transition-colors hover:text-paper ${
                      starred ? "text-accent" : "text-dim"
                    }`}
                    onClick={() => {
                      setStarOverride((prev) => ({ ...prev, [track.id]: !starred }))
                      const call = starred
                        ? api.unfavorite("tracks", track.id)
                        : api.favorite("tracks", track.id)
                      void call
                        .then(() => queryClient.invalidateQueries())
                        .catch(() => setStarOverride((prev) => ({ ...prev, [track.id]: starred })))
                    }}
                  >
                    <Heart className={`h-5 w-5 ${starred ? "fill-current" : ""}`} />
                  </button>
                )
              })()}
            </div>

            {/* 音量调节 */}
            <div className="flex w-full items-center gap-4">
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={volume}
                onChange={(event) => setVolume(Number(event.target.value))}
                aria-label="音量"
                className="w-28 accent-accent"
              />
              <button
                type="button"
                onClick={toggleNowPlaying}
                className="ml-auto rounded-md p-2 text-faint transition-colors hover:text-paper"
                title="关闭"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
