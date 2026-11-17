/**
 * openmusic 第一方 API 客户端（Node/Bun fetch + 会话 cookie）。
 *
 * TUI 不走 Subsonic 层——第一方 API 就是给自家人用的：
 * - 登录拿 session cookie，后续所有请求（含音频流）都带它
 * - 流播放 URL 交给 OpenTUI 原生 Audio（playStreamUrl 支持 request headers）
 * - 响应类型对齐 apps/web/src/api/client.ts（同一 server schema 的两个视图）
 */
import type { AudioStreamUrlOptions } from "@opentui/core"

export interface TrackSummary {
  id: string
  title: string
  artist: { id: string; name: string }
  album: { id: string; name: string; year: number | null }
  disc: number
  track: number | null
  durationSeconds: number
  starred: boolean
  playCount: number
  codec: string
}

export interface ArtistSummary {
  id: string
  name: string
  albumCount: number
  trackCount: number
  starred: boolean
}

export interface AlbumSummary {
  id: string
  name: string
  year: number | null
  genre: string | null
  trackCount: number
  durationSeconds: number
  artist: { id: string; name: string }
  starred: boolean
}

export interface PlaylistSummary {
  id: string
  name: string
  comment: string | null
  isPublic: boolean
  owner: string
  isMine: boolean
  songCount: number
  durationSeconds: number
}

export interface SearchResult {
  artists: ArtistSummary[]
  albums: AlbumSummary[]
  tracks: TrackSummary[]
  artistCount: number
  albumCount: number
  trackCount: number
}

export interface PlayEntry {
  /** null = 曲目已不在库中（墓碑行）——快照字段承载叙事，灰显不可播 */
  track: TrackSummary | null
  title: string
  artistName: string
  albumName: string
  durationSeconds: number
  playedAt: string
}

export type Period = "all" | "month" | "year"

export interface MostPlayedTrack {
  kind: "track"
  playCount: number
  listenedSeconds: number
  track: TrackSummary
}

export interface ScanStatus {
  state: "idle" | "scanning"
  /** walking=遍历磁盘（total 随发现增长），indexing=解析入库，idle 为 null */
  phase: "walking" | "indexing" | null
  total: number
  processed: number
}

export interface Page<T> {
  items: T[]
  total: number
  limit: number
  offset: number
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

export class OmApi {
  private cookie = ""

  constructor(public baseUrl: string) {}

  /** 注入上次保存的会话 cookie（配合 me() 校验后再用） */
  restoreSession(cookie: string): void {
    this.cookie = cookie
  }

  /** 当前会话 cookie（登录成功后用于持久化） */
  get sessionCookie(): string {
    return this.cookie
  }

  /** 登录并保存会话 cookie（服务器会话 cookie 名为 om_session，HttpOnly） */
  async login(username: string, password: string): Promise<void> {
    const res = await this.request("POST", "/api/v1/auth/login", { username, password }, true)
    if (res.status === 401 || res.status === 403) throw new ApiError(res.status, "用户名或密码错误")
    if (!res.ok) throw new ApiError(res.status, await errorText(res))
    const set = res.headers.getSetCookie?.() ?? []
    const session = set.find((c) => c.startsWith("om_session=") || c.startsWith("session="))
    if (!session) throw new ApiError(res.status, "登录响应缺少会话 cookie")
    this.cookie = session.split(";")[0]!
  }

  /** 校验当前会话是否有效；无效抛 ApiError（401） */
  async me(): Promise<{ username: string; isAdmin: boolean }> {
    const data = await this.get<{ username?: string; isAdmin?: boolean }>("/api/v1/auth/me")
    return { username: data.username ?? "", isAdmin: data.isAdmin ?? false }
  }

  // —— 浏览 ——

  /** 最近添加在前（sort=-createdAt；「recent」不在服务端白名单，会被静默忽略） */
  async albums(limit = 100, offset = 0): Promise<Page<AlbumSummary>> {
    return this.get(`/api/v1/albums?limit=${limit}&offset=${offset}&sort=-createdAt`)
  }

  async albumTracks(albumId: string): Promise<TrackSummary[]> {
    return this.get(`/api/v1/albums/${albumId}/tracks`)
  }

  async artists(limit = 200, offset = 0): Promise<Page<ArtistSummary>> {
    return this.get(`/api/v1/artists?limit=${limit}&offset=${offset}`)
  }

