import { describe, expect, test } from "bun:test"
import { parseRange } from "./stream"

describe("Range 头解析（仅单区间）", () => {
  const size = 1000

  test("无头 → null（普通 200 直传）", () => {
    expect(parseRange(undefined, size)).toBeNull()
  })

  test("bytes=0-99", () => {
    expect(parseRange("bytes=0-99", size)).toEqual({ start: 0, end: 99 })
  })

  test("开区间 bytes=900-（end 钳制到 size-1）", () => {
    expect(parseRange("bytes=900-", size)).toEqual({ start: 900, end: 999 })
  })

  test("后缀 bytes=-100（取最后 100 字节）", () => {
    expect(parseRange("bytes=-100", size)).toEqual({ start: 900, end: 999 })
    expect(parseRange("bytes=-99999", size)).toEqual({ start: 0, end: 999 }) // 超长钳制为全文
  })

  test("end 超过 size-1 被钳制", () => {
    expect(parseRange("bytes=0-99999", size)).toEqual({ start: 0, end: 999 })
  })

  test("非法输入 → null（交给 200 全量响应）", () => {
    expect(parseRange("bytes=abc", size)).toBeNull()
    expect(parseRange("bytes=", size)).toBeNull()
    expect(parseRange("chunks=0-1", size)).toBeNull()
    expect(parseRange("bytes=500-100", size)).toBeNull() // start > end
    expect(parseRange("bytes=1000-", size)).toBeNull() // start >= size
    expect(parseRange("bytes=-0", size)).toBeNull()
  })
})
