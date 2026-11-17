import { create } from "zustand"
import { api, streamUrl, type TrackSummary } from "@/api/client"
import { initAnalyser } from "@/player/analyser"
import {
  deleteCachedAudio,
  readCachedAudio,
  writeCachedAudio,
} from "@/player/audio-cache"

export type RepeatMode = "off" | "all" | "one"

interface PlayerState {
  queue: TrackSummary[]
  index: number
  playing: boolean
  volume: number
  shuffle: boolean
  repeat: RepeatMode
  showQueue: boolean
  showNowPlaying: boolean
  /** 手势期打开进度（0..1，null=非拖动中）——驱动 NowPlaying 层跟手位移 */
  nowPlayingDrag: number | null
  setNowPlayingDrag: (progress: number | null) => void
  position: number
  duration: number

  playNow: (tracks: ReadonlyArray<TrackSummary>, startIndex?: number) => void
  playTrack: (track: TrackSummary) => void
  enqueue: (tracks: ReadonlyArray<TrackSummary>) => void
  enqueueNext: (track: TrackSummary) => void
  toggle: () => void
  next: () => void
  previous: () => void
  seek: (seconds: number) => void
  setVolume: (volume: number) => void
  toggleShuffle: () => void
  cycleRepeat: () => void
  toggleQueue: () => void
  toggleNowPlaying: () => void
  removeFromQueue: (position: number) => void
  jumpTo: (position: number) => void
  clearQueue: () => void
}

const audio = new Audio()
audio.preload = "auto"

let scrobbled = false

/** 解码失败回退：当前曲换 ?format=mp3&maxBitRate=320 重试一次（每曲限一次，
 *  与 Android 的 transcoded 集合同款语义）——Safari 不解 ogg/opus、浏览器
 *  不解 ape/wavpack 等场景由服务器转码兜底 */
let transcodeFallback = false
const srcFor = (trackId: string) =>
  transcodeFallback ? `${streamUrl(trackId)}?format=mp3&maxBitRate=320` : streamUrl(trackId)

/** 起播稳定后才补缓存：快速切歌不浪费一次整首下载 */
const CACHE_DELAY_MS = 8000

const cacheVersionFor = (track: TrackSummary) => `${track.createdAt}:${track.sizeBytes}`

/** 缓存命中时 <audio> 的 blob URL 需要手动释放，否则整首字节一直挂在内存里 */
let objectUrl: string | null = null
/** 逻辑流地址（不含 blob）：断点自愈重连时仍从同一个 URL 取 */
let logicalSrc: string | null = null
/** 源代数：快速切歌时让过期的异步缓存查询 / play 回调失效 */
let sourceGeneration = 0
/** 后台写缓存的取消器（切歌即取消） */
let cacheAbort: AbortController | null = null
let cacheTimer: number | null = null

const releaseObjectUrl = () => {
  if (objectUrl !== null) {
    URL.revokeObjectURL(objectUrl)
    objectUrl = null
  }
}

const cancelCacheJob = () => {
  if (cacheTimer !== null) {
    window.clearTimeout(cacheTimer)
    cacheTimer = null
  }
  cacheAbort?.abort()
  cacheAbort = null
}

const scheduleCache = (url: string, version: string, generation: number) => {
  const controller = new AbortController()
  cacheAbort = controller
  cacheTimer = window.setTimeout(() => {
    cacheTimer = null
    if (generation !== sourceGeneration || controller.signal.aborted) return
    // 没真正听起来的曲目不占缓存（<3s 的预览式切歌）
    if (audio.currentTime < 3) return
    void writeCachedAudio(url, version, controller.signal).catch(() => {})
  }, CACHE_DELAY_MS)
}

