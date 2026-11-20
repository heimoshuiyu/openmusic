import { songID } from "./source"

/** NetEase public plain-JSON API (anonymous only in v1): search / batch song detail /
 *  album / lyric, always direct to music.163.com with a desktop Chrome UA (the album
 *  route additionally needs the Referer; a weak UA gets -462 risk control). All outbound
 *  requests are bounded in time and size. NETEASE_REAL_IP is sent as X-Real-IP (and
 *  yt-dlp --xff). No weapi/eapi crypto, no cookies, no third-party instance protocol. */

export interface NeteaseRuntime {
  readonly realIp: string | null
}

const ipv4 = /^\d{1,3}(?:\.\d{1,3}){3}$/

/** Throws on invalid configuration so the server fails loudly at startup. */
export function neteaseRuntime(raw: { neteaseRealIp: string }): NeteaseRuntime {
  const realIp = raw.neteaseRealIp.trim()
  if (realIp && !(ipv4.test(realIp) && realIp.split(".").every(part => Number(part) <= 255))) {
    throw Error(`NETEASE_REAL_IP 无效：${raw.neteaseRealIp}（应为 IPv4 地址）`)
  }
  return { realIp: realIp || null }
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

/** fee: 1=VIP, 4=购买专辑（付费），0/8=免费可听。付费歌只有元数据，明确跳过不入库。 */
export function vipFee(fee: number): boolean {
  return fee === 1 || fee === 4
}
export const VIP_SKIP_REASON = "VIP/付费歌曲需要会员账号，未导入。"

const DESKTOP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
const plainHeaders = (rt: NeteaseRuntime): Record<string, string> => ({
  "user-agent": DESKTOP_UA, referer: "https://music.163.com/", ...(rt.realIp ? { "x-real-ip": rt.realIp } : {}),
})

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

/** GET /api/search/get?s=…&type=1&limit=5，至多 5 个候选。 */
export async function searchSongs(query: string, rt: NeteaseRuntime, signal: AbortSignal): Promise<SongBrief[]> {
  const raw = await fetchJson(
    `https://music.163.com/api/search/get?${new URLSearchParams({ s: query, type: "1", limit: "5" })}`,
    signal, 512 * 1024, plainHeaders(rt),
  )
  if (Number(raw.code) !== 200) throw Error("搜索接口不可用")
  return briefs((raw.result as Record<string, unknown> | undefined)?.songs)
}

/** 批量详情预检：GET /api/song/detail?id=&ids=[a,b]（方括号必须 URL 编码）。 */
export async function songDetails(ids: ReadonlyArray<string>, rt: NeteaseRuntime, signal: AbortSignal): Promise<Map<string, SongBrief>> {
  const list = [...new Set(ids)].slice(0, 100)
  if (!list.length) return new Map()
  const raw = await fetchJson(
    `https://music.163.com/api/song/detail?${new URLSearchParams({ id: list[0]!, ids: `[${list.join(",")}]` })}`,
    signal, 512 * 1024, plainHeaders(rt),
  )
  if (Number(raw.code) !== 200) throw Error("详情接口不可用")
  return new Map(briefs(raw.songs).map(brief => [brief.songId, brief]))
}

export interface NeteaseAlbum { name: string; artist: string; publishTimeMs: number | null; songs: SongBrief[] }

/** 专辑走明文 /api/album/{id}（yt-dlp 的 album extractor 已坏）。弱 UA 会吃 -462 风控，非 200 一律明确报错。 */
export async function albumDetail(id: string, rt: NeteaseRuntime, signal: AbortSignal): Promise<NeteaseAlbum> {
  const raw = await fetchJson(`https://music.163.com/api/album/${id}`, signal, 1024 * 1024, plainHeaders(rt))
  if (Number(raw.code) !== 200 || typeof raw.album !== "object" || raw.album === null) {
    throw Error("暂时无法读取专辑（接口风控或限制），请稍后重试。")
  }
  const album = raw.album as unknown as Record<string, unknown>
  const artistRaw = album.artist as Record<string, unknown> | undefined
  const publishTimeMs = Number(album.publishTime) || 0
  return {
    name: text(album.name, 300), artist: text(artistRaw?.name, 300),
    publishTimeMs: publishTimeMs > 0 && publishTimeMs < 4.1e12 ? Math.round(publishTimeMs) : null,
    songs: briefs(album.songs),
  }
}

export interface NeteaseLyrics { lrc: string; tlyrc: string }

/** 原文 + 翻译（tlyric）；无歌词（nolyric / 空 lrc）返回 null，不算失败。 */
export async function songLyrics(id: string, rt: NeteaseRuntime, signal: AbortSignal): Promise<NeteaseLyrics | null> {
  const raw = await fetchJson(
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
