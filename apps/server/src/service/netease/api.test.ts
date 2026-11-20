import { expect, test } from "bun:test"
import {
  VIP_SKIP_REASON, albumDetail, mergeLyrics, neteaseRuntime, searchSongs, songDetails, songLyrics, songUrl, vipFee,
  type NeteaseRuntime,
} from "./api"
import { deliveredQuality, durationOk, durationToleranceMs } from "./downloader"
import { parseLyrics } from "../../util/lyrics"

const anonymous: NeteaseRuntime = neteaseRuntime({ neteaseApiBase: "", neteaseQuality: "exhigh", neteaseRealIp: "" })
const instance: NeteaseRuntime = neteaseRuntime({ neteaseApiBase: "http://ncm-api:3000/", neteaseQuality: "lossless", neteaseRealIp: "116.25.146.77" })
const signal = new AbortController().signal

/** Inline fixtures only: every fetch in this file is mocked, no test touches the network. */
function withFixtures(handler: (input: Parameters<typeof fetch>[0], init?: RequestInit) => Response, run: () => Promise<void>) {
  const previous = globalThis.fetch
  return (async () => {
    globalThis.fetch = Object.assign((input: Parameters<typeof fetch>[0], init?: RequestInit) => Promise.resolve(handler(input, init)), { preconnect: previous.preconnect })
    try { await run() } finally { globalThis.fetch = previous }
  })()
}

const searchFixture = { code: 200, result: { songs: [
  { id: 5264842, name: "晴天", artists: [{ name: "周杰伦" }], album: { id: 35135711, name: "叶惠美", picUrl: "http://p1.music.126.net/6TqR_U__xy.jpg" }, fee: 8, duration: 269000 },
  { id: 2606227455, name: "VIP 歌曲", artists: [{ name: "某人" }], album: { name: "专辑" }, fee: 1, duration: 281000 },
] } }

test("runtime validation: quality whitelist, IPv4 realIP, instance base normalization", () => {
  expect(anonymous).toEqual({ base: null, level: "exhigh", realIp: null })
  expect(instance).toEqual({ base: "http://ncm-api:3000", level: "lossless", realIp: "116.25.146.77" })
  expect(neteaseRuntime({ neteaseApiBase: "http://h.example/ncm/", neteaseQuality: "exhigh", neteaseRealIp: " " }).base).toBe("http://h.example/ncm")
  for (const bad of ["ftp://x", "http://u:p@h:3000", "not a url", "http://:3000"]) {
    expect(() => neteaseRuntime({ neteaseApiBase: bad, neteaseQuality: "exhigh", neteaseRealIp: "" })).toThrow()
  }
  expect(() => neteaseRuntime({ neteaseApiBase: "", neteaseQuality: "extreme", neteaseRealIp: "" })).toThrow()
  expect(() => neteaseRuntime({ neteaseApiBase: "", neteaseQuality: "exhigh", neteaseRealIp: "116.25" })).toThrow()
  expect(() => neteaseRuntime({ neteaseApiBase: "", neteaseQuality: "exhigh", neteaseRealIp: "music.163.com" })).toThrow()
})

test("fee precheck: only VIP (1) and paid-album (4) songs are unimportable anonymously", () => {
  expect(vipFee(1)).toBe(true); expect(vipFee(4)).toBe(true)
  expect(vipFee(0)).toBe(false); expect(vipFee(8)).toBe(false); expect(vipFee(NaN)).toBe(false)
  expect(VIP_SKIP_REASON).toContain("NETEASE_API_BASE")
})

test("plain search parses legacy shape (artists/album/duration) into briefs", () =>
  withFixtures(input => {
    expect(String(input)).toContain("music.163.com/api/search/get")
    return Response.json(searchFixture)
  }, async () => {
    const rows = await searchSongs("晴天", anonymous, signal)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ songId: "5264842", title: "晴天", artist: "周杰伦", album: "叶惠美", fee: 8, durationMs: 269000 })
    expect(rows[0]!.cover).toBe("http://p1.music.126.net/6TqR_U__xy.jpg")
    expect(rows[1]!.fee).toBe(1)
  }))

