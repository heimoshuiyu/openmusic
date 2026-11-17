/**
 * mini 播放器（小窗模式）：窗口 < 70 列或 < 16 行时替代完整界面。
 * 可以把终端缩成小窗挂在角落当迷你播放器。播放键位由 MainScreen 的
 * 全局键盘处理（mini 分支）持续生效。
 */
import type { MouseEvent } from "@opentui/core"
import { formatDuration } from "../api.js"
import type { Player } from "../player.js"
import { truncateVisual, visualWidth } from "../text.js"
import { C } from "../theme.js"
import { usePlayerTick } from "../use-player-tick.js"

function playStateIcon(state: string): string {
  switch (state) {
    case "playing":
      return "▶"
    case "paused":
      return "❚❚"
    case "error":
      return "!"
    default:
      return "·"
  }
}

export function MiniPlayer({ player, width, height }: { player: Player; width: number; height: number }) {
  // 必须自己订阅：MiniPlayer 与 MainScreen 是兄弟节点，MainScreen 的 tick
  // 重渲染带不动这里——不订阅就只有窗口尺寸变化（App 重渲染）时才刷新
  usePlayerTick(player)
  const track = player.current

  // 宽高足够时画带边框的卡片，否则裸排（极限小窗也能看）。
  // 进度条块字符（░█）在 CJK 终端按 2 列渲染，预算按 visualWidth 计算。
  const bordered = width >= 34 && height >= 7
  const innerW = bordered ? Math.min(width - 4, 42) : Math.max(1, width - 2)
  const innerH = bordered ? height - 4 : height
  const contentW = Math.max(1, innerW - (bordered ? 2 : 1))

  const showProgress = innerH >= 2
  const showArtist = innerH >= 3
  const showHint = innerH >= 4
  const showControls = bordered && innerH >= 5

  const title = track !== null ? track.title : player.errorText !== "" ? "OpenMusic" : "OpenMusic · 未播放"
  const titleColor = track !== null ? C.paper : C.faint
  const icon = playStateIcon(player.state)

  const onWheel = (event: MouseEvent) => {
    if (event.scroll?.direction === "up") player.volumeUp()
    else if (event.scroll?.direction === "down") player.volumeDown()
  }

  const miniBtn = (label: string, action: () => void, accent = false) => (
    <box
      style={{ width: 3, height: 1, alignItems: "center", justifyContent: "center" }}
      onMouseDown={(event: MouseEvent) => {
        if (event.button === 0) action()
      }}
    >
      <text fg={accent ? C.accent : C.dim}>{label}</text>
    </box>
  )

  const progressLine = () => {
    const pos = formatDuration(player.positionSec)
    const dur = formatDuration(player.durationSec)
    // pos + 1 + bar(2n) + 1 + dur ≤ contentW
    const barCols = Math.max(2, contentW - pos.length - dur.length - 2)
    const barN = Math.max(1, Math.floor(barCols / 2))
    const filled =
      player.durationSec > 0 ? Math.round((player.positionSec / player.durationSec) * barN) : 0
    return `${pos} ${"█".repeat(filled)}${"░".repeat(Math.max(0, barN - filled))} ${dur}`
  }

  const rows = (
    <box style={{ flexDirection: "column", width: innerW }}>
      <text fg={player.state === "playing" ? C.accent : titleColor} attributes={1}>
        {`${icon} ${truncateVisual(title, contentW - visualWidth(icon) - 1)}`}
      </text>
      {showArtist &&
        (player.errorText !== "" ? (
          <text fg={C.danger}>{truncateVisual(player.errorText, contentW - 1)}</text>
        ) : (
          track !== null && (
            <text fg={C.faint}>{truncateVisual(`${track.artist.name} · ${track.album.name}`, contentW - 1)}</text>
          )
        ))}
      {showProgress && (
        <text fg={C.dim}>{track !== null ? progressLine() : truncateVisual("缩小窗口 = 迷你播放器 · 放大恢复浏览", contentW - 1)}</text>
      )}
      {showHint && (
        <text fg={C.faint}>
          {truncateVisual(`vol ${Math.round(player.volume * 100)}% · space 暂停 · n/p 切歌 · ,/. 快进退 · q 退出`, contentW - 1)}
        </text>
      )}
      {showControls && (
        <box style={{ flexDirection: "row", gap: 1 }}>
          {miniBtn("◀◀", () => player.prev())}
          {miniBtn(icon, () => player.toggle(), player.state === "playing")}
          {miniBtn("▶▶", () => player.next())}
          <text fg={C.faint}>{`vol ${Math.round(player.volume * 100)}%`}</text>
          {miniBtn("-", () => player.volumeDown())}
          {miniBtn("+", () => player.volumeUp())}
        </box>
      )}
    </box>
  )

  if (!bordered) {
    return (
      <box onMouseScroll={onWheel} style={{ flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
        {rows}
      </box>
    )
  }
  return (
    <box
      title="OpenMusic"
      onMouseScroll={onWheel}
      style={{
        width: innerW + 4,
        border: true,
        borderColor: player.state === "playing" ? C.accent : C.line,
        flexDirection: "column",
        padding: 1,
      }}
    >
      {rows}
    </box>
  )
}
