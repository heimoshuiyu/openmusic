import { Effect } from "effect"
import { SqlClient, SqlError } from "effect/unstable/sql"
import { BadRequest, Forbidden, NotFound } from "../../domain/errors"
import type { TrackSummary } from "../../domain/media"
import {
  AnnotationRepo,
  PlayRepo,
  type AnnotationItemType,
  type MostPlayedType,
  type StatsPeriod,
} from "../../repo/annotations"
import { AlbumRepo, ArtistRepo, TrackRepo } from "../../repo/browse"
import { PlaylistRepo } from "../../repo/playlists"
import { SearchRepo } from "../../repo/search"

/**
 * music 工具面（docs/08-ai-agent.md §3.2）：把曲库浏览/搜索/收藏/播放列表/
 * 收听史这些既有 repo 能力，以「名字 + 描述 + JSON Schema 入参 + Effect 执行」
 * 的工具形式二次暴露。A0 不绑定任何 LLM/agent 运行时——A1 的内嵌宿主插件
 * 遍历 musicTools 注册到 OpenCode，测试直接跑 runMusicTool。
 *
 * 口径约束（与浏览面一致，docs/03 §2.5 / §2.7）：
 * - 浏览类出 canonical 口径（ofAlbum/random/search 走视图）；id 定位类
 *   （play_now/enqueue/playlist）用物理行 byIds，严禁换源；
 * - track 收藏走 AnnotationRepo（内部 canonicalize，收藏的是歌不是文件）；
 * - most-played：track 型过滤墓碑，album/artist 型按快照聚合排除兜底身份
 *   （repo 已内建，这里只透传参数）；
 * - 返回给模型的是精简投影（trackBrief 等），防上下文爆炸。
 *
 * run 的守卫是同步早退（Effect.fail 不碰 SqlClient）；整个 run 由
 * runMusicTool 包在 Effect.suspend 里，解析延迟到执行期。
 */

export interface MusicToolCtx {
  /** 工具调用者的用户 id（A1 由会话属主带入；写类工具据此鉴权） */
  readonly userId: number
}

/** JSON Schema 子集（与 OpenCode 工具注册的 input 形状一致：索引签名开放） */
export interface MusicToolInputSchema {
  readonly [x: string]: unknown
  readonly type: "object"
  readonly properties: Readonly<Record<string, unknown>>
  readonly required?: ReadonlyArray<string>
  readonly additionalProperties?: boolean
}

/** 工具错误 = 既有域错误 + repo 层的 NotFound/SqlError（后者由 infra 转 defect） */
export type MusicToolError = BadRequest | Forbidden
export type MusicToolFailure = MusicToolError | NotFound | SqlError.SqlError

export interface MusicTool {
  readonly name: string
  readonly description: string
  readonly input: MusicToolInputSchema
  /** A2 客户端动作标记：工具只解析与校验，真正的播放/入队由 Web 端确认后执行 */
  readonly clientAction?: "play-now" | "enqueue"
  readonly run: (
    input: unknown,
    ctx: MusicToolCtx,
  ) => Effect.Effect<unknown, MusicToolFailure, SqlClient.SqlClient>
}

/** SqlError 等基础设施错误 → defect（500），域错误保持类型化（与 http/api/browse.ts 同款） */
const infra = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, Exclude<E, SqlError.SqlError>, R> =>
  Effect.catch(effect, (error) =>
    (error as { readonly _tag?: string })._tag === "SqlError"
      ? Effect.die(error)
      : Effect.fail(error as never)) as Effect.Effect<A, Exclude<E, SqlError.SqlError>, R>

// ---- 入参解析（守卫纯同步，失败即 BadRequest） ----

const asRecord = (raw: unknown): Record<string, unknown> | undefined =>
  typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : undefined

const str = (o: Record<string, unknown>, k: string): string | undefined =>
  typeof o[k] === "string" ? (o[k] as string) : undefined

const int = (o: Record<string, unknown>, k: string): number | undefined =>
  typeof o[k] === "number" && Number.isInteger(o[k]) && (o[k] as number) > 0 ? (o[k] as number) : undefined

