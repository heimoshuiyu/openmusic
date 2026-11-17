/**
 * 播放引擎：OpenTUI 原生 Audio 拉第一方流 + 轻量订阅 store 驱动 React UI。
 *
 * 位置 = baseSec + framesPlayed / sampleRate（AudioStreamStats，500ms 轮询）。
 * Scrobble 语义与 Web 播放器一致（docs/03 §2.7）：
 * 通过有效性判定（>50% 或 >4min）时上报 listenedSeconds = 当时的实测位置。
 *
 * 暂停/seek：AudioStream 无暂停/seek——暂停 = 停流并冻结位置；恢复/seek =
 * 带 timeOffset 重连（服务器 ffmpeg 输入端 seek），位置基线 = 冻结值。
 * 暂停态下 seek 只挪指针不起流（恢复时才带偏移重连）。
 *
 * 队列：shuffle 随机跳（避开当前曲）、repeat 关→全→单 循环；自动播完与手动
 * n 行为不同：手动 next 总是回绕，自动 advance 走 repeat 语义（off 播完即停）。
 */
import { Audio, type AudioStream } from "@opentui/core"
import type { OmApi, TrackSummary } from "./api.js"
import { savePlayerState } from "./player-state.js"

export type PlayState = "idle" | "playing" | "paused" | "ended" | "error"
export type RepeatMode = "off" | "all" | "one"

const TICK_MS = 500
/** scrobble 有效性判定（与 Web 端一致） */
const SCROBBLE_MIN_SECONDS = 240
/** 手动 seek 步长（秒） */
export const SEEK_STEP_SEC = 10

/** 最小发布-订阅 store：version 自增，UI 经 useSyncExternalStore 重渲染 */
export class Player {
  private readonly audio: Audio | null
  private stream: AudioStream | null = null
  /** 流代数：seek/切歌快速连发时旧流回调凭代数自弃 */
  private streamGen = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private scrobbled = false
  private listeners = new Set<() => void>()
  private versionVal = 0

  private queue: TrackSummary[] = []
  private index = -1

  // 当前流的起点秒数（断点续播时 >0）——位置 = baseSec + framesPlayed/sampleRate
  private baseSec = 0

  // —— UI 可读状态（tick/动作时更新并 bump） ——
  positionSec = 0
  durationSec = 0
  state: PlayState = "idle"
  volume = 0.9
  current: TrackSummary | null = null
  errorText = ""
  shuffle = false
  repeat: RepeatMode = "off"

  constructor(private readonly api: OmApi) {
    // 无头机器 / 无音频设备时降级：可浏览，播放报错（不崩整个 TUI）。
    // autoStart 默认 false——不启动引擎设备端永不消费，缓冲填满即永远卡
    // buffering（framesPlayed=0），有声卡的机器也一样（踩坑实录）
    try {
      this.audio = Audio.create({ autoStart: true })
    } catch (e) {
      this.audio = null
      this.errorText = String((e as Error)?.message ?? e)
    }
  }

