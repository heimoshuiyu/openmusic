import { expect, test } from "bun:test"
import { neteaseSource } from "./source"

test("rebuilds trusted song/playlist/album/artist URLs, never sends the user's raw URL to yt-dlp", () => {
  for (const [raw, expected] of [
    ["https://music.163.com/song?id=5264842", { kind: "song", id: "5264842" }],
    ["http://music.163.com/song?id=5264842&userid=1", { kind: "song", id: "5264842" }],
    ["https://music.163.com/#/song?id=5264842", { kind: "song", id: "5264842" }],
    ["https://y.music.163.com/m/song?id=5264842", { kind: "song", id: "5264842" }],
    ["https://music.163.com/m/song/5264842", { kind: "song", id: "5264842" }],
    ["https://www.music.163.com/song/?id=5264842", { kind: "song", id: "5264842" }],
    ["https://music.163.com/playlist?id=718606", { kind: "playlist", id: "718606" }],
    ["https://music.163.com/#/playlist?id=718606", { kind: "playlist", id: "718606" }],
    ["https://music.163.com/album?id=35135711", { kind: "album", id: "35135711" }],
    ["https://music.163.com/#/album?id=35135711", { kind: "album", id: "35135711" }],
    ["https://y.music.163.com/m/album?id=35135711", { kind: "album", id: "35135711" }],
    ["https://music.163.com/artist?id=6454", { kind: "artist", id: "6454" }],
    [" https://music.163.com/song?id=6454 ", { kind: "song", id: "6454" }],
  ] as const) {
    expect(neteaseSource(raw)).toEqual({ ...expected, url: `https://music.163.com/${expected.kind}?id=${expected.id}` })
  }
})

test("rejects other hosts, paths, ids and injection attempts", () => {
  for (const url of [
    "file:///etc/passwd", "--exec=echo", "netease:song:5264842",
    "https://music.163.com.evil.com/song?id=5264842",
    "https://evil.com/?u=https://music.163.com/song?id=5264842",
    "https://user@music.163.com/song?id=5264842",
    "http://music.163.com:555/song?id=5264842",
    "https://music.163.com/discover/playlist?id=5264842",
    "https://music.163.com/dj?id=5264842",
    "https://music.163.com/song?id=abc", "https://music.163.com/song?id=",
    "https://music.163.com/song?id=123456789012345678901",
    "https://v6.music.163.com/song?id=5264842",
    "https://music.163.com/song/5264842/extra",
    "https://music.163.com/#/mv?id=5264842",
    "https://music.163.com/",
  ]) expect(neteaseSource(url)).toBeNull()
})
