import { describe, expect, test } from "bun:test"
import { albumDirOf, discFromDirName } from "./album-grouping"
import { applyAlbumFallbacks, pickCoverImage, resolveAlbumArtists } from "../service/scanner"
import type { ParsedFile } from "../service/scanner"
import { UNKNOWN_ALBUM, VARIOUS_ARTISTS } from "@openmusic/shared"

describe("discFromDirName", () => {
  test("主流命名形态", () => {
    expect(discFromDirName("Disc 1")).toBe(1)
    expect(discFromDirName("disc 2")).toBe(2)
    expect(discFromDirName("CD 1")).toBe(1)
    expect(discFromDirName("cd3")).toBe(3)
    expect(discFromDirName("CD-2")).toBe(2)
    expect(discFromDirName("disk_04")).toBe(4)
    expect(discFromDirName("DISC 12")).toBe(12)
  })
  test("非纯碟号段不认（防误伤）", () => {
    expect(discFromDirName("Discography")).toBeNull()
    expect(discFromDirName("Disc 1 Bonus")).toBeNull()
    expect(discFromDirName("Disco")).toBeNull()
    expect(discFromDirName("CD")).toBeNull()
    expect(discFromDirName("CD 0")).toBeNull()
    expect(discFromDirName("CD 1000")).toBeNull() // 4 位超出 {1,3}
    expect(discFromDirName("")).toBeNull()
  })
})

describe("albumDirOf", () => {
  test("碟号子目录剥到专辑根", () => {
    expect(albumDirOf("ReStart-F/Disc 1/01.flac")).toBe("ReStart-F")
    expect(albumDirOf("ReStart-F/Disc 2/01.flac")).toBe("ReStart-F")
    expect(albumDirOf("Album/cd1/x.mp3")).toBe("Album")
    expect(albumDirOf("Album/CD-2/y.flac")).toBe("Album")
  })
  test("多层碟号段剥净", () => {
    expect(albumDirOf("Album/Disc 1/CD 1/x.flac")).toBe("Album")
  })
  test("平铺与根目录", () => {
    expect(albumDirOf("Album/01.flac")).toBe("Album")
    expect(albumDirOf("01.flac")).toBe("")
    expect(albumDirOf("Disc 1/01.flac")).toBe("") // 根下直接分碟：专辑目录=根
  })
  test("非碟号子目录不剥", () => {
    expect(albumDirOf("Artist/Album/bonus/x.flac")).toBe("Artist/Album/bonus")
    expect(albumDirOf("Discography/Album/x.flac")).toBe("Discography/Album")
  })
})

// ---- resolvePendingAlbumArtists 裁决规则 ----

const file = (over: Partial<ParsedFile>): ParsedFile =>
  ({
    relPath: "x/01.flac",
    absPath: "/x/01.flac",
    mtimeMs: 0,
    size: 1,
    albumArtist: null,
    trackArtist: "甲",
    album: "Album X",
    albumDirRel: "Album X",
    title: "t",
    disc: 1,
    trackNo: 1,
    year: null,
    genre: null,
    durationSeconds: 100,
    bitrateKbps: 1000,
    sampleRateHz: 44100,
    channels: 2,
    codec: "flac",
    mime: "audio/flac",
    hasEmbeddedCover: false,
    offsetMs: 0,
    isVirtual: false,
    ...over,
  }) as ParsedFile

