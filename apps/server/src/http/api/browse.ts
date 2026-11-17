import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Effect } from "effect"
import { page } from "../../domain/media"
import { AlbumRepo, ArtistRepo, GenreRepo, TrackRepo } from "../../repo/browse"
import { SearchRepo } from "../../repo/search"
import { CurrentUser } from "../middleware/session"
import { Api } from "./index"
import { SearchResult } from "./browse-schema"

/** SqlError 等基础设施错误 → defect（500），域错误（NotFound 等）保持类型化 */
const infra = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, Exclude<E, { readonly _tag: "SqlError" }>, R> =>
  Effect.catch(effect, (error) =>
    (error as { readonly _tag?: string })._tag === "SqlError"
      ? Effect.die(error)
      : Effect.fail(error as never)) as Effect.Effect<A, Exclude<E, { readonly _tag: "SqlError" }>, R>

/** 当前用户 id（starred 态随查询下发——红心在列表页就能亮，SocialRepo 同款取法） */
const uid = Effect.map(CurrentUser, (user) => Number(user.id))

export const BrowseApiLive = HttpApiBuilder.group(Api, "browse", Effect.fn(function* (handlers) {
  return handlers.handleAll({
    artists: ({ query }) =>
      Effect.map(
        infra(ArtistRepo.list({ limit: query.limit ?? 20, offset: query.offset ?? 0, sort: query.sort })),
        (result) => page(result.items, result.total, query.offset ?? 0, query.limit ?? 20),
      ),
    artist: ({ params }) => Effect.flatMap(uid, (userId) => infra(ArtistRepo.byId(params.id, userId))),
    artistAlbums: ({ params, query }) =>
      Effect.flatMap(uid, (userId) =>
        Effect.flatMap(
          infra(ArtistRepo.byId(params.id, userId)),
          () =>
            Effect.map(
              infra(ArtistRepo.albumsOf(params.id, { limit: query.limit ?? 20, offset: query.offset ?? 0 }, userId)),
              (result) => page(result.items, result.total, query.offset ?? 0, query.limit ?? 20),
            ),
        )),
    artistTopTracks: ({ params, query }) =>
      Effect.flatMap(uid, (userId) =>
        Effect.flatMap(
          infra(ArtistRepo.byId(params.id, userId)),
          () =>
            Effect.flatMap(
              infra(ArtistRepo.topTracks(params.id, query.limit ?? 10)),
              (ids) =>
                Effect.map(infra(TrackRepo.byIds(ids, userId)), (tracks) =>
                  tracks.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id))),
            ),
        )),
    albums: ({ query }) =>
      Effect.flatMap(uid, (userId) =>
        Effect.map(
          infra(AlbumRepo.list({
            limit: query.limit ?? 20,
            offset: query.offset ?? 0,
            sort: query.sort,
            artistId: query.artistId,
            year: query.year,
            genre: query.genre,
          }, userId)),
          (result) => page(result.items, result.total, query.offset ?? 0, query.limit ?? 20),
        )),
    album: ({ params }) => Effect.flatMap(uid, (userId) => infra(AlbumRepo.byId(params.id, userId))),
    albumTracks: ({ params }) =>
      Effect.flatMap(uid, (userId) =>
        Effect.flatMap(infra(AlbumRepo.byId(params.id, userId)), () =>
          infra(TrackRepo.ofAlbum(params.id, userId)))),
    tracks: ({ query }) =>
      Effect.flatMap(uid, (userId) =>
        Effect.map(
          infra(TrackRepo.list({
            limit: query.limit ?? 20,
            offset: query.offset ?? 0,
            sort: query.sort,
            albumId: query.albumId,
            artistId: query.artistId,
            genre: query.genre,
          }, userId)),
          (result) => page(result.items, result.total, query.offset ?? 0, query.limit ?? 20),
        )),
    track: ({ params }) =>
      Effect.flatMap(uid, (userId) => infra(TrackRepo.byId(params.id, userId))),
    trackVersions: ({ params }) =>
      Effect.flatMap(uid, (userId) => infra(TrackRepo.ofVersions(params.id, userId))),
    genres: () => infra(GenreRepo.list),
    random: ({ query }) =>
      Effect.flatMap(uid, (userId) => infra(TrackRepo.random(query.count ?? 20, userId))),
    search: ({ query }) =>
      Effect.flatMap(uid, (userId) =>
        Effect.map(
          Effect.all([
            infra(SearchRepo.counts(query.q)),
            (query.type ?? "all") === "artist" || (query.type ?? "all") === "all"
              ? infra(SearchRepo.artists(query.q, query.limit ?? 20, query.offset ?? 0))
              : Effect.succeed([]),
            (query.type ?? "all") === "album" || (query.type ?? "all") === "all"
              ? infra(SearchRepo.albums(query.q, query.limit ?? 20, query.offset ?? 0, userId))
              : Effect.succeed([]),
            (query.type ?? "all") === "track" || (query.type ?? "all") === "all"
              ? infra(SearchRepo.tracks(query.q, query.limit ?? 20, query.offset ?? 0, userId))
              : Effect.succeed([]),
          ]),
          ([counts, artists, albums, tracks]) =>
            new SearchResult({
              artistCount: counts.artists,
              albumCount: counts.albums,
              trackCount: counts.tracks,
              artists,
              albums,
              tracks,
            }),
        )),
  })
}))
