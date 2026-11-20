import { songID } from "./source"

/** NetEase public plain-JSON API + optional self-hosted NeteaseCloudMusicApi-compatible instance.
 *  Plain requests use a desktop Chrome UA (the album route additionally needs the Referer;
 *  a weak UA gets -462 risk control). All outbound requests are bounded in time and size.
 *  NETEASE_REAL_IP is sent as X-Real-IP (plain) / realIP query param (instance) / yt-dlp --xff. */

export const neteaseLevels = ["standard", "higher", "exhigh", "lossless", "hires", "jyeffect", "jymaster", "sky"] as const
export type NeteaseLevel = (typeof neteaseLevels)[number]

export interface NeteaseRuntime {
  /** Normalized instance root (origin + optional path prefix) or null for anonymous yt-dlp mode. */
  readonly base: string | null
  readonly level: NeteaseLevel
  readonly realIp: string | null
}

const ipv4 = /^\d{1,3}(?:\.\d{1,3}){3}$/

/** Throws on invalid configuration so the server fails loudly at startup. */
export function neteaseRuntime(raw: { neteaseApiBase: string; neteaseQuality: string; neteaseRealIp: string }): NeteaseRuntime {
  const quality = raw.neteaseQuality.trim() as NeteaseLevel
  if (!neteaseLevels.includes(quality)) throw Error(`NETEASE_QUALITY 无效：${raw.neteaseQuality}（可选 ${neteaseLevels.join("/")}）`)
  const realIp = raw.neteaseRealIp.trim()
  if (realIp && !ipv4.test(realIp)) throw Error(`NETEASE_REAL_IP 无效：${raw.neteaseRealIp}（应为 IPv4 地址）`)
  const trimmedBase = raw.neteaseApiBase.trim()
  if (!trimmedBase) return { base: null, level: quality, realIp: realIp || null }
  const base = URL.parse(trimmedBase)
  if (!base || !["http:", "https:"].includes(base.protocol) || base.username || base.password ||
    !/^[\w.-]+(?::\d+)?$/.test(base.host)) throw Error(`NETEASE_API_BASE 无效：${raw.neteaseApiBase}（应为 http(s)://host[:port][/前缀]）`)
  return { base: `${base.origin}${base.pathname.replace(/\/+$/, "")}`, level: quality, realIp: realIp || null }
}

export interface SongBrief {
  readonly songId: string
  readonly title: string
  readonly artist: string
  readonly album: string
  readonly cover: string | null
  readonly fee: number
  readonly durationMs: number
}

/** fee: 1=VIP, 4=购买专辑（付费），0/8=免费可听。匿名模式对这两类只能拿试听片段。 */
export function vipFee(fee: number): boolean {
  return fee === 1 || fee === 4
}
export const VIP_SKIP_REASON = "VIP/付费歌曲，匿名无法导入完整版（配置 NETEASE_API_BASE 后可重试）。"

const DESKTOP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
const plainHeaders = (rt: NeteaseRuntime): Record<string, string> => ({
  "user-agent": DESKTOP_UA, referer: "https://music.163.com/", ...(rt.realIp ? { "x-real-ip": rt.realIp } : {}),
})
const instanceParams = (rt: NeteaseRuntime, extra: Record<string, string>): Record<string, string> =>
  rt.realIp ? { ...extra, realIP: rt.realIp } : extra

export async function fetchBounded(url: string, signal: AbortSignal, max: number, headers?: Record<string, string>): Promise<Buffer> {
  const response = await fetch(url, { headers, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(6500)]) })
  if (!response.ok || !response.body || Number(response.headers.get("content-length")) > max) {
    await response.body?.cancel(); throw Error("资源不可用或过大")
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > max) { await reader.cancel(); throw Error("资源过大") }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  return Buffer.concat(chunks, size)
}

async function fetchJson(url: string, signal: AbortSignal, max: number, headers?: Record<string, string>): Promise<Record<string, unknown>> {
  const raw = JSON.parse((await fetchBounded(url, signal, max, headers)).toString("utf8")) as unknown
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw Error("接口响应无效")
  return raw as Record<string, unknown>
}

