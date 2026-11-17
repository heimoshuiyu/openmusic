import { HttpApiBuilder } from "effect/unstable/httpapi"
import { SqlClient } from "effect/unstable/sql"
import { Effect } from "effect"
import { Forbidden } from "../../domain/errors"
import { page } from "../../domain/media"
import { AlbumSummary, ArtistSummary, TrackSummary } from "../../domain/media"
import { AnnotationRepo, PlayRepo } from "../../repo/annotations"
import { PlaylistRepo } from "../../repo/playlists"
import { AlbumRepo, ArtistRepo, TrackRepo } from "../../repo/browse"
import {
  AlbumPlayStat,
  ArtistPlayStat,
  ListeningSummary,
  PlaylistSummary,
  PlaysGroup,
  PlaylistsGroup,
  PlayEntry,
  SocialGroup,
  TrackPlayStat,
} from "./social-schema"
import { Api } from "./index"
import { CurrentUser } from "../middleware/session"

const infra = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, Exclude<E, { readonly _tag: "SqlError" }>, R> =>
  Effect.catch(effect, (error) =>
    (error as { readonly _tag?: string })._tag === "SqlError"
      ? Effect.die(error)
      : Effect.fail(error as never)) as Effect.Effect<A, Exclude<E, { readonly _tag: "SqlError" }>, R>

const itemTypeOf = (
  type: "artists" | "albums" | "tracks" | "artist" | "album" | "track",
): "artist" | "album" | "track" =>
  (type.replace(/s$/, "") as "artist" | "album" | "track")

const toPlaylistSummary = (userId: number) => (row: {
  id: number
  ownerUserId: number
  ownerUsername: string
  name: string
  comment: string | null
  isPublic: boolean
  songCount: number
  durationSeconds: number
  createdAt: string
  updatedAt: string
}) =>
  new PlaylistSummary({
    id: String(row.id),
    name: row.name,
    comment: row.comment,
    isPublic: row.isPublic,
    owner: row.ownerUsername,
    isMine: row.ownerUserId === userId,
    songCount: row.songCount,
    durationSeconds: row.durationSeconds,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  })

export const SocialApiLive = HttpApiBuilder.group(Api, "social", Effect.fn(function* (handlers) {
  return handlers.handleAll({
    favorite: ({ params }) =>
      Effect.flatMap(CurrentUser, (user) =>
        Effect.as(
          infra(AnnotationRepo.star(Number(user.id), itemTypeOf(params.type), [Number(params.id)])),
          undefined,
        )),
    unfavorite: ({ params }) =>
      Effect.flatMap(
        CurrentUser,
        (user) =>
          infra(AnnotationRepo.unstar(Number(user.id), itemTypeOf(params.type), [Number(params.id)])),
      ),
    favorites: ({ query }) =>
      Effect.flatMap(CurrentUser, (user): Effect.Effect<
        { items: (TrackSummary | AlbumSummary | ArtistSummary)[]; total: number; offset: number; limit: number },
        never,
        SqlClient.SqlClient
      > => {
        const type = itemTypeOf(query.type ?? "track")
        const limit = query.limit ?? 500
        const offset = query.offset ?? 0
        return Effect.flatMap(
          infra(AnnotationRepo.starredIds(Number(user.id), type, limit, offset)),
          ({ ids, total }) =>
            Effect.flatMap(
              infra(AnnotationRepo.mapFor(Number(user.id), type, ids)),
              (annotations): Effect.Effect<
                { items: (TrackSummary | AlbumSummary | ArtistSummary)[]; total: number; offset: number; limit: number },
                never,
                SqlClient.SqlClient
              > => {
                const starredOf = (id: string) => annotations.get(Number(id))?.starredAt ?? undefined
                // starredIds 按收藏时间降序返回；byIds 顺序不保证 → 按 ids 重排
                const ordered = <T extends { readonly id: string }>(items: ReadonlyArray<T>): ReadonlyArray<T> => {
                  const byId = new Map(items.map((item) => [item.id, item]))
                  return ids.flatMap((id) => {
                    const item = byId.get(String(id))
                    return item === undefined ? [] : [item]
                  })
                }
                switch (type) {
                  case "album":
                    return Effect.map(infra(AlbumRepo.byIds(ids.map(String))), (albums) =>
                      page(
                        ordered(albums).map((album) => new AlbumSummary({ ...album, starred: starredOf(album.id) })),
                        total,
                        offset,
                        limit,
                      ))
                  case "artist":
                    return Effect.map(infra(ArtistRepo.byIds(ids.map(String))), (artists) =>
                      page(
                        ordered(artists).map((artist) => new ArtistSummary({ ...artist, starred: starredOf(artist.id) })),
                        ids.length,
                        offset,
                        limit,
                      ))
                  default:
                    return Effect.map(infra(TrackRepo.byIds(ids.map(String))), (tracks) =>
                      page(
                        ordered(tracks).map((track) => new TrackSummary({ ...track, starred: starredOf(track.id) })),
                        ids.length,
                        offset,
                        limit,
                      ))
                }
              },
            ),
        )
      }),
    rating: ({ params, payload }) =>
      Effect.flatMap(
        CurrentUser,
        (user) =>
          Effect.as(
            infra(AnnotationRepo.setRating(
              Number(user.id),
              itemTypeOf(params.type),
              Number(params.id),
              payload.rating,
            )),
            undefined,
          ),
      ),
  })
}))