const bool = (o: Record<string, unknown>, k: string): boolean | undefined =>
  typeof o[k] === "boolean" ? (o[k] as boolean) : undefined

const intList = (v: unknown): ReadonlyArray<number> | undefined =>
  Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "number" && Number.isInteger(x) && x > 0)
    ? (v as ReadonlyArray<number>)
    : undefined

const clamp = (n: number | undefined, def: number, max: number): number =>
  n === undefined ? def : Math.min(n, max)

const oneOf = <T extends string>(v: unknown, allowed: ReadonlyArray<T>, def: T | undefined): T | undefined =>
  v === undefined ? def : (allowed.includes(v as T) ? (v as T) : undefined)

const bad = (tool: string, why: string) => new BadRequest({ message: `${tool} 入参非法：${why}` })

/** 队列/播放列表类一次最多 500 个 id（防模型输出失控打爆请求） */
const TRACK_IDS_MAX = 500

/** id 解析守卫：非空正整数数组 + 上限 */
const guardIds = (tool: string, v: unknown): ReadonlyArray<number> | BadRequest => {
  const ids = intList(v)
  if (ids === undefined) return bad(tool, "trackIds 必须是非空正整数数组")
  if (ids.length > TRACK_IDS_MAX) return bad(tool, `一次最多 ${TRACK_IDS_MAX} 个 id`)
  return ids
}

// ---- 投影（给模型看的精简形状） ----

const trackBrief = (t: TrackSummary) => ({
  id: t.id,
  title: t.title,
  artist: t.artist.name,
  album: t.album.name,
  disc: t.disc,
  track: t.track ?? null,
  durationSeconds: t.durationSeconds,
  ...(t.versionCount !== undefined ? { versionCount: t.versionCount } : {}),
})

const albumBrief = (a: {
  readonly id: string
  readonly name: string
  readonly artist: { readonly name: string }
  readonly year?: number | null | undefined
}) => ({ id: a.id, name: a.name, artist: a.artist.name, year: a.year ?? null })

const artistBrief = (a: { readonly id: string; readonly name: string }) => ({ id: a.id, name: a.name })

/** 按请求顺序重排（byIds / in 查询不保序） */
const reorderByIds = <T extends { readonly id: string }>(
  items: ReadonlyArray<T>,
  ids: ReadonlyArray<number>,
): ReadonlyArray<T> => {
  const byId = new Map(items.map((item) => [item.id, item]))
  return ids.flatMap((id) => {
    const hit = byId.get(String(id))
    return hit === undefined ? [] : [hit]
  })
}

/**
 * id 定位类解析：物理行 byIds（不换 canonical 源），缺 id 即 BadRequest——
 * 播放列表/队列语义不允许静默丢弃
 */
const resolveTracks = (tool: string, ids: ReadonlyArray<number>, userId: number) =>
  Effect.flatMap(TrackRepo.byIds(ids.map(String), userId), (tracks) => {
    const found = new Set(tracks.map((t) => t.id))
    const missing = ids.filter((id) => !found.has(String(id)))
    return missing.length > 0
      ? Effect.fail(bad(tool, `曲目不存在：${missing.slice(0, 10).join(", ")}${missing.length > 10 ? " …" : ""}`))
      : Effect.succeed(reorderByIds(tracks, ids))
  })

/** most-played 各型的取名方式（统计行 + 名称投影合并，stat 顺序保持） */
const withNames = <A extends { readonly id: string }, I extends { readonly id: string }>(
  stats: ReadonlyArray<A>,
  items: ReadonlyArray<I>,
  nameOf: (item: I) => Record<string, unknown>,
) => {
  const byId = new Map(items.map((item) => [item.id, item]))
  return stats.flatMap((stat) => {
    const item = byId.get(stat.id)
    return item === undefined ? [] : [{ ...stat, ...nameOf(item) }]
  })
}

// ---- 工具实现（顺序即 docs/08 §3.2 清单顺序） ----

