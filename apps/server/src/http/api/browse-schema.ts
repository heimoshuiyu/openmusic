import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { NotFound } from "../../domain/errors"
import { SessionAuth } from "../middleware/session"
import { SqlProvider } from "../middleware/sql"
import {
  AlbumDetail,
  AlbumSummary,
  ArtistDetail,
  ArtistSummary,
  Genre,
  Page,
  TrackSummary,
} from "../../domain/media"

/** 分页 query 字段（handler 侧兜底默认值 limit=20 / offset=0） */
export const paginationQuery = {
  limit: Schema.optional(Schema.NumberFromString),
  offset: Schema.optional(Schema.NumberFromString),
}

export class SearchResult extends Schema.Class<SearchResult>("SearchResult")({
  artists: Schema.Array(ArtistSummary),
  albums: Schema.Array(AlbumSummary),
  tracks: Schema.Array(TrackSummary),
  artistCount: Schema.Number,
  albumCount: Schema.Number,
  trackCount: Schema.Number,
}) {}

export class BrowseGroup extends HttpApiGroup.make("browse")
  // artists
  .add(
    HttpApiEndpoint.get("artists", "/artists", {
      query: { ...paginationQuery, sort: Schema.optional(Schema.String) },
      success: Page(ArtistSummary),
    }),
  )
  .add(
    HttpApiEndpoint.get("artist", "/artists/:id", {
      params: { id: Schema.String },
      success: ArtistDetail,
      error: [NotFound],
    }),
  )
  .add(
    HttpApiEndpoint.get("artistAlbums", "/artists/:id/albums", {
      params: { id: Schema.String },
      query: { ...paginationQuery },
      success: Page(AlbumSummary),
      error: [NotFound],
    }),
  )
  .add(
    HttpApiEndpoint.get("artistTopTracks", "/artists/:id/top-tracks", {
      params: { id: Schema.String },
      query: { limit: Schema.optional(Schema.NumberFromString) },
      success: Schema.Array(TrackSummary),
      error: [NotFound],
    }),
  )
  // albums
  .add(
    HttpApiEndpoint.get("albums", "/albums", {
      query: {
        ...paginationQuery,
        sort: Schema.optional(Schema.String),
        artistId: Schema.optional(Schema.String),
        year: Schema.optional(Schema.NumberFromString),
        genre: Schema.optional(Schema.String),
      },
      success: Page(AlbumSummary),
    }),
  )
  .add(
    HttpApiEndpoint.get("album", "/albums/:id", {
      params: { id: Schema.String },
      success: AlbumDetail,
      error: [NotFound],
    }),
  )
  .add(
    HttpApiEndpoint.get("albumTracks", "/albums/:id/tracks", {
      params: { id: Schema.String },
      success: Schema.Array(TrackSummary),
      error: [NotFound],
    }),
  )
  // tracks
  .add(
    HttpApiEndpoint.get("tracks", "/tracks", {
      query: {
        ...paginationQuery,
        sort: Schema.optional(Schema.String),
        albumId: Schema.optional(Schema.String),
        artistId: Schema.optional(Schema.String),
        genre: Schema.optional(Schema.String),
      },
      success: Page(TrackSummary),
    }),
  )
  .add(
    HttpApiEndpoint.get("track", "/tracks/:id", {
      params: { id: Schema.String },
      success: TrackSummary,
      error: [NotFound],
    }),
  )
  .add(
    /** 槽位的全部物理副本（版本切换用，docs/03 §2.5）：canonical 在首位，
     *  其余按择优序；path 便于用户辨认来源目录 */
    HttpApiEndpoint.get("trackVersions", "/tracks/:id/versions", {
      params: { id: Schema.String },
      success: Schema.Array(TrackSummary),
      error: [NotFound],
    }),
  )
  // genres & random & search
  .add(
    HttpApiEndpoint.get("genres", "/genres", { success: Schema.Array(Genre) }),
  )
  .add(
    HttpApiEndpoint.get("random", "/random", {
      query: { count: Schema.optional(Schema.NumberFromString) },
      success: Schema.Array(TrackSummary),
    }),
  )
  .add(
    HttpApiEndpoint.get("search", "/search", {
      query: {
        q: Schema.String,
        type: Schema.optional(Schema.Literals(["all", "artist", "album", "track"])),
        limit: Schema.optional(Schema.NumberFromString),
        offset: Schema.optional(Schema.NumberFromString),
      },
      success: SearchResult,
    }),
  )
  .middleware(SessionAuth).middleware(SqlProvider)
  .prefix("/api/v1") {}