export const usePlayer = create<PlayerState>((set, get) => {
  const current = () => get().queue[get().index]

  /** 切源：缓存命中走本地 blob；未命中走网络流并在后台补缓存 */
  const setSource = (url: string, track: TrackSummary, position?: number) => {
    const generation = ++sourceGeneration
    cancelCacheJob()
    releaseObjectUrl()
    audio.pause()
    audio.removeAttribute("src")
    logicalSrc = url
    const version = cacheVersionFor(track)
    void (async () => {
      const cached = await readCachedAudio(url, version)
      if (generation !== sourceGeneration) return
      if (cached !== null) {
        const blobUrl = URL.createObjectURL(cached)
        objectUrl = blobUrl
        audio.src = blobUrl
      } else {
        audio.src = url
      }
      if (position !== undefined) {
        const seek = () => {
          audio.currentTime = position
        }
        if (audio.readyState >= 1) seek()
        else audio.addEventListener("loadedmetadata", seek, { once: true })
      }
      audio.play().catch(() => {
        if (generation === sourceGeneration) set({ playing: false })
      })
      if (cached === null) scheduleCache(url, version, generation)
    })()
  }

  const loadCurrent = () => {
    const track = current()
    if (track === undefined) {
      sourceGeneration += 1
      cancelCacheJob()
      releaseObjectUrl()
      logicalSrc = null
      audio.pause()
      audio.removeAttribute("src")
      set({ playing: false, position: 0, duration: 0 })
      return
    }
    scrobbled = false
    transcodeFallback = false
    setSource(srcFor(track.id), track)
    updateMediaSession(track)
  }

  const updateMediaSession = (track: TrackSummary) => {
    if (!("mediaSession" in navigator)) return
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist.name,
      album: track.album.name,
      artwork: track.hasCoverArt
        ? [{ src: coverUrlSafe(track.album.id), sizes: "300x300", type: "image/jpeg" }]
        : [],
    })
  }

  const coverUrlSafe = (albumId: string) => `/api/v1/covers/al-${albumId}`

  const advance = (direction: 1 | -1) => {
    const { index, queue, shuffle, repeat } = get()
    if (queue.length === 0) return
    let nextIndex: number
    if (shuffle && queue.length > 1) {
      do {
        nextIndex = Math.floor(Math.random() * queue.length)
      } while (nextIndex === index)
    } else {
      nextIndex = index + direction
      if (nextIndex >= queue.length) {
        if (repeat === "all") {
          nextIndex = 0
        } else {
          audio.pause()
          set({ playing: false })
          return
        }
      }
      if (nextIndex < 0) nextIndex = 0
    }
    set({ index: nextIndex })
    loadCurrent()
  }

  audio.addEventListener("timeupdate", () => {
    const track = current()
    set({ position: audio.currentTime, duration: audio.duration || track?.durationSeconds || 0 })
    // scrobble：>50% 或 >4 分钟（docs/04 §2.8，客户端判定）
    // listenedSeconds = 触发瞬间真实进度（seek 误差可忽略）
    if (track && !scrobbled && audio.duration > 0) {
      if (audio.currentTime / audio.duration > 0.5 || audio.currentTime > 240) {
        scrobbled = true
        api
          .recordPlay(track.id, Math.max(0, Math.floor(Math.min(audio.currentTime, audio.duration))))
          .catch(() => {})
      }
    }
  })
  audio.addEventListener("ended", () => {
    const track = current()
    if (track && !scrobbled) {
      scrobbled = true
      const total =
        Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : track.durationSeconds
      api.recordPlay(track.id, Math.max(0, Math.floor(total))).catch(() => {})
    }
    if (get().repeat === "one") {
      audio.currentTime = 0
      audio.play().catch(() => {})
      return
    }
    advance(1)
  })
  audio.addEventListener("play", () => {
    initAnalyser(audio)
    set({ playing: true })
  })
  audio.addEventListener("pause", () => set({ playing: false }))
  // 流中断/解码失败：缓存 blob 坏了 → 删条目回退网络源；网络源失败 → 同曲
  // 转码 mp3 兜底一次；再失败才停（元素停止但不会自动同步到 store，否则转圈不止）
  audio.addEventListener("error", () => {
    const track = current()
    if (
      track !== undefined &&
      objectUrl !== null &&
      logicalSrc !== null &&
      audio.src === objectUrl
    ) {
      const url = logicalSrc
      void deleteCachedAudio(url)
      setSource(url, track)
      return
    }
    if (track !== undefined && !transcodeFallback) {
      transcodeFallback = true
      setSource(srcFor(track.id), track)
      return
    }
    set({ playing: false })
  })

  // 卡死自愈兜底：播放中位置连续 5s 不前进且在等数据 → 断点重拉
  // （服务端 idleTimeout 已禁用，此路径正常不触发；网络闪断时兜底）
  let lastTickPos = -1
  let frozenMs = 0
  const recover = () => {
    const track = current()
    if (track === undefined || logicalSrc === null) return
    // 走与正常起播同一条路：缓存还在就直接读 blob，避免闪断时又拉一遍网络
    setSource(logicalSrc, track, audio.currentTime)
  }
  window.setInterval(() => {
    if (audio.paused) {
      frozenMs = 0
      lastTickPos = -1
      return
    }
    if (audio.readyState >= 1 && audio.readyState < 3 && audio.currentTime === lastTickPos) {
      frozenMs += 5000
      if (frozenMs >= 5000) {
        frozenMs = 0
        recover()
      }
    } else {
      frozenMs = 0
    }
    lastTickPos = audio.currentTime
  }, 5000)

  if ("mediaSession" in navigator) {
    navigator.mediaSession.setActionHandler("play", () => audio.play())
    navigator.mediaSession.setActionHandler("pause", () => audio.pause())
    navigator.mediaSession.setActionHandler("nexttrack", () => advance(1))
    navigator.mediaSession.setActionHandler("previoustrack", () => advance(-1))
  }

  return {
    queue: [],
    index: 0,
    playing: false,
    volume: 0.9,
    shuffle: false,
    repeat: "off",
    showQueue: false,
    showNowPlaying: false,
    nowPlayingDrag: null,
    position: 0,
    duration: 0,

    playNow: (tracks, startIndex = 0) => {
      set({ queue: [...tracks], index: startIndex })
      loadCurrent()
    },
    playTrack: (track) => get().playNow([track]),
    enqueue: (tracks) => set((s) => ({ queue: [...s.queue, ...tracks] })),
    enqueueNext: (track) =>
      set((s) => {
        const queue = [...s.queue]
        queue.splice(s.index + 1, 0, track)
        return { queue }
      }),
    toggle: () => {
      if (current() === undefined) return
      if (audio.paused) {
        audio.play().catch(() => {})
      } else {
        audio.pause()
      }
    },
    next: () => advance(1),
    previous: () => {
      if (audio.currentTime > 3) {
        audio.currentTime = 0
        return
      }
      advance(-1)
    },
    seek: (seconds) => {
      audio.currentTime = seconds
    },
    setVolume: (volume) => {
      audio.volume = volume
      set({ volume })
    },
    toggleShuffle: () => set((s) => ({ shuffle: !s.shuffle })),
    cycleRepeat: () =>
      set((s) => ({
        repeat: s.repeat === "off" ? "all" : s.repeat === "all" ? "one" : "off",
      })),
    toggleQueue: () => set((s) => ({ showQueue: !s.showQueue })),
    toggleNowPlaying: () => set((s) => ({ showNowPlaying: !s.showNowPlaying })),
    /** 手势期打开进度（0..1；null = 非拖动中）。显隐合成见 NowPlaying：
     *  drag 非 null 时层位置完全由它驱动（transition none 跟手），松手后清 null、
     *  由 showNowPlaying + CSS 过渡接管 snap——两态接力，永不同时生效 */
    setNowPlayingDrag: (progress) => set({ nowPlayingDrag: progress }),
    removeFromQueue: (position) =>
      set((s) => {
        const queue = [...s.queue]
        queue.splice(position, 1)
        const index = position < s.index ? s.index - 1 : s.index
        return { queue, index }
      }),
    jumpTo: (position) => {
      set({ index: position })
      loadCurrent()
    },
    clearQueue: () => {
      sourceGeneration += 1
      cancelCacheJob()
      releaseObjectUrl()
      logicalSrc = null
      audio.pause()
      audio.removeAttribute("src")
      set({ queue: [], index: 0, playing: false, position: 0, duration: 0 })
    },
  }
})

// 初始音量；挂到 DOM（便于调试与自动化测试探测）
audio.volume = 0.9
if (typeof document !== "undefined") {
  document.body.appendChild(audio)
}

export const useCurrentTrack = () =>
  usePlayer((s) => s.queue[s.index] as TrackSummary | undefined)