  async artistAlbums(artistId: string): Promise<AlbumSummary[]> {
    const page = await this.get<Page<AlbumSummary>>(
      `/api/v1/artists/${artistId}/albums?limit=100`,
    )
    return page.items
  }

  async artistTopTracks(artistId: string): Promise<TrackSummary[]> {
    return this.get(`/api/v1/artists/${artistId}/top-tracks`)
  }

  async search(q: string): Promise<SearchResult> {
    return this.get(`/api/v1/search?q=${encodeURIComponent(q)}&type=all`)
  }

  async randomTracks(count = 50): Promise<TrackSummary[]> {
    return this.get(`/api/v1/random?count=${count}`)
  }

  // —— 收藏 ——

  async favorite(trackId: string): Promise<void> {
    await this.request("PUT", `/api/v1/favorites/tracks/${trackId}`)
  }

  async unfavorite(trackId: string): Promise<void> {
    await this.request("DELETE", `/api/v1/favorites/tracks/${trackId}`)
  }

  async starredTracks(limit = 200, offset = 0): Promise<Page<TrackSummary>> {
    return this.get(`/api/v1/favorites?type=track&limit=${limit}&offset=${offset}`)
  }

  // —— 播放历史 ——

  async recentPlays(limit = 100): Promise<PlayEntry[]> {
    return this.get(`/api/v1/plays/recent?limit=${limit}`)
  }

  async mostPlayedTracks(period: Period, limit = 100): Promise<MostPlayedTrack[]> {
    return this.get(`/api/v1/plays/most-played?type=track&period=${period}&limit=${limit}`)
  }

  // —— 播放列表 ——

  async playlists(): Promise<PlaylistSummary[]> {
    return this.get("/api/v1/playlists")
  }

  async playlistTracks(playlistId: string): Promise<TrackSummary[]> {
    return this.get(`/api/v1/playlists/${playlistId}/tracks`)
  }

  // —— 系统 ——

  async scanStatus(): Promise<ScanStatus> {
    return this.get("/api/v1/library/scan-status")
  }

  // —— 播放上报 ——

  /** 播放上报：listenedSeconds = 阈值触发瞬间的实测秒数（docs/03 §2.7） */
  async recordPlay(trackId: string, listenedSeconds: number): Promise<void> {
    await this.request("POST", `/api/v1/plays/${trackId}`, { listenedSeconds })
  }

  /** 第一方音频流 URL + 供 OpenTUI Audio 使用的请求选项（带 cookie）。
   *  OpenTUI 原生 demuxer 不认 audio/flac——统一让服务器转码成 mp3（走转码缓存）。
   *  offsetSec > 0 → 断点续播/seek（服务器 ffmpeg 输入端 seek） */
  streamRequest(trackId: string, offsetSec = 0): { url: string; options: Pick<AudioStreamUrlOptions, "request"> } {
    const offset = Math.max(0, Math.floor(offsetSec))
    return {
      url: `${this.baseUrl}/api/v1/tracks/${trackId}/stream?format=mp3&maxBitRate=320${offset > 0 ? `&timeOffset=${offset}` : ""}`,
      options: { request: { headers: { cookie: this.cookie } } },
    }
  }

  private async get<T>(path: string): Promise<T> {
    const res = await this.request("GET", path)
    if (!res.ok) throw new ApiError(res.status, await errorText(res))
    return (await res.json()) as T
  }

  private request(method: string, path: string, body?: unknown, _isLogin = false): Promise<Response> {
    const headers: Record<string, string> = {}
    if (body !== undefined) headers["content-type"] = "application/json"
    if (this.cookie) headers.cookie = this.cookie
    return fetch(this.baseUrl + path, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  }
}

async function errorText(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { message?: string; error?: { message?: string } }
    return data.message ?? data.error?.message ?? `${res.status}`
  } catch {
    return `${res.status}`
  }
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00"
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  // 超 1 小时进位 h:mm:ss（超长曲/演唱会录音；注意 visualWidth——全 ASCII）
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
  return `${m}:${String(s).padStart(2, "0")}`
}

/** 最近播放的时间戳：今天显示 HH:MM，今年显示 MM-DD，更早显示 YYYY-MM-DD */
export function formatPlayedAt(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  if (d.toDateString() === now.toDateString()) return hm
  const md = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  if (d.getFullYear() === now.getFullYear()) return md
  return `${d.getFullYear()}-${md}`
}