test("instance search uses /search with keywords and the realIP query parameter", () =>
  withFixtures(input => {
    const url = new URL(String(input))
    expect(url.pathname).toBe("/search")
    expect(url.searchParams.get("keywords")).toBe("晴天")
    expect(url.searchParams.get("realIP")).toBe("116.25.146.77")
    return Response.json({ code: 200, result: { songs: [{ id: 1, name: "x", ar: [{ name: "v3 艺人" }], al: { name: "v3 专辑" }, dt: 1000, fee: 0 }] } })
  }, async () => {
    const rows = await searchSongs("晴天", instance, signal)
    expect(rows[0]).toMatchObject({ artist: "v3 艺人", album: "v3 专辑", durationMs: 1000 })
  }))

test("batch detail precheck encodes ids=[a,b] brackets and drops unknown entries", () =>
  withFixtures(input => {
    const url = new URL(String(input))
    expect(url.pathname).toBe("/api/song/detail")
    expect(url.searchParams.get("ids")).toBe("[5264842,2606227455]")
    expect(url.searchParams.get("id")).toBe("5264842")
    return Response.json({ code: 200, songs: [{ id: 5264842, name: "晴天", artists: [{ name: "周杰伦" }], album: { name: "叶惠美" }, fee: 8, duration: 269000 }] })
  }, async () => {
    const details = await songDetails(["5264842", "2606227455"], anonymous, signal)
    expect(details.size).toBe(1)
    expect(details.get("5264842")!.title).toBe("晴天")
    expect(details.has("2606227455")).toBe(false)
  }))

test("instance song/detail uses the comma-separated ids convention and the v3 ar/al/dt shape", () =>
  withFixtures(input => {
    const url = new URL(String(input))
    expect(url.pathname).toBe("/song/detail")
    expect(url.searchParams.get("ids")).toBe("5264842,2606227455")
    expect(url.searchParams.get("realIP")).toBe("116.25.146.77")
    return Response.json({ code: 200, songs: [
      { id: 5264842, name: "渡口", ar: [{ name: "蔡琴" }], al: { name: "惠威T200A试音碟", picUrl: "https://p3.music.126.net/x.jpg" }, dt: 227039, fee: 8 },
      { id: 2606227455, name: "作者", ar: [{ name: "某人" }], al: { name: "专辑" }, dt: 280822, fee: 1 },
    ] })
  }, async () => {
    const details = await songDetails(["5264842", "2606227455"], instance, signal)
    expect(details.get("5264842")).toMatchObject({ title: "渡口", artist: "蔡琴", album: "惠威T200A试音碟", durationMs: 227039 })
    expect(details.get("2606227455")).toMatchObject({ fee: 1, durationMs: 280822 })
  }))

test("album parsing accepts both plain (album.songs) and instance (top-level songs) shapes; -462 risk control fails loudly", () => {
  const albumFixture = { code: 200, album: { name: "叶惠美", artist: { name: "周杰伦" }, publishTime: 1060617600000, songs: [
    { id: 5264842, name: "晴天", artists: [{ name: "周杰伦" }], album: { name: "叶惠美" }, fee: 8, duration: 269000 },
  ] } }
  const instanceAlbumFixture = { code: 200, album: { name: "惠威T200A试音碟", artist: { name: "群星" }, publishTime: 1104508800007 },
    songs: [{ id: 5264836, name: "两千年等一次", ar: [{ name: "Smile" }], al: { name: "惠威T200A试音碟", picUrl: "https://p3.music.126.net/y.jpg" }, dt: 239706, fee: 0 }] }
  return withFixtures(input => {
    const url = String(input)
    if (url.includes("/api/album/35135711")) return Response.json(albumFixture)
    if (url.includes("/album?id=512635")) return Response.json(instanceAlbumFixture)
    return Response.json({ code: -462 })
  }, async () => {
    const album = await albumDetail("35135711", anonymous, signal)
    expect(album).toMatchObject({ name: "叶惠美", artist: "周杰伦", publishTimeMs: 1060617600000 })
    expect(album.songs[0]).toMatchObject({ songId: "5264842", durationMs: 269000 })
    const instanceAlbum = await albumDetail("512635", instance, signal)
    expect(instanceAlbum).toMatchObject({ name: "惠威T200A试音碟", artist: "群星", publishTimeMs: 1104508800007 })
    expect(instanceAlbum.songs[0]).toMatchObject({ songId: "5264836", title: "两千年等一次", artist: "Smile", durationMs: 239706 })
    await expect(albumDetail("666666", instance, signal)).rejects.toThrow("暂时无法读取专辑")
  })
})

