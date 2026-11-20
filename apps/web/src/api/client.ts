/** 第一方 API 客户端（类型手工对齐 server 的 domain schema，docs/04） */
import type { AgentPart, PendingQuestion } from "@openmusic/shared/agent-parts"
import { apiFetch } from "@/api/transport"

export interface UserPublic {
  id: string
  username: string
  isAdmin: boolean
  createdAt: string
  lastSeenAt: string | null
}

export interface ArtistSummary {
  id: string
  name: string
  albumCount: number
  trackCount: number
  hasCoverArt: boolean
  starred?: string
  createdAt: string
}

export interface ArtistDetail extends ArtistSummary {
  durationSeconds: number
}

export interface AlbumSummary {
  id: string
  name: string
  artist: { id: string; name: string }
  year: number | null
  genre: string | null
  trackCount: number
  durationSeconds: number
  hasCoverArt: boolean
  starred?: string
  createdAt: string
}

export type AlbumDetail = AlbumSummary

export interface TrackSummary {
  id: string
  title: string
  artist: { id: string; name: string }
  album: { id: string; name: string; year: number | null }
  disc: number
  track: number | null
  durationSeconds: number
  bitrateKbps: number
  sampleRateHz: number
  channels: number
  format: string
  codec: string
  sizeBytes: number
  hasCoverArt: boolean
  /** 该槽位的物理副本数（不同来源/音质的重复拷贝）；仅浏览面查询填充 */
  versionCount?: number
  /** 相对路径；仅版本列表（/tracks/:id/versions）填充 */
  path?: string
  starred?: string
  userRating?: number | null
  playCount: number
  createdAt: string
}

export interface Genre {
  name: string
  albumCount: number
  trackCount: number
}

export interface Page<T> {
  items: T[]
  total: number
  offset: number
  limit: number
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
  createdAt: string
  updatedAt: string
}

export interface ScanStatus {
  state: "idle" | "scanning"
  /** 扫描子阶段（idle 为 null）：walking=遍历磁盘（total 随发现持续增长），indexing=解析入库 */
  phase: "walking" | "indexing" | null
  total: number
  processed: number
  startedAt: string | null
  lastScanAt: string | null
  errors: string[]
}

export interface MusicFolderDto { id: string; name: string; path: string; lastScanAt: string | null }

// ---- imports/netease（docs/04 §网易云音乐导入；类型手工对齐 server domain/netease.ts）----

export interface NeteaseCandidate {
  title: string
  artist: string
  album: string
  /** 1–20 位数字的网易云歌曲 ID */
  songId: string
  /** 规范化重建后的单曲链接（music.163.com/song?id=…） */
  url: string
  /** true 即 VIP/付费：元数据完整可见，导入时会被明确跳过 */
  vip: boolean
}

export interface NeteaseImportResult {
  url: string
  kind: "song" | "playlist" | "album" | "artist"
  state: "done" | "partial" | "failed"
  total: number
  imported: number
  skipped: number
  failed: number
  destination: string
  trackIds: number[]
  files: Array<{ trackId: number; name: string }>
  failures: Array<{ songId: string; reason: string }>
  warnings: Array<{ songId: string; message: string }>
}

/** GET /api/v1/imports/netease/folders：管理员注册的曲库根目录 + 可写状态 */
export interface NeteaseFolder { id: string; name: string; path: string; writable: boolean }

/** 与 YouTube 同义的固定文本标签 + cover（data image、https *.music.126.net 或 "netease" 恢复网易云封面） */
export interface NeteaseTags {
  title?: string
  artist?: string
  album?: string
  albumArtist?: string
  genre?: string
  trackNumber?: number
  discNumber?: number
  cover?: string
}

export interface NeteaseInfo {
  trackId: string
  songId: string
  /** 实际音质档位（匿名来源为 MP3 ≤320k；旧档可为 null） */
  quality: string | null
  format: "mp3" | "flac"
  filename: string
  title: string
  artist: string
  album: string
  albumArtist: string
  genre: string | null
  trackNumber: number | null
  discNumber: number
  hasCover: boolean
  /** 仅写入曲库未嵌入文件等非致命提示 */
  warnings?: string[]
}

export interface NeteaseDeleteRequest { requestId: string; reviewPath: string; expiresAt: number }

/** 删除票据的人工核对信息：youtube 与 netease 同形，review-deletion 页共用 */
export interface DeletionReview {
  trackId: string
  title: string
  artist: string
  filename: string
  format: string
  path: string
  sizeBytes: number
  expiresAt: number
  token: string
}

// ---- agent（docs/04 §2.11；事件形状见 service/agent/embedded.ts 归一化）----

export interface AgentSessionDto {
  id: string
  title: string
  createdAt: string
}

