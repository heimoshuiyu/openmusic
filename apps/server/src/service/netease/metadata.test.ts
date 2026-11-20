import { expect, test } from "bun:test"
import { allowedArtwork, applyNeteaseEdit, neteaseTags, releaseDay, validNeteaseTags, type NeteaseDump } from "./metadata"
import type { NeteaseRuntime, SongBrief } from "./api"

const brief: SongBrief = { songId: "5264842", title: "晴天", artist: "周杰伦", album: "叶惠美", cover: "http://p3.music.126.net/cover.jpg", fee: 8, durationMs: 269000 }
const signal = new AbortController().signal

test("netease artwork only resolves to https on the netease image CDN, never other hosts or schemes", () => {
  expect(allowedArtwork("http://p1.music.126.net/6TqR_U__xy.jpg")).toBe("https://p1.music.126.net/6TqR_U__xy.jpg")
  expect(allowedArtwork("https://p3.music.126.net/cover.png")).toBe("https://p3.music.126.net/cover.png")
  for (const raw of [
    "http://127.0.0.1/a.jpg", "file:///etc/passwd", "data:image/jpeg;base64,AAAA",
    "https://p1.music.126.net.evil.example/a.jpg", "https://evil.com/a.jpg",
    "https://u@p1.music.126.net/a.jpg", "http://p1.music.126.net:8080/a.jpg",
    "http://p1.music.126.net/a.jpg?param=1", "http://p1.music.126.net/a.gif", "http://music.126.net/a.jpg",
  ]) expect(allowedArtwork(raw)).toBeNull()
})

test("album release days are calendar days within a sane range", () => {
  expect(releaseDay(Date.UTC(2003, 7, 1) / 1000, "s")).toBe("2003-08-01")
  expect(releaseDay(Date.UTC(2003, 7, 12), "ms")).toBe("2003-08-12")
  expect(releaseDay(null, "s")).toBeNull(); expect(releaseDay(0, "ms")).toBeNull()
  expect(releaseDay(4102444800, "s")).toBe("2100-01-01")
  expect(releaseDay(Date.UTC(2101, 0, 1) / 1000, "s")).toBeNull()
})

test("netease tags prefer the per-song dump, fall back to the precheck detail, never invent enrichment", () => {
  const dump: NeteaseDump = { id: "5264842", title: "晴天 (Live)", creators: [{ name: "周杰伦" }, { name: "特邀" }],
    album: "叶惠美", album_artists: [{ name: "周杰伦" }], timestamp: Date.UTC(2003, 7, 12) / 1000, thumbnail: "http://p1.music.126.net/dump.jpg" }
  const built = neteaseTags(brief, dump, null)
  expect(built.tags).toEqual({ title: "晴天 (Live)", artist: "周杰伦 / 特邀", album: "叶惠美", albumArtist: "周杰伦", cover: "https://p1.music.126.net/dump.jpg" })
  expect(built.date).toBe("2003-08-12")
  // No dump (instance mode): detail fields carry the tags, albumDate only fills the date.
  const plain = neteaseTags(brief, null, "2003-08-12")
  expect(plain.tags).toEqual({ title: "晴天", artist: "周杰伦", album: "叶惠美", cover: "https://p3.music.126.net/cover.jpg" })
  expect(plain.date).toBe("2003-08-12")
  expect(neteaseTags(brief, null, null).date).toBeNull()
  // Off-CDN covers from the source are refused, not silently fetched.
  expect(neteaseTags({ ...brief, cover: "https://evil.example/x.jpg" }, null, null).tags.cover).toBeNull()
})

// ---- 管理编辑入参与封面校验（N2）----

test("编辑入参仅接受覆盖字段，拒绝未知字段与越界值", () => {
  expect(validNeteaseTags({})).toEqual({})
  expect(validNeteaseTags({ title: "新标题", genre: "J-Pop" })).toEqual({ title: "新标题", genre: "J-Pop" })
  expect(validNeteaseTags({ trackNumber: 1, discNumber: 99 })).toEqual({ trackNumber: 1, discNumber: 99 })
  // 未知字段 / 越界轨号 / 空 cover 一律 Schema 层拒绝
  for (const bad of [{ uploadDate: "2026-11-01" }, { trackNumber: 0 }, { discNumber: 10000 }, { cover: "" }, { title: "" }]) {
    expect(() => validNeteaseTags(bad)).toThrow()
  }
})

const rt: NeteaseRuntime = { realIp: null }

test("applyNeteaseEdit 在触碰任何文件前拒绝非法封面（不发起网络、不启动标签进程）", async () => {
  await expect(applyNeteaseEdit("/nonexistent", "5264842", { cover: "https://evil.example/x.jpg" }, rt, signal, { ext: "mp3" }))
    .rejects.toThrow("仅支持 *.music.126.net")
  await expect(applyNeteaseEdit("/nonexistent", "5264842", { cover: "data:image/jpeg;base64,!!not-base64!!" }, rt, signal, { ext: "mp3" }))
    .rejects.toThrow("封面数据无效或过大")
})

test("cover:\"netease\" 回源失败即整次编辑失败：详情缺失时不降级、不写文件", async () => {
  const previous = globalThis.fetch
  try {
    globalThis.fetch = Object.assign(async () => Response.json({ code: 200, songs: [] }), { preconnect: previous.preconnect })
    await expect(applyNeteaseEdit("/nonexistent", "5264842", { cover: "netease" }, rt, signal, { ext: "mp3" }))
      .rejects.toThrow("未能取得网易云封面")
  } finally { globalThis.fetch = previous }
})

test("cover:\"netease\" 只接受详情里的 *.music.126.net 封面，其他 host 一律拒绝", async () => {
  const previous = globalThis.fetch
  try {
    globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
      const url = new URL(String(input instanceof Request ? input.url : input))
      expect(url.hostname).toBe("music.163.com")
      // 详情给的封面在白名单外 → sourceCover 必须拒绝而不是转而 fetch
      return Response.json({ code: 200, songs: [{ id: 5264842, name: "晴天", artists: [{ name: "周杰伦" }], album: { name: "叶惠美", picUrl: "https://evil.example/cover.jpg" }, fee: 8, duration: 269000 }] })
    }, { preconnect: previous.preconnect })
    await expect(applyNeteaseEdit("/nonexistent", "5264842", { cover: "netease" }, rt, signal, { ext: "mp3" }))
      .rejects.toThrow("未能取得网易云封面")
  } finally { globalThis.fetch = previous }
})
