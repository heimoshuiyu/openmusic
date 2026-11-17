import { describe, expect, test } from "bun:test"
import { planEviction, type CacheEntry } from "./cache"

const entry = (
  path: string,
  size: number,
  touchedAgoMs = 1_000_000,
  mtimeAgoMs = 1_000_000,
): CacheEntry => ({
  path,
  size,
  atimeMs: Date.now() - touchedAgoMs,
  mtimeMs: Date.now() - mtimeAgoMs,
})

describe("磁盘缓存 LRU 淘汰计划（planEviction）", () => {
  test("总量未超预算 → 不淘汰", () => {
    expect(planEviction([entry("a", 100), entry("b", 100)], 300)).toEqual([])
  })

  test("超预算 → 从最旧开始删到预算的 90% 为止", () => {
    const victims = planEviction(
      [entry("new", 400, 500_000), entry("mid", 300, 900_000), entry("old", 300, 1_500_000)],
      500,
    )
    // total 1000 > 500 → target 450：old(300)→剩 700 仍超 → mid(300)→剩 400 ≤ 450 停
    expect(victims).toEqual(["old", "mid"])
  })

  test("minAge 内触碰过的文件豁免（写后即被淘汰的竞态防护）", () => {
    const victims = planEviction(
      [entry("fresh", 800, 10_000), entry("old", 200, 5_000_000)],
      500,
    )
    // fresh 10s 前触碰（< 60s 豁免）不可删；old 删完仍超预算也只能到此为止
    expect(victims).toEqual(["old"])
  })

  test("全部豁免时宁可不达标也不删新文件", () => {
    expect(planEviction([entry("fresh", 900, 0)], 100)).toEqual([])
  })

  test("atime 与 mtime 取大者为触碰时间（写缓存即触碰）", () => {
    const victims = planEviction(
      [entry("atime新mtime旧", 400, 100_000, 9_000_000), entry("mtime新", 400, 9_000_000, 100_000)],
      500,
    )
    expect(victims).toEqual(["atime新mtime旧"])
  })

  test("空列表 → 空计划", () => {
    expect(planEviction([], 0)).toEqual([])
  })
})
