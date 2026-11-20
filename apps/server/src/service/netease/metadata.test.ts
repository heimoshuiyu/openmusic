import { expect, test } from "bun:test"
import { allowedArtwork, neteaseTags, releaseDay, type NeteaseDump } from "./metadata"
import type { SongBrief } from "./api"

const brief: SongBrief = { songId: "5264842", title: "晴天", artist: "周杰伦", album: "叶惠美", cover: "http://p3.music.126.net/cover.jpg", fee: 8, durationMs: 269000 }

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
