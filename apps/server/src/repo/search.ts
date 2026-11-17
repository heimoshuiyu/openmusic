import { SqlClient } from "effect/unstable/sql"
import { Effect } from "effect"
import { AlbumSummary, ArtistSummary, TrackSummary } from "../domain/media"
import { albumSummary, artistSummary, trackSummary } from "./browse"
import { TRACK_GENRE } from "./metadata-overrides"

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v))

/** 曲目搜索的可选结构化过滤（A3 探索面）：genre 在 albums 上（join 已有），artistId 精确定位 */
export interface TrackFilters {
  readonly genre?: string | undefined
  readonly yearFrom?: number | undefined
  readonly yearTo?: number | undefined
  readonly artistId?: string | undefined
  /** 按当前用户的播放次数降序（自己的口味信号，非全局计数） */
  readonly sortByPlays?: boolean | undefined
}

/**
 * 三路 trigram 搜索（ILIKE %q%，走 gin_trgm_ops 索引，CJK 友好，见 docs/02 R2-4）。
 * tracks 支持 q 为空 + filters 的「浏览式」检索（探索场景：q 空时必须有过滤条件，
 * 守卫在工具层；repo 只管拼条件）。canonical 口径不变。
 */
export const SearchRepo = {
  artists: (q: string, limit: number, offset: number) =>
    Effect.map(
      Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql`select a.id, a.name, a.album_count, a.track_count,
                   (a.cover_file is not null) as has_cover, a.created_at
            from artists a
            where a.name ilike ${`%${q}%`}
            order by a.name asc
            limit ${limit} offset ${offset}`),
      (rows) => rows.map((row) => artistSummary(row as Record<string, unknown>)),
    ),

  albums: (q: string, limit: number, offset: number, userId = 0) =>
    Effect.map(
      Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql`select al.id, al.name, al.year, al.genre, al.track_count, al.duration_seconds,
                   (al.cover_file is not null or exists(
                      select 1 from tracks te where te.album_id = al.id and te.has_embedded_cover)) as has_cover,
                   al.created_at,
                   a.id as artist_id, a.name as artist_name,
                   (select an.starred_at from annotations an
                    where an.user_id = ${userId} and an.item_type = 'album' and an.item_id = al.id) as starred_at
            from library_albums al join artists a on a.id = al.artist_id
            where al.name ilike ${`%${q}%`}
            order by a.name asc, al.name asc
            limit ${limit} offset ${offset}`),
      (rows) => rows.map((row) => albumSummary(row as Record<string, unknown>)),
    ),

  tracks: (q: string | undefined, limit: number, offset: number, userId = 0, filters?: TrackFilters | undefined) =>
    Effect.flatMap(SqlClient.SqlClient, (sql) => {
      const f = filters ?? {}
      const conds = [
        q === undefined || q === "" ? undefined : sql`t.title ilike ${`%${q}%`}`,
        f.genre === undefined ? undefined : sql`${sql.literal(TRACK_GENRE)} ilike ${`%${f.genre}%`}`,
        f.yearFrom === undefined ? undefined : sql`al.year >= ${f.yearFrom}`,
        f.yearTo === undefined ? undefined : sql`al.year <= ${f.yearTo}`,
        f.artistId === undefined ? undefined : sql`t.artist_id = ${f.artistId}::bigint`,
      ].flatMap((fragment) => (fragment === undefined ? [] : [fragment]))
      let where = conds.length === 0 ? sql`where true` : sql`where ${conds[0]!}`
      for (const cond of conds.slice(1)) where = sql`${where} and ${cond}`
      const order = f.sortByPlays
        ? sql`order by my_play_count desc nulls last, ar.name asc, al.name asc, t.disc asc, t.track_no asc nulls last`
        : sql`order by ar.name asc, al.name asc, t.disc asc, t.track_no asc nulls last`
      return Effect.map(
        sql`select t.id, t.title, t.disc, t.track_no, t.duration_seconds, t.bitrate_kbps,
                   t.sample_rate_hz, t.channels, t.format, t.codec, t.size_bytes,
                   t.has_embedded_cover, t.created_at, t.version_count,
                   ar.id as artist_id, ar.name as artist_name,
                   al.id as album_id, al.name as album_name, al.year as album_year,
                   (t.has_embedded_cover or al.cover_file is not null
                    or exists(select 1 from tracks te where te.album_id = al.id and te.has_embedded_cover)) as has_cover,
                   (select count(*)::int from plays p where p.track_id = t.id) as play_count,
                   (select count(*)::int from plays p where p.track_id = t.id and p.user_id = ${userId}) as my_play_count,
                   (select an.starred_at from annotations an
                    where an.user_id = ${userId} and an.item_type = 'track' and an.item_id = t.id) as starred_at
            from canonical_tracks t
            join artists ar on ar.id = t.artist_id
            join albums al on al.id = t.album_id
            ${where}
            ${order}
            limit ${limit} offset ${offset}`,
        (rows) => rows.map((row) => trackSummary(row as Record<string, unknown>)),
      )
    }),

  counts: (q: string) =>
    Effect.map(
      Effect.flatMap(SqlClient.SqlClient, (sql) =>
        Effect.all([
          sql`select count(*)::int as n from artists where name ilike ${`%${q}%`}`,
          sql`select count(*)::int as n from library_albums where name ilike ${`%${q}%`}`,
          sql`select count(*)::int as n from canonical_tracks where title ilike ${`%${q}%`}`,
        ])),
      ([a, al, t]) => ({
        artists: num((a[0] as Record<string, unknown>).n),
        albums: num((al[0] as Record<string, unknown>).n),
        tracks: num((t[0] as Record<string, unknown>).n),
      }),
    ),
}

export type { ArtistSummary, AlbumSummary, TrackSummary }