const search: MusicTool = {
  name: "music_search",
  description:
    "搜索/探索曲库：按关键词找曲目/专辑/艺人（trigram 模糊匹配，支持中日文与部分匹配），或按结构化过滤（genre/年代/艺人）浏览曲目（q 可省略）。返回精简列表。",
  input: {
    type: "object",
    properties: {
      q: { type: "string", description: "关键词（标题/专辑名/艺人名）；与过滤条件可单独或组合使用" },
      type: { type: "string", enum: ["all", "track", "album", "artist"], description: "限定返回类型，默认 all" },
      genre: { type: "string", description: "按流派过滤曲目（模糊匹配专辑 genre，如 Vocaloid、J-Pop）" },
      yearFrom: { type: "integer", description: "曲目所在专辑年份下限（配合 genre/artistId 做年代探索）" },
      yearTo: { type: "integer", description: "曲目所在专辑年份上限" },
      artistId: { type: "string", description: "限定艺人（music_search/facets 返回的 artist id）" },
      sortBy: { type: "string", enum: ["plays"], description: "plays=按用户自己的播放次数降序（口味信号）" },
      limit: { type: "integer", description: "每类最多返回条数，默认 10，上限 50" },
    },
    additionalProperties: false,
  },
  run: (raw, ctx) => {
    const o = asRecord(raw)
    if (o === undefined) return Effect.fail(bad("music_search", "期望对象"))
    const q = str(o, "q")?.trim()
    if (q === "") return Effect.fail(bad("music_search", "q 不能为空串（省略 q 请连同过滤条件一起传）"))
    const type = oneOf(str(o, "type"), ["all", "track", "album", "artist"] as const, "all")
    if (type === undefined) return Effect.fail(bad("music_search", "type 只能是 all/track/album/artist"))
    const limit = clamp(int(o, "limit"), 10, 50)
    const genre = str(o, "genre")?.trim()
    if (genre === "") return Effect.fail(bad("music_search", "genre 不能为空串"))
    const yearFrom = int(o, "yearFrom")
    const yearTo = int(o, "yearTo")
    if (yearFrom !== undefined && (yearFrom < 1900 || yearFrom > 2100)) {
      return Effect.fail(bad("music_search", "yearFrom 须在 1900–2100"))
    }
    if (yearTo !== undefined && (yearTo < 1900 || yearTo > 2100)) {
      return Effect.fail(bad("music_search", "yearTo 须在 1900–2100"))
    }
    const artistId = str(o, "artistId")?.trim()
    if (artistId === "") return Effect.fail(bad("music_search", "artistId 不能为空串"))
    const sortBy = oneOf(str(o, "sortBy"), ["plays"] as const, undefined)
    if (sortBy === undefined && str(o, "sortBy") !== undefined) {
      return Effect.fail(bad("music_search", "sortBy 只能是 plays"))
    }
    const hasFilter = genre !== undefined || yearFrom !== undefined || yearTo !== undefined || artistId !== undefined
    // q 省略时必须有过滤条件（防止全库无界扫描）
    if (q === undefined && !hasFilter) {
      return Effect.fail(bad("music_search", "q 省略时必须至少给一个过滤条件（genre/yearFrom/yearTo/artistId）"))
    }
    // 过滤只作用于曲目维度：显式要 album/artist 时报错（过滤静默不生效会造成误解）；
    // type=all/track 时过滤存在则只走 track 路
    if (hasFilter && (type === "album" || type === "artist")) {
      return Effect.fail(bad("music_search", "过滤条件（genre/year/artistId）只作用于曲目，type 不能是 album/artist"))
    }
    const want = (t: string) => (hasFilter ? t === "track" : type === "all" || type === t)
    return Effect.map(
      Effect.all([
        want("artist") && q !== undefined ? SearchRepo.artists(q, limit, 0) : Effect.succeed([]),
        want("album") && q !== undefined ? SearchRepo.albums(q, limit, 0, ctx.userId) : Effect.succeed([]),
        want("track")
          ? SearchRepo.tracks(q, limit, 0, ctx.userId, {
              ...(genre === undefined ? {} : { genre }),
              ...(yearFrom === undefined ? {} : { yearFrom }),
              ...(yearTo === undefined ? {} : { yearTo }),
              ...(artistId === undefined ? {} : { artistId }),
              ...(sortBy === undefined ? {} : { sortByPlays: true }),
            })
          : Effect.succeed([]),
      ]),
      ([artists, albums, tracks]) => ({
        artists: artists.map(artistBrief),
        albums: albums.map(albumBrief),
        tracks: tracks.map(trackBrief),
      }),
    )
  },
}

