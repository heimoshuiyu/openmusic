/**
 * 导航轨：九个浏览分区的索引（数字前缀 = 快捷键 1-9）。
 * 框架 Select 单行模式（showDescription false）；点击行 = 切换分区。
 */
import { useRef } from "react"
import type { MouseEvent, SelectRenderable } from "@opentui/core"
import { C } from "../theme.js"

export const SECTIONS = [
  { id: "albums", label: "专辑" },
  { id: "artists", label: "艺人" },
  { id: "search", label: "搜索" },
  { id: "favorites", label: "收藏" },
  { id: "recent", label: "最近" },
  { id: "most", label: "最常" },
  { id: "playlists", label: "列表" },
  { id: "queue", label: "队列" },
  { id: "random", label: "随机" },
] as const

export type SectionId = (typeof SECTIONS)[number]["id"]

export function NavRail({
  section,
  focused,
  interactive,
  onSwitch,
}: {
  section: SectionId
  focused: boolean
  interactive: boolean
  onSwitch: (id: SectionId) => void
}) {
  const selectRef = useRef<SelectRenderable | null>(null)
  const options = SECTIONS.map((s, i) => ({ name: `${i + 1} ${s.label}`, description: "", value: s.id }))

  const indexAtY = (y: number): number => {
    const select = selectRef.current
    if (select === null) return -1
    const rel = y - select.y
    if (rel < 0) return -1
    const internals = select as unknown as { scrollOffset: number; linesPerItem: number }
    const index = internals.scrollOffset + Math.floor(rel / internals.linesPerItem)
    return index >= 0 && index < SECTIONS.length ? index : -1
  }

  return (
    <box
      onMouseDown={(event: MouseEvent) => {
        if (!interactive || event.button !== 0) return
        const index = indexAtY(event.y)
        const id = SECTIONS[index]?.id
        if (id !== undefined) onSwitch(id)
      }}
      onMouseScroll={(event: MouseEvent) => {
        if (!interactive || !event.scroll) return
        const select = selectRef.current
        if (select === null) return
        const step = event.scroll.direction === "up" ? -1 : 1
        const cur = SECTIONS.findIndex((s) => s.id === section)
        const next = Math.min(SECTIONS.length - 1, Math.max(0, cur + step))
        if (next !== cur) onSwitch(SECTIONS[next]!.id)
      }}
      style={{ width: 12, border: true, borderColor: focused ? C.accent : C.line }}
    >
      <select
        ref={(r) => {
          selectRef.current = r
        }}
        focused={focused}
        options={options}
        selectedIndex={SECTIONS.findIndex((s) => s.id === section)}
        onChange={(index: number) => {
          // 导航轨上移动即切换（不需要再按 Enter）
          const id = SECTIONS[index]?.id
          if (id !== undefined) onSwitch(id)
        }}
        onSelect={(index: number) => {
          const id = SECTIONS[index]?.id
          if (id !== undefined) onSwitch(id)
        }}
        style={{
          height: "100%",
          showDescription: false,
          showSelectionIndicator: false,
          selectedBackgroundColor: C.raised,
          selectedTextColor: C.accent,
        }}
      />
    </box>
  )
}
