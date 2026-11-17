/**
 * CUE sheet 解析（整轨虚拟分轨，docs/03 §2.9）。
 *
 * 只支持「专辑级」关键字：REM/PERFORMER/TITLE/FILE/TRACK/INDEX，其余行
 * （FLAGS/PREGAP/POSTGAP/CATALOG/ISRC/REPLAYGAIN…）静默忽略——解析器宽容：
 * 抓轨工具产出的 cue 千奇百怪（引号缺失、编码错误、乱序 INDEX），坏行跳过
 * 好过整张弃单。
 *
 * 编码：cue 是文本文件但无编码声明——日系抓轨几乎都是 Shift-JIS，中文
 * ripper 常 GB 系。策略：UTF-8 严格解码（BOM 场景）失败后按
 * gb18030 → big5 → shift-jis → euc-kr 逐个尝试，取首个零替换符结果。
 */

export interface CueTrack {
  readonly no: number
  readonly title: string | null
  readonly performer: string | null
  /** 起点毫秒（INDEX 01 优先，退 INDEX 00；都没有 = null，调用方应放弃该轨） */
  readonly startMs: number | null
}

export interface CueFile {
  /** FILE 行的文件名（原样，未做任何路径解析） */
  readonly name: string
  readonly tracks: ReadonlyArray<CueTrack>
}

export interface CueSheet {
  readonly title: string | null
  readonly performer: string | null
  readonly albumArtist: string | null
  readonly genre: string | null
  readonly year: number | null
  readonly disc: number | null
  readonly files: ReadonlyArray<CueFile>
}

const ENC_FALLBACKS = ["shift-jis", "gb18030", "big5", "euc-kr"] as const

/**
 * 候选编码可用性判定：
 * - 出现替换符（U+FFFD）→ 该编码解释不了这串字节，淘汰
 * - 半角片假名占比超阈 → 几乎必然是「GBK/Big5 字节被 SJIS 误读」的伪影
 *   （0xA0-0xDF 在 SJIS 是单字节半角片假名，真实 cue 里不会成片出现）
 *
 * 顺序含义：日系抓轨（本库主体）Shift-JIS 优先；SJIS 解不了的 GB 系字节
 * 通常落出半角片假马伪影被罚下，轮到 gb18030/big5。GB 系被 SJIS 误读成
 * 生僻汉字且恰好不成片假名时仍会误判——极端情况下元数据显示乱码，但
 * 虚拟化/时长/播放不受影响（编码只影响 title/performer 文本）。
 */
const plausibleFor = (text: string): boolean => {
  if (text.includes("�")) return false
  let halfKana = 0
  let total = 0
  for (const ch of text) {
    total++
    const c = ch.codePointAt(0)!
    if (c >= 0xff61 && c <= 0xff9f) halfKana++
  }
  return halfKana === 0 || halfKana / total <= 0.02
}

export const decodeCue = (bytes: Uint8Array): string => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    // 落到多字节回退链
  }
  for (const enc of ENC_FALLBACKS) {
    const text = new TextDecoder(enc).decode(bytes)
    if (plausibleFor(text)) return text
  }
  return new TextDecoder("utf-8").decode(bytes)
}

/** CUE 时间点 mm:ss:ff（75 帧/秒）→ 毫秒 */
const cueTimeToMs = (mm: string, ss: string, ff: string): number | null => {
  const m = Number(mm)
  const s = Number(ss)
  const f = Number(ff)
  if (![m, s, f].every((n) => Number.isInteger(n) && n >= 0)) return null
  return Math.round((m * 60 + s) * 1000 + (f * 1000) / 75)
}

/** 取双引号字符串；无引号时取到行尾（宽容抓轨工具的不规范输出） */
const readQuoted = (rest: string): { value: string; tail: string } | null => {
  const trimmed = rest.trim()
  if (trimmed.startsWith('"')) {
    const end = trimmed.indexOf('"', 1)
    if (end <= 0) return null
    return { value: trimmed.slice(1, end), tail: trimmed.slice(end + 1) }
  }
  if (trimmed.length === 0) return null
  return { value: trimmed, tail: "" }
}

const commandOf = (line: string): { cmd: string; rest: string } | null => {
  const match = /^([A-Za-z]+)\s*(.*)$/.exec(line.trim())
  if (match === null) return null
  return { cmd: match[1]!.toUpperCase(), rest: match[2] ?? "" }
}