const facets: MusicTool = {
  name: "music_facets",
  description:
    "曲库词表：流派分布（带专辑数）、年代分布（按十年）、专辑数最多的艺人。探索/推荐前先调用——知道库里有什么才能规划检索（如「放点 Vocaloid」先确认该流派规模）。",
  input: { type: "object", properties: {}, additionalProperties: false },
  run: () => Effect.map(AlbumRepo.facets(), (f) => f),
}

const albumTracks: MusicTool = {
  name: "music_album_tracks",
  description: "列出某专辑的曲目（canonical 口径：同槽位多副本只出一份最优，带版本数）。",
  input: {
    type: "object",
    properties: { albumId: { type: "string", description: "专辑 id" } },
    required: ["albumId"],
    additionalProperties: false,
  },
  run: (raw, ctx) => {
    const o = asRecord(raw)
    const albumId = o === undefined ? undefined : str(o, "albumId")
    if (albumId === undefined || albumId === "") return Effect.fail(bad("music_album_tracks", "albumId 必填"))
    return Effect.map(
      Effect.flatMap(AlbumRepo.byId(albumId, ctx.userId), () => TrackRepo.ofAlbum(albumId, ctx.userId)),
      (tracks) => ({ tracks: tracks.map(trackBrief) }),
    )
  },
}

const artistTop: MusicTool = {
  name: "music_artist_top",
  description: "某艺人最常播放的曲目（按收听次数排序）。",
  input: {
    type: "object",
    properties: {
      artistId: { type: "string", description: "艺人 id" },
      limit: { type: "integer", description: "默认 10，上限 50" },
    },
    required: ["artistId"],
    additionalProperties: false,
  },
  run: (raw, ctx) => {
    const o = asRecord(raw)
    const artistId = o === undefined ? undefined : str(o, "artistId")
    if (artistId === undefined || artistId === "") return Effect.fail(bad("music_artist_top", "artistId 必填"))
    const limit = clamp(o === undefined ? undefined : int(o, "limit"), 10, 50)
    return Effect.map(
      Effect.flatMap(ArtistRepo.topTracks(artistId, limit), (ids) =>
        Effect.map(TrackRepo.byIds(ids, ctx.userId), (tracks) => reorderByIds(tracks, ids.map(Number))),
      ),
      (tracks) => ({ tracks: tracks.map(trackBrief) }),
    )
  },
}

const recentPlays: MusicTool = {
  name: "music_recent_plays",
  description:
    "按时间倒序查询用户的播放记录。查最近听过哪些不同曲目时用 distinct=track；查单曲循环等逐次记录时省略 distinct。翻页用返回的 nextOffset，保持 distinct 不变；null 表示已到末页。trackId 为 null 表示曲目已不在库中。",
  input: {
    type: "object",
    properties: {
      limit: { type: "integer", minimum: 1, description: "默认 20，上限 100" },
      offset: { type: "integer", minimum: 0, description: "跳过多少条结果，从 0 开始；去重模式下按去重后的曲目计数" },
      distinct: { type: "string", enum: ["track"], description: "每个物理曲目只取最近一次；不合并同名的不同版本" },
    },
    additionalProperties: false,
  },
  run: (raw, ctx) => {
    const o = asRecord(raw)
    const offset = o?.offset === undefined ? 0 : o.offset
    if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) return Effect.fail(bad("music_recent_plays", "offset 必须是非负整数"))
    const distinct = o?.distinct
    if (distinct !== undefined && distinct !== "track") return Effect.fail(bad("music_recent_plays", "distinct 只能是 track 或省略"))
    const limit = clamp(o === undefined ? undefined : int(o, "limit"), 20, 100)
    return Effect.map(PlayRepo.recent(ctx.userId, limit + 1, distinct, offset), (rows) => ({
      plays: rows.slice(0, limit), nextOffset: rows.length > limit ? offset + limit : null,
    }))
  },
}

