import * as fs from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { parseFile } from "music-metadata"
import { fetchBounded, songDetails, type NeteaseRuntime, type SongBrief } from "./api"
import { NeteaseTags as NeteaseTagsInput } from "../../domain/netease"
import type { MetadataOverrides } from "../../domain/metadata-overrides"

/** Netease keeps its own cover/tag path: no iTunes enrichment, artwork only from *.music.126.net
 *  (http is normalized to https). Album release dates come from the source, unlike YouTube upload days. */

export const neteaseCdn = /^[\w-]+\.music\.126\.net$/
const maxImage = 4 * 1024 * 1024

/** Returns the normalized https URL, or null for anything off the netease image CDN. */
export function allowedArtwork(raw: string): string | null {
  const u = URL.parse(raw)
  if (!u || !["http:", "https:"].includes(u.protocol) || u.username || u.password || u.port || u.search || u.hash) return null
  if (!neteaseCdn.test(u.hostname) || !/\.(?:jpe?g|png|webp)$/i.test(u.pathname)) return null
  return `https://${u.hostname}${u.pathname}`
}

export function releaseDay(value: number | null | undefined, scale: "s" | "ms"): string | null {
  if (!Number.isFinite(value) || !value) return null
  const date = new Date(scale === "s" ? value * 1000 : value)
  if (Number.isNaN(date.getTime())) return null
  const year = date.getUTCFullYear()
  return year >= 1980 && year <= 2100 ? date.toISOString().slice(0, 10) : null
}

/** yt-dlp's netease dump. There is no artist/track/channel field — never run YouTube-style enrichment. */
export interface NeteaseDump {
  readonly id?: string | number
  readonly title?: string
  readonly creator?: string
  readonly creators?: ReadonlyArray<Record<string, unknown>>
  readonly album?: string
  readonly album_artists?: ReadonlyArray<Record<string, unknown>>
  readonly timestamp?: number
  readonly thumbnail?: string
}

export interface NeteaseTagValues { title: string; artist: string; album: string; albumArtist?: string; cover: string | null }
export interface NeteaseTags { tags: NeteaseTagValues; date: string | null }

const text = (value: unknown, max: number): string => typeof value === "string" ? value.trim().slice(0, max) : ""
const names = (list: ReadonlyArray<Record<string, unknown>> | undefined): string[] =>
  Array.isArray(list) ? list.map(a => text(a?.name, 150)).filter(Boolean) : []

/** Source tags prefer the per-song dump (creators/album_artists/timestamp/thumbnail), the
 *  precheck detail fills the gaps. cover is already allowlisted+normalized; date falls back to albumDate. */
export function neteaseTags(detail: SongBrief, dump: NeteaseDump | null, albumDate: string | null): NeteaseTags {
  const creators = names(dump?.creators)
  const albumArtists = names(dump?.album_artists)
  return {
    tags: {
      title: text(dump?.title, 300) || detail.title,
      artist: (creators.length ? creators.join(" / ") : text(dump?.creator, 300) || detail.artist).slice(0, 300),
      album: text(dump?.album, 300) || detail.album,
      ...(albumArtists.length ? { albumArtist: albumArtists.join(" / ").slice(0, 300) } : {}),
      cover: allowedArtwork(text(dump?.thumbnail, 2048) || detail.cover || ""),
    },
    date: releaseDay(dump?.timestamp, "s") ?? albumDate,
  }
}

export interface NeteaseTagResult { date: string | null; coverSource: string | null; warnings: string[] }

export async function applyNeteaseTags(dir: string, songId: string, tags: NeteaseTagValues, date: string | null, signal: AbortSignal,
  options: { ext: "mp3" | "flac" }): Promise<NeteaseTagResult> {
  const warnings: string[] = []
  let image: string | undefined, coverSource: string | null = null
  if (!tags.cover) warnings.push("未取得专辑封面，媒体仍已入库。")
  else try {
    const bytes = await fetchBounded(tags.cover, signal, maxImage)
    if (!bytes.length || bytes.length > maxImage) throw Error("封面大小无效")
    // Netease may serve PNG bytes under a .jpg name; tag_media.py re-encodes via Pillow.
    await fs.writeFile(path.join(dir, "cover-input"), bytes)
    image = "cover-input"; coverSource = tags.cover
  } catch { signal.throwIfAborted(); warnings.push("未取得专辑封面，媒体仍已入库。") }
  if (!date) warnings.push("未取得专辑发行日期。")
  const values: Record<string, string> = {}
  if (tags.title) values.title = tags.title
  if (tags.artist) values.artist = tags.artist
  if (tags.album) values.album = tags.album
  if (tags.albumArtist) values.albumArtist = tags.albumArtist
  signal.throwIfAborted()
  const proc = Bun.spawn([process.env.OPENMUSIC_TAG_PYTHON || "python3", "-I", path.join(import.meta.dir, "../youtube/tag_media.py")], {
    cwd: dir, stdin: new Blob([JSON.stringify({ source: "netease", songId, ext: options.ext, tags: values, uploadDate: date, image, newImport: true })]),
    stdout: "pipe", stderr: "ignore", signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
  })
  if (await proc.exited !== 0) throw Error("媒体格式、标签或封面校验失败，原文件未修改")
  const written = JSON.parse(await new Response(proc.stdout).text()) as { coverApplied?: boolean }
  if (!written.coverApplied) coverSource = null
  return { date, coverSource, warnings }
}

