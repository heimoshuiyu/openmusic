import type { SNode } from "../../domain/subsonic"
import { node } from "../../domain/subsonic"
import type { Row } from "../../repo/subsonic"

const str = (v: unknown): string => (v === null || v === undefined ? "" : String(v))
const nnum = (v: unknown): number | undefined =>
  v === null || v === undefined ? undefined : Number(v)
const iso = (v: unknown): string | undefined =>
  v === null || v === undefined ? undefined : new Date(v as string).toISOString()
const subsonicDate = (v: unknown): string | undefined =>
  v === null || v === undefined
    ? undefined
    : `${new Date(v as string).toISOString().slice(0, 19)}Z`.replace(/(\.\d+)?Z$/, "Z")

const dirId = (folderId: number, rel: string): string =>
  `d${folderId}-${Buffer.from(rel, "utf8").toString("base64url")}`

export const parseDirId = (id: string): { folderId: number; rel: string } | null => {
  const match = /^d(\d+)-([A-Za-z0-9_-]+)$/.exec(id)
  if (match === null || match[2] === undefined) return null
  try {
    return { folderId: Number(match[1]), rel: Buffer.from(match[2], "base64url").toString("utf8") }
  } catch {
    return null
  }
}

/** song → Subsonic 属性（字段清单见 docs/05 §6） */
export const songNode = (r: Row): SNode =>
  node("song", {
    id: String(r.id),
    parent: String(r.album_id),
    isDir: false,
    title: str(r.title),
    album: str(r.album_name),
    artist: str(r.artist_name),
    track: nnum(r.track_no) ?? 0,
    year: nnum(r.year),
    genre: r.genre === null || r.genre === undefined ? undefined : str(r.genre),
    coverArt: r.has_cover ? `tr-${String(r.id)}` : undefined,
    size: nnum(r.size_bytes),
    contentType: str(r.format),
    suffix: str(r.codec),
    duration: nnum(r.duration_seconds) ?? 0,
    bitRate: nnum(r.bitrate_kbps) ?? 0,
    path: str(r.path).replace(/#\d+$/, ""), // 虚拟分段合成键后缀不外泄（docs/03 §2.9）
    playCount: nnum(r.play_count) ?? 0,
    discNumber: nnum(r.disc) ?? 1,
    created: subsonicDate(r.created_at),
    albumId: String(r.album_id),
    artistId: String(r.artist_id),
    type: "music",
    isVideo: false,
    starred: subsonicDate(r.starred_at),
    userRating: nnum(r.rating),
  })

export const albumNode = (r: Row): SNode =>
  node("album", {
    id: String(r.id),
    name: str(r.name),
    album: str(r.name),
    title: str(r.name),
    artist: str(r.artist_name),
    artistId: String(r.artist_id),
    coverArt: Boolean(r.has_cover) ? `al-${String(r.id)}` : undefined,
    songCount: nnum(r.song_count) ?? 0,
    duration: nnum(r.duration_seconds) ?? 0,
    playCount: nnum(r.play_count) ?? 0,
    created: subsonicDate(r.created_at),
    year: nnum(r.year),
    genre: r.genre === null || r.genre === undefined ? undefined : str(r.genre),
    starred: subsonicDate(r.starred_at),
  })

export const artistNode = (r: Row): SNode =>
  node("artist", {
    id: String(r.id),
    name: str(r.name),
    coverArt: r.cover_file !== null && r.cover_file !== undefined ? `ar-${String(r.id)}` : undefined,
    albumCount: nnum(r.album_count) ?? 0,
    starred: subsonicDate(r.starred_at),
  })

export const artistListEntryNode = (r: Row): SNode =>
  node("artist", {
    id: String(r.id),
    name: str(r.name),
    coverArt: r.cover_file !== null && r.cover_file !== undefined ? `ar-${String(r.id)}` : undefined,
    albumCount: nnum(r.album_count) ?? 0,
    starred: subsonicDate(r.starred_at),
  })

/** getIndexes / getArtists 的首字母分组（CJK/非字母归 "#"） */
export const groupByIndex = <A>(items: ReadonlyArray<A>, nameOf: (item: A) => string) => {
  const groups = new Map<string, Array<A>>()
  for (const item of items) {
    const first = nameOf(item).charAt(0).toUpperCase()
    const key = /[A-Z]/.test(first) ? first : "#"
    const list = groups.get(key) ?? []
    list.push(item)
    groups.set(key, list)
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === "#" ? 1 : b === "#" ? -1 : a.localeCompare(b)))
    .map(([name, list]) => ({ name, list }))
}

export { dirId, iso }
export type { SNode }
