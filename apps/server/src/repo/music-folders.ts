import { SqlClient } from "effect/unstable/sql"
import { Effect } from "effect"
import { notFound } from "../domain/errors"
import { MusicFolder } from "../domain/media"
import { reconcileAlbums, refreshTrackArtists } from "./album-lifecycle"
import { lockFolderIndex } from "./library-exclusions"

export interface MusicFolderRow {
  id: string | number
  name: string
  path: string
  last_scan_at: Date | string | null
  created_at: Date | string
}

export const toMusicFolder = (row: MusicFolderRow): MusicFolder =>
  new MusicFolder({
    id: String(row.id),
    name: row.name,
    path: row.path,
    lastScanAt: row.last_scan_at ? new Date(row.last_scan_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
  })

export const MusicFolderRepo = {
  list: Effect.map(
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql`select id, name, path, last_scan_at, created_at from music_folders order by id`),
    (rows) => rows.map((row) => toMusicFolder(row as unknown as MusicFolderRow)),
  ),

  byId: (id: string) =>
    Effect.flatMap(
      Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql`select id, name, path, last_scan_at, created_at from music_folders where id = ${id}::bigint`),
      (rows) => {
        const row = rows[0] as MusicFolderRow | undefined
        return row === undefined
          ? Effect.fail(notFound("music_folder", id))
          : Effect.succeed(toMusicFolder(row))
      },
    ),

  /** 扫描器需要 folder id + path */
  listForScan: Effect.map(
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql`select id, path from music_folders order by id`),
    (rows) => rows.map((row) => ({
      id: Number(row.id),
      path: String(row.path),
    })),
  ),

  create: (input: { name: string; path: string }) =>
    Effect.map(
      Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql`
          insert into music_folders (name, path) values (${input.name}, ${input.path})
          on conflict (path) do update set name = excluded.name
          returning id, name, path, last_scan_at, created_at
        `),
      (rows) => toMusicFolder(rows[0] as unknown as MusicFolderRow),
    ),

  rename: (id: string, name: string) =>
    Effect.flatMap(
      Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql`update music_folders set name = ${name} where id = ${id}::bigint
            returning id, name, path, last_scan_at, created_at`),
      (rows) => {
        const row = rows[0] as MusicFolderRow | undefined
        return row === undefined
          ? Effect.fail(notFound("music_folder", id))
          : Effect.succeed(toMusicFolder(row))
      },
    ),

  delete: (id: string) =>
    Effect.flatMap(SqlClient.SqlClient, sql => sql.withTransaction(Effect.gen(function* () {
      yield* lockFolderIndex(sql, Number(id))
      const affected = yield* sql<{album_id:string;artist_id:string}>`select distinct album_id,artist_id from tracks where music_folder_id=${id}::bigint`
      const rows = yield* sql`delete from music_folders where id=${id}::bigint returning id`
      if (!rows.length) return yield* notFound("music_folder", id)
      yield* reconcileAlbums(sql,affected.map(r=>r.album_id))
      yield* refreshTrackArtists(sql,affected.map(r=>r.artist_id))
    }))),

  touchScanned: (id: number) =>
    Effect.flatMap(
      SqlClient.SqlClient,
      (sql) => sql`update music_folders set last_scan_at = now() where id = ${id}`,
    ),
}
