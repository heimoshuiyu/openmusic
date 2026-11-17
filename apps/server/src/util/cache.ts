/**
 * 磁盘缓存 LRU 淘汰计划（纯函数，转码/封面缓存共用；docs/02 §6.2）。
 *
 * 语义：总量超预算时，从「最后触碰时间」（atime 与 mtime 取大——写缓存即触碰）
 * 最旧的开始挑受害者，删到预算的 90% 为止；minAgeMs 内触碰过的文件豁免
 * （避免淘汰与「刚写入正要回发」的竞态）。
 */

export interface CacheEntry {
  readonly path: string
  readonly size: number
  readonly atimeMs: number
  readonly mtimeMs: number
}

const touchedAt = (entry: CacheEntry): number => Math.max(entry.atimeMs, entry.mtimeMs)

export const planEviction = (
  entries: ReadonlyArray<CacheEntry>,
  maxBytes: number,
  now: number = Date.now(),
  minAgeMs: number = 60_000,
): ReadonlyArray<string> => {
  const total = entries.reduce((n, entry) => n + entry.size, 0)
  if (total <= maxBytes || entries.length === 0) return []
  const target = Math.floor(maxBytes * 0.9)
  const evictable = entries.filter((entry) => touchedAt(entry) <= now - minAgeMs)
  const victims: Array<string> = []
  let remaining = total
  for (const entry of [...evictable].sort((a, b) => touchedAt(a) - touchedAt(b))) {
    if (remaining <= target) break
    victims.push(entry.path)
    remaining -= entry.size
  }
  return victims
}