const text = (value: unknown, max: number): string => typeof value === "string" ? value.trim().slice(0, max) : ""
const idOf = (value: unknown): string | null => {
  const id = typeof value === "number" ? String(Math.trunc(value)) : typeof value === "string" ? value : null
  return id !== null && songID.test(id) ? id : null
}

/** Reads both the legacy shape (artists/album/duration) and the v3 shape (ar/al/dt). */
export function briefOf(raw: unknown): SongBrief | null {
  if (typeof raw !== "object" || raw === null) return null
  const o = raw as Record<string, unknown>
  const songId = idOf(o.id)
  if (songId === null) return null
  const artistsRaw = o.artists ?? o.ar
  const artists = Array.isArray(artistsRaw)
    ? artistsRaw.map(a => text((a as Record<string, unknown>)?.name, 150)).filter(Boolean).join(" / ")
    : ""
  const albumRaw = o.album ?? o.al
  const album = typeof albumRaw === "object" && albumRaw !== null ? text((albumRaw as Record<string, unknown>).name, 300) : ""
  const cover = typeof albumRaw === "object" && albumRaw !== null
    ? (text((albumRaw as Record<string, unknown>).picUrl, 2048) || null)
    : null
  const durationMs = Math.round(Number(o.duration ?? o.dt) || 0)
  return {
    songId, title: text(o.name, 300) || songId, artist: artists.slice(0, 300), album,
    cover, fee: Number(o.fee) || 0,
    durationMs: durationMs > 0 && durationMs < 3.6e9 ? durationMs : 0,
  }
}

const briefs = (raw: unknown): SongBrief[] => Array.isArray(raw) ? raw.map(briefOf).filter((b): b is SongBrief => b !== null) : []

/** 匿名：GET /api/search/get?s=…&type=1&limit=5；实例：GET {base}/search?keywords=…（至多 5 个候选）。 */
export async function searchSongs(query: string, rt: NeteaseRuntime, signal: AbortSignal): Promise<SongBrief[]> {
  if (rt.base) {
    const raw = await fetchJson(`${rt.base}/search?${new URLSearchParams(instanceParams(rt, { keywords: query, type: "1", limit: "5" }))}`, signal, 512 * 1024)
    if (Number(raw.code) !== 200) throw Error("实例搜索失败")
    return briefs((raw.result as Record<string, unknown> | undefined)?.songs)
  }
  const raw = await fetchJson(
    `https://music.163.com/api/search/get?${new URLSearchParams({ s: query, type: "1", limit: "5" })}`,
    signal, 512 * 1024, plainHeaders(rt),
  )
  if (Number(raw.code) !== 200) throw Error("搜索接口不可用")
  return briefs((raw.result as Record<string, unknown> | undefined)?.songs)
}

/** 批量详情预检：匿名 GET /api/song/detail?id=&ids=[a,b]（方括号必须 URL 编码）；
 *  实例 GET {base}/song/detail?ids=a,b（NeteaseCloudMusicApi 协议是逗号列表）。 */
export async function songDetails(ids: ReadonlyArray<string>, rt: NeteaseRuntime, signal: AbortSignal): Promise<Map<string, SongBrief>> {
  const list = [...new Set(ids)].slice(0, 100)
  if (!list.length) return new Map()
  const raw = rt.base
    ? await fetchJson(`${rt.base}/song/detail?${new URLSearchParams(instanceParams(rt, { ids: list.join(",") }))}`, signal, 512 * 1024)
    : await fetchJson(
        `https://music.163.com/api/song/detail?${new URLSearchParams({ id: list[0]!, ids: `[${list.join(",")}]` })}`,
        signal, 512 * 1024, plainHeaders(rt),
      )
  if (Number(raw.code) !== 200) throw Error("详情接口不可用")
  return new Map(briefs(raw.songs).map(brief => [brief.songId, brief]))
}

export interface NeteaseAlbum { name: string; artist: string; publishTimeMs: number | null; songs: SongBrief[] }

