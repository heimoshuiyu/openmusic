import { expect, test } from "bun:test"
import {
  VIP_SKIP_REASON, albumDetail, briefOf, mergeLyrics, neteaseRuntime, searchSongs, songDetails, songLyrics, vipFee,
  type NeteaseRuntime,
} from "./api"
import { deliveredQuality, durationOk, durationToleranceMs } from "./downloader"
import { parseLyrics } from "../../util/lyrics"

const anonymous: NeteaseRuntime = neteaseRuntime({ neteaseRealIp: "" })
const realIp: NeteaseRuntime = neteaseRuntime({ neteaseRealIp: "116.25.146.77" })
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

test("runtime validation: NETEASE_REAL_IP must be an IPv4 when set", () => {
  expect(anonymous).toEqual({ realIp: null })
  expect(realIp).toEqual({ realIp: "116.25.146.77" })
  expect(neteaseRuntime({ neteaseRealIp: "  " }).realIp).toBeNull()
  for (const bad of ["116.25", "music.163.com", "116.25.146.777"]) {
    expect(() => neteaseRuntime({ neteaseRealIp: bad })).toThrow()
  }
})

test("fee precheck: only VIP (1) and paid-album (4) songs are refused, with a plain reason", () => {
  expect(vipFee(1)).toBe(true); expect(vipFee(4)).toBe(true)
  expect(vipFee(0)).toBe(false); expect(vipFee(8)).toBe(false); expect(vipFee(NaN)).toBe(false)
  expect(VIP_SKIP_REASON).toBe("VIP/付费歌曲需要会员账号，未导入。")
})

test("plain search parses the legacy shape (artists/album/duration) into briefs", () =>
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

test("plain requests carry the desktop UA and the optional X-Real-IP header", () =>
  withFixtures((input, init) => {
    const headers = new Headers(init?.headers)
    expect(headers.get("user-agent")).toContain("Chrome/")
    expect(headers.get("referer")).toBe("https://music.163.com/")
    expect(headers.get("x-real-ip")).toBe("116.25.146.77")
    return Response.json(searchFixture)
  }, async () => {
    const rows = await searchSongs("晴天", realIp, signal)
    expect(rows).toHaveLength(2)
  }))

test("briefOf also reads the v3 ar/al/dt shape as a defensive fallback", () => {
  expect(briefOf({ id: 5264842, name: "渡口", ar: [{ name: "蔡琴" }], al: { name: "惠威T200A试音碟", picUrl: "https://p3.music.126.net/x.jpg" }, dt: 227039, fee: 8 }))
    .toMatchObject({ songId: "5264842", title: "渡口", artist: "蔡琴", album: "惠威T200A试音碟", cover: "https://p3.music.126.net/x.jpg", durationMs: 227039, fee: 8 })
  expect(briefOf({ id: "not-a-number" })).toBeNull()
  expect(briefOf(null)).toBeNull()
})

test("album parsing reads plain album.songs; -462 risk control fails loudly", () => {
  const albumFixture = { code: 200, album: { name: "叶惠美", artist: { name: "周杰伦" }, publishTime: 1060617600000, songs: [
    { id: 5264842, name: "晴天", artists: [{ name: "周杰伦" }], album: { name: "叶惠美" }, fee: 8, duration: 269000 },
  ] } }
  return withFixtures(input => {
    if (String(input).includes("/api/album/35135711")) return Response.json(albumFixture)
    return Response.json({ code: -462 })
  }, async () => {
    const album = await albumDetail("35135711", anonymous, signal)
    expect(album).toMatchObject({ name: "叶惠美", artist: "周杰伦", publishTimeMs: 1060617600000 })
    expect(album.songs[0]).toMatchObject({ songId: "5264842", durationMs: 269000 })
    await expect(albumDetail("666666", anonymous, signal)).rejects.toThrow("暂时无法读取专辑")
  })
})

test("lyrics: lrc/tlyric extraction, nolyric returns null, translations merge by identical timestamps", () =>
  withFixtures(input => {
    const url = new URL(String(input))
    expect(url.searchParams.get("lv")).toBe("-1")
    if (url.searchParams.get("id") === "5264842") return Response.json({ code: 200, lrc: { lyric: "[00:01.00]原文" }, tlyric: { lyric: "[00:01.00]translation" } })
    return Response.json({ code: 200, nolyric: true })
  }, async () => {
    const translated = await songLyrics("5264842", anonymous, signal)
    expect(translated).toEqual({ lrc: "[00:01.00]原文", tlyrc: "[00:01.00]translation" })
    expect(mergeLyrics(translated!.lrc, translated!.tlyrc)).toBe("[00:01.00]原文\n[00:01.00]translation")
    // The stored body re-parses into a single bilingual line, exactly the shared lyric model.
    expect(parseLyrics(mergeLyrics(translated!.lrc, translated!.tlyrc))).toEqual([{ startMs: 1000, text: "原文\ntranslation" }])
    expect(await songLyrics("999999", anonymous, signal)).toBeNull()
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

test("delivered quality tiers map from flac or the probed MP3 bitrate", () => {
  expect(deliveredQuality("mp3", 320)).toBe("exhigh")
  expect(deliveredQuality("mp3", 321)).toBe("exhigh")
  expect(deliveredQuality("mp3", 192)).toBe("higher")
  expect(deliveredQuality("mp3", 128)).toBe("standard")
  expect(deliveredQuality("flac", 0)).toBe("lossless")
})
