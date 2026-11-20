/** 网易云导入的纯视图逻辑：URL/子目录校验、终态结果归一、删除票据来源解析。
 *  全部为客户端 UX 反馈的镜像；服务端（service/netease/*）永远是权威裁决。 */
import { ApiError, type NeteaseImportResult, type NeteaseInfo, type NeteaseTags } from "@/api/client"

export type NeteaseLinkKind = "song" | "playlist" | "album" | "artist"

const songID = /^\d{1,20}$/
const neteaseHosts = ["music.163.com", "www.music.163.com", "y.music.163.com"]
const neteaseRoute = /^\/(?:m\/)?(song|playlist|album|artist)(?:\/(\d{1,20}))?\/?$/

export interface NeteaseLink {
  kind: NeteaseLinkKind
  id: string
  /** 规范化重建后的单曲/歌单/专辑/歌手链接（与服务端同款重建，绝不透传用户原始输入） */
  url: string
}

const neteaseUrl = (link: { kind: NeteaseLinkKind; id: string }) => `https://music.163.com/${link.kind}?id=${link.id}`

function resolveRoute(pathname: string, params: URLSearchParams | null): { kind: NeteaseLinkKind; id: string } | null {
  const match = neteaseRoute.exec(pathname)
  if (!match) return null
  const id = match[2] ?? params?.get("id") ?? null
  return id !== null && songID.test(id) ? { kind: match[1] as NeteaseLinkKind, id } : null
}

/** 客户端镜像 server service/netease/source.ts 的白名单解析，只用于粘贴框即时反馈。 */
export function neteaseLink(input: string): NeteaseLink | null {
  const text = input.trim()
  if (text.length === 0 || text.length > 2048) return null
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return null
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port) return null
  if (!neteaseHosts.includes(url.hostname)) return null
  const direct = resolveRoute(url.pathname, url.searchParams)
  if (direct) return { ...direct, url: neteaseUrl(direct) }
  // SPA shares put the route in the hash: https://music.163.com/#/song?id=…
  if (url.hash.length > 1) {
    const body = url.hash.slice(1), at = body.indexOf("?")
    const hash = resolveRoute(at === -1 ? body : body.slice(0, at), at === -1 ? null : new URLSearchParams(body.slice(at + 1)))
    if (hash) return { ...hash, url: neteaseUrl(hash) }
  }
  return null
}

/** 客户端镜像 server service/youtube/source.ts 的 checkSubdirectory；返回 null 表示可用。 */
export function subdirectoryProblem(input: string): string | null {
  if (input === "") return null
  if (input.length > 360) return "子目录路径过长（最多 360 字符）。"
  const parts = input.split("/")
  if (parts.length > 8) return "子目录层级过深（最多 8 层）。"
  for (const part of parts) {
    if (part.length === 0) return "子目录路径里有空段。"
    if (part.length > 100) return "单段子目录名过长（最多 100 字符）。"
    if (part.startsWith(".")) return "子目录不能以点开头。"
    if (/[\\:\x00-\x1f\x7f]/.test(part)) return "子目录不能包含反斜杠、冒号或控制字符。"
  }
  return null
}

/** 泛化导入终态：youtube（videoId 维）与 netease（songId 维）共用同一结果面板。 */
export interface ImportOutcome {
  kind: string
  state: "done" | "partial" | "failed"
  total: number
  imported: number
  skipped: number
  failed: number
  destination: string
  trackIds: number[]
  files: ReadonlyArray<{ trackId: number; name: string }>
  failures: ReadonlyArray<{ id: string; reason: string }>
  warnings: ReadonlyArray<{ id: string; message: string }>
}

export function neteaseOutcome(result: NeteaseImportResult): ImportOutcome {
  return {
    kind: neteaseKindLabel[result.kind], state: result.state,
    total: result.total, imported: result.imported, skipped: result.skipped, failed: result.failed,
    destination: result.destination, trackIds: result.trackIds, files: result.files,
    failures: result.failures.map((failure) => ({ id: failure.songId, reason: failure.reason })),
    warnings: result.warnings.map((warning) => ({ id: warning.songId, message: warning.message })),
  }
}

export const neteaseKindLabel: Record<NeteaseLinkKind, string> = { song: "单曲", playlist: "歌单", album: "专辑", artist: "歌手热门" }

export function neteaseKindHint(kind: NeteaseLinkKind): string | null {
  if (kind === "playlist" || kind === "album") return `${neteaseKindLabel[kind]}最多导入 25 首，超限整组拒绝。`
  if (kind === "artist") return "歌手热门只取前 25 首。"
  return null
}

export const importStateLabel: Record<ImportOutcome["state"], string> = { done: "完成", partial: "部分成功", failed: "失败" }

/** 元数据编辑 diff：只提交与当前值不同、且非空的字段；服务端仍是权威校验。 */
export function neteaseTagsDiff(
  info: NeteaseInfo,
  form: {
    title: string
    artist: string
    album: string
    albumArtist: string
    genre: string
    trackNumber: number | null
    discNumber: number | null
    cover: string
  },
): NeteaseTags {
  const tags: NeteaseTags = {}
  const trimmed = (value: string) => value.trim()
  if (trimmed(form.title) && trimmed(form.title) !== info.title) tags.title = trimmed(form.title)
  if (trimmed(form.artist) && trimmed(form.artist) !== info.artist) tags.artist = trimmed(form.artist)
  if (trimmed(form.album) && trimmed(form.album) !== info.album) tags.album = trimmed(form.album)
  if (trimmed(form.albumArtist) && trimmed(form.albumArtist) !== info.albumArtist) tags.albumArtist = trimmed(form.albumArtist)
  if (trimmed(form.genre) && trimmed(form.genre) !== (info.genre ?? "")) tags.genre = trimmed(form.genre)
  if (form.trackNumber !== null && Number.isSafeInteger(form.trackNumber) && form.trackNumber !== info.trackNumber) tags.trackNumber = form.trackNumber
  if (form.discNumber !== null && Number.isSafeInteger(form.discNumber) && form.discNumber !== info.discNumber) tags.discNumber = form.discNumber
  if (trimmed(form.cover)) tags.cover = trimmed(form.cover)
  return tags
}

export type DeletionSource = "youtube" | "netease"

export type ResolvedReview<T> = { source: DeletionSource; review: T } | { missing: true; message: string }

/** 删除票据按先 YouTube 后网易云解析：只有明确 404 才落到下一来源，其余错误原样上抛文案。 */
export async function resolveDeletionReview<T>(
  key: string,
  youtubeReview: (key: string) => Promise<T>,
  neteaseReview: (key: string) => Promise<T>,
): Promise<ResolvedReview<T>> {
  try {
    return { source: "youtube", review: await youtubeReview(key) }
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 404) {
      return { missing: true, message: error instanceof Error && error.message ? error.message : "申请读取失败，请稍后重试。" }
    }
    try {
      return { source: "netease", review: await neteaseReview(key) }
    } catch (second) {
      if (second instanceof ApiError && second.status === 404) return { missing: true, message: "申请不存在、已过期，或不属于当前账号。" }
      return { missing: true, message: second instanceof Error && second.message ? second.message : "申请读取失败，请稍后重试。" }
    }
  }
}