/** REM DATE 的年份提取：容忍 "2013" / "2013-06-12" / "2013/06/12" */
const yearOf = (raw: string): number | null => {
  const m = /(\d{4})/.exec(raw)
  const y = m === null ? Number.NaN : Number(m[1])
  return Number.isInteger(y) && y > 0 && y < 3000 ? y : null
}

export const parseCue = (text: string): CueSheet | null => {
  const sheet: {
    title: string | null
    performer: string | null
    albumArtist: string | null
    genre: string | null
    year: number | null
    disc: number | null
  } = { title: null, performer: null, albumArtist: null, genre: null, year: null, disc: null }
  const files: Array<{ name: string; tracks: Array<CueTrack> }> = []
  let currentFile: { name: string; tracks: Array<CueTrack> } | null = null
  let pendingTrack: { no: number; title: string | null; performer: string | null; index00: number | null; index01: number | null } | null = null

  const flushTrack = () => {
    if (pendingTrack === null) return
    const startMs = pendingTrack.index01 ?? pendingTrack.index00
    currentFile?.tracks.push({
      no: pendingTrack.no,
      title: pendingTrack.title,
      performer: pendingTrack.performer,
      startMs,
    })
    pendingTrack = null
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith("//")) continue
    const parsed = commandOf(line)
    if (parsed === null) continue
    const { cmd, rest } = parsed

    if (cmd === "REM") {
      const inner = commandOf(rest)
      if (inner === null) continue
      const key = inner.cmd.toUpperCase()
      if (key === "ALBUMARTIST" || key === "ALBUM_ARTIST") {
        const q = readQuoted(inner.rest)
        if (q !== null && sheet.albumArtist === null) sheet.albumArtist = q.value.trim()
      } else if (key === "GENRE") {
        const q = readQuoted(inner.rest)
        if (q !== null && sheet.genre === null) sheet.genre = q.value.trim()
      } else if (key === "DATE") {
        if (sheet.year === null) sheet.year = yearOf(rest.trim().replace(/^DATE\s*/i, "").trim())
      } else if (key === "DISCNUMBER" || key === "DISC") {
        if (sheet.disc === null) {
          const n = Number(readQuoted(inner.rest)?.value ?? inner.rest.trim())
          if (Number.isInteger(n) && n > 0) sheet.disc = n
        }
      }
      continue
    }
    if (cmd === "PERFORMER") {
      const q = readQuoted(rest)
      if (q !== null) {
        if (pendingTrack !== null) pendingTrack.performer = q.value.trim()
        else sheet.performer = q.value.trim()
      }
      continue
    }
    if (cmd === "TITLE") {
      const q = readQuoted(rest)
      if (q !== null) {
        if (pendingTrack !== null) pendingTrack.title = q.value.trim()
        else sheet.title = q.value.trim()
      }
      continue
    }
    if (cmd === "FILE") {
      flushTrack()
      const q = readQuoted(rest)
      if (q === null || q.value.length === 0) {
        currentFile = null // FILE 行坏了：后续 TRACK 无处挂，放弃到下一个 FILE
        continue
      }
      currentFile = { name: q.value, tracks: [] }
      files.push(currentFile)
      continue
    }
    if (cmd === "TRACK") {
      flushTrack()
      const no = Number(rest.trim().split(/\s+/)[0])
      if (currentFile !== null && Number.isInteger(no) && no > 0) {
        pendingTrack = { no, title: null, performer: null, index00: null, index01: null }
      } else {
        pendingTrack = null
      }
      continue
    }
    if (cmd === "INDEX") {
      const match = /^(\d+)\s+(\d+):(\d+):(\d+)\s*$/.exec(rest.trim())
      if (match === null || pendingTrack === null) continue
      const ms = cueTimeToMs(match[2]!, match[3]!, match[4]!)
      if (ms === null) continue
      if (match[1] === "01") pendingTrack.index01 = ms
      else if (match[1] === "00") pendingTrack.index00 = ms
      // INDEX 02+（一章内多索引）忽略：分段以 00/01 为准
      continue
    }
    // 其余命令（FLAGS/PREGAP/POSTGAP/CATALOG/ISRC/…）忽略
  }
  flushTrack()

  const usable = files.filter((f) => f.tracks.length > 0)
  if (usable.length === 0) return null
  return { ...sheet, files: usable }
}
