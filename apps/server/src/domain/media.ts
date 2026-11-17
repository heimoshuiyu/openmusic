import { Schema } from "effect"

/** DB 内 bigint id → 对外一律字符串（见 AGENTS.md 约定） */
export const Id = Schema.String

/** ISO 8601 UTC 时间 */
export const Timestamp = Schema.String

export class ArtistRef extends Schema.Class<ArtistRef>("ArtistRef")({
  id: Id,
  name: Schema.String,
}) {}

export class AlbumRef extends Schema.Class<AlbumRef>("AlbumRef")({
  id: Id,
  name: Schema.String,
  year: Schema.optional(Schema.NullOr(Schema.Number)),
}) {}

export class ArtistSummary extends Schema.Class<ArtistSummary>("ArtistSummary")({
  id: Id,
  name: Schema.String,
  albumCount: Schema.Number,
  trackCount: Schema.Number,
  hasCoverArt: Schema.Boolean,
  starred: Schema.optional(Timestamp),
  createdAt: Timestamp,
}) {}

export class ArtistDetail extends Schema.Class<ArtistDetail>("ArtistDetail")({
  id: Id,
  name: Schema.String,
  albumCount: Schema.Number,
  trackCount: Schema.Number,
  durationSeconds: Schema.Number,
  hasCoverArt: Schema.Boolean,
  starred: Schema.optional(Timestamp),
  createdAt: Timestamp,
}) {}

export class AlbumSummary extends Schema.Class<AlbumSummary>("AlbumSummary")({
  id: Id,
  name: Schema.String,
  artist: ArtistRef,
  year: Schema.optional(Schema.NullOr(Schema.Number)),
  genre: Schema.optional(Schema.NullOr(Schema.String)),
  trackCount: Schema.Number,
  durationSeconds: Schema.Number,
  hasCoverArt: Schema.Boolean,
  starred: Schema.optional(Timestamp),
  createdAt: Timestamp,
}) {}

export class AlbumDetail extends Schema.Class<AlbumDetail>("AlbumDetail")({
  id: Id,
  name: Schema.String,
  artist: ArtistRef,
  year: Schema.optional(Schema.NullOr(Schema.Number)),
  genre: Schema.optional(Schema.NullOr(Schema.String)),
  trackCount: Schema.Number,
  durationSeconds: Schema.Number,
  hasCoverArt: Schema.Boolean,
  starred: Schema.optional(Timestamp),
  createdAt: Timestamp,
}) {}

export class TrackSummary extends Schema.Class<TrackSummary>("TrackSummary")({
  id: Id,
  title: Schema.String,
  artist: ArtistRef,
  album: AlbumRef,
  disc: Schema.Number,
  track: Schema.optional(Schema.NullOr(Schema.Number)),
  durationSeconds: Schema.Number,
  bitrateKbps: Schema.Number,
  sampleRateHz: Schema.Number,
  channels: Schema.Number,
  format: Schema.String,
  codec: Schema.String,
  sizeBytes: Schema.Number,
  hasCoverArt: Schema.Boolean,
  /** 该槽位（专辑+碟+归一标题）的物理副本数；仅浏览面（canonical 视图）查询填充，
   *  id 直查/队列等物理行查询不带——同一槽位的多副本是不同来源/音质的重复拷贝 */
  versionCount: Schema.optional(Schema.Number),
  /** 相对路径；仅版本列表（/tracks/:id/versions）填充，供用户辨认拷贝来源 */
  path: Schema.optional(Schema.String),
  starred: Schema.optional(Timestamp),
  userRating: Schema.optional(Schema.NullOr(Schema.Number)),
  playCount: Schema.Number,
  createdAt: Timestamp,
}) {}

export class Genre extends Schema.Class<Genre>("Genre")({
  name: Schema.String,
  albumCount: Schema.Number,
  trackCount: Schema.Number,
}) {}

export class MusicFolder extends Schema.Class<MusicFolder>("MusicFolder")({
  id: Id,
  name: Schema.String,
  path: Schema.String,
  lastScanAt: Schema.optional(Schema.NullOr(Timestamp)),
  createdAt: Timestamp,
}) {}

/** 统一分页信封（TS7 限制：泛型 Schema.Class 不可行，用函数构造 struct schema） */
export const Page = <A>(item: Schema.Schema<A>) =>
  Schema.Struct({
    items: Schema.Array(item),
    total: Schema.Number,
    offset: Schema.Number,
    limit: Schema.Number,
  })

export const page = <A>(items: ReadonlyArray<A>, total: number, offset: number, limit: number) => ({
  items: [...items],
  total,
  offset,
  limit,
})

// ---- 分页公共类型（query 校验在各端点声明，默认值在 handler 兜底） ----

export interface PaginationQuery {
  readonly limit: number
  readonly offset: number
  readonly sort?: string | undefined
}