export interface AssistantModel { providerID: string; id: string }
export interface AssistantSettings {
  current: AssistantModel | null
  voiceModel: string
  voiceModels: Array<AssistantModel & { name: string; provider: string }>
  models: Array<AssistantModel & { name: string; provider: string }>
  integrations: Array<{ id: string; name: string; key: boolean; consoleLogin: boolean; connected: boolean; accounts: Array<{ id: string; label: string }> }>
}
export type AssistantChange =
  | ({ type: "model" | "voiceModel" } & AssistantModel)
  | { type: "custom"; slug: string; name: string; baseURL: string; models: string[] }
  | { type: "key"; integrationID: string; key: string }
  | { type: "activate" | "disconnect"; integrationID: string; credentialID: string }
export interface ConsoleAttempt { attemptID: string; url: string; instructions: string; expires: number }

export interface AgentMessageDto {
  id: string
  role: "user" | "assistant"
  text: string
  parts?: readonly AgentPart[]
  createdAt: string
}
export type AgentDelivery = "steer" | "queue"
export interface InboxItem { id:string; text:string; delivery:AgentDelivery }

/** music_play_now / music_enqueue 工具结果里的精简曲目（服务端 trackBrief） */
export interface AgentTrackBrief {
  id: string
  title: string
  artist: string
  album: string
  durationSeconds: number
}

export type AgentEventDto =
  | { type:'questions.changed'; sessionID:string }
  | { type:"inbox.changed"; sessionID:string; delivered:boolean }
  | { type: "session.renamed"; sessionID: string; title: string }
  | { type: "message.delta"; sessionID: string; messageID: string; ordinal: number; append: string }
  | { type: "message.snapshot"; sessionID: string; messageID: string; ordinal: number; text: string }
  | {
      type: "client-action"
      sessionID: string
      kind: "play-now" | "enqueue"
      position?: string
      tracks: ReadonlyArray<AgentTrackBrief & Record<string, unknown>>
    }
  | { type: "raw"; event: { type: string } & Record<string, unknown> }

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

export interface PlayStat {
  playCount: number
  listenedSeconds: number
}

export type MostPlayedItem =
  | (PlayStat & { kind: "track"; track: TrackSummary })
  | (PlayStat & { kind: "album"; album: AlbumSummary })
  | (PlayStat & { kind: "artist"; artist: ArtistSummary })

export interface ListeningSummary {
  plays: number
  tracks: number
  listenedSeconds: number
}

const BASE = "/api/v1"

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await apiFetch(BASE + path, {
    method,
    ...(body !== undefined ? { headers: { "content-type": "application/json" } } : {}),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    credentials: "same-origin",
  })
  if (!response.ok) {
    if (response.status === 401) {
      window.dispatchEvent(new CustomEvent("om:unauthorized"))
    }
    let message = `${response.status}`
    try {
      const data = await response.json()
      message = data?.message ?? data?.error?.message ?? message
    } catch {
      /* ignore */
    }
    throw new ApiError(response.status, message)
  }
  if (response.status === 204) return undefined as T
  const text = await response.text()
  return (text === "" ? undefined : JSON.parse(text)) as T
}

