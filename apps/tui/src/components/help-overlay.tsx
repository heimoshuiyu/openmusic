/**
 * 键位帮助页（?）：占满内容区（不叠层——终端无 z-index，整页替换最稳）。
 * 两栏对齐用 visualWidth padding（CJK 宽字符）。
 */
import { padVisual } from "../text.js"
import { C } from "../theme.js"

const KEY_COL = 24

interface Row {
  keys?: string
  desc?: string
}

const SECTIONS_HELP: Array<{ title: string; rows: Row[] }> = [
  {
    title: "导航",
    rows: [
      { keys: "1-9 / 点击导航轨", desc: "跳转分区" },
      { keys: "Tab · ←→", desc: "导航轨 ↔ 列表" },
      { keys: "→ / Enter", desc: "进入专辑、艺人" },
      { keys: "← / Esc", desc: "返回上一层" },
      { keys: "/  搜索", desc: "输入关键词回车检索" },
      { keys: "g / G", desc: "跳到列表首行 / 末行" },
    ],
  },
  {
    title: "播放",
    rows: [
      { keys: "space / 点击 ❚❚", desc: "播放 · 暂停（从断点续播）" },
      { keys: "n / p", desc: "下一首 · 上一首" },
      { keys: ", / .", desc: "后退 / 前进 10 秒" },
      { keys: "点击进度条", desc: "跳到对应位置" },
      { keys: "s / 点击 ★", desc: "收藏当前或选中的曲目" },
      { keys: "z  随机", desc: "下一首随机跳" },
      { keys: "r  循环", desc: "关 → 全部 → 单曲" },
      { keys: "d", desc: "队列页：移除选中曲" },
    ],
  },
  {
    title: "音量与其他",
    rows: [
      { keys: "+ / - / 滚轮", desc: "音量" },
      { keys: "x  停止", desc: "停止并清空队列" },
      { keys: "m", desc: "最常页：切换时段（全部/月/年）" },
      { keys: "q  退出", desc: "下次启动恢复登录与上次曲目" },
    ],
  },
]

export function HelpOverlay() {
  const lines: Array<{ text: string; color: string; bold?: boolean }> = [
    { text: "Esc 或 ? 返回", color: C.faint },
  ]
  for (const section of SECTIONS_HELP) {
    lines.push({ text: `── ${section.title} ──`, color: C.dim, bold: true })
    for (const row of section.rows) {
      lines.push({
        text: `  ${padVisual(row.keys ?? "", KEY_COL)}${row.desc ?? ""}`,
        color: C.paper,
      })
    }
  }
  return (
    <box
      title="键位"
      style={{ flexGrow: 1, flexDirection: "column", border: true, borderColor: C.accent, padding: 1 }}
    >
      {lines.map((line, i) => (
        <text key={i} fg={line.color} attributes={line.bold === true ? 1 : 0}>
          {line.text}
        </text>
      ))}
    </box>
  )
}
