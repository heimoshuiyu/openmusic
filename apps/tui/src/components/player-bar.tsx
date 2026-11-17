/**
 * 播放面板（faceplate）：按钮排 + 正在播放 + 时间码 + **可点击进度条** + 音量。
 *
 * 进度条整体是 seek 热区（timeOffset 后端）：点击列 → 比例 → seekTo。
 * 指示灯：z（随机）/ r（循环 · r1 单曲）只在开启时出现，可点击切换；
 * ★ 收藏当前曲（StarOverlay 乐观同步）。红只给激活态。
 */
import { useRef, useState } from "react"
import type { MouseEvent, Renderable } from "@opentui/core"
import { formatDuration } from "../api.js"
import type { Player } from "../player.js"
import type { StarOverlay } from "../star-overlay.js"
import { truncateVisual, visualWidth } from "../text.js"
import { C } from "../theme.js"

export function PlayerBar({
  player,
  stars,
  width,
  onToast,
}: {
  player: Player
  stars: StarOverlay
  width: number
  onToast: (msg: string) => void
}) {
  const [hover, setHover] = useState("")
  const barRef = useRef<Renderable | null>(null)
  const track = player.current

  const barWidth = Math.max(10, Math.min(26, Math.floor(width / 6)))
  const filled =
    player.durationSec > 0
      ? Math.round((player.positionSec / player.durationSec) * barWidth)
      : 0
  const barText = `${"█".repeat(filled)}${"░".repeat(Math.max(0, barWidth - filled))}`

  const ctl = (key: string, label: string, action: () => void, accent = false, w = 4) => (
    <box
      style={{ width: w, height: 1, alignItems: "center", justifyContent: "center" }}
      onMouseDown={(event: MouseEvent) => {
        if (event.button === 0) action()
      }}
      onMouseOver={() => setHover(key)}
      onMouseOut={() => setHover((h) => (h === key ? "" : h))}
    >
      <text fg={accent ? C.accent : hover === key ? C.paper : C.dim} attributes={hover === key ? 1 : 0}>
        {label}
      </text>
    </box>
  )

  const stateIcon = player.state === "playing" ? "▶" : player.state === "paused" ? "❚❚" : player.state === "error" ? "!" : "·"

  const seekClick = (event: MouseEvent): void => {
    if (event.button !== 0 || player.durationSec <= 0) return
    const bar = barRef.current
    if (bar === null) return
    const rel = event.x - bar.x
    if (rel < 0 || rel >= barWidth) return
    player.seekTo(((rel + 0.5) / barWidth) * player.durationSec)
  }

  /** 标题/艺人按剩余预算截断（flex 行内的 text 不会自行收缩，长专辑名会溢出面板） */
  const metaBudget = () => {
    // 按钮 3×4 + 时间码 ~11 + 进度条 + ★3 + vol 文本 ~8 + vol 按钮 3+3 + gap×子项 + 边框内衬
    const fixed = 12 + 11 + barWidth + 3 + 8 + 6 + 12 + 4
    return Math.max(10, width - fixed)
  }
  const budget = metaBudget()
  const titleText = truncateVisual(track?.title ?? "", Math.max(6, Math.floor(budget * 0.45)))
  const artistText =
    track !== null
      ? truncateVisual(`— ${track.artist.name} · ${track.album.name}`, Math.max(6, budget - visualWidth(titleText) - 1))
      : ""

  const starCurrent = () => {
    if (track === null) return
    void stars.toggle(track).then(({ next, ok }) => {
      onToast(ok ? (next ? `已收藏 ${track.title}` : `已取消收藏 ${track.title}`) : "收藏失败（服务端错误）")
    })
  }

  return (
    <box
      onMouseScroll={(event: MouseEvent) => {
        if (event.scroll?.direction === "up") player.volumeUp()
        else if (event.scroll?.direction === "down") player.volumeDown()
      }}
      style={{
        height: 3,
        flexDirection: "row",
        border: true,
        borderColor: C.line,
        paddingLeft: 1,
        paddingRight: 1,
        alignItems: "center",
        gap: 1,
      }}
    >
      {ctl("prev", "◀◀", () => player.prev())}
      {ctl("toggle", stateIcon, () => player.toggle(), player.state === "playing")}
      {ctl("next", "▶▶", () => player.next())}
      {track === null ? (
        <text fg={C.faint}>{"未播放 —— 左侧选分区，回车起播（? 查看键位）"}</text>
      ) : (
        <>
          <box style={{ flexGrow: 1, minWidth: 0, height: 1, flexDirection: "row", gap: 1 }}>
            <text fg={player.state === "playing" ? C.accent : C.faint} attributes={1}>
              {player.state === "playing" ? "▶" : player.state === "error" ? "!" : "·"}
            </text>
            <text fg={C.paper} attributes={1}>
              {titleText}
            </text>
            <text fg={C.dim}>{artistText}</text>
          </box>
          <text fg={C.dim}>{`${formatDuration(player.positionSec)} / ${formatDuration(player.durationSec)}`}</text>
          <box
            ref={(r) => {
              barRef.current = r
            }}
            onMouseDown={seekClick}
            onMouseOver={() => setHover("bar")}
            onMouseOut={() => setHover((h) => (h === "bar" ? "" : h))}
            style={{ width: barWidth, height: 1 }}
          >
            <text fg={hover === "bar" ? C.paper : C.accent}>{barText}</text>
          </box>
          {ctl("star", stars.is(track) ? "★" : "☆", starCurrent, stars.is(track), 3)}
          {player.shuffle && ctl("shuffle", "z", () => player.toggleShuffle(), true, 3)}
          {player.repeat !== "off" &&
            ctl("repeat", player.repeat === "one" ? "r1" : "r", () => player.cycleRepeat(), true, 3)}
          <text fg={C.faint}>{`vol ${Math.round(player.volume * 100)}%`}</text>
          {ctl("vol-down", "-", () => player.volumeDown(), false, 3)}
          {ctl("vol-up", "+", () => player.volumeUp(), false, 3)}
        </>
      )}
    </box>
  )
}
