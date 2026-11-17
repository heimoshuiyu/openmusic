import { describe, expect, test } from "bun:test"
import { decodeCue, parseCue } from "./cue"

const CUE = `
REM GENRE "Anime"
REM DATE 2013-05-22
REM ALBUMARTIST "Various Artists"
PERFORMER "雪ノ下雪乃"
TITLE "やはりこのキューシートはまちがっている。"
FILE "CDImage.flac" WAVE
  TRACK 01 AUDIO
    TITLE "Hello Alone"
    PERFORMER "雪ノ下雪乃"
    INDEX 00 00:00:00
    INDEX 01 00:37:00
  TRACK 02 AUDIO
    TITLE "Hello Alone (Instrumental)"
    INDEX 01 04:01:12
  TRACK 03 AUDIO
    TITLE "Bonus"
    INDEX 01 08:30:00
`

describe("CUE 解析（parseCue）", () => {
  test("基本结构：专辑元数据 + FILE + 多 TRACK + INDEX 01 优先", () => {
    const sheet = parseCue(CUE)!
    expect(sheet).not.toBeNull()
    expect(sheet.title).toBe("やはりこのキューシートはまちがっている。")
    expect(sheet.performer).toBe("雪ノ下雪乃")
    expect(sheet.albumArtist).toBe("Various Artists")
    expect(sheet.genre).toBe("Anime")
    expect(sheet.year).toBe(2013)
    expect(sheet.files).toHaveLength(1)
    const file = sheet.files[0]!
    expect(file.name).toBe("CDImage.flac")
    expect(file.tracks).toHaveLength(3)
    // TRACK 01：INDEX 00=0 但 INDEX 01=00:37:00 → 取 01
    expect(file.tracks[0]!.startMs).toBe(37_000)
    // 04:01:12 → (4*60+1)*1000 + 12*1000/75 ≈ 241160
    expect(file.tracks[1]!.startMs).toBe(241_160)
    expect(file.tracks[1]!.performer).toBeNull() // 未写 → 继承调用方处理
    expect(file.tracks[2]!.title).toBe("Bonus")
  })

  test("多 FILE（分盘整轨）：曲目挂到各自 FILE，flush 不丢最后一轨", () => {
    const sheet = parseCue(`
FILE "disc1.flac" WAVE
  TRACK 01 AUDIO
    INDEX 01 00:00:00
  TRACK 02 AUDIO
    INDEX 01 05:00:00
FILE "disc2.flac" WAVE
  TRACK 01 AUDIO
    INDEX 01 00:00:00
`)!
    expect(sheet.files).toHaveLength(2)
    expect(sheet.files[0]!.tracks).toHaveLength(2)
    expect(sheet.files[1]!.tracks).toHaveLength(1)
    expect(sheet.files[1]!.tracks[0]!.startMs).toBe(0)
  })

  test("INDEX 只有 00 时退回 00；全无 INDEX 的轨 startMs=null", () => {
    const sheet = parseCue(`
FILE "a.flac" WAVE
  TRACK 01 AUDIO
    INDEX 00 02:00:00
  TRACK 02 AUDIO
    TITLE "no index"
`)!
    expect(sheet.files[0]!.tracks[0]!.startMs).toBe(120_000)
    expect(sheet.files[0]!.tracks[1]!.startMs).toBeNull()
  })

  test("每轨一个 FILE（分轨 rip 的 cue）：正常解析，虚拟化判定留给调用方", () => {
    const sheet = parseCue(`
FILE "01.flac" WAVE
  TRACK 01 AUDIO
    INDEX 01 00:00:00
FILE "02.flac" WAVE
  TRACK 02 AUDIO
    INDEX 01 00:00:00
`)!
    expect(sheet.files).toHaveLength(2)
    expect(sheet.files.every((f) => f.tracks.length === 1)).toBe(true)
  })

  test("坏行宽容：未知命令/畸形 INDEX/无引号 FILE 跳过不炸", () => {
    const sheet = parseCue(`
FLAGS DCP
PREGAP 00:00:50
CATALOG 0000000000000
FILE no-quote.flac WAVE
  TRACK 01 AUDIO
    INDEX XX garbage
    INDEX 01 00:00:00
  TRACK 02 AUDIO
    ISRC JPPC01300123
    INDEX 01 not-a-time
    INDEX 01 01:00:00
`)!
    expect(sheet.files[0]!.tracks[0]!.startMs).toBe(0)
    expect(sheet.files[0]!.tracks[1]!.startMs).toBe(60_000)
  })

  test("无任何 TRACK/FILE → null（不是有效 cue）", () => {
    expect(parseCue("just some text\nnothing here")).toBeNull()
    expect(parseCue("")).toBeNull()
  })

  test("大小写不敏感 + CRLF + 尾随空白", () => {
    const sheet = parseCue(
      'title "Album"\r\nperformer "P"\r\nfile "x.ape" WAVE\r\n  track 01 audio\r\n    index 01 01:00:00  \r\n',
    )!
    expect(sheet.title).toBe("Album")
    expect(sheet.files[0]!.tracks[0]!.startMs).toBe(60_000)
  })

  test("REM DISCNUMBER 与年份容错", () => {
    const sheet = parseCue(`
REM DISCNUMBER 2
REM DATE "1998/07/22"
FILE "x.flac" WAVE
  TRACK 01 AUDIO
    INDEX 01 00:00:00
`)!
    expect(sheet.disc).toBe(2)
    expect(sheet.year).toBe(1998)
  })
})

describe("CUE 编码回退链（decodeCue）", () => {
  const text = 'PERFORMER "となるholm"\nTITLE "日本語タイトル"\n'

  test("UTF-8 直通", () => {
    expect(decodeCue(new TextEncoder().encode(text))).toContain("となるholm")
  })

  test("Shift-JIS 字节 → 正确解码（不会被 gb18030 抢走）", () => {
    // "日本語" Shift-JIS = 93 FA 96 7B 8C EA
    const sjis = new Uint8Array([0x50, 0x45, 0x52, 0x46, 0x4f, 0x52, 0x4d, 0x45, 0x52, 0x20, 0x22, 0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea, 0x22])
    expect(decodeCue(sjis)).toContain("日本語")
  })

  test("GBK 字节 → 正确解码（简中 ripper 常见）", () => {
    // "周杰伦" GBK = D6 DC D6 DC BD DC（周=D6 DC，杰=BD DC，伦=C2 D7）
    const gbk = new Uint8Array([0x22, 0xd6, 0xdc, 0xbd, 0xdc, 0xc2, 0xd7, 0x22])
    expect(decodeCue(gbk)).toContain("周杰伦")
  })

  test("无效 UTF-8 序列不误判为 UTF-8", () => {
    // 0x93 单字节在 UTF-8 里非法 → 必须走回退链
    const sjis = new Uint8Array([0x93, 0xfa, 0x96, 0x7b])
    const decoded = decodeCue(sjis)
    expect(decoded).toContain("日本")
  })
})