test("instance /song/url/v1: url=null, freeTrialInfo and level are all read as-is", () =>
  withFixtures(input => {
    const url = new URL(String(input))
    expect(url.pathname).toBe("/song/url/v1")
    expect(url.searchParams.get("level")).toBe("lossless")
    if (url.searchParams.get("id") === "2606227455") return Response.json({ code: 200, data: [{ url: null, freeTrialInfo: { start: 0, end: 30000 } }] })
    if (url.searchParams.get("id") === "5264842") return Response.json({ code: 200, data: [{ url: "http://m701.music.126.net/x.flac", level: "lossless", type: "flac" }] })
    return Response.json({ code: 404 })
  }, async () => {
    const trial = await songUrl("2606227455", instance, signal)
    expect(trial).toEqual({ url: null, level: null, freeTrial: true })
    const full = await songUrl("5264842", instance, signal)
    expect(full).toEqual({ url: "http://m701.music.126.net/x.flac", level: "lossless", freeTrial: false })
    await expect(songUrl("999", instance, signal)).rejects.toThrow()
    await expect(songUrl("5264842", anonymous, signal)).rejects.toThrow()
  }))

test("lyrics: lrc/tlyric extraction, nolyric returns null, translations merge by identical timestamps", () =>
  withFixtures(input => {
    const url = new URL(String(input))
    if (url.searchParams.has("realIP")) return Response.json({ code: 200, lrc: { lyric: "[00:01.00]原文" }, tlyric: { lyric: "[00:01.00]translation" } })
    expect(url.searchParams.get("lv")).toBe("-1")
    return Response.json({ code: 200, nolyric: true })
  }, async () => {
    const translated = await songLyrics("5264842", instance, signal)
    expect(translated).toEqual({ lrc: "[00:01.00]原文", tlyrc: "[00:01.00]translation" })
    expect(mergeLyrics(translated!.lrc, translated!.tlyrc)).toBe("[00:01.00]原文\n[00:01.00]translation")
    // The stored body re-parses into a single bilingual line, exactly the shared lyric model.
    expect(parseLyrics(mergeLyrics(translated!.lrc, translated!.tlyrc))).toEqual([{ startMs: 1000, text: "原文\ntranslation" }])
    expect(await songLyrics("5264842", anonymous, signal)).toBeNull()
    expect(mergeLyrics("[00:01.00]原文", "")).toBe("[00:01.00]原文")
  }))

test("trial-duration guard: tolerance is max(2s, 1%), boundaries included", () => {
  expect(durationToleranceMs(200000)).toBe(2000)
  expect(durationToleranceMs(280000)).toBe(2800)
  expect(durationToleranceMs(600000)).toBe(6000)
  // A 30s silent VIP trial of a 281s song must fail; small encoder drift must pass.
  expect(durationOk(200000, 202.0)).toBe(true)
  expect(durationOk(200000, 198.0)).toBe(true)
  expect(durationOk(200000, 202.1)).toBe(false)
  expect(durationOk(280000, 30.0)).toBe(false)
  expect(durationOk(600000, 594.0)).toBe(true)
  expect(durationOk(600000, 593.9)).toBe(false)
})

test("delivered quality tiers map from the instance level, flac or the probed MP3 bitrate", () => {
  expect(deliveredQuality("mp3", 320, null)).toBe("exhigh")
  expect(deliveredQuality("mp3", 321, null)).toBe("exhigh")
  expect(deliveredQuality("mp3", 192, null)).toBe("higher")
  expect(deliveredQuality("mp3", 128, null)).toBe("standard")
  expect(deliveredQuality("flac", 0, null)).toBe("lossless")
  expect(deliveredQuality("mp3", 128, "lossless")).toBe("lossless")
})
