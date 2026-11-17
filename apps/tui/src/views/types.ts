/** 视图栈模型：每个分区一个根视图，钻入（专辑曲目/艺人页/列表曲目）压栈，←/Esc 弹栈 */
import type { AlbumSummary, ArtistSummary, OmApi, PlaylistSummary } from "../api.js"
import type { Player } from "../player.js"
import type { StarOverlay } from "../star-overlay.js"
import type { ListHandle } from "../components/list-pane.js"

export type View =
  | { kind: "albums"; sel?: number }
  | { kind: "album-tracks"; album: AlbumSummary; sel?: number }
  | { kind: "artists"; sel?: number }
  | { kind: "artist"; artist: ArtistSummary; sel?: number }
  | { kind: "search"; sel?: number }
  | { kind: "favorites"; sel?: number }
  | { kind: "recent"; sel?: number }
  | { kind: "most"; sel?: number }
  | { kind: "playlists"; sel?: number }
  | { kind: "playlist-tracks"; playlist: PlaylistSummary; sel?: number }
  | { kind: "queue"; sel?: number }
  | { kind: "random"; sel?: number }

export type SectionId =
  | "albums"
  | "artists"
  | "search"
  | "favorites"
  | "recent"
  | "most"
  | "playlists"
  | "queue"
  | "random"

/** 分区根视图工厂 */
export function sectionRoot(id: SectionId): View {
  return { kind: id }
}

/** 所有视图组件共用的 props（MainScreen 注入） */
export interface ViewProps {
  api: OmApi
  player: Player
  stars: StarOverlay
  /** 内容区持有焦点（false = 导航轨/帮助页/输入模式） */
  focused: boolean
  /** false = mini 模式（本树隐藏）：不抢焦点、不吃鼠标 */
  interactive: boolean
  drill: (view: View) => void
  toast: (message: string, kind?: "info" | "error") => void
  registerList: (handle: ListHandle | null) => void
  /** 把选中行写回视图栈条目（返回导航恢复位置） */
  reportSel: (sel: number) => void
}