// ---- 管理编辑（PATCH /tracks/:id/metadata，docs/04 网易云导入组） ----
// 与导入共用 tag_media.py 的 netease 分支，编辑态不传 uploadDate 且无 newImport：
// 文件内已有的发行日标签原样保留（发行日=专辑年份语义，重扫仍回填 albums.year）。

export const validNeteaseTags = (value: unknown) => Schema.decodeUnknownSync(NeteaseTagsInput)(value, { onExcessProperty: "error" })

/** legacy 文件（无 netease_imports 行）核验：mp3 的 TXXX:OPENMUSIC_NETEASE_ID / flac 的
 *  同名 vorbis 键必须等于文件名中的 songId。不符即 throw——绝不给未核实文件开管理面。 */
export async function verifyNeteaseLegacy(songId: string, file: FileHandle): Promise<void> {
  const tags = await parseFile(`/proc/self/fd/${file.fd}`, { skipCovers: true })
  const first = (value: unknown) => Array.isArray(value) ? value[0] : value
  const verified = Object.values(tags.native).some(group => group.some(t =>
    /^(?:TXXX:)?OPENMUSIC_NETEASE_ID$/i.test(String(t.id)) && first(t.value) === songId))
  if (!verified) throw Error("unverified legacy file")
}

export interface NeteaseEditResult { coverSource: string | null; overrides: MetadataOverrides; dbOnly: boolean; warnings: string[] }

/** "netease" 关键字 → 回源 song detail 的专辑封面（仍仅 *.music.126.net）；失败即整次编辑失败。 */
async function sourceCover(songId: string, rt: NeteaseRuntime, signal: AbortSignal): Promise<string> {
  const brief: SongBrief | undefined = (await songDetails([songId], rt, signal)).get(songId)
  const url = allowedArtwork(brief?.cover ?? "")
  if (!url) throw Error("未能取得网易云封面")
  return url
}

/** 编辑态标签写入：在调用方的私有 staging 拷贝上执行（audio.<ext>），成功后由调用方 rename 发布。
 *  cover 接受 "netease"（回源封面）/ *.music.126.net URL / data:image 内联图；文本标签写入失败
 *  且未要求封面时可降级 dbOnly（原文不动、覆盖值进曲库）；要求了封面则绝不降级。 */
export async function applyNeteaseEdit(dir: string, songId: string, tags: NeteaseTagsInput, rt: NeteaseRuntime, signal: AbortSignal,
  options: { ext: "mp3" | "flac" }): Promise<NeteaseEditResult> {
  const { cover, ...textTags } = tags
  let image: string | undefined, coverSource: string | null = null
  if (cover) {
    let bytes: Buffer
    if (cover === "netease") {
      const url = await sourceCover(songId, rt, signal)
      bytes = await fetchBounded(url, signal, maxImage); coverSource = url
    } else if (cover.startsWith("data:")) {
      const base = /^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(cover)?.[1]
      if (!base || base.length > Math.ceil(maxImage / 3) * 4) throw Error("封面数据无效或过大")
      bytes = Buffer.from(base, "base64"); coverSource = "custom-image"
    } else {
      const url = allowedArtwork(cover)
      if (!url) throw Error("仅支持 *.music.126.net 的封面链接、data:image 内联图，或 \"netease\" 恢复来源封面。")
      bytes = await fetchBounded(url, signal, maxImage); coverSource = url
    }
    if (!bytes.length || bytes.length > maxImage) throw Error("封面大小无效")
    await fs.writeFile(path.join(dir, "cover-input"), bytes)
    image = "cover-input"
  }
  signal.throwIfAborted()
  const proc = Bun.spawn([process.env.OPENMUSIC_TAG_PYTHON || "python3", "-I", path.join(import.meta.dir, "../youtube/tag_media.py")], {
    cwd: dir, stdin: new Blob([JSON.stringify({ source: "netease", songId, ext: options.ext, tags: textTags,
      uploadDate: null, image, allowDbOnly: Object.keys(textTags).length > 0, requiredImage: !!cover })]),
    stdout: "pipe", stderr: "ignore", signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
  })
  if (await proc.exited !== 0) throw Error("媒体格式、标签或封面校验失败，原文件未修改")
  const written = JSON.parse(await new Response(proc.stdout).text()) as { coverApplied?: boolean; dbOnly?: boolean }
  // Only a tag-codec failure on an otherwise validated file can degrade to catalog-only text.
  if (written.dbOnly === true) return { coverSource: null, overrides: textTags, dbOnly: true,
    warnings: ["未能嵌入文件标签；保留原文件，指定的文字元数据已存入曲库。未转码。"] }
  if (!written.coverApplied) coverSource = null
  return { coverSource, overrides: textTags, dbOnly: false, warnings: [] }
}