  // —— store 接口（useSyncExternalStore） ——
  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }
  getVersion = (): number => this.versionVal
  private bump(): void {
    this.versionVal++
    for (const cb of this.listeners) cb()
  }

  // —— 队列快照（QueueView 渲染用） ——
  queueSnapshot(): { queue: TrackSummary[]; index: number } {
    return { queue: this.queue, index: this.index }
  }

  /** 从队列指定位置开始播放（队列 = 上下文曲目列表，Enter 所在行起播） */
  play(queue: TrackSummary[], startIndex: number): void {
    if (queue.length === 0) return
    this.queue = queue
    this.index = Math.min(Math.max(0, startIndex), queue.length - 1)
    this.startCurrent()
  }

  /** 恢复上次播放态：曲目停在播放条上但保持暂停（空格从头播这首）；不起流 */
  restore(queue: TrackSummary[], index: number, volume: number): void {
    const track = queue[index]
    if (!track) return
    this.stopStream()
    this.queue = queue
    this.index = index
    this.current = track
    this.durationSec = track.durationSeconds
    this.positionSec = 0
    this.baseSec = 0
    this.scrobbled = false
    this.errorText = ""
    this.setVolume(volume)
    this.state = "paused"
    this.bump()
  }

  /** 手动下一首：总是有下一首（尾部回绕；shuffle 随机跳） */
  next(): void {
    const target = this.nextIndex()
    if (target === null || target === this.index) {
      // 单曲队列 / shuffle 无处可跳 → 重放
      this.startCurrent()
      return
    }
    this.index = target
    this.startCurrent()
  }

  /** 上一首；已在首曲时重头放 */
  prev(): void {
    if (this.index > 0) {
      this.index -= 1
      this.startCurrent()
    } else if (this.index === 0) {
      this.startCurrent()
    }
  }

  /** 队列内跳转（QueueView Enter）：目标即当前曲 → 重头放 */
  jumpTo(index: number): void {
    if (index < 0 || index >= this.queue.length) return
    this.index = index
    this.startCurrent()
  }

  /** 队列内移除一行（QueueView d）；移除当前曲 → 接着播补位曲，队列空则停 */
  removeAt(index: number): TrackSummary | null {
    const [removed] = this.queue.splice(index, 1)
    if (removed === undefined) return null
    if (this.queue.length === 0) {
      this.stop()
      return removed
    }
    if (index < this.index) {
      this.index -= 1
    } else if (index === this.index) {
      // 移除当前曲：播放中 → 补位曲从头播；暂停/结束 → 补位曲以暂停态上岗
      if (this.index >= this.queue.length) this.index = this.queue.length - 1
      if (this.state === "playing") {
        this.startCurrent()
      } else if (this.state === "paused" || this.state === "ended") {
        const track = this.queue[this.index]
        if (track) {
          this.current = track
          this.durationSec = track.durationSeconds
          this.positionSec = 0
          this.baseSec = 0
          this.state = "paused"
        }
      }
    }
    this.persistState()
    this.bump()
    return removed
  }

  /** 暂停（停流冻结位置）/ 恢复（带 timeOffset 断点续播） */
  toggle(): void {
    if (this.state === "playing") {
      this.freezePosition()
      this.stopStream()
      this.state = "paused"
      this.bump()
    } else if (this.current !== null) {
      // 已到末尾附近 → 重头放（避免续播即结束）
      const resumeFrom =
        this.durationSec > 0 && this.positionSec >= this.durationSec - 1 ? 0 : this.positionSec
      this.startCurrent(resumeFrom)
    }
  }

  /** seek 到绝对秒；播放中带 timeOffset 重连，暂停态只挪指针 */
  seekTo(sec: number): void {
    if (this.current === null || this.durationSec <= 0) return
    const target = Math.max(0, Math.min(this.durationSec - 0.5, sec))
    if (this.state === "playing") {
      this.startCurrent(target)
    } else {
      this.positionSec = target
      this.bump()
    }
  }

  seekBy(deltaSec: number): void {
    this.seekTo(this.positionSec + deltaSec)
  }

  /** 播完整个队列（repeat off 的自然结束）：停流但保留队列与当前曲 */
  finish(): void {
    this.freezePosition()
    this.stopStream()
    this.state = "ended"
    this.bump()
  }

  stop(): void {
    this.stopStream()
    this.queue = []
    this.index = -1
    this.current = null
    this.positionSec = 0
    this.baseSec = 0
    this.durationSec = 0
    this.state = "idle"
    this.errorText = ""
    this.bump()
  }

  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v))
    this.stream?.setVolume(this.volume)
    this.persistState()
    this.bump()
  }

  volumeUp(): void {
    this.setVolume(this.volume + 0.1)
  }

  volumeDown(): void {
    this.setVolume(this.volume - 0.1)
  }

  toggleShuffle(): void {
    this.shuffle = !this.shuffle
    this.bump()
  }

  cycleRepeat(): RepeatMode {
    this.repeat = this.repeat === "off" ? "all" : this.repeat === "all" ? "one" : "off"
    this.bump()
    return this.repeat
  }

  dispose(): void {
    this.stopStream()
    this.audio?.dispose()
  }

  // —— 内部 ——

  /** 下一曲索引：shuffle 随机跳（避开当前曲），否则顺序 +1（尾部回绕） */
  private nextIndex(): number | null {
    if (this.queue.length === 0) return null
    if (this.shuffle && this.queue.length > 1) {
      let candidate = this.index
      while (candidate === this.index) {
        candidate = Math.floor(Math.random() * this.queue.length)
      }
      return candidate
    }
    return (this.index + 1) % this.queue.length
  }

  /** 流自然播完（"ended" 事件）：repeat one → 重放；all → 回绕；off → finish() */
  private advance(): void {
    if (this.repeat === "one" && this.index >= 0) {
      this.startCurrent()
      return
    }
    if (this.repeat === "all" || this.index + 1 < this.queue.length) {
      this.next()
      return
    }
    this.finish()
  }

  private persistState(): void {
    if (this.current === null) return
    // 记住「上次播放的曲目」（不记时间点；重开 TUI 后暂停态恢复）
    savePlayerState({
      url: this.api.baseUrl,
      queue: this.queue,
      index: this.index,
      volume: Math.round(this.volume * 1000) / 1000,
    })
  }

  /** 从队列指定曲目起播；resumeFrom > 0 = 断点续播/seek（保留 scrobble 已报状态） */
  private startCurrent(resumeFrom = 0): void {
    const track = this.queue[this.index]
    if (!track) return
    this.stopStream()
    if (resumeFrom <= 0) this.scrobbled = false
    this.errorText = ""
    this.current = track
    this.durationSec = track.durationSeconds
    this.positionSec = resumeFrom
    this.baseSec = resumeFrom
    this.persistState()

    if (this.audio === null) {
      this.state = "error"
      this.errorText = "音频设备不可用（无头环境？）——仅可浏览"
      this.bump()
      return
    }
    this.state = "playing"
    this.bump()

    const gen = ++this.streamGen
    const { url, options } = this.api.streamRequest(track.id, this.baseSec)
    void this.audio
      .playStreamUrl(url, options)
      .then((stream) => {
        // 竞态：流建立期间已切歌/seek → 凭代数丢弃旧流
        if (gen !== this.streamGen) {
          stream.dispose()
          return
        }
        this.stream = stream
        stream.setVolume(this.volume)
        stream.on("ended", () => {
          if (gen === this.streamGen) this.advance()
        })
        stream.on("error", (error) => {
          if (gen !== this.streamGen) return
          this.errorText = String(error.message ?? error)
          this.state = "error"
          this.bump()
        })
        this.timer ??= setInterval(() => this.tick(), TICK_MS)
      })
      .catch((error: unknown) => {
        if (gen !== this.streamGen) return
        this.errorText = String((error as Error)?.message ?? error)
        this.state = "error"
        this.bump()
      })
  }

  private stopStream(): void {
    this.streamGen++
    this.stream?.dispose()
    this.stream = null
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** 停流前最后一读：冻结到准确的断点位置（轮询间隔最多滞后 500ms） */
  private freezePosition(): void {
    const stream = this.stream
    if (stream === null) return
    try {
      const stats = stream.getStats()
      if (stats.sampleRate > 0) {
        this.positionSec = this.baseSec + Number(stats.framesPlayed) / stats.sampleRate
      }
    } catch {
      // 流已失效 → 保留最后一次 tick 的位置
    }
  }

  private tick(): void {
    const stream = this.stream
    if (stream === null) return
    const stats = stream.getStats()
    this.positionSec =
      stats.sampleRate > 0 ? this.baseSec + Number(stats.framesPlayed) / stats.sampleRate : this.baseSec
    // 透传真实流状态（启动失败/真正无音频设备的机器会卡在 buffering——给出明确提示）
    if (stats.state === "buffering" && this.state === "playing") {
      this.errorText = this.positionSec === this.baseSec ? "缓冲中…（若长期不动：音频引擎未能启动播放）" : ""
    } else if (stats.state === "playing") {
      this.errorText = ""
    }

    if (
      !this.scrobbled &&
      this.durationSec > 0 &&
      (this.positionSec >= SCROBBLE_MIN_SECONDS || this.positionSec >= this.durationSec / 2)
    ) {
      this.scrobbled = true
      const track = this.current
      if (track) {
        this.api.recordPlay(track.id, Math.floor(this.positionSec)).catch(() => {
          // 上报失败不影响播放；本曲不重试
        })
      }
    }
    this.bump()
  }
}
