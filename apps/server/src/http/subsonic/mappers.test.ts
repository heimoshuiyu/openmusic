import { describe, expect, test } from "bun:test"
import { dirId, groupByIndex, parseDirId } from "./mappers"

describe("coverArt / 目录 ID 编解码", () => {
  test("dirId 往返（含中日文、空格、斜杠层级）", () => {
    for (const rel of ["Artist A", "芸坊/雨月", "a b/c d/e f.mp3", "宇多田ヒカル/First Love"]) {
      const folderId = 3
      const encoded = dirId(folderId, rel)
      expect(encoded).toMatch(/^d3-[A-Za-z0-9_-]+$/) // base64url，无 +/=
      expect(parseDirId(encoded)).toEqual({ folderId, rel })
    }
  })

  test("parseDirId 拒绝非法输入", () => {
    expect(parseDirId("al-1")).toBeNull()
    expect(parseDirId("1")).toBeNull()
    expect(parseDirId("dx-!!!")).toBeNull()
    expect(parseDirId("d1-")).toBeNull()
  })
})

describe("getIndexes/getArtists 首字母分组", () => {
  test("字母分组排序（大小写归并），非字母归 #（CJK 归 #）", () => {
    const items = ["zak", "芸坊", "Apple", "banana", "初音ミク", "Zebra"]
    const groups = groupByIndex(items, (item) => item)
    expect(groups.map((group) => group.name)).toEqual(["A", "B", "Z", "#"])
    expect(groups[2]?.list).toEqual(["zak", "Zebra"])
    expect(groups[3]?.list).toEqual(["芸坊", "初音ミク"])
  })

  test("# 恒排最后", () => {
    const groups = groupByIndex(["漢字", "abc"], (item) => item)
    expect(groups[groups.length - 1]?.name).toBe("#")
  })
})
