import { SqlClient } from "effect/unstable/sql"
import { Effect, Option } from "effect"
import { notFound } from "../domain/errors"

const infra = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, Exclude<E, { readonly _tag: "SqlError" }>, R> =>
  Effect.catch(effect, (error) =>
    (error as { readonly _tag?: string })._tag === "SqlError"
      ? Effect.die(error)
      : Effect.fail(error as never)) as Effect.Effect<A, Exclude<E, { readonly _tag: "SqlError" }>, R>

const iso = (v: unknown) => new Date(v as string).toISOString()

export interface PlaylistRow {
  readonly id: number
  readonly ownerUserId: number
  readonly ownerUsername: string
  readonly name: string
  readonly comment: string | null
  readonly isPublic: boolean
  readonly durationSeconds: number
  readonly songCount: number
  readonly createdAt: string
  readonly updatedAt: string
}

const PLAYLIST_COLS = `p.id, p.owner_user_id, u.username as owner_username, p.name, p.comment,
  p.is_public, p.duration_seconds,
  (select count(*)::int from playlist_tracks pt where pt.playlist_id = p.id) as song_count,
  p.created_at, p.updated_at`

const toRow = (row: Record<string, unknown>): PlaylistRow => ({
  id: Number(row.id),
  ownerUserId: Number(row.owner_user_id),
  ownerUsername: String(row.owner_username),
  name: String(row.name),
  comment: row.comment === null ? null : String(row.comment),
  isPublic: Boolean(row.is_public),
  durationSeconds: Number(row.duration_seconds),
  songCount: Number(row.song_count),
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
})

export const PlaylistRepo = {
  /** 自己的 + public 的（Subsonic getPlaylists 语义） */
  listFor: (userId: number) =>
    Effect.map(
      infra(
        Effect.flatMap(SqlClient.SqlClient, (sql) =>
          sql`select ${sql.literal(PLAYLIST_COLS)} from playlists p
              join users u on u.id = p.owner_user_id
              where p.owner_user_id = ${userId} or p.is_public
              order by p.id`),
      ),
      (rows) => (rows as ReadonlyArray<Record<string, unknown>>).map(toRow),
    ),

  byId: (playlistId: number) =>
    Effect.flatMap(
      infra(
        Effect.flatMap(SqlClient.SqlClient, (sql) =>
          sql`select ${sql.literal(PLAYLIST_COLS)} from playlists p
              join users u on u.id = p.owner_user_id
              where p.id = ${playlistId}`),
      ),
      (rows) => {
        const row = (rows as ReadonlyArray<Record<string, unknown>>)[0]
        return row === undefined
          ? Effect.fail(notFound("playlist", playlistId))
          : Effect.succeed(toRow(row))
      },
    ),

  /** 可见性：owner 或 public */
  visible: (playlistId: number, userId: number) =>
    Effect.flatMap(PlaylistRepo.byId(playlistId), (row) =>
      row.ownerUserId === userId || row.isPublic
        ? Effect.succeed(row)
        : Effect.fail(notFound("playlist", playlistId)))

  ,

  create: (ownerUserId: number, name: string, comment: string | null, isPublic: boolean) =>
    Effect.map(
      infra(
        Effect.flatMap(SqlClient.SqlClient, (sql) =>
          sql`insert into playlists (owner_user_id, name, comment, is_public)
              values (${ownerUserId}, ${name}, ${comment}, ${isPublic})
              returning id`),
      ),
      (rows) => Number((rows[0] as Record<string, unknown>).id),
    ),

  updateMeta: (
    playlistId: number,
    input: { name?: string | undefined; comment?: string | null | undefined; isPublic?: boolean | undefined },
  ) =>
    infra(
      Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql`update playlists set
              name = coalesce(${input.name ?? null}, name),
              comment = coalesce(${input.comment ?? null}, comment),
              is_public = coalesce(${input.isPublic ?? null}, is_public),
              updated_at = now()
            where id = ${playlistId}`),
    ),

  delete: (playlistId: number) =>
    infra(
      Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql`delete from playlists where id = ${playlistId}`),
    ),

  trackIds: (playlistId: number) =>
    Effect.map(
      infra(
        Effect.flatMap(SqlClient.SqlClient, (sql) =>
          sql`select track_id from playlist_tracks where playlist_id = ${playlistId}
              order by position asc`),
      ),
      (rows) => (rows as ReadonlyArray<Record<string, unknown>>).map((row) => Number(row.track_id)),
    ),

  /** 全量替换曲目（createPlaylist 带 playlistId 的语义；也用于整体重排） */
  replaceTracks: (playlistId: number, trackIds: ReadonlyArray<number>) =>
    infra(
      Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql.withTransaction(Effect.gen(function* () {
          yield* sql`delete from playlist_tracks where playlist_id = ${playlistId}`
          for (let position = 0; position < trackIds.length; position++) {
            yield* sql`insert into playlist_tracks (playlist_id, position, track_id)
                       values (${playlistId}, ${position}, ${trackIds[position]!})`
          }
          yield* sql`update playlists set updated_at = now(),
                        duration_seconds = coalesce((
                          select sum(t.duration_seconds) from playlist_tracks pt
                          join tracks t on t.id = pt.track_id where pt.playlist_id = ${playlistId}
                        ), 0)
                      where id = ${playlistId}`
        }))),
    ),

  /** 增量更新（updatePlaylist：追加 + 按位置删除） */
  editTracks: (
    playlistId: number,
    addTrackIds: ReadonlyArray<number>,
    removePositions: ReadonlyArray<number>,
  ) =>
    infra(
      Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql.withTransaction(Effect.gen(function* () {
          if (removePositions.length > 0) {
            yield* sql`delete from playlist_tracks
                       where playlist_id = ${playlistId}
                         and position in ${sql.in(removePositions)}`
          }
          if (addTrackIds.length > 0) {
            const maxRows = yield* sql`select coalesce(max(position), -1) + 1 as next
                                       from playlist_tracks where playlist_id = ${playlistId}`
            let next = Number((maxRows[0] as Record<string, unknown>).next)
            for (const trackId of addTrackIds) {
              yield* sql`insert into playlist_tracks (playlist_id, position, track_id)
                         values (${playlistId}, ${next}, ${trackId})`
              next++
            }
          }
          // 位置重排（删除后压缩空洞）
          const rows = yield* sql`select track_id from playlist_tracks
                                  where playlist_id = ${playlistId} order by position asc`
          const ids = (rows as ReadonlyArray<Record<string, unknown>>).map((r) => Number(r.track_id))
          yield* sql`delete from playlist_tracks where playlist_id = ${playlistId}`
          for (let position = 0; position < ids.length; position++) {
            yield* sql`insert into playlist_tracks (playlist_id, position, track_id)
                       values (${playlistId}, ${position}, ${ids[position]!})`
          }
          yield* sql`update playlists set updated_at = now(),
                        duration_seconds = coalesce((
                          select sum(t.duration_seconds) from playlist_tracks pt
                          join tracks t on t.id = pt.track_id where pt.playlist_id = ${playlistId}
                        ), 0)
                      where id = ${playlistId}`
        }))),
    ),
}

export { Option }