/** 专辑走明文 /api/album/{id}（yt-dlp 的 album extractor 已坏）。弱 UA 会吃 -462 风控，非 200 一律明确报错。
 *  歌曲列表两种形状都读：明文接口在 album.songs 内，实例 v3 协议在顶层 songs。 */
export async function albumDetail(id: string, rt: NeteaseRuntime, signal: AbortSignal): Promise<NeteaseAlbum> {
  const raw = rt.base
    ? await fetchJson(`${rt.base}/album?${new URLSearchParams(instanceParams(rt, { id }))}`, signal, 1024 * 1024)
    : await fetchJson(`https://music.163.com/api/album/${id}`, signal, 1024 * 1024, plainHeaders(rt))
  if (Number(raw.code) !== 200 || typeof raw.album !== "object" || raw.album === null) {
    throw Error("暂时无法读取专辑（接口风控或限制），请稍后重试。")
  }
  const album = raw.album as unknown as Record<string, unknown>
  const artistRaw = album.artist as Record<string, unknown> | undefined
  const publishTimeMs = Number(album.publishTime) || 0
  return {
    name: text(album.name, 300), artist: text(artistRaw?.name, 300),
    publishTimeMs: publishTimeMs > 0 && publishTimeMs < 4.1e12 ? Math.round(publishTimeMs) : null,
    songs: briefs(Array.isArray(raw.songs) ? raw.songs : album.songs),
  }
}

export interface NeteaseLyrics { lrc: string; tlyrc: string }

/** 原文 + 翻译（tlyric）；无歌词（nolyric / 空 lrc）返回 null，不算失败。 */
export async function songLyrics(id: string, rt: NeteaseRuntime, signal: AbortSignal): Promise<NeteaseLyrics | null> {
  const raw = rt.base
    ? await fetchJson(`${rt.base}/lyric?${new URLSearchParams(instanceParams(rt, { id }))}`, signal, 512 * 1024)
    : await fetchJson(
        `https://music.163.com/api/song/lyric?${new URLSearchParams({ id, lv: "-1", tv: "-1" })}`,
        signal, 512 * 1024, plainHeaders(rt),
      )
  if (Number(raw.code) !== 200 && raw.code !== undefined) return null
  const lrc = text((raw.lrc as Record<string, unknown> | undefined)?.lyric, 131072)
  if (!lrc) return null
  return { lrc, tlyrc: text((raw.tlyric as Record<string, unknown> | undefined)?.lyric, 131072) }
}

/** 原文与翻译同时间戳拼接：入库后由 LRC 解析器把等时间戳行合并为「原文\n译文」。 */
export function mergeLyrics(lrc: string, tlyrc: string): string {
  return tlyrc.trim() ? `${lrc.trim()}\n${tlyrc.trim()}` : lrc.trim()
}

export interface NeteaseSongUrl { url: string | null; level: NeteaseLevel | null; freeTrial: boolean }

/** 实例模式专用：/song/url/v1?id=&level=。url=null 表示实例拿不到可用音源；freeTrialInfo 表示 VIP 试听片段。 */
export async function songUrl(id: string, rt: NeteaseRuntime, signal: AbortSignal): Promise<NeteaseSongUrl> {
  if (!rt.base) throw Error("未配置 NETEASE_API_BASE")
  const raw = await fetchJson(`${rt.base}/song/url/v1?${new URLSearchParams(instanceParams(rt, { id, level: rt.level }))}`, signal, 256 * 1024)
  if (Number(raw.code) !== 200) throw Error("实例接口不可用")
  const item = Array.isArray(raw.data) ? raw.data[0] : null
  if (typeof item !== "object" || item === null) return { url: null, level: null, freeTrial: false }
  const url = typeof item.url === "string" && item.url ? item.url : null
  const level = typeof item.level === "string" && neteaseLevels.includes(item.level as NeteaseLevel) ? item.level as NeteaseLevel : null
  return { url, level, freeTrial: typeof item.freeTrialInfo === "object" && item.freeTrialInfo !== null }
}