const mostPlayed: MusicTool = {
  name: "music_most_played",
  description: "用户最常播放的曲目/专辑/艺人（按播放次数与收听时长排序）。用于了解用户口味。",
  input: {
    type: "object",
    properties: {
      type: { type: "string", enum: ["track", "album", "artist"], description: "默认 track" },
      period: { type: "string", enum: ["all", "month", "year"], description: "统计周期，默认 all" },
      limit: { type: "integer", description: "默认 10，上限 50" },
    },
    additionalProperties: false,
  },
  run: (raw, ctx) => {
    const o = asRecord(raw)
    const type = oneOf(o === undefined ? undefined : str(o, "type"), ["track", "album", "artist"] as const, "track")
    if (type === undefined) return Effect.fail(bad("music_most_played", "type 只能是 track/album/artist"))
    const period = oneOf(o === undefined ? undefined : str(o, "period"), ["all", "month", "year"] as const, "all")
    if (period === undefined) return Effect.fail(bad("music_most_played", "period 只能是 all/month/year"))
    const limit = clamp(o === undefined ? undefined : int(o, "limit"), 10, 50)
    return Effect.flatMap(
      PlayRepo.mostPlayed(ctx.userId, type satisfies MostPlayedType, period satisfies StatsPeriod, limit),
      (stats): Effect.Effect<{
        readonly type: "track" | "album" | "artist"
        readonly items: ReadonlyArray<Record<string, unknown>>
      }, SqlError.SqlError, SqlClient.SqlClient> => {
        const ids = stats.map((row) => row.id)
        if (type === "track") {
          return Effect.map(TrackRepo.byIds(ids, ctx.userId), (tracks) => ({
            type,
            items: withNames(stats, tracks, (t) => ({ title: t.title, artist: t.artist.name, album: t.album.name })),
          }))
        }
        if (type === "album") {
          return Effect.map(AlbumRepo.byIds(ids, ctx.userId), (albums) => ({
            type,
            items: withNames(stats, albums, (a) => ({ name: a.name, artist: a.artist.name, year: a.year ?? null })),
          }))
        }
        return Effect.map(ArtistRepo.byIds(ids, ctx.userId), (artists) => ({
          type,
          items: withNames(stats, artists, (a) => ({ name: a.name })),
        }))
      },
    )
  },
}

const favorites: MusicTool = {
  name: "music_favorites",
  description: "用户收藏（红心）的曲目/专辑/艺人列表，按收藏时间倒序。",
  input: {
    type: "object",
    properties: {
      type: { type: "string", enum: ["track", "album", "artist"], description: "默认 track" },
      limit: { type: "integer", description: "默认 20，上限 100" },
    },
    additionalProperties: false,
  },
  run: (raw, ctx) => {
    const o = asRecord(raw)
    const type = oneOf(o === undefined ? undefined : str(o, "type"), ["track", "album", "artist"] as const, "track")
    if (type === undefined) return Effect.fail(bad("music_favorites", "type 只能是 track/album/artist"))
    const limit = clamp(o === undefined ? undefined : int(o, "limit"), 20, 100)
    const itemType = type satisfies AnnotationItemType
    return Effect.flatMap(
      AnnotationRepo.starredIds(ctx.userId, itemType, limit, 0),
      ({ ids }): Effect.Effect<{
        readonly type: "track" | "album" | "artist"
        readonly items: ReadonlyArray<Record<string, unknown>>
      }, SqlError.SqlError, SqlClient.SqlClient> => {
      if (ids.length === 0) return Effect.succeed({ type, items: [] })
      if (type === "track") {
        return Effect.map(TrackRepo.byIds(ids.map(String), ctx.userId), (tracks) => ({
          type,
          items: reorderByIds(tracks, ids).map(trackBrief),
        }))
      }
      if (type === "album") {
        return Effect.map(AlbumRepo.byIds(ids.map(String), ctx.userId), (albums) => ({
          type,
          items: reorderByIds(albums, ids).map(albumBrief),
        }))
      }
      return Effect.map(ArtistRepo.byIds(ids.map(String), ctx.userId), (artists) => ({
        type,
        items: reorderByIds(artists, ids).map(artistBrief),
      }))
    })
  },
}

