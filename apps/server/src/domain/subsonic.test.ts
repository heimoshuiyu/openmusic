import { describe, expect, test } from "bun:test"
import { node, renderSubsonic, envelope, SUBSONIC_ERRORS, type SNode } from "./subsonic"

const parse = (format: string | undefined) => {
  const rendered = renderSubsonic(envelope.ok({ hello: node("hello", { id: "1" }) }), format)
  return JSON.parse(rendered.body)["subsonic-response"] as Record<string, unknown>
}

describe("Subsonic 信封渲染", () => {
  test("JSON 信封基础字段（Feishin 依赖 openSubsonic/serverVersion 探测）", () => {
    const response = parse("json")
    expect(response.status).toBe("ok")
    expect(response.version).toBe("1.16.1")
    expect(response.serverVersion).toBe("0.1.0")
    expect(response.openSubsonic).toBe(true)
    expect(response.hello).toEqual({ id: "1" })
  })

  test("错误信封（业务错误仍是 HTTP 200 语义，错误在 body）", () => {
    const rendered = renderSubsonic(
      envelope.error(SUBSONIC_ERRORS.wrongUsernameOrPassword, "Wrong username or password."),
      "json",
    )
    expect(rendered.contentType).toContain("application/json")
    const response = JSON.parse(rendered.body)["subsonic-response"]
    expect(response.status).toBe("failed")
    expect(response.error).toEqual({ code: 40, message: "Wrong username or password." })
  })

  test("children：数组保持数组、单节点渲染为对象（包裹节点）", () => {
    const single: SNode = node("playlists", {}, { playlist: [node("playlist", { id: "7" })] })
    const rendered = renderSubsonic(envelope.ok({ playlists: single }), "json")
    const response = JSON.parse(rendered.body)["subsonic-response"]
    // 包裹节点是对象，列表字段是数组
    expect(response.playlists).toEqual({ playlist: [{ id: "7" }] })
  })

  test("空数组省略（对齐 Navidrome，getStarred2 空收藏无 song 键）", () => {
    const starred = node("starred2", {}, { song: [], album: [node("album", { id: "1" })] })
    const rendered = renderSubsonic(envelope.ok({ starred2: starred }), "json")
    const response = JSON.parse(rendered.body)["subsonic-response"]
    expect(response.starred2).toBeDefined()
    expect("song" in response.starred2).toBeFalse()
    expect(response.starred2.album).toEqual([{ id: "1" }])
  })

  test("XML 输出：命名空间 + 属性 + 子元素重复", () => {
    const xml = renderSubsonic(
      envelope.ok({ musicFolders: node("musicFolders", {}, { musicFolder: [node("musicFolder", { id: 1, name: "M" })] }) }),
      "xml",
    )
    expect(xml.contentType).toContain("text/xml")
    expect(xml.body).toContain(`<?xml version="1.0" encoding="UTF-8"?>`)
    expect(xml.body).toContain(`xmlns="http://subsonic.org/restapi"`)
    expect(xml.body).toContain(`<musicFolder id="1" name="M"></musicFolder>`)
    expect(xml.body).toContain(`<subsonic-response `)
  })

  test("XML 错误信封", () => {
    const xml = renderSubsonic(envelope.error(0, "not implemented"), "xml")
    expect(xml.body).toContain(`<error code="0" message="not implemented"/>`)
  })

  test("XML 转义", () => {
    const xml = renderSubsonic(envelope.ok({ v: node("v", { name: `a<b"&'` }) }), "xml")
    expect(xml.body).toContain(`name="a&lt;b&quot;&amp;'`)
  })

  test("未指定 f 时默认 JSON（Feishin 恒带 f=json，默认兜底）", () => {
    expect(parse(undefined).status).toBe("ok")
  })

  test("text 节点渲染为 value 字段（getLyrics 场景）", () => {
    const lyrics = node("lyrics", { artist: "x" })
    const withText: SNode = { ...lyrics, text: "la la la" }
    const rendered = renderSubsonic(envelope.ok({ lyrics: withText }), "json")
    const response = JSON.parse(rendered.body)["subsonic-response"]
    expect(response.lyrics).toEqual({ artist: "x", value: "la la la" })
  })

  test("undefined/null 属性被省略", () => {
    const song = node("song", { id: "1", year: undefined, genre: null as unknown as undefined })
    const rendered = renderSubsonic(envelope.ok({ song }), "json")
    const response = JSON.parse(rendered.body)["subsonic-response"]
    expect(response.song).toEqual({ id: "1" })
  })
})
