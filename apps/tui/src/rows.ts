/**
 * 列表行构造器：全部走 OpenTUI Select 的 name/description 两行制。
 *
 * 对齐策略（CJK 终端歧义宽字符按 2 列渲染）：
 * - 行首标记用 ASCII `>`（正在播放）——每行同宽，左缘永不漂移
 * - `★` 只出现在行尾——后面没有需要对齐的内容
 * - 时长进 description 首位，按 dim 弱化（不做右对齐：Select 拿不到可靠内宽）
 */
import type { SelectOption } from "@opentui/core"
import { formatDuration, type AlbumSummary, type ArtistSummary, type PlayEntry, type TrackSummary } from "./api.js"

/** 列表行的语义类型（全局键 s/→/d 依据它决定行为） */
export type RowItem =
  | { kind: "track"; track: TrackSummary }
  | { kind: "album"; album: AlbumSummary }
  | { kind: "artist"; artist: ArtistSummary }
  | { kind: "header" }
  | { kind: "action" }
  /** 墓碑：曲目已不在库中（plays 事件快照）——不可播、不可收藏，仅供历史叙事 */
  | { kind: "tombstone" }

export interface RowStyle {
  /** 正在播放 → 行首 `>`（调用方比较 track.id === player.current?.id） */
  readonly playing: boolean
  /** 收藏状态（走 StarOverlay.is） */
  readonly starred: boolean
  /** 曲目号/名次前缀（如 "03" / "1"；无则留空） */
  readonly no?: string
}

const MARK_PLAY = "> "
const MARK_NONE = "  "

export function trackRow(track: TrackSummary, style: RowStyle, description: string): SelectOption {
  const no = style.no !== undefined ? `${style.no} ` : ""
  return {
    name: `${style.playing ? MARK_PLAY : MARK_NONE}${no}${track.title}${style.starred ? " ★" : ""}`,
    description,
    value: { kind: "track", track } satisfies RowItem,
  }
}

export function albumRow(
  album: AlbumSummary,
  style: Pick<RowStyle, "playing">,
  description: string,
): SelectOption {
  return {
    name: `${style.playing ? MARK_PLAY : MARK_NONE}${album.name}`,
    description,
    value: { kind: "album", album } satisfies RowItem,
  }
}

export function artistRow(artist: ArtistSummary, description: string): SelectOption {
  return {
    name: `  ${artist.name}`,
    description,
    value: { kind: "artist", artist } satisfies RowItem,
  }
}

export function headerRow(label: string): SelectOption {
  return { name: `── ${label} ──`, description: "", value: { kind: "header" } satisfies RowItem }
}

export function actionRow(label: string, description: string): SelectOption {
  return {
    name: `  ${label}`,
    description,
    value: { kind: "action" } satisfies RowItem,
  }
}

/** 墓碑行（最近播放里的已删曲目）：`（已删除）` 是 ASCII 安全的行内标记 */
export function tombstoneRow(entry: PlayEntry): SelectOption {
  return {
    name: `  ${entry.title}（已删除）`,
    description: `${formatDuration(entry.durationSeconds)} · ${entry.artistName} · ${entry.albumName}`,
    value: { kind: "tombstone" } satisfies RowItem,
  }
}

/** 通用 description 片段 */
export const descTrack = (t: TrackSummary): string =>
  `${formatDuration(t.durationSeconds)} · ${t.artist.name} · ${t.album.name}`

export const descTrackNoAlbum = (t: TrackSummary): string =>
  `${formatDuration(t.durationSeconds)} · ${t.artist.name}`

export const descAlbum = (a: AlbumSummary): string => {
  const year = a.year !== null ? `${a.year} · ` : ""
  return `${year}${a.trackCount} 曲 · ${formatDuration(a.durationSeconds)} · ${a.artist.name}`
}