describe("resolveAlbumArtists", () => {
  test("多名曲作者同组（无显式）→ Various Artists", () => {
    const out = resolveAlbumArtists([
      file({ albumDirRel: "ReStart", album: "Re:Start", trackArtist: "wowaka feat. ミク" }),
      file({ albumDirRel: "ReStart", album: "Re:Start", trackArtist: "ika feat. ミク" }),
      file({ relPath: "x/02.flac", albumDirRel: "ReStart", album: "Re:Start", trackArtist: "Neru" }),
    ])
    expect(out.every((f) => f.albumArtist === VARIOUS_ARTISTS)).toBe(true)
  })

  test("组内曲作者唯一（无显式）→ 还原为该艺人", () => {
    const out = resolveAlbumArtists([
      file({ albumDirRel: "Solo", album: "Solo Album", trackArtist: "丁" }),
      file({ relPath: "x/02.flac", albumDirRel: "Solo", album: "Solo Album", trackArtist: "丁" }),
    ])
    expect(out.every((f) => f.albumArtist === "丁")).toBe(true)
  })

  test("组内显式 albumartist 唯一 → 该艺人（半标注专辑自动并入已标注侧）", () => {
    const out = resolveAlbumArtists([
      file({ albumDirRel: "Solo", album: "Solo Album", albumArtist: "Various Artists", trackArtist: "戊" }),
      file({ relPath: "x/02.flac", albumDirRel: "Solo", album: "Solo Album", trackArtist: "己" }),
    ])
    expect(out.every((f) => f.albumArtist === "Various Artists")).toBe(true)
  })

  test("显式对立 + 众数 ≥80% → 众数吸收少数派（串标签的单文件）", () => {
    const files = [
      ...Array.from({ length: 9 }, (_, i) =>
        file({ relPath: `x/${i}.flac`, albumDirRel: "A", album: "Al", albumArtist: "正主", trackArtist: "正主" })),
      file({ relPath: "x/stray.flac", albumDirRel: "A", album: "Al", albumArtist: "串了", trackArtist: "串了" }),
    ]
    expect(resolveAlbumArtists(files).every((f) => f.albumArtist === "正主")).toBe(true)
  })

  test("显式对立且分散（谎话标签，VOCALO.ID 病灶）→ 整组 Various Artists", () => {
    const out = resolveAlbumArtists([
      file({ albumDirRel: "V2", album: "VOCALO.ID 2", albumArtist: "甲 feat. ルカ", trackArtist: "甲 feat. ルカ" }),
      file({ relPath: "x/02.mp3", albumDirRel: "V2", album: "VOCALO.ID 2", albumArtist: "乙 feat. Gumi", trackArtist: "乙 feat. Gumi" }),
      file({ relPath: "x/03.mp3", albumDirRel: "V2", album: "VOCALO.ID 2", albumArtist: "丙 Project", trackArtist: "丙 Project" }),
    ])
    expect(out.every((f) => f.albumArtist === VARIOUS_ARTISTS)).toBe(true)
  })

  test("显式对立 6:6 平分 → Various Artists（split 合辑）", () => {
    const files = [
      ...Array.from({ length: 6 }, (_, i) =>
        file({ relPath: `x/a${i}.flac`, albumDirRel: "S", album: "Split", albumArtist: "A", trackArtist: "A" })),
      ...Array.from({ length: 6 }, (_, i) =>
        file({ relPath: `x/b${i}.flac`, albumDirRel: "S", album: "Split", albumArtist: "B", trackArtist: "B" })),
    ]
    expect(resolveAlbumArtists(files).every((f) => f.albumArtist === VARIOUS_ARTISTS)).toBe(true)
  })

  test("不同目录的同名专辑不互相合并（目录是推断边界）", () => {
    const out = resolveAlbumArtists([
      file({ albumDirRel: "DirA", album: "Same Name", trackArtist: "甲" }),
      file({ albumDirRel: "DirB", album: "Same Name", trackArtist: "乙" }),
    ])
    expect(out[0]!.albumArtist).toBe("甲")
    expect(out[1]!.albumArtist).toBe("乙")
  })
})

// ---- applyAlbumFallbacks 专辑名回填 ----

