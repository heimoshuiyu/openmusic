import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi"

const del = HttpApiEndpoint.make("DELETE")
import { Schema } from "effect"
import { BadRequest, Conflict, Forbidden, NotFound } from "../../domain/errors"
import { AlbumSummary, ArtistSummary, Page, Timestamp, TrackSummary } from "../../domain/media"
import { SessionAuth } from "../middleware/session"
import { SqlProvider } from "../middleware/sql"

const IdPath = { id: Schema.String }

export class PlaylistSummary extends Schema.Class<PlaylistSummary>("PlaylistSummary")({
  id: Schema.String,
  name: Schema.String,
  comment: Schema.optional(Schema.NullOr(Schema.String)),
  isPublic: Schema.Boolean,
  owner: Schema.String,
  isMine: Schema.Boolean,
  songCount: Schema.Number,
  durationSeconds: Schema.Number,
  createdAt: Timestamp,
  updatedAt: Timestamp,
}) {}

export const CreatePlaylistRequest = Schema.Struct({
  name: Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(200))),
  comment: Schema.optional(Schema.NullOr(Schema.String)),
  isPublic: Schema.optional(Schema.Boolean),
})

export const UpdatePlaylistRequest = Schema.Struct({
  name: Schema.optional(Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(200)))),
  comment: Schema.optional(Schema.NullOr(Schema.String)),
  isPublic: Schema.optional(Schema.Boolean),
})

export const AddPlaylistTracksRequest = Schema.Struct({
  trackIds: Schema.Array(Schema.String).pipe(Schema.check(Schema.isMinLength(1))),
})

export const ReorderPlaylistRequest = Schema.Struct({
  order: Schema.Array(Schema.String).pipe(Schema.check(Schema.isMinLength(1))),
})

/** 最近播放条目（docs/04 §2.8）：track 为 null = 曲目已不在库中（墓碑行），
 *  快照字段（打点时定格）承载叙事——客户端灰显不可播；统计凭快照不回退 */
export class PlayEntry extends Schema.Class<PlayEntry>("PlayEntry")({
  track: Schema.NullOr(TrackSummary),
  title: Schema.String,
  artistName: Schema.String,
  albumName: Schema.String,
  durationSeconds: Schema.Number,
  playedAt: Timestamp,
}) {}

export const RecordPlayRequest = Schema.Struct({
  /** 客户端实测收听秒数；缺省 = 未知（统计按曲目时长兜底，docs/04 §2.8） */
  listenedSeconds: Schema.optional(
    Schema.Number.pipe(Schema.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 86400 }))),
  ),
})

export class TrackPlayStat extends Schema.Class<TrackPlayStat>("TrackPlayStat")({
  kind: Schema.Literal("track"),
  track: TrackSummary,
  playCount: Schema.Number,
  listenedSeconds: Schema.Number,
}) {}

export class AlbumPlayStat extends Schema.Class<AlbumPlayStat>("AlbumPlayStat")({
  kind: Schema.Literal("album"),
  album: AlbumSummary,
  playCount: Schema.Number,
  listenedSeconds: Schema.Number,
}) {}

export class ArtistPlayStat extends Schema.Class<ArtistPlayStat>("ArtistPlayStat")({
  kind: Schema.Literal("artist"),
  artist: ArtistSummary,
  playCount: Schema.Number,
  listenedSeconds: Schema.Number,
}) {}

export const MostPlayedItem = Schema.Union([TrackPlayStat, AlbumPlayStat, ArtistPlayStat])

export class ListeningSummary extends Schema.Class<ListeningSummary>("ListeningSummary")({
  plays: Schema.Number,
  tracks: Schema.Number,
  listenedSeconds: Schema.Number,
}) {}

export const RatingRequest = Schema.Struct({
  rating: Schema.Number.pipe(Schema.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 5 }))),
})

const TypePath = { type: Schema.Literals(["artists", "albums", "tracks"]), id: Schema.String }