type MostPlayedResult = ReadonlyArray<TrackPlayStat | AlbumPlayStat | ArtistPlayStat>

export const PlaysApiLive = HttpApiBuilder.group(Api, "plays", Effect.fn(function* (handlers) {
  return handlers.handleAll({
    record: ({ params, payload }) =>
      Effect.flatMap(CurrentUser, (user) =>
        Effect.as(
          infra(PlayRepo.record(Number(user.id), Number(params.id), new Date(), payload.listenedSeconds)),
          undefined,
        )),
    recent: ({ query }) =>
      Effect.flatMap(CurrentUser, (user) =>
        Effect.flatMap(
          infra(PlayRepo.recent(Number(user.id), query.limit ?? 50, query.distinct, query.offset)),
          (entries) => {
            const ids = entries.flatMap((entry) =>
              entry.trackId === null ? [] : [String(entry.trackId)])
            return Effect.map(infra(TrackRepo.byIds(ids)), (tracks) => {
              const byId = new Map(tracks.map((track) => [track.id, track]))
              // 墓碑行（trackId null / 曲目行已消失）保留在结果里——历史是事实
              return entries.map((entry) =>
                new PlayEntry({
                  track: entry.trackId === null ? null : (byId.get(String(entry.trackId)) ?? null),
                  title: entry.title,
                  artistName: entry.artistName,
                  albumName: entry.albumName,
                  durationSeconds: entry.durationSeconds,
                  playedAt: entry.playedAt,
                }))
            })
          },
        )),
    mostPlayed: ({ query }) =>
      Effect.flatMap(CurrentUser, (user) => {
        const type = query.type ?? "track"
        return Effect.flatMap(
          infra(PlayRepo.mostPlayed(Number(user.id), type, query.period ?? "all", query.limit ?? 50)),
          (stats): Effect.Effect<MostPlayedResult, never, SqlClient.SqlClient> => {
            if (stats.length === 0) return Effect.succeed([])
            const ids = stats.map((stat) => stat.id)
            if (type === "album") {
              return Effect.map(infra(AlbumRepo.byIds(ids)), (albums) => {
                const byId = new Map(albums.map((album) => [album.id, album]))
                return stats.flatMap((stat) => {
                  const album = byId.get(stat.id)
                  return album === undefined
                    ? []
                    : [new AlbumPlayStat({ kind: "album", album, playCount: stat.playCount, listenedSeconds: stat.listenedSeconds })]
                })
              })
            }
            if (type === "artist") {
              return Effect.map(infra(ArtistRepo.byIds(ids)), (artists) => {
                const byId = new Map(artists.map((artist) => [artist.id, artist]))
                return stats.flatMap((stat) => {
                  const artist = byId.get(stat.id)
                  return artist === undefined
                    ? []
                    : [new ArtistPlayStat({ kind: "artist", artist, playCount: stat.playCount, listenedSeconds: stat.listenedSeconds })]
                })
              })
            }
            return Effect.map(infra(TrackRepo.byIds(ids)), (tracks) => {
              const byId = new Map(tracks.map((track) => [track.id, track]))
              return stats.flatMap((stat) => {
                const track = byId.get(stat.id)
                return track === undefined
                  ? []
                  : [new TrackPlayStat({ kind: "track", track, playCount: stat.playCount, listenedSeconds: stat.listenedSeconds })]
              })
            })
          },
        )
      }),
    summary: () =>
      Effect.flatMap(CurrentUser, (user) =>
        Effect.map(
          infra(PlayRepo.summary(Number(user.id))),
          (summary) => new ListeningSummary(summary),
        )),
  })
}))

