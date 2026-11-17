import { SqlClient } from "effect/unstable/sql"
import { PgTypes } from "@effect/sql-pg"
import * as fs from "node:fs/promises"
import type { Dirent, Stats } from "node:fs"
import type { MetadataOverrides } from "../domain/metadata-overrides"
import { loadOverrides, saveOverrides } from "../repo/metadata-overrides"
import { UNKNOWN_ALBUM, UNKNOWN_ARTIST, VARIOUS_ARTISTS } from "@openmusic/shared"
import { Context, Effect, Exit, Fiber, Layer, Ref, Result } from "effect"
import { ScanInProgress } from "../domain/errors"
import { MusicFolderRepo } from "../repo/music-folders"
import { lockFolderIndex } from "../repo/library-exclusions"
import { reconcileAlbums, refreshTrackArtists } from "../repo/album-lifecycle"
import { AUDIO_EXTENSIONS, fromExtension } from "../util/codecs"
import { albumDirOf, discFromDirName } from "../util/album-grouping"
import { decodeCue, parseCue, type CueFile, type CueSheet } from "../util/cue"
import { ffprobeMeta, readMediaTags } from "../util/media-probe"

export interface ScanStatus {
  readonly state: "idle" | "scanning"
  /** 扫描子阶段（idle 时为 null）：walking=遍历磁盘，indexing=解析/入库 */
  readonly phase: "walking" | "indexing" | null
  readonly total: number
  readonly processed: number
  readonly startedAt: string | null
  readonly lastScanAt: string | null
  readonly errors: ReadonlyArray<string>
}

interface DiskFile {
  readonly relPath: string
  readonly absPath: string
  readonly mtimeMs: number
  readonly size: number
}

export interface ParsedFile extends DiskFile {
  /** null = 标签无 albumartist，等跨文件证据推断（resolvePendingAlbumArtists） */
  readonly albumArtist: string | null
  readonly trackArtist: string
  readonly album: string
  /** 专辑目录（尾部碟号段已剥掉）：albumartist 缺失时的推断分组键 */
  readonly albumDirRel: string
  readonly title: string
  readonly disc: number
  readonly trackNo: number | null
  readonly year: number | null
  readonly genre: string | null
  readonly durationSeconds: number
  readonly bitrateKbps: number
  readonly sampleRateHz: number
  readonly channels: number
  readonly codec: string
  readonly mime: string
  readonly hasEmbeddedCover: boolean
  /** CUE 虚拟分段：起点毫秒（物理行为 0） */
  readonly offsetMs: number
  readonly isVirtual: boolean
}

/** NFKC 归一化 + 去首尾空白（配合 lower(btrim(name)) 唯一索引，见 docs/03 §2.1） */
const norm = (s: string): string => s.normalize("NFKC").trim()

const withOverrides = (file: ParsedFile, overrides?: MetadataOverrides): ParsedFile => overrides ? {
  ...file,
  title: overrides.title ? norm(overrides.title) : file.title,
  trackArtist: overrides.artist ? norm(overrides.artist) : file.trackArtist,
  album: overrides.album ? norm(overrides.album) : file.album,
  albumArtist: overrides.albumArtist ? norm(overrides.albumArtist) : file.albumArtist,
  genre: overrides.genre ? norm(overrides.genre) : file.genre,
  disc: overrides.discNumber ?? file.disc, trackNo: overrides.trackNumber ?? file.trackNo,
} : file

/** 批内去重键：与 DB 唯一索引 lower(btrim(name)) 对齐 */
const nameKey = (s: string): string => s.toLowerCase()

/** 单语句参数上限 65535：批量语句与 IN 列表一律按远小于它的块切分 */
const UPSERT_CHUNK = 500
const DELETE_CHUNK = 500
const PARSE_CONCURRENCY = 8
const MAX_ERRORS = 100

/** 显式类型的数组参数——@effect/sql-pg 逐元素推断 OID：
 *  全 null 数组无法推断、int4/int8 混装会推断冲突，可空列/大数列必须显式定型
 *  （int8 编码器严格要求 BigInt 元素） */
const int4Array = (values: ReadonlyArray<number | null>): PgTypes.Parameter =>
  Result.getOrThrow(PgTypes.array(values, PgTypes.OID.int4))
const int8Array = (values: ReadonlyArray<number | null>): PgTypes.Parameter =>
  Result.getOrThrow(
    PgTypes.array(values.map((v) => (v === null ? null : BigInt(v))), PgTypes.OID.int8),
  )
const textArray = (values: ReadonlyArray<string | null>): PgTypes.Parameter =>
  Result.getOrThrow(PgTypes.array(values, PgTypes.OID.text))