export const api = {
  reviewDeletion: (key:string) => request<DeletionReview>("POST",`/imports/youtube/file-deletion-requests/${encodeURIComponent(key)}/review`),
  confirmDeletion: (key:string,token:string,filename:string) => request<void>("POST",`/imports/youtube/file-deletion-requests/${encodeURIComponent(key)}/confirm`,{token,filename}),
  cancelDeletion: (key:string) => request<void>("DELETE",`/imports/youtube/file-deletion-requests/${encodeURIComponent(key)}`),
  async transcribe(session: string, audio: Blob, signal: AbortSignal): Promise<string> {
    const response = await apiFetch(`${BASE}/agent/sessions/${encodeURIComponent(session)}/transcribe`, { method: "POST", credentials: "same-origin", body: audio, signal })
    if (response.status === 401) window.dispatchEvent(new CustomEvent("om:unauthorized"))
    const result = await response.json().catch(() => null)
    if (!response.ok || typeof result?.text !== "string") throw new ApiError(response.status, result?.message ?? "听写失败，请稍后重试。")
    return result.text
  },
  login: (username: string, password: string) =>
    request<{ user: UserPublic }>("POST", "/auth/login", { username, password }),  logout: () => request<void>("POST", "/auth/logout"),
  me: () => request<UserPublic>("GET", "/auth/me"),

  artists: (params: { limit?: number; offset?: number; sort?: string } = {}) =>
    request<Page<ArtistSummary>>("GET", `/artists?${toQuery(params)}`),
  artist: (id: string) => request<ArtistDetail>("GET", `/artists/${id}`),
  artistAlbums: (id: string) => request<Page<AlbumSummary>>("GET", `/artists/${id}/albums?limit=100`),
  artistTopTracks: (id: string) => request<TrackSummary[]>("GET", `/artists/${id}/top-tracks?limit=10`),

  albums: (params: { limit?: number; offset?: number; sort?: string; artistId?: string; genre?: string } = {}) =>
    request<Page<AlbumSummary>>("GET", `/albums?${toQuery(params)}`),
  album: (id: string) => request<AlbumDetail>("GET", `/albums/${id}`),
  albumTracks: (id: string) => request<TrackSummary[]>("GET", `/albums/${id}/tracks`),

  tracks: (params: { limit?: number; offset?: number; sort?: string } = {}) =>
    request<Page<TrackSummary>>("GET", `/tracks?${toQuery(params)}`),
  track: (id: string) => request<TrackSummary>("GET", `/tracks/${id}`),
  lyrics: (id: string) => request<{source:string;synced:boolean;lines:{startMs:number|null;text:string}[]}>("GET",`/tracks/${id}/lyrics`),
  trackVersions: (id: string) => request<TrackSummary[]>("GET", `/tracks/${id}/versions`),
  random: (count = 20) => request<TrackSummary[]>("GET", `/random?count=${count}`),
  genres: () => request<Genre[]>("GET", "/genres"),
  search: (q: string, type: "all" | "artist" | "album" | "track" = "all") =>
    request<SearchResult>("GET", `/search?q=${encodeURIComponent(q)}&type=${type}`),

  favorites: (type: "artist" | "album" | "track" = "track", limit = 100, offset = 0) =>
    request<Page<TrackSummary | AlbumSummary | ArtistSummary>>(
      "GET",
      `/favorites?type=${type}&limit=${limit}&offset=${offset}`,
    ),
  favorite: (type: "artists" | "albums" | "tracks", id: string) =>
    request<void>("PUT", `/favorites/${type}/${id}`),
  unfavorite: (type: "artists" | "albums" | "tracks", id: string) =>
    request<void>("DELETE", `/favorites/${type}/${id}`),
  rate: (type: "artists" | "albums" | "tracks", id: string, rating: number) =>
    request<void>("PUT", `/ratings/${type}/${id}`, { rating }),

  recordPlay: (trackId: string, listenedSeconds?: number) =>
    // 始终发 JSON body（服务端 payload schema 要求非空 body；未知时长传 {}）
    request<void>("POST", `/plays/${trackId}`, { listenedSeconds }),
  recentPlays: (limit = 50, distinct?: "track", offset?: number) => request<PlayEntry[]>("GET", `/plays/recent?${toQuery({ limit, distinct, offset })}`),
  mostPlayed: (
    type: "track" | "album" | "artist" = "track",
    params: { period?: "all" | "month" | "year"; limit?: number } = {},
  ) => request<MostPlayedItem[]>("GET", `/plays/most-played?type=${type}&${toQuery(params)}`),
  playSummary: () => request<ListeningSummary>("GET", "/plays/summary"),

  playlists: () => request<PlaylistSummary[]>("GET", "/playlists"),
  playlist: (id: string) => request<PlaylistSummary>("GET", `/playlists/${id}`),
  playlistTracks: (id: string) => request<TrackSummary[]>("GET", `/playlists/${id}/tracks`),
  createPlaylist: (name: string) => request<PlaylistSummary>("POST", "/playlists", { name }),
  updatePlaylist: (id: string, patch: { name?: string; isPublic?: boolean }) =>
    request<PlaylistSummary>("PATCH", `/playlists/${id}`, patch),
  deletePlaylist: (id: string) => request<void>("DELETE", `/playlists/${id}`),
  addToPlaylist: (id: string, trackIds: string[]) =>
    request<void>("POST", `/playlists/${id}/tracks`, { trackIds }),
  removeFromPlaylist: (id: string, position: number) =>
    request<void>("DELETE", `/playlists/${id}/tracks/${position}`),

  folders: () => request<MusicFolderDto[]>("GET", "/music-folders"),
  createFolder: (name: string, path: string) =>
    request<MusicFolderDto>("POST", "/music-folders", { name, path }),
  renameFolder: (id: string, name: string) => request<MusicFolderDto>("PATCH", `/music-folders/${id}`, { name }),
  deleteFolder: (id: string) => request<void>("DELETE", `/music-folders/${id}`),
  scan: (force = false) =>
    request<void>("POST", `/library/scan${force ? "?force=true" : ""}`),
  cancelScan: () => request<void>("DELETE", "/library/scan"),
  scanStatus: () => request<ScanStatus>("GET", "/library/scan-status"),

  // ---- imports/netease（docs/04 §网易云音乐导入）----
  neteaseSearch: (q: string) =>
    request<NeteaseCandidate[]>("GET", `/imports/netease/search?q=${encodeURIComponent(q)}`),
  // 同步等终态：可能持续数分钟；无任务句柄、无轮询接口（与服务端 single-flight 对齐）
  neteaseImport: (payload: { url: string; folderId: string; subdirectory?: string }) =>
    request<NeteaseImportResult>("POST", "/imports/netease/requests", payload),
  neteaseFolders: () => request<NeteaseFolder[]>("GET", "/imports/netease/folders"),
  neteaseSubdirectories: (folderId: string, subdirectory = "") =>
    request<{ directories: string[]; truncated: boolean }>(
      "GET", `/imports/netease/subdirectories?${toQuery({ folderId, subdirectory })}`),
  neteaseInfo: (id: string) => request<NeteaseInfo>("GET", `/imports/netease/tracks/${encodeURIComponent(id)}/metadata`),
  neteaseEdit: (id: string, tags: NeteaseTags) =>
    request<NeteaseInfo>("PATCH", `/imports/netease/tracks/${encodeURIComponent(id)}/metadata`, tags),
  neteaseUnindex: (id: string) => request<void>("DELETE", `/imports/netease/tracks/${encodeURIComponent(id)}/library-entry`),
  neteaseRequestDeletion: (id: string) =>
    request<NeteaseDeleteRequest>("POST", `/imports/netease/tracks/${encodeURIComponent(id)}/file-deletion-requests`),
  neteaseReviewDeletion: (key: string) =>
    request<DeletionReview>("POST", `/imports/netease/file-deletion-requests/${encodeURIComponent(key)}/review`),
  neteaseConfirmDeletion: (key: string, token: string, filename: string) =>
    request<void>("POST", `/imports/netease/file-deletion-requests/${encodeURIComponent(key)}/confirm`, { token, filename }),
  neteaseCancelDeletion: (key: string) =>
    request<void>("DELETE", `/imports/netease/file-deletion-requests/${encodeURIComponent(key)}`),

  users: () => request<Page<UserPublic>>("GET", "/users?limit=100"),
  createUser: (username: string, password: string, isAdmin = false) =>
    request<UserPublic>("POST", "/users", { username, password, isAdmin }),
  deleteUser: (id: string) => request<void>("DELETE", `/users/${id}`),

  // ---- agent（docs/04 §2.11）----
  assistantSettings: () => request<AssistantSettings>("GET", "/admin/agent/settings"),
  assistantChange: (change: AssistantChange) => request<void>("POST", "/admin/agent/settings", change),
  consoleBegin: () => request<ConsoleAttempt>("POST", "/admin/agent/console"),
  consoleStatus: (id: string) => request<"pending" | "failed" | "expired" | "complete">("GET", `/admin/agent/console/${encodeURIComponent(id)}`),
  consoleCancel: (id: string) => request<void>("DELETE", `/admin/agent/console/${encodeURIComponent(id)}`),
  agentSessions: () => request<AgentSessionDto[]>("GET", "/agent/sessions"),
  agentSessionCreate: (title?: string) =>
    request<AgentSessionDto>("POST", "/agent/sessions", title === undefined ? {} : { title }),
  agentMessages: (id: string) => request<AgentMessageDto[]>("GET", `/agent/sessions/${id}/messages`),
  agentInbox: (id:string) => request<{busy:boolean;items:InboxItem[];questions?:PendingQuestion[]}>("GET",`/agent/sessions/${encodeURIComponent(id)}/inbox`),
  agentSettleQuestion: (session:string,id:string,answers:string[][]|null) => request<void>(answers===null?'DELETE':'POST',
    `/agent/sessions/${encodeURIComponent(session)}/questions/${encodeURIComponent(id)}`, answers===null?undefined:{answers}),
  agentChangePending: (id:string,item:string,delivery:AgentDelivery|null) => request<void>(delivery ? "PATCH" : "DELETE",
    `/agent/sessions/${encodeURIComponent(id)}/inbox/${encodeURIComponent(item)}`, delivery ? {delivery} : undefined),
  agentPrompt: (id: string, text: string, delivery:AgentDelivery="steer") =>
    request<void>("POST", `/agent/sessions/${id}/prompt`, { text, delivery }),
  agentInterrupt: (id: string) => request<void>("POST", `/agent/sessions/${id}/interrupt`),
}

function toQuery(params: Record<string, unknown>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      search.set(key, String(value))
    }
  }
  return search.toString()
}

export const streamUrl = (trackId: string) => `/api/v1/tracks/${trackId}/stream`
export const coverUrl = (albumId: string) => `/api/v1/covers/al-${albumId}`

export const formatDuration = (seconds: number): string => {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  // 超 1 小时进位 h:mm:ss（超长曲/演唱会录音/整轨时代遗留的时长展示）
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
  return `${m}:${String(s).padStart(2, "0")}`
}