/** 收藏 / 评分（docs/04 §2.6） */
export class SocialGroup extends HttpApiGroup.make("social")
  .add(
    HttpApiEndpoint.put("favorite", "/favorites/:type/:id", {
      params: TypePath,
      success: HttpApiSchema.NoContent,
    }),
  )
  .add(
    del("unfavorite", "/favorites/:type/:id", {
      params: TypePath,
      success: HttpApiSchema.NoContent,
    }),
  )
  .add(
    HttpApiEndpoint.get("favorites", "/favorites", {
      query: {
        type: Schema.optional(Schema.Literals(["artist", "album", "track"])),
        limit: Schema.optional(Schema.NumberFromString),
        offset: Schema.optional(Schema.NumberFromString),
      },
      // 条目形状随 type：track→TrackSummary / album→AlbumSummary / artist→ArtistSummary（均带 starred）
      success: Page(Schema.Union([TrackSummary, AlbumSummary, ArtistSummary])),
    }),
  )
  .add(
    HttpApiEndpoint.put("rating", "/ratings/:type/:id", {
      params: TypePath,
      payload: RatingRequest,
      success: HttpApiSchema.NoContent,
    }),
  )
  .middleware(SessionAuth).middleware(SqlProvider)
  .prefix("/api/v1") {}

/** 播放记录（docs/04 §2.8） */
const recentPageNumber = Schema.optional(Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)))
export class PlaysGroup extends HttpApiGroup.make("plays")
  .add(
    HttpApiEndpoint.post("record", "/plays/:id", {
      params: IdPath,
      payload: RecordPlayRequest,
      success: HttpApiSchema.NoContent,
    }),
  )
  .add(
    HttpApiEndpoint.get("recent", "/plays/recent", {
      query: { limit: recentPageNumber, offset: recentPageNumber, distinct: Schema.optional(Schema.Literal("track")) },
      success: Schema.Array(PlayEntry),
    }),
  )
  .add(
    HttpApiEndpoint.get("mostPlayed", "/plays/most-played", {
      query: {
        type: Schema.optional(Schema.Literals(["track", "album", "artist"])),
        period: Schema.optional(Schema.Literals(["all", "month", "year"])),
        limit: Schema.optional(Schema.NumberFromString),
      },
      success: Schema.Array(MostPlayedItem),
    }),
  )
  .add(
    HttpApiEndpoint.get("summary", "/plays/summary", {
      success: ListeningSummary,
    }),
  )
  .middleware(SessionAuth).middleware(SqlProvider)
  .prefix("/api/v1") {}

/** 播放列表（docs/04 §2.7） */
export class PlaylistsGroup extends HttpApiGroup.make("playlists")
  .add(
    HttpApiEndpoint.get("list", "/playlists", {
      success: Schema.Array(PlaylistSummary),
    }),
  )
  .add(
    HttpApiEndpoint.post("create", "/playlists", {
      payload: CreatePlaylistRequest,
      success: PlaylistSummary,
      error: [NotFound, Conflict],
    }),
  )
  .add(
    HttpApiEndpoint.get("detail", "/playlists/:id", {
      params: IdPath,
      success: PlaylistSummary,
      error: [NotFound],
    }),
  )
  .add(
    HttpApiEndpoint.get("tracks", "/playlists/:id/tracks", {
      params: IdPath,
      success: Schema.Array(TrackSummary),
      error: [NotFound],
    }),
  )
  .add(
    HttpApiEndpoint.patch("update", "/playlists/:id", {
      params: IdPath,
      payload: UpdatePlaylistRequest,
      success: PlaylistSummary,
      error: [NotFound, Forbidden],
    }),
  )
  .add(
    del("delete", "/playlists/:id", {
      params: IdPath,
      success: HttpApiSchema.NoContent,
      error: [NotFound, Forbidden],
    }),
  )
  .add(
    HttpApiEndpoint.post("addTracks", "/playlists/:id/tracks", {
      params: IdPath,
      payload: AddPlaylistTracksRequest,
      success: HttpApiSchema.NoContent,
      error: [NotFound, Forbidden],
    }),
  )
  .add(
    del("removeTrack", "/playlists/:id/tracks/:position", {
      params: { id: Schema.String, position: Schema.NumberFromString },
      success: HttpApiSchema.NoContent,
      error: [NotFound, Forbidden],
    }),
  )
  .add(
    HttpApiEndpoint.patch("reorder", "/playlists/:id/tracks", {
      params: IdPath,
      payload: ReorderPlaylistRequest,
      success: HttpApiSchema.NoContent,
      error: [NotFound, BadRequest, Forbidden],
    }),
  )
  .middleware(SessionAuth).middleware(SqlProvider)
  .prefix("/api/v1") {}