/** 错误清单封顶：大库烂文件多时防 scan-status 响应膨胀 */
const addError = (errors: Array<string>, message: string): void => {
  if (errors.length < MAX_ERRORS) errors.push(message)
  else if (errors.length === MAX_ERRORS) errors.push("…… 错误条目过多，其余已省略")
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

/**
 * 递归遍历，收集白名单扩展名的音频文件（relPath 为相对 folder 根的 POSIX 路径）。
 * Effect 原生循环（非整段 promise）：onProgress 随走随报，大目录可见「发现 N 个文件」。
 *
 * 任何读失败——根不可达（挂载断开/目录被删）、子目录 readdir 失败、单文件 stat
 * 失败——都只记进 errors 并跳过该子树/文件，**绝不中止整个 walk**：调用方凭
 * `errors.length === 0` 判定 walk 完整，只有完整的 walk 才允许触发消失清理。
 * 「看不见」与「已消失」必须区分：远程 FS（NFS/SMB/sshfs）扫描数小时里一次
 * 瞬时读错误很平常，把整目录当作空库清掉是不可逆事故（play 墓碑化、收藏/评分清扫）。
 */
interface WalkResult {
  readonly files: ReadonlyArray<DiskFile>
  /** 伴生 cue 文件（虚拟分轨用，docs/03 §2.9）：walk 一并收集，stat 失败同样记错跳过 */
  readonly cues: ReadonlyArray<DiskFile>
  readonly errors: ReadonlyArray<string>
}

const walk = (
  root: string,
  onProgress: (filesSoFar: number) => Effect.Effect<void>,
): Effect.Effect<WalkResult> =>
  Effect.gen(function* () {
    const files: Array<DiskFile> = []
    const cues: Array<DiskFile> = []
    const errors: Array<string> = []
    const pending: Array<readonly [string, string]> = [[root, ""]]
    while (pending.length > 0) {
      const [dir, rel] = pending.pop()!
      const entries = yield* Effect.catch(
        Effect.tryPromise({
          try: () => fs.readdir(dir, { withFileTypes: true }),
          catch: (cause): string => `${dir}: ${String(cause)}`,
        }),
        (message: string) =>
          Effect.andThen(
            Effect.sync(() => {
              errors.push(message)
            }),
            Effect.succeed<ReadonlyArray<Dirent> | null>(null),
          ),
      )
      if (entries === null) continue
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue
        const abs = `${dir}/${entry.name}`
        const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`
        if (entry.isDirectory()) {
          pending.push([abs, childRel])
        } else if (entry.isFile()) {
          const ext = entry.name.split(".").pop()!.toLowerCase()
          const isCue = ext === "cue"
          if (!isCue && !AUDIO_EXTENSIONS.has(ext)) continue
          const stat = yield* Effect.catch(
            Effect.tryPromise({
              try: () => fs.stat(abs),
              catch: (cause): string => `${childRel}: ${String(cause)}`,
            }),
            (message: string) =>
              Effect.andThen(
                Effect.sync(() => {
                  errors.push(message)
                }),
                Effect.succeed<Stats | null>(null),
              ),
          )
          if (stat === null) continue
          // 0 字节死文件（下载残骸/云盘占位）：无任何可索引内容，静默跳过——
          // 已入库的僵尸行由消失清理自然回收（磁盘键不含它们）
          if (Number(stat.size) === 0) continue
          const diskFile: DiskFile = {
            relPath: childRel,
            absPath: abs,
            mtimeMs: Math.floor(stat.mtimeMs),
            size: Number(stat.size),
          }
          if (isCue) cues.push(diskFile)
          else {
            files.push(diskFile)
            // 单个巨型扁平目录也要有进度：每 200 个文件报一次
            if (files.length % 200 === 0) yield* onProgress(files.length)
          }
        }
      }
      yield* onProgress(files.length)
    }
    return { files, cues, errors }
  })

const parse = (file: DiskFile): Effect.Effect<ParsedFile, Error> =>
  Effect.tryPromise({
    try: async () => {
      const ext = file.relPath.split(".").pop()!.toLowerCase()
      const codecInfo = fromExtension(ext)!
      const fallbackTitle = file.relPath.split("/").pop()!.replace(/\.[^.]+$/, "")
      const parentDir = file.relPath.includes("/")
        ? file.relPath.slice(0, file.relPath.lastIndexOf("/"))
        : ""
      const parentSeg = parentDir.includes("/")
        ? parentDir.slice(parentDir.lastIndexOf("/") + 1)
        : parentDir
      const albumDirRel = albumDirOf(file.relPath)
      // 碟号链：标签 DISCNUMBER → 父目录名末段（`…/Disc 2/01.flac`）——目录分碟是
      // 标签缺失时唯一可靠的真相源（Re:Start 类 rip：双碟全部落 disc=1 就是没走这条链）
      const discFromTagsOrDir = (tagDisc: number | null | undefined): number =>
        tagDisc ?? discFromDirName(parentSeg) ?? 1
      // albumartist 判空：有些 rip 写空串，视同缺失走推断
      const albumArtistTag = (raw: string | null | undefined): string | null => {
        const trimmed = raw?.trim()
        return trimmed === undefined || trimmed === "" ? null : norm(trimmed)
      }
      // 同款空串守卫：空白标签当缺失，让兜底身份（Unknown）接管——
      // 否则会落一个名字为 "" 的艺人，26 首曲挂空名下（实测踩过）
      const tagOrUndefined = (raw: string | null | undefined): string | undefined => {
        const trimmed = raw?.trim()
        return trimmed === undefined || trimmed === "" ? undefined : trimmed
      }
      let mm: Awaited<ReturnType<typeof readMediaTags>>
      try {
        mm = await readMediaTags(file.absPath)
      } catch (metaError) {
        // music-metadata 解析怪癖兜底（实测 APEv2 footer 声明负 size → fs.read
        // RangeError，文件本身可读）：ffprobe 提取标签/时长；ffprobe 也读不出
        // 才真正弃单
        const probe = await ffprobeMeta(file.absPath)
        if (probe === null) throw metaError
        // ffprobe 偶尔对损坏容器 exit=0 但全零（如本例 FourCC 损坏的 FLAC）：
        // 结构不可读守卫与主路径同款，防假成功入库
        if (probe.durationSeconds === 0 && probe.sampleRateHz === 0) {
          throw metaError
        }
        return {
          ...file,
          albumArtist: albumArtistTag(probe.albumArtist),
          trackArtist: norm(tagOrUndefined(probe.artist) ?? tagOrUndefined(probe.albumArtist) ?? UNKNOWN_ARTIST),
          album: norm(tagOrUndefined(probe.album) ?? UNKNOWN_ALBUM),
          title: norm(tagOrUndefined(probe.title) ?? fallbackTitle),
          disc: discFromTagsOrDir(probe.disc),
          trackNo: probe.trackNo,
          albumDirRel,
          year: probe.year !== null && probe.year > 0 ? probe.year : null,
          genre: probe.genre !== null ? norm(probe.genre) : null,
          durationSeconds: probe.durationSeconds,
          bitrateKbps: probe.bitrateKbps,
          sampleRateHz: probe.sampleRateHz,
          channels: probe.channels,
          codec: codecInfo.codec,
          mime: probe.hasVideo ? codecInfo.mime.replace(/^audio\//, 'video/') : codecInfo.mime,
          hasEmbeddedCover: probe.coverStream !== null,
          offsetMs: 0,
          isVirtual: false,
        } satisfies ParsedFile
      }
      const c = mm.common
      // YouTube imports use TDRC for the video's upload date, not the shared album's year.
      const youtubeDate = Object.values(mm.native).some(tags => tags.some(t => /(?:^|:)OPENMUSIC_YOUTUBE_ID$/i.test(t.id)))
      // 结构不可读检测：连采样率/声道都拿不到（如 moov 缺失的 m4a 下载残骸，
      // music-metadata 不抛错只返回空）——这种文件任何播放器都解不开，不该
      // 入库为死曲。先试 ffprobe 能否补出流信息（跨解析器容错），全空才弃单
      let duration = mm.format.duration ?? 0
      let bitrate = Math.round((mm.format.bitrate ?? 0) / 1000)
      let sampleRate = mm.format.sampleRate ?? 0
      let channels = mm.format.numberOfChannels ?? 0
      if (duration === 0 && sampleRate === 0) {
        const probe = await ffprobeMeta(file.absPath)
        if (probe !== null && (probe.durationSeconds > 0 || probe.sampleRateHz > 0)) {
          duration = probe.durationSeconds
          bitrate = probe.bitrateKbps
          sampleRate = probe.sampleRateHz
          channels = probe.channels
        } else {
          throw new Error(`unreadable container (no stream info): ${file.relPath}`)
        }
      }
      return {
        ...file,
        albumArtist: albumArtistTag(c.albumartist),
        trackArtist: norm(tagOrUndefined(c.artist) ?? tagOrUndefined(c.albumartist) ?? UNKNOWN_ARTIST),
        album: norm(tagOrUndefined(c.album) ?? UNKNOWN_ALBUM),
        title: norm(tagOrUndefined(c.title) ?? fallbackTitle),
        disc: discFromTagsOrDir(c.disk?.no),
        trackNo: c.track?.no ?? null,
        albumDirRel,
        year: !youtubeDate && typeof c.year === "number" && c.year > 0 ? c.year : null,
        genre: c.genre?.[0] !== undefined ? norm(c.genre[0]) : null,
        durationSeconds: Math.round(duration),
        bitrateKbps: bitrate,
        sampleRateHz: sampleRate,
        channels: channels,
        codec: codecInfo.codec,
        mime: mm.format.hasVideo || (youtubeDate && ext === "mp4") ? codecInfo.mime.replace(/^audio\//, 'video/') : codecInfo.mime,
        hasEmbeddedCover: (c.picture?.length ?? 0) > 0,
        offsetMs: 0,
        isVirtual: false,
      } satisfies ParsedFile
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  })

// ---- CUE 虚拟分轨（docs/03 §2.9） ----

interface VirtualImage {
  readonly image: DiskFile
  readonly cue: DiskFile
  readonly sheet: CueSheet
  readonly section: CueFile
}

/** 虚拟行合成路径：镜像相对路径 + "#" + 三位零填充轨号（零填充保证 path 排序 = 轨序） */
export const virtualPath = (imageRelPath: string, trackNo: number): string =>
  `${imageRelPath}#${String(trackNo).padStart(3, "0")}`

/**
 * cue ↔ 镜像配对，产出虚拟化计划：
 * - cue FILE 按「同目录 + 文件名（大小写不敏感）」匹配 walk 收集的音频文件；
 *   引用的镜像不在库（分轨 rip 保留 cue 的典型形态，如本库 miku_music 699/702
 *   个 cue 目录）→ 整节静默跳过，分轨文件照常物理索引
 * - 同一镜像被 ≥2 轨引用才虚拟化；「每 FILE 恰一轨」的 cue（分轨自带 cue）
 *   走物理索引，避免同内容双份入库
 * - 存在 startMs 缺失或起点乱序的轨 → 分段边界不可信，该镜像走物理
 * - 同目录多个 cue 引用同一镜像：字典序第一个赢（其余跳过）
 */
const planVirtuals = (
  folderFiles: ReadonlyArray<DiskFile>,
  cues: ReadonlyArray<DiskFile>,
  onCueError: (message: string) => void,
): Effect.Effect<{ readonly virtuals: ReadonlyArray<VirtualImage>; readonly virtualizedRelPaths: ReadonlySet<string> }> =>
  Effect.gen(function* () {
    if (cues.length === 0) return { virtuals: [], virtualizedRelPaths: new Set<string>() }
    const dirOf = (rel: string): string => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "")
    const byDir = new Map<string, ReadonlyArray<DiskFile>>()
    for (const f of folderFiles) {
      const dir = dirOf(f.relPath)
      const list = byDir.get(dir) ?? []
      byDir.set(dir, [...list, f])
    }
    const claimed = new Map<string, VirtualImage>()
    for (const cue of [...cues].sort((a, b) => (a.relPath < b.relPath ? -1 : 1))) {
      const dir = dirOf(cue.relPath)
      const siblings = byDir.get(dir) ?? []
      const byLower = new Map(
        siblings.map((f) => [f.relPath.slice(dir === "" ? 0 : dir.length + 1).toLowerCase(), f]),
      )
      const text = yield* Effect.exit(
        Effect.promise(async () => decodeCue(new Uint8Array(await fs.readFile(cue.absPath)))),
      )
      if (Exit.isFailure(text)) {
        onCueError(`${cue.relPath}: ${String(text.cause)}`)
        continue
      }
      const sheet = parseCue(text.value)
      if (sheet === null) continue // 无有效 TRACK/FILE：静默忽略
      for (const section of sheet.files) {
        if (section.name.includes("/") || section.name.includes("\\")) continue // 只接受同目录引用
        const image = byLower.get(section.name.toLowerCase())
        if (image === undefined || claimed.has(image.relPath)) continue
        if (section.tracks.length < 2) continue
        if (!section.tracks.every((t) => t.startMs !== null)) continue
        const starts = section.tracks.map((t) => t.startMs!)
        let monotonic = true
        for (let i = 1; i < starts.length; i++) {
          if (starts[i]! < starts[i - 1]!) {
            monotonic = false
            break
          }
        }
        if (!monotonic) continue
        claimed.set(image.relPath, { image, cue, sheet, section })
      }
    }
    return { virtuals: [...claimed.values()], virtualizedRelPaths: new Set(claimed.keys()) }
  })

/** 由镜像解析结果 + cue 分段构造虚拟行（身份/元数据优先镜像内嵌 tag，cue 兜底；
 *  albumartist 双缺 → null，与其他未标注行一起走跨文件推断） */
const virtualParsed = (v: VirtualImage, image: ParsedFile): ReadonlyArray<ParsedFile> => {
  const tracks = v.section.tracks
  const sheetAA = v.sheet.albumArtist ?? v.sheet.performer
  const albumArtist = image.albumArtist ?? (sheetAA !== null ? norm(sheetAA) : null)
  const album =
    image.album !== UNKNOWN_ALBUM
      ? image.album
      : norm(v.sheet.title ?? UNKNOWN_ALBUM)
  const imageEndMs = image.durationSeconds * 1000
  return tracks.map((t, i) => {
    const startMs = t.startMs!
    const endMs = i + 1 < tracks.length ? tracks[i + 1]!.startMs! : imageEndMs
    return {
      ...image,
      relPath: virtualPath(v.image.relPath, t.no),
      mtimeMs: Math.max(image.mtimeMs, v.cue.mtimeMs),
      albumArtist,
      trackArtist: norm(t.performer ?? v.sheet.performer ?? image.trackArtist),
      album,
      title: norm(t.title ?? `${image.title} #${t.no}`),
      trackNo: t.no,
      disc: v.sheet.disc ?? image.disc,
      year: image.year ?? v.sheet.year,
      genre: image.genre ?? v.sheet.genre,
      durationSeconds: Math.max(1, Math.round((endMs - startMs) / 1000)),
      offsetMs: startMs,
      isVirtual: true,
    } satisfies ParsedFile
  })
}

/** 推断分组键：专辑目录 + 专辑名（目录是推断的边界——不同目录的同名专辑
 *  不会被推断规则错误合并；显式标签一致时仍走 (artist, name) 全局键）。 */
const inferenceGroupKey = (f: ParsedFile): string => `${f.albumDirRel}\u0000${nameKey(f.album)}`

/** 文件名轨号前缀（专辑 rip 的最强命名信号）：`(01) x` / `01. x` / `01 - x`；
 *  要求前缀后跟分隔符，`8bit.wav` 这类数字开头的词不误伤。 */
const TRACK_NO_PREFIX_RE = /^(?:\(\d{1,3}\)|\d{1,3})[.:\-_ ]/

/**
 * 专辑名回填（docs/02 §3）：整 folder 解析完后、albumartist 裁决前，按专辑目录
 * 分组做两级回填——标签缺失（album="Unknown Album"）不再是终局：
 * 1) 标签传染：组内带真实 album 标签且标签名唯一 → 传染给无标签行（半标注
 *    专辑：ripper 标了一半撂挑子；与 §5 的「半标注吸收」同一哲学）
 * 2) 目录名兜底：组内无任何标签证据，但多数文件名带轨号前缀 → 目录末段即
 *    专辑名（实测 Vocaloid Discography 合集 198 个目录全中此形态）。散曲
 *    目录不满足信号：mv/piano 下载件无轨号平铺、单曲多版本收藏（无轨号）
 *    都保持 Unknown。目录名里的来源后缀（`(FLAC)`/`(MP3)`）不剥——剥了会把
 *    同专辑双格式 rip 并成一张曲目翻倍的专辑。
 * 门控：目录内 ≥2 文件、带轨号 ≥2 且 ≥半数。证据集与 §5 相同 = 本次扫描
 * 实际解析的文件，增量视野不全时暂不回填，force 全量收敛。
 */
export const applyAlbumFallbacks = (
  files: ReadonlyArray<ParsedFile>,
): ReadonlyArray<ParsedFile> => {
  const groups = new Map<string, Array<ParsedFile>>()
  for (const f of files) {
    const list = groups.get(f.albumDirRel) ?? []
    list.push(f)
    groups.set(f.albumDirRel, list)
  }
  const out: Array<ParsedFile> = []
  for (const group of groups.values()) {
    const labeled = new Map<string, string>()
    for (const f of group) {
      if (f.album !== UNKNOWN_ALBUM) labeled.set(nameKey(f.album), f.album)
    }
    let fallback: string | null = null
    if (labeled.size === 1) {
      fallback = [...labeled.values()][0]!
    } else if (labeled.size === 0 && group.length >= 2) {
      const prefixed = group.filter((f) =>
        TRACK_NO_PREFIX_RE.test(f.relPath.slice(f.relPath.lastIndexOf("/") + 1))).length
      if (prefixed >= 2 && prefixed * 2 >= group.length) {
        const seg = group[0]!.albumDirRel.slice(group[0]!.albumDirRel.lastIndexOf("/") + 1)
        if (seg !== "") fallback = norm(seg)
      }
    }
    for (const f of group) {
      out.push(fallback !== null && f.album === UNKNOWN_ALBUM ? { ...f, album: fallback } : f)
    }
  }
  return out
}

/**
 * 专辑艺人统一裁决（docs/02 §5）——整个 music folder 解析完后对所有文件一次性进行，
 * 按「专辑目录 + 专辑名」分组：
 * 1) 组内显式 albumartist 唯一 → 该艺人（显式标签的常规形态）
 * 2) 组内显式 albumartist 多个且互相对立：
 *    - 众数覆盖 ≥ 80% → 该艺人吸收少数派（个别文件标错，如串了 performer）
 *    - 否则 → Various Artists（「撒谎的 albumartist」：ripper 给 VA 合辑逐曲
 *      填表演者，VOCALO.ID 2 实例 19 行单曲专辑即此病灶）
 * 3) 无任何显式：组内曲作者唯一 → 该艺人（单艺人未标注专辑）；
 *    多名 → Various Artists（合辑）
 *
 * 注意：证据集 = 本次扫描实际解析的文件。增量扫描只摸变更文件，视野不全时
 * 可能暂时归错（下次全量证据齐了自然收敛）；修复存量用 force 全量重扫。
 */
export const resolveAlbumArtists = (
  files: ReadonlyArray<ParsedFile>,
): ReadonlyArray<ParsedFile & { readonly albumArtist: string }> => {
  const groups = new Map<string, Array<ParsedFile>>()
  for (const f of files) {
    const key = inferenceGroupKey(f)
    const list = groups.get(key) ?? []
    list.push(f)
    groups.set(key, list)
  }
  const out: Array<ParsedFile & { readonly albumArtist: string }> = []
  for (const files_ of groups.values()) {
    const explicit = new Map<string, { name: string; count: number }>()
    for (const f of files_) {
      if (f.albumArtist === null) continue
      const entry = explicit.get(nameKey(f.albumArtist)) ?? { name: f.albumArtist, count: 0 }
      entry.count += 1
      explicit.set(nameKey(f.albumArtist), entry)
    }
    let artist: string
    if (explicit.size === 1) {
      artist = [...explicit.values()][0]!.name
    } else if (explicit.size >= 2) {
      const top = [...explicit.values()].reduce((a, b) =>
        b.count > a.count || (b.count === a.count && b.name < a.name) ? b : a)
      artist = top.count / files_.length >= 0.8 ? top.name : VARIOUS_ARTISTS
    } else {
      const trackArtists = new Map<string, string>()
      for (const f of files_) trackArtists.set(nameKey(f.trackArtist), f.trackArtist)
      artist = trackArtists.size === 1 ? [...trackArtists.values()][0]! : VARIOUS_ARTISTS
    }
    for (const f of files_) out.push({ ...f, albumArtist: artist })
  }
  return out
}

const COVER_CANDIDATES = [
  "cover.jpg",
  "cover.jpeg",
  "cover.png",
  "folder.jpg",
  "folder.png",
  "front.jpg",
  "front.png",
  "album.jpg",
  "album.png",
]

/** 非封面图命名（词元级子串）：底面/内页/盘面/腰封/书脊——选正面时排除 */
const NON_COVER_WORDS = ["back", "rear", "inside", "inlay", "disc", "cd", "dvd", "obi", "spine", "vinyl"]
/** 封面语义词，优先级与 COVER_CANDIDATES 同序（cover 最高） */
const COVER_WORDS = ["cover", "front", "folder", "album"]

const imageExtOf = (name: string): string | null => {
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : ""
  return ext === "jpg" || ext === "jpeg" || ext === "png" || ext === "webp" ? ext : null
}

/**
 * 目录内图片挑选（固定候选与专辑名候选全 miss 后的兜底）：自扫合集的封面
 * 命名与专辑名不同步（实测 MIKU-Pack 目录放 `MIKU-Pack 04 Song Collection.jpg`
 * 而目录名更长，专辑名候选永远 miss）。目录里常同时存在封面/底面/宣传图
 * 等整套图档，挑选规则：
 * - 单图 → 直接用
 * - 语义优先：文件名（stem）含封面词（cover/front/folder/album，优先级与
 *   COVER_CANDIDATES 同序）→ 取最高优先级词的字典序第一
 * - 数字序：stem 为纯数字的多页 booklet（`00 …`/`01 …` 从封面起的惯例）→ 取最小
 * - 兜底：排除非封面词（back/rear/disc/cd/obi/…）后取字典序第一
 * - 全部命中非封面词（只有底面/盘面照）→ 放弃，宁缺毋滥
 */
export const pickCoverImage = (names: ReadonlyArray<string>): string | null => {
  const images = names.filter((n) => imageExtOf(n) !== null && !n.startsWith("."))
  if (images.length === 0) return null
  if (images.length === 1) return images[0]!
  const stemOf = (name: string): string => name.slice(0, name.lastIndexOf(".")).toLowerCase()
  const pool = images.filter((n) => !NON_COVER_WORDS.some((w) => stemOf(n).includes(w)))
  if (pool.length === 0) return null
  for (const word of COVER_WORDS) {
    const hits = pool.filter((n) => stemOf(n).includes(word))
    if (hits.length > 0) return hits.reduce((a, b) => (b < a ? b : a))
  }
  const numeric = pool.filter((n) => /^\d+$/.test(stemOf(n)))
  if (numeric.length > 0) {
    return numeric.reduce((a, b) => Number(stemOf(b)) < Number(stemOf(a)) ? b : a)
  }
  return pool.reduce((a, b) => (b < a ? b : a))
}

export class Scanner extends Context.Service<Scanner, {
  /** Index exactly one newly published file. Never walk the library or remove missing tracks. */
  readonly indexImport: (folderId: number, relPath: string, absPath: string, options?: {metadata?:MetadataOverrides; fileDateIsUpload?:boolean}) => Effect.Effect<void, Error>
  /** force=true 跳过 mtime/size 增量基线，重解析全部文件（归组规则升级后修存量） */
  readonly start: (force?: boolean) => Effect.Effect<void, ScanInProgress>
  readonly cancel: Effect.Effect<void>
  readonly status: Effect.Effect<ScanStatus>
}>()("app/Scanner") {
  static readonly layer = Layer.effect(
    Scanner,
    Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const status = yield* Ref.make<ScanStatus>({
      state: "idle",
      phase: null,
      total: 0,
      processed: 0,
      startedAt: null,
      lastScanAt: null,
      errors: [],
    })
    /** 进行中的扫描 fiber（cancel 用；idle 后残留的句柄 interrupt 是无害 no-op） */
    const scanFiber = yield* Ref.make<Fiber.Fiber<void, unknown> | null>(null)

    /**
     * 批量 upsert：每 500 文件一个事务、每张表一条 unnest 多行语句
     * （此前每文件 4 次往返，10 万文件 = 40 万次；现在每批 3 次）。
     * 批内先按冲突键去重——`on conflict do update` 同语句命中同一行两次会直接报错。
     * 入参要求 albumArtist 已裁决为具体值（resolvePendingAlbumArtists 的产物）。
     */
    type ResolvedFile = ParsedFile & { readonly albumArtist: string }
    type PinSnapshot = ReadonlyMap<string, {revision:string; fields:MetadataOverrides}>
    const upsertBatch = (folderId: number, files: ReadonlyArray<ResolvedFile>, importedPath?:string, snapshot?:PinSnapshot, youtubePaths?:ReadonlySet<string>) =>
      sql.withTransaction(
        Effect.gen(function* () {
          // 路径批内去重：虚拟行由 cue 计划构造，同批同路径（异常 cue 场景）
          // 会触发 on conflict 同语句二次命中报错——先按 relPath 收敛
          const byPath = new Map<string, ResolvedFile>()
          for (const f of files) {
            if (!byPath.has(f.relPath)) byPath.set(f.relPath, f)
          }
          yield* lockFolderIndex(sql, folderId)
          const excluded = yield* sql`select path from library_exclusions where music_folder_id=${folderId} and path in ${sql.in([...byPath.keys()])}`
          for (const row of excluded) byPath.delete(String(row.path))
          if (snapshot && byPath.size) {
            // A concurrent edit/import already indexed the newer version. A stale folder scan must not undo it.
            const latest = yield* loadOverrides(sql,folderId,[...byPath.keys()])
            for (const path of byPath.keys()) if (latest.get(path)?.revision !== snapshot.get(path)?.revision) byPath.delete(path)
          }
          const rows = [...byPath.values()]
          if (!rows.length) return
          // 1) artists（album/track 艺人名合并去重，键对齐 lower(btrim(name))）
          const nameByKey = new Map<string, string>()
          for (const f of rows) {
            for (const n of [f.albumArtist, f.trackArtist]) {
              const key = nameKey(n)
              if (!nameByKey.has(key)) nameByKey.set(key, n)
            }
          }
          const artistRows = (yield* sql`
            insert into artists (name)
            select unnest(${textArray([...nameByKey.values()])})
            on conflict (lower(btrim(name))) do update set name = excluded.name
            returning id, name`) as ReadonlyArray<{ id: string | number; name: string }>
          const artistIdByKey = new Map(
            artistRows.map((r) => [nameKey(String(r.name)), Number(r.id)]),
          )
          const artistIdOf = (name: string): number => artistIdByKey.get(nameKey(name))!

          // 2) albums（键 = (albumArtistId, lower(name))；year/genre coalesce 语义与逐行版一致）
          const albumArgs = new Map<string, { artistId: number; name: string; year: number | null; genre: string | null }>()
          for (const f of rows) {
            const artistId = artistIdOf(f.albumArtist)
            const key = `${artistId}:${nameKey(f.album)}`
            // A pinned genre describes this version, not every sibling on its album. On a scan
            // leave the existing album genre alone unless an ordinary file supplies evidence.
            const genre = snapshot?.get(f.relPath)?.fields.genre ? null : f.genre
            const existingAlbum = albumArgs.get(key)
            if (!existingAlbum) albumArgs.set(key, { artistId, name: f.album, year: f.year, genre })
            else existingAlbum.genre ??= genre
          }
          const albumValues = [...albumArgs.values()]
          const albumRows = (yield* sql`
            insert into albums (artist_id, name, year, genre)
            select a, n, y, g from unnest(
              ${int8Array(albumValues.map((v) => v.artistId))},
              ${textArray(albumValues.map((v) => v.name))},
              ${int4Array(albumValues.map((v) => v.year))},
              ${textArray(albumValues.map((v) => v.genre))}) as u(a, n, y, g)
            on conflict (artist_id, lower(btrim(name)))
             do update set year = coalesce(excluded.year, albums.year),
                            genre = case when ${importedPath??null}::text is not null and exists
                              (select 1 from tracks t where t.album_id=albums.id and (t.music_folder_id,t.path) <> (${folderId},${importedPath??null}::text))
                              then albums.genre else coalesce(excluded.genre, albums.genre) end
            returning id, artist_id, name`) as ReadonlyArray<{ id: string | number; artist_id: string | number; name: string }>
          const albumIdByKey = new Map(
            albumRows.map((r) => [`${Number(r.artist_id)}:${nameKey(String(r.name))}`, Number(r.id)]),
          )
          const albumIdOf = (f: ResolvedFile): number =>
            albumIdByKey.get(`${artistIdOf(f.albumArtist)}:${nameKey(f.album)}`)!

          // 3) tracks（18 列 unnest；路径已在批首按 relPath 去重，不会同语句二次命中）
          yield* sql`
            insert into tracks (music_folder_id, album_id, artist_id, disc, track_no, title,
              duration_seconds, bitrate_kbps, sample_rate_hz, channels, format, codec,
              size_bytes, path, mtime_ms, has_embedded_cover, offset_ms, is_virtual)
            select ${folderId}, al, ar, d, tn, ti, du, br, sr, ch, fm, co, sz, pa, mt, ec, of, iv
            from unnest(
              ${int8Array(rows.map((f) => albumIdOf(f)))},
              ${int8Array(rows.map((f) => artistIdOf(f.trackArtist)))},
              ${int4Array(rows.map((f) => f.disc))},
              ${int4Array(rows.map((f) => f.trackNo))},
              ${textArray(rows.map((f) => f.title))},
              ${int4Array(rows.map((f) => f.durationSeconds))},
              ${int4Array(rows.map((f) => f.bitrateKbps))},
              ${int4Array(rows.map((f) => f.sampleRateHz))},
              ${int4Array(rows.map((f) => f.channels))},
              ${textArray(rows.map((f) => f.mime))},
              ${textArray(rows.map((f) => f.codec))},
              ${int8Array(rows.map((f) => f.size))},
              ${textArray(rows.map((f) => f.relPath))},
              ${int8Array(rows.map((f) => f.mtimeMs))},
              ${Result.getOrThrow(PgTypes.array(rows.map((f) => f.hasEmbeddedCover), PgTypes.OID.bool))},
              ${int8Array(rows.map((f) => f.offsetMs))},
              ${Result.getOrThrow(PgTypes.array(rows.map((f) => f.isVirtual), PgTypes.OID.bool))}) as u(al, ar, d, tn, ti, du, br, sr, ch, fm, co, sz, pa, mt, ec, of, iv)
            on conflict (music_folder_id, path) do update set
              album_id = excluded.album_id,
              artist_id = excluded.artist_id,
              disc = excluded.disc,
              track_no = excluded.track_no,
              title = excluded.title,
              duration_seconds = excluded.duration_seconds,
              bitrate_kbps = excluded.bitrate_kbps,
              sample_rate_hz = excluded.sample_rate_hz,
              channels = excluded.channels,
              format = excluded.format,
              codec = excluded.codec,
              size_bytes = excluded.size_bytes,
              mtime_ms = excluded.mtime_ms,
              has_embedded_cover = excluded.has_embedded_cover,
              offset_ms = excluded.offset_ms,
              is_virtual = excluded.is_virtual,
               updated_at = now()`
          const sourced = youtubePaths ? rows.filter(r => youtubePaths.has(r.relPath)) : []
          if (sourced.length) yield* sql`update youtube_imports y set genre=v.genre from tracks t,
            unnest(${textArray(sourced.map(f=>f.relPath))},${textArray(sourced.map(f=>f.genre))}) as v(path,genre)
            where t.music_folder_id=${folderId} and t.path=v.path and y.track_id=t.id and y.genre is distinct from v.genre`
        }),
      )

    /** 文件夹级封面解析；内嵌封面在请求时惰性提取（M2）。
     *  两类专辑不挂文件夹封面（docs/03 §2.4）：
     *  - 兜底命名的 Unknown Album——没有真实专辑身份，挂上等于给几十首无关曲目标同一张图
     *  - 曲目跨多个专辑目录的专辑——cover_file 是 folder 根的相对路径，取任意目录的封面都是错配。
     *  专辑目录 = 剥掉尾部碟号段后的目录（`ReStart-F/Disc 1` → `ReStart-F`）：
     *  多碟专辑的 Cover.jpg 放在专辑根目录是主流摆放，碟子目录不该把它判成「跨目录」 */
    const resolveFolderCovers = Effect.gen(function* () {
      // 虚拟行 path 带 "#NNN" 合成后缀：剥掉再算目录（镜像所在目录才是封面所在）
      const rows = (yield* sql`
        select al.id, min(t.music_folder_id)::int as folder_id,
               array_agg(distinct regexp_replace(t.path, '#[0-9]+$', '')) as paths,
               lower(regexp_replace(al.name, '\\s+', '', 'g')) as album_key
        from albums al join tracks t on t.album_id = al.id
        where al.cover_file is null and al.name <> ${UNKNOWN_ALBUM}
        group by al.id, al.name`) as ReadonlyArray<{
        id: string | number
        folder_id: number
        paths: ReadonlyArray<string>
        album_key: string
      }>
      if (rows.length === 0) return
      const folders = yield* MusicFolderRepo.listForScan
      for (const row of rows) {
        // 碟号子目录归一成一个专辑目录；归一后仍跨目录 → 真跨目录，跳过
        const albumDirs = new Set(row.paths.map((p) => albumDirOf(p)))
        if (albumDirs.size !== 1) continue
        const dirRel = [...albumDirs][0]!
        const folder = folders.find((f) => f.id === row.folder_id)
        if (folder === undefined) continue
        const dirAbs = dirRel === "" ? folder.path : `${folder.path}/${dirRel}`
        const candidates = [...COVER_CANDIDATES, `${row.album_key}.jpg`, `${row.album_key}.png`]
        const found: string | null = yield* Effect.promise(async () => {
          for (const candidate of candidates) {
            if (await exists(`${dirAbs}/${candidate}`)) {
              return dirRel === "" ? candidate : `${dirRel}/${candidate}`
            }
          }
          // 目录内图片挑选兜底（pickCoverImage）：封面/底面/宣传图整套同存的
          // 目录按语义优先级选正面封面（详见函数注释）。子目录不在 readdir
          // 平面结果里，多碟各自的碟内图天然不参与
          try {
            const entries = await fs.readdir(dirAbs)
            const picked = pickCoverImage(entries)
            if (picked !== null) {
              return dirRel === "" ? picked : `${dirRel}/${picked}`
            }
          } catch {
            // 目录不可读（消失/权限）：与候选 exists 同语义，跳过
          }
          return null
        })
        if (found !== null) {
          yield* sql`update albums set cover_file = ${found} where id = ${Number(row.id)}`
        }
      }
    })

    const scanNow = (force: boolean) => Effect.gen(function* () {
      const errors: Array<string> = []
      const folders = yield* MusicFolderRepo.listForScan

      // v4：forkDetach 启动有延迟——状态置位由 start() 在 fork 前同步完成，
      // 此处只推进 phase/total（walk 过程中可见「已发现 N 个文件」）
      yield* Ref.update(status, (s): ScanStatus => ({ ...s, phase: "walking" }))
      let discovered = 0
      const walked = yield* Effect.forEach(folders, (folder) =>
        Effect.map(
          walk(folder.path, (n) =>
            Ref.update(status, (s): ScanStatus => ({ ...s, total: discovered + n }))),
          (result) => {
            for (const message of result.errors) addError(errors, message)
            discovered += result.files.length
            // complete = walk 零错误：整棵树被完整看见过，是消失清理的前提
            return {
              folder,
              files: result.files,
              cues: result.cues,
              complete: result.errors.length === 0,
            }
          },
        ))
      const total = walked.reduce((n, entry) => n + entry.files.length, 0)
      yield* Ref.update(status, (s): ScanStatus => ({
        ...s,
        total,
        phase: "indexing",
      }))

      // 增量 diff 基线
      const existing = (yield* sql`select music_folder_id, path, mtime_ms, size_bytes from tracks`) as ReadonlyArray<{
        music_folder_id: string | number
        path: string
        mtime_ms: string | number
        size_bytes: string | number
      }>
      const existingMeta = new Map(
        existing.map((row) => [
          `${Number(row.music_folder_id)}:${row.path}`,
          { mtime: Number(row.mtime_ms), size: Number(row.size_bytes) },
        ]),
      )

      for (const { folder, files: walkedFiles, cues, complete } of walked) {
        const ignored = new Set((yield* sql`select path from library_exclusions where music_folder_id=${folder.id}`).map(r=>String(r.path)))
        const files = walkedFiles.filter(f=>!ignored.has(f.relPath))
        // CUE 配对：被虚拟化的镜像走虚拟行（每镜像 N 轨），其余物理索引。
        // 虚拟行总是重解析重入库（幂等；镜像数量级 = 专辑数，代价可忽略）——
        // 跳过 mtime diff 换取「cue 改轨数后旧合成键必然被清理」的正确性
        const plan = yield* planVirtuals(files, cues, (m) => addError(errors, m))

        // 消失清理只在 walk 完整成功时执行：读失败（挂载断开/子目录不可读/单文件
        // stat 失败）会让还存在的文件看起来「消失」——瞬时远程故障下清库不可逆
        // （play 墓碑化、收藏/评分清扫）。索引侧照常：找到的新增/变更文件继续
        // 入库，部分进度不丢；恢复后的下一次完整扫描自然会补做清理
        if (complete) {
          // 磁盘键 = 物理存活路径（不含被虚拟化的镜像——旧时代物理行由此清除）
          // + 当前虚拟合成键（cue 改轨数后，不再生成的旧合成键由此清除）。
          // 分块删（单语句 65535 参数上限，大库批量挪走会炸）
          const diskKeys = new Set<string>([
            ...files.filter((f) => !plan.virtualizedRelPaths.has(f.relPath)).map((f) => `${folder.id}:${f.relPath}`),
            ...plan.virtuals.flatMap((v) =>
              v.section.tracks.map((t) => `${folder.id}:${virtualPath(v.image.relPath, t.no)}`)),
          ])
          const vanished = [...existingMeta.keys()].filter(
            (key) => key.startsWith(`${folder.id}:`) && !diskKeys.has(key),
          ).map((key) => key.slice(key.indexOf(":") + 1))
          for (let i = 0; i < vanished.length; i += DELETE_CHUNK) {
            yield* sql`delete from tracks where music_folder_id = ${folder.id} and path in ${sql.in(vanished.slice(i, i + DELETE_CHUNK))}`
          }
        }

        // 新增/变更（mtime 或 size 变化）；force 跳过基线重解析一切；
        // 被虚拟化的镜像不物理入库
        const changed = files.filter((f) => {
          if (plan.virtualizedRelPaths.has(f.relPath)) return false
          if (force) return true
          const prev = existingMeta.get(`${folder.id}:${f.relPath}`)
          return prev === undefined || prev.mtime !== f.mtimeMs || prev.size !== f.size
        })

        // 两阶段：先解析完整个 folder，统一裁决后分批入库——显式 albumartist
        // 「谎话标签」（ripper 给 VA 合辑逐曲填表演者）的对立证据散在整组文件里，
        // 边解析边入库就永远看不见；裁决规则见 resolveAlbumArtists。
        // 内存上限 = 单 folder 解析结果（walk 本就全量持有 DiskFile，量级相当）
        const parsedAll: Array<ParsedFile> = []
        const pins = yield* loadOverrides(sql,folder.id)
        const youtubePaths = new Set((yield* sql<{path:string}>`select t.path from youtube_imports y join tracks t on t.id=y.track_id
          where t.music_folder_id=${folder.id}`).map(r=>r.path))

        for (let i = 0; i < changed.length; i += UPSERT_CHUNK) {
          const chunk = changed.slice(i, i + UPSERT_CHUNK)
          yield* Effect.forEach(chunk, (file) =>
            Effect.gen(function* () {
              const result = yield* Effect.exit(parse(file))
              if (Exit.isFailure(result)) {
                addError(errors, `${file.relPath}: ${String(result.cause)}`)
              } else {
                parsedAll.push(result.value)
              }
              yield* Ref.update(status, (s): ScanStatus => ({ ...s, processed: s.processed + 1 }))
            }), { concurrency: PARSE_CONCURRENCY })
        }

        // 虚拟行：每镜像解析一次（拿镜像 tag/codec/全长），按 cue 分段展开成 N 行
        for (const v of plan.virtuals) {
          const image = yield* Effect.exit(parse(v.image))
          if (Exit.isFailure(image)) {
            addError(errors, `${v.image.relPath}: ${String(image.cause)}`)
            continue
          }
          parsedAll.push(...virtualParsed(v, image.value))
          yield* Ref.update(status, (s): ScanStatus => ({ ...s, processed: s.processed + 1 }))
        }

        // 统一裁决（专辑名回填 → 显式唯一 / 众数≥80% 吸收 / VA）→ 分批入库
        const effective = parsedAll.map(f => withOverrides(youtubePaths.has(f.relPath) ? {...f,year:null} : f,pins.get(f.relPath)?.fields))
        const resolved = resolveAlbumArtists(applyAlbumFallbacks(effective)).map(f => {
          // Heuristics may combine conflicting on-disk credits, but cannot change a pinned album/credit.
          const pin = pins.get(f.relPath)?.fields
          return pin ? {...f,album:pin.album ? norm(pin.album) : f.album, albumArtist:pin.albumArtist ? norm(pin.albumArtist) : f.albumArtist} : f
        })
        for (let i = 0; i < resolved.length; i += UPSERT_CHUNK) {
          const result = yield* Effect.exit(upsertBatch(folder.id, resolved.slice(i, i + UPSERT_CHUNK),undefined,pins,youtubePaths))
          if (Exit.isFailure(result)) {
            addError(errors, `batch upsert failed: ${String(result.cause)}`)
          }
        }
      }

      // 清理悬空数据 + 物化计数（见 docs/03 §2.2 与 §4）
      yield* sql`delete from annotations where item_type = 'track' and item_id not in (select id from tracks)`
      yield* sql`delete from annotations where item_type = 'album' and item_id not in (select id from albums)`
      yield* sql`delete from annotations where item_type = 'artist' and item_id not in (select id from artists)`

      // An empty album with history or annotations is an identity, not a same-name merge candidate.
      yield* sql.withTransaction(reconcileAlbums(sql))
      // 艺人清扫必须同时看 albums.artist_id：只看 tracks.artist_id 会把「从未以曲作者身份
      // 出现的专辑艺人」（VA 合辑的典型形态）连同专辑、曲目整棵级联删除——
      // 且下次扫描又重新入库再被删，形成每次重扫的抖动（先删专辑再清艺人，引用集是净的）
      yield* sql`delete from artists where id not in (select artist_id from tracks)
                 and id not in (select artist_id from albums)`
      yield* sql`
        update albums al set track_count = c.n, duration_seconds = c.d
        from (select album_id, count(*)::bigint as n, sum(duration_seconds)::bigint as d
              from canonical_tracks group by album_id) c
        where al.id = c.album_id and (al.track_count, al.duration_seconds) <> (c.n, c.d)`
      yield* sql`
        update artists a set album_count = c.n, track_count = c.t
        from (select artist_id, count(distinct album_id)::bigint as n, count(*)::bigint as t
              from canonical_tracks group by artist_id) c
        where a.id = c.artist_id and (a.album_count, a.track_count) <> (c.n, c.t)`
      yield* Effect.ignore(resolveFolderCovers)

      yield* Effect.forEach(folders, (folder) => MusicFolderRepo.touchScanned(folder.id), { discard: true })
      yield* Ref.update(status, (s): ScanStatus => ({
        ...s,
        state: "idle",
        phase: null,
        lastScanAt: new Date().toISOString(),
        errors,
      }))
    })

    const start = (force = false) =>
      Effect.flatMap(Ref.get(status), (current) => {
        if (current.state === "scanning") {
          return Effect.fail(
            new ScanInProgress({ startedAt: current.startedAt ?? new Date().toISOString() }),
          )
        }
        return Effect.gen(function* () {
          // 同步置位（forkDetach 启动延迟期间 scan-status 必须已见 scanning）
          yield* Ref.update(status, (s): ScanStatus => ({
            ...s,
            state: "scanning",
            phase: "walking",
            total: 0,
            processed: 0,
            startedAt: new Date().toISOString(),
            errors: [],
          }))
          const fiber = yield* Effect.forkDetach(
            Effect.catchCause(scanNow(force), (cause) =>
              Effect.andThen(
                Effect.logError("scan failed", cause),
                Ref.update(status, (s): ScanStatus => ({
                  ...s,
                  state: "idle",
                  phase: null,
                  errors: [...s.errors, String(cause)],
                })),
              )).pipe(
              // 取消：interrupt 落在下一个 yield 点（SQL/解析间隙），已提交的批次保留
              Effect.onInterrupt(() =>
                Ref.update(status, (s): ScanStatus => ({
                  ...s,
                  state: "idle",
                  phase: null,
                  errors: [...s.errors, "扫描已取消（已完成的部分保留，重新扫描可续上）"],
                }))),
              Effect.provideService(SqlClient.SqlClient, sql),
            ),
          )
          yield* Ref.set(scanFiber, fiber)
        })
      })

    /** 幂等取消：没有进行中的扫描时为无害 no-op */
    const cancel = Effect.flatMap(Ref.get(scanFiber), (fiber) =>
      fiber === null ? Effect.void : Effect.andThen(Fiber.interrupt(fiber), Effect.void))

    return {
      indexImport: (folderId, relPath, absPath, options) => Effect.gen(function* () {
        const patch = options?.metadata
        const stat = yield* Effect.tryPromise(() => fs.stat(absPath))
        const file = yield* parse({ relPath, absPath, size: stat.size, mtimeMs: Math.floor(stat.mtimeMs) })
        yield* sql.withTransaction(Effect.gen(function* () {
          yield* lockFolderIndex(sql,folderId)
          const [prior]=yield* sql<{album_id:string;artist_id:string}>`select album_id,artist_id from tracks where music_folder_id=${folderId} and path=${relPath}`
          const saved = prior ? (yield* loadOverrides(sql,folderId,[relPath])).get(relPath)?.fields : undefined
          const effective = withOverrides(options?.fileDateIsUpload ? {...file,year:null} : file,{...saved,...patch})
          yield* upsertBatch(folderId, resolveAlbumArtists(applyAlbumFallbacks([effective])),relPath)
          const current=yield* sql<{id:string;album_id:string;artist_id:string}>`select id,album_id,artist_id from tracks where music_folder_id=${folderId} and path=${relPath}`
          if (!current[0]) return yield* Effect.fail(new Error('Track excluded or not indexed'))
          if (patch && Object.keys(patch).length) yield* saveOverrides(sql,current[0].id,patch)
          const affected=prior ? [...current, prior] : current
          yield* reconcileAlbums(sql,affected.map(r=>r.album_id))
          yield* refreshTrackArtists(sql,affected.map(r=>r.artist_id))
        }))
      }),
      start,
      cancel,
      status: Ref.get(status),
    } as const
    }),
  )
}