describe("applyAlbumFallbacks", () => {
  test("目录名兜底：无标签 + 多数带轨号前缀 → 目录名成专辑（Vocaloid Discography 形态）", () => {
    const out = applyAlbumFallbacks([
      file({ relPath: "VD/MIKU-Pack/(01) a.flac", albumDirRel: "VD/MIKU-Pack", album: UNKNOWN_ALBUM }),
      file({ relPath: "VD/MIKU-Pack/(02) b.flac", albumDirRel: "VD/MIKU-Pack", album: UNKNOWN_ALBUM }),
      file({ relPath: "VD/MIKU-Pack/03. c.flac", albumDirRel: "VD/MIKU-Pack", album: UNKNOWN_ALBUM }),
    ])
    expect(out.every((f) => f.album === "MIKU-Pack")).toBe(true)
  })

  test("散曲目录：无轨号（mv/piano 下载件）→ 保持 Unknown", () => {
    const out = applyAlbumFallbacks([
      file({ relPath: "mv/lamazep/Medical Dream [sm31761195].mp4", albumDirRel: "mv/lamazep", album: UNKNOWN_ALBUM }),
      file({ relPath: "mv/lamazep/Another Song [sm31761196].mp4", albumDirRel: "mv/lamazep", album: UNKNOWN_ALBUM }),
    ])
    expect(out.every((f) => f.album === UNKNOWN_ALBUM)).toBe(true)
  })

  test("单曲多版本目录（LamazeP 形态，无轨号）→ 保持 Unknown", () => {
    const out = applyAlbumFallbacks([
      file({ relPath: "LC/やだ働かない/やだ働かない-初音ミク.mp3", albumDirRel: "LC/やだ働かない", album: UNKNOWN_ALBUM }),
      file({ relPath: "LC/やだ働かない/やだ働かない-offve_offcho.mp3", albumDirRel: "LC/やだ働かない", album: UNKNOWN_ALBUM }),
    ])
    expect(out.every((f) => f.album === UNKNOWN_ALBUM)).toBe(true)
  })

  test("目录内仅 1 文件 → 不触发（防单曲目录）", () => {
    const out = applyAlbumFallbacks([
      file({ relPath: "VD/Solo/(01) only.flac", albumDirRel: "VD/Solo", album: UNKNOWN_ALBUM }),
    ])
    expect(out[0]!.album).toBe(UNKNOWN_ALBUM)
  })

  test("带标签行不足半数轨号文件混合：半数以下轨号 → 不兜底", () => {
    const out = applyAlbumFallbacks([
      file({ relPath: "D/(01) a.flac", albumDirRel: "D", album: UNKNOWN_ALBUM }),
      file({ relPath: "D/きづいてはぁとFull - 8bit.wav", albumDirRel: "D", album: UNKNOWN_ALBUM }),
      file({ relPath: "D/驚天動地-初音ミク.mp3", albumDirRel: "D", album: UNKNOWN_ALBUM }),
      file({ relPath: "D/スパムジャック-初音ミク.mp3", albumDirRel: "D", album: UNKNOWN_ALBUM }),
    ])
    expect(out.every((f) => f.album === UNKNOWN_ALBUM)).toBe(true)
  })

  test("标签传染：半标注目录 → 无标签行并入唯一标签名", () => {
    const out = applyAlbumFallbacks([
      file({ relPath: "D/01 a.flac", albumDirRel: "D", album: "Best of D" }),
      file({ relPath: "D/02 b.flac", albumDirRel: "D", album: UNKNOWN_ALBUM }),
      file({ relPath: "D/03 c.flac", albumDirRel: "D", album: UNKNOWN_ALBUM }),
    ])
    expect(out.every((f) => f.album === "Best of D")).toBe(true)
  })

  test("杂目录（两个不同标签名）→ 不传染不兜底", () => {
    const out = applyAlbumFallbacks([
      file({ relPath: "D/(01) a.flac", albumDirRel: "D", album: "Album A" }),
      file({ relPath: "D/(02) b.flac", albumDirRel: "D", album: "Album B" }),
      file({ relPath: "D/(03) c.flac", albumDirRel: "D", album: UNKNOWN_ALBUM }),
    ])
    expect(out[0]!.album).toBe("Album A")
    expect(out[1]!.album).toBe("Album B")
    expect(out[2]!.album).toBe(UNKNOWN_ALBUM)
  })

  test("多碟目录：Disc 1/Disc 2 剥碟号后同归一个专辑目录名", () => {
    const out = applyAlbumFallbacks([
      file({ relPath: "Album/Disc 1/01.flac", albumDirRel: "Album", album: UNKNOWN_ALBUM }),
      file({ relPath: "Album/Disc 2/01.flac", albumDirRel: "Album", album: UNKNOWN_ALBUM }),
    ])
    expect(out.every((f) => f.album === "Album")).toBe(true)
  })

  test("根目录平铺 → 无目录名可用，保持 Unknown", () => {
    const out = applyAlbumFallbacks([
      file({ relPath: "01 a.flac", albumDirRel: "", album: UNKNOWN_ALBUM }),
      file({ relPath: "02 b.flac", albumDirRel: "", album: UNKNOWN_ALBUM }),
    ])
    expect(out.every((f) => f.album === UNKNOWN_ALBUM)).toBe(true)
  })

  test("与 albumartist 裁决串联：目录名专辑内多名曲作者 → Various Artists", () => {
    const out = resolveAlbumArtists(
      applyAlbumFallbacks([
        file({ relPath: "VD/MIKU-Pack/(01) a.flac", albumDirRel: "VD/MIKU-Pack", album: UNKNOWN_ALBUM, trackArtist: "リン" }),
        file({ relPath: "VD/MIKU-Pack/(02) b.flac", albumDirRel: "VD/MIKU-Pack", album: UNKNOWN_ALBUM, trackArtist: "レン" }),
      ]),
    )
    expect(out.every((f) => f.album === "MIKU-Pack" && f.albumArtist === VARIOUS_ARTISTS)).toBe(true)
  })
})

