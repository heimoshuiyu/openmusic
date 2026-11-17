/**
 * 播放态持久化：~/.config/openmusic-tui/player.json。
 *
 * 只记「上次播放的曲目」（队列 + 索引）和音量——不记时间点：
 * 重开 TUI 后该曲目以暂停态出现在播放条上，按空格从头播放。
 * 队列直接存 TrackSummary（恢复零网络依赖；starred/时长可能略陈旧，可接受）。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { TrackSummary } from "./api.js"

export interface PlayerState {
  url: string
  queue: TrackSummary[]
  index: number
  volume: number
}

const dir = join(homedir(), ".config", "openmusic-tui")
const file = join(dir, "player.json")

export function loadPlayerState(): PlayerState | null {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<PlayerState>
    const index = raw.index
    if (
      typeof raw.url === "string" &&
      Array.isArray(raw.queue) &&
      raw.queue.length > 0 &&
      typeof index === "number" &&
      Number.isInteger(index) &&
      index >= 0 &&
      index < raw.queue.length &&
      typeof raw.volume === "number"
    ) {
      return { url: raw.url, queue: raw.queue, index, volume: raw.volume }
    }
  } catch {
    // 无文件或损坏 → 无可恢复
  }
  return null
}

export function savePlayerState(state: PlayerState): void {
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, JSON.stringify(state) + "\n")
  } catch {
    // 持久化失败不影响播放
  }
}