const random: MusicTool = {
  name: "music_random",
  description: "从曲库随机抽取曲目（canonical 口径），适合快速起一个队列。",
  input: {
    type: "object",
    properties: { count: { type: "integer", description: "默认 10，上限 50" } },
    additionalProperties: false,
  },
  run: (raw, ctx) => {
    const o = asRecord(raw)
    const count = clamp(o === undefined ? undefined : int(o, "count"), 10, 50)
    return Effect.map(TrackRepo.random(count, ctx.userId), (tracks) => ({ tracks: tracks.map(trackBrief) }))
  },
}

const playNow: MusicTool = {
  name: "music_play_now",
  description: "请求立即播放曲目（替换当前队列并从第一首开始）。返回解析好的曲目列表，客户端确认后执行。",
  clientAction: "play-now",
  input: {
    type: "object",
    properties: {
      trackIds: { type: "array", items: { type: "integer" }, description: "按播放顺序排列的曲目 id" },
    },
    required: ["trackIds"],
    additionalProperties: false,
  },
  run: (raw, ctx) => {
    const ids = guardIds("music_play_now", asRecord(raw)?.trackIds)
    if (ids instanceof BadRequest) return Effect.fail(ids)
    return Effect.map(resolveTracks("music_play_now", ids, ctx.userId), (tracks) => ({
      action: "play-now" as const,
      tracks: tracks.map(trackBrief),
    }))
  },
}

const enqueue: MusicTool = {
  name: "music_enqueue",
  description: "请求把曲目加入播放队列（默认排到队尾）。返回解析好的曲目列表，客户端确认后执行。",
  clientAction: "enqueue",
  input: {
    type: "object",
    properties: {
      trackIds: { type: "array", items: { type: "integer" }, description: "按加入顺序排列的曲目 id" },
      position: { type: "string", enum: ["next", "end"], description: "next=插到当前曲后，默认 end" },
    },
    required: ["trackIds"],
    additionalProperties: false,
  },
  run: (raw, ctx) => {
    const o = asRecord(raw)
    if (o === undefined) return Effect.fail(bad("music_enqueue", "期望对象"))
    const ids = guardIds("music_enqueue", o.trackIds)
    if (ids instanceof BadRequest) return Effect.fail(ids)
    const position = oneOf(str(o, "position"), ["next", "end"] as const, "end")
    if (position === undefined) return Effect.fail(bad("music_enqueue", "position 只能是 next/end"))
    return Effect.map(resolveTracks("music_enqueue", ids, ctx.userId), (tracks) => ({
      action: "enqueue" as const,
      position,
      tracks: tracks.map(trackBrief),
    }))
  },
}

const playlistCreate: MusicTool = {
  name: "music_playlist_create",
  description: "创建播放列表，可同时带入首批曲目。",
  input: {
    type: "object",
    properties: {
      name: { type: "string", description: "列表名（1–200 字符）" },
      comment: { type: "string", description: "备注（可选）" },
      isPublic: { type: "boolean", description: "是否公开，默认 false" },
      trackIds: { type: "array", items: { type: "integer" }, description: "首批曲目 id（可选，按顺序）" },
    },
    required: ["name"],
    additionalProperties: false,
  },
  run: (raw, ctx) => {
    const o = asRecord(raw)
    if (o === undefined) return Effect.fail(bad("music_playlist_create", "期望对象"))
    const name = str(o, "name")?.trim()
    if (name === undefined || name.length === 0 || name.length > 200) {
      return Effect.fail(bad("music_playlist_create", "name 必填（1–200 字符）"))
    }
    const comment = str(o, "comment") ?? null
    const isPublic = bool(o, "isPublic") ?? false
    const firstIds = o.trackIds === undefined ? undefined : guardIds("music_playlist_create", o.trackIds)
    if (firstIds instanceof BadRequest) return Effect.fail(firstIds)
    // 先解析曲目（失败不建列表，避免留空壳），再建表、再灌曲
    return Effect.flatMap(
      firstIds === undefined ? Effect.succeed([]) : resolveTracks("music_playlist_create", firstIds, ctx.userId),
      (tracks) =>
        Effect.flatMap(PlaylistRepo.create(ctx.userId, name, comment, isPublic), (playlistId) =>
          Effect.map(
            tracks.length === 0
              ? Effect.succeed(undefined)
              : PlaylistRepo.editTracks(playlistId, tracks.map((t) => Number(t.id)), []),
            () => ({ playlistId: String(playlistId), name, trackCount: tracks.length }),
          ),
        ),
    )
  },
}

