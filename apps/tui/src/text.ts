/**
 * 终端文本度量工具——mini 播放器按可视宽度截断标题用。
 *
 * 终端里 CJK/全角字符占 2 列，按 code unit 数截断会让宽字符行溢出换行。
 * 这里实现一个够用的 wcwidth 近似（覆盖中日韩常用区段），误差可接受的
 * 场景是纯显示截断，不是对齐计算。
 */

/** 单个码点的显示列宽（近似：CJK/全角/歧义宽字符=2，其余=1；忽略组合符零宽） */
export function charWidth(cp: number): number {
  if (
    // —— 歧义宽度字符：CJK 环境终端普遍按 2 列渲染（·…░█▶★ 等），
    //    截断预算宁可高估也不换行 ——
    cp === 0x00b7 || // ·
    (cp >= 0x2010 && cp <= 0x2027) || // 各类破折号·省略号（含 … U+2026）
    (cp >= 0x2580 && cp <= 0x259f) || // ▀▄█▌▐░▒▓ 块元素（进度条）
    (cp >= 0x25a0 && cp <= 0x25ff) || // ■▶▼等几何图形
    (cp >= 0x2605 && cp <= 0x2606) || // ★☆
    (cp >= 0x2756 && cp <= 0x275f) || // ❚（暂停符 U+275A）
    (cp >= 0x2190 && cp <= 0x21ff) || // 箭头
    (cp >= 0x1100 && cp <= 0x115f) || // 谚文字母
    (cp >= 0x2329 && cp <= 0x232a) ||
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK 部首·康熙·假名补区
    (cp >= 0x3041 && cp <= 0x33ff) || // 平/片假名·注音·CJK 兼容
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK 扩展 A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK 统一表意
    (cp >= 0xa000 && cp <= 0xa4cf) || // 彝文
    (cp >= 0xac00 && cp <= 0xd7a3) || // 谚文音节
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK 兼容表意
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK 兼容形式
    (cp >= 0xff00 && cp <= 0xff60) || // 全角形式
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) || // 常用 emoji
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK 扩展 B+
  ) {
    return 2
  }
  return 1
}

/** 可视宽度 */
export function visualWidth(s: string): number {
  let w = 0
  for (const ch of s) w += charWidth(ch.codePointAt(0) ?? 0)
  return w
}

/** 按可视宽度截断，超长补省略号（… 视为 1 列） */
export function truncateVisual(s: string, maxWidth: number): string {
  if (maxWidth <= 0) return ""
  if (visualWidth(s) <= maxWidth) return s
  if (maxWidth === 1) return "…"
  let w = 0
  let out = ""
  for (const ch of s) {
    const cw = charWidth(ch.codePointAt(0) ?? 0)
    if (w + cw > maxWidth - 1) break
    w += cw
    out += ch
  }
  return `${out}…`
}

/** 按可视宽度右侧补空格到 width 列（帮助页两栏对齐用） */
export function padVisual(s: string, width: number): string {
  const w = visualWidth(s)
  return w >= width ? s : s + " ".repeat(width - w)
}