export const PlaylistsApiLive = HttpApiBuilder.group(Api, "playlists", Effect.fn(function* (handlers) {
  const visible = (playlistId: string, userId: number) =>
    infra(PlaylistRepo.visible(Number(playlistId), userId))

  return handlers.handleAll({
    list: () =>
      Effect.flatMap(CurrentUser, (user) =>
        Effect.map(
          infra(PlaylistRepo.listFor(Number(user.id))),
          (rows) => rows.map(toPlaylistSummary(Number(user.id))),
        )),
    create: ({ payload }) =>
      Effect.flatMap(CurrentUser, (user) =>
        Effect.flatMap(
          infra(PlaylistRepo.create(Number(user.id), payload.name, payload.comment ?? null, payload.isPublic ?? false)),
          (id) => infra(PlaylistRepo.byId(id)),
        ).pipe(Effect.map(toPlaylistSummary(Number(user.id))))),
    detail: ({ params }) =>
      Effect.flatMap(CurrentUser, (user) =>
        Effect.map(visible(params.id, Number(user.id)), toPlaylistSummary(Number(user.id)))),
    tracks: ({ params }) =>
      Effect.flatMap(CurrentUser, (user) =>
        Effect.flatMap(visible(params.id, Number(user.id)), () =>
          Effect.flatMap(infra(PlaylistRepo.trackIds(Number(params.id))), (ids) =>
            Effect.map(infra(TrackRepo.byIds(ids.map(String))), (tracks) => {
              const byId = new Map(tracks.map((track) => [track.id, track]))
              return ids.flatMap((id) => {
                const track = byId.get(String(id))
                return track === undefined ? [] : [track]
              })
            })))),
    update: ({ params, payload }) =>
      Effect.flatMap(CurrentUser, (user) =>
        Effect.map(
          Effect.gen(function* () {
            const playlist = yield* visible(params.id, Number(user.id))
            if (playlist.ownerUserId !== Number(user.id)) {
              return yield* Effect.fail(new Forbidden({ message: "not owner" }))
            }
            yield* infra(PlaylistRepo.updateMeta(Number(params.id), {
              name: payload.name,
              comment: payload.comment,
              isPublic: payload.isPublic,
            }))
            return yield* infra(PlaylistRepo.byId(Number(params.id)))
          }),
          toPlaylistSummary(Number(user.id)),
        )),
    delete: ({ params }) =>
      Effect.flatMap(CurrentUser, (user) =>
        Effect.as(
          Effect.gen(function* () {
            const playlist = yield* visible(params.id, Number(user.id))
            if (playlist.ownerUserId !== Number(user.id)) {
              return yield* Effect.fail(new Forbidden({ message: "not owner" }))
            }
            return yield* infra(PlaylistRepo.delete(Number(params.id)))
          }),
          undefined,
        )),
    addTracks: ({ params, payload }) =>
      Effect.flatMap(CurrentUser, (user) =>
        Effect.flatMap(
          visible(params.id, Number(user.id)),
          () =>
            infra(PlaylistRepo.editTracks(
              Number(params.id),
              payload.trackIds.map(Number),
              [],
            )),
        )),
    removeTrack: ({ params }) =>
      Effect.flatMap(CurrentUser, (user) =>
        Effect.flatMap(
          visible(params.id, Number(user.id)),
          () => infra(PlaylistRepo.editTracks(Number(params.id), [], [params.position])),
        )),
    reorder: ({ params, payload }) =>
      Effect.flatMap(CurrentUser, (user) =>
        Effect.flatMap(
          visible(params.id, Number(user.id)),
          () => infra(PlaylistRepo.replaceTracks(Number(params.id), payload.order.map(Number))),
        )),
  })
}))