// ---- pickCoverImage 目录图片挑选 ----

describe("pickCoverImage", () => {
  test("单图任意名 → 直接用（MIKU-Pack 实测形态）", () => {
    expect(pickCoverImage(["MIKU-Pack 04 Song Collection.jpg", "01. a.flac", "playlist.m3u"]))
      .toBe("MIKU-Pack 04 Song Collection.jpg")
  })

  test("封面/底面/内页同存 → 语义选正面（front），排除 back/inlay", () => {
    expect(pickCoverImage(["front.jpg", "back.jpg", "inlay.jpg"])).toBe("front.jpg")
  })

  test("cover 语义词优先于 front（与 COVER_CANDIDATES 同序）", () => {
    expect(pickCoverImage(["front.jpg", "album cover art.png"])).toBe("album cover art.png")
  })

  test("多页 booklet 纯数字 stem → 取最小（00 起封面惯例）", () => {
    expect(pickCoverImage(["00.jpg", "01.jpg", "02.jpg"])).toBe("00.jpg")
    expect(pickCoverImage(["10.jpg", "2.jpg"])).toBe("2.jpg") // 数值比较，非字典序
  })

  test("字典序兜底：无语义多图取第一", () => {
    expect(pickCoverImage(["1 booklet.jpg", "2 booklet.jpg"])).toBe("1 booklet.jpg")
  })

  test("全负面词（只有底面/盘面/腰封照）→ 宁缺毋滥", () => {
    expect(pickCoverImage(["back.jpg", "cd1.jpg", "obi.jpg"])).toBeNull()
  })

  test("负面词排除后语义命中：obi 与 front cover 同存", () => {
    expect(pickCoverImage(["obi.jpg", "front cover.jpg"])).toBe("front cover.jpg")
  })

  test("无图片 → null；隐藏文件与非图片扩展名忽略", () => {
    expect(pickCoverImage(["01. a.flac", ".cover.jpg", "Scans"])).toBeNull()
  })

  test("webp 参与；大小写扩展名兼容", () => {
    expect(pickCoverImage(["COVER ART.JPG", "back.JPG"])).toBe("COVER ART.JPG")
    expect(pickCoverImage(["art.webp"])).toBe("art.webp")
  })
})