const playlistAdd: MusicTool = {
  name: "music_playlist_add",
  description: "向自己的播放列表追加曲目（排到列表末尾）。",
  input: {
    type: "object",
    properties: {
      playlistId: { type: "integer", description: "播放列表 id" },
      trackIds: { type: "array", items: { type: "integer" }, description: "按追加顺序排列的曲目 id" },
    },
    required: ["playlistId", "trackIds"],
    additionalProperties: false,
  },
  run: (raw, ctx) => {
    const o = asRecord(raw)
    if (o === undefined) return Effect.fail(bad("music_playlist_add", "期望对象"))
    const playlistId = int(o, "playlistId")
    if (playlistId === undefined) return Effect.fail(bad("music_playlist_add", "playlistId 必须是正整数"))
    const ids = guardIds("music_playlist_add", o.trackIds)
    if (ids instanceof BadRequest) return Effect.fail(ids)
    // 只能改自己的列表（与第一方 API 的归属语义一致）
    return Effect.flatMap(
      PlaylistRepo.byId(playlistId),
      (row): Effect.Effect<{ readonly playlistId: string; readonly addedCount: number }, Forbidden | BadRequest | SqlError.SqlError, SqlClient.SqlClient> => {
        if (row.ownerUserId !== ctx.userId) {
          return Effect.fail(new Forbidden({ message: "只能编辑自己的播放列表" }))
        }
        return Effect.map(
          Effect.flatMap(resolveTracks("music_playlist_add", ids, ctx.userId), (tracks) =>
            PlaylistRepo.editTracks(playlistId, tracks.map((t) => Number(t.id)), []),
          ),
          () => ({ playlistId: String(playlistId), addedCount: ids.length }),
        )
      },
    )
  },
}

const star: MusicTool = {
  name: "music_star",
  description: "收藏（红心）或取消收藏曲目。收藏的是「歌」——id 会归一到槽位 canonical。",
  input: {
    type: "object",
    properties: {
      trackIds: { type: "array", items: { type: "integer" }, description: "曲目 id" },
      starred: { type: "boolean", description: "true=收藏（默认），false=取消" },
    },
    required: ["trackIds"],
    additionalProperties: false,
  },
  run: (raw, ctx) => {
    const o = asRecord(raw)
    if (o === undefined) return Effect.fail(bad("music_star", "期望对象"))
    const ids = guardIds("music_star", o.trackIds)
    if (ids instanceof BadRequest) return Effect.fail(ids)
    const starred = bool(o, "starred") ?? true
    return Effect.map(
      starred
        ? AnnotationRepo.star(ctx.userId, "track", ids)
        : AnnotationRepo.unstar(ctx.userId, "track", ids),
      () => ({ starred, trackIds: ids }),
    )
  },
}

/** 工具注册表（A1 插件遍历注册） */
export const musicTools: ReadonlyArray<MusicTool> = [
  search,
  facets,
  albumTracks,
  artistTop,
  recentPlays,
  mostPlayed,
  favorites,
  random,
  playNow,
  enqueue,
  playlistCreate,
  playlistAdd,
  star,
]

const registry = new Map(musicTools.map((tool) => [tool.name, tool]))

/** 工具元信息（A1 注册 OpenCode 工具用：name/description/input/clientAction） */
export const musicToolMetas = musicTools.map(({ run: _run, ...meta }) => meta)

/** 统一执行入口：未知工具 → BadRequest；守卫延迟到执行期；SqlError → defect */
export const runMusicTool = (name: string, input: unknown, ctx: MusicToolCtx) => {
  const tool = registry.get(name)
  if (tool === undefined) {
    return Effect.fail(new BadRequest({ message: `未知工具：${name}` }))
  }
  return infra(Effect.suspend(() => tool.run(input, ctx)))
}
