import * as fs from "node:fs/promises"
import path from "node:path"
import { fetchBounded, type SongBrief } from "./api"

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
