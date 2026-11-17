import { SqlClient } from "effect/unstable/sql"
import type { Fragment } from "effect/unstable/sql/Statement"
import { Effect } from "effect"
import { notFound } from "../domain/errors"
import { TRACK_GENRE } from "./metadata-overrides"
import {
  AlbumDetail,
  AlbumRef,
  AlbumSummary,
  ArtistDetail,
  ArtistRef,
  ArtistSummary,
  Genre,
  TrackSummary,
  type PaginationQuery,
} from "../domain/media"

type Sql = SqlClient.SqlClient

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v))
const iso = (v: unknown): string => new Date(v as string).toISOString()

/** 排序白名单：参数名 → 列名（杜绝 SQL 注入）；命中白名单才允许 - 降序，fallback 为完整 order by 子句 */
const orderBy = (map: Record<string, string>, sort: string | undefined, fallback: string): string => {
  if (sort !== undefined && sort !== "") {
    const key = sort.replace(/^-/, "")
    const column = map[key]
    if (column !== undefined) {
      return `order by ${column} ${sort.startsWith("-") ? "desc" : "asc"} nulls last`
    }
  }
  return fallback
}

const whereOf = (sql: Sql, conds: ReadonlyArray<Fragment>): Fragment => {
  if (conds.length === 0) return sql.literal("")
  let clause = conds[0]!
  for (const cond of conds.slice(1)) {
    clause = sql`${clause} and ${cond}`
  }
  return sql` where ${clause}`
}

// ---- Artists ----

const ARTIST_COLS = `a.id, a.name, a.album_count, a.track_count,
  (a.cover_file is not null) as has_cover, a.created_at`

/** 用户维度的收藏态子查询（starred 贯通第一方浏览面——红心在列表页就能亮） */
const starredSub = (itemType: "artist" | "album" | "track", userId: number, col: string): string =>
  `(select an.starred_at from annotations an
    where an.user_id = ${userId} and an.item_type = '${itemType}' and an.item_id = ${col}) as starred_at`

export const artistSummary = (row: Record<string, unknown>): ArtistSummary =>
  new ArtistSummary({
    id: String(row.id),
    name: String(row.name),
    albumCount: num(row.album_count),
    trackCount: num(row.track_count),
    hasCoverArt: Boolean(row.has_cover),
    createdAt: iso(row.created_at),
  })

export const ArtistRepo = {
  list: (query: PaginationQuery & { readonly sort?: string | undefined }) =>
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      Effect.map(
        Effect.all([
          sql`select ${sql.literal(ARTIST_COLS)} from artists a
              ${sql.literal(orderBy({ name: "a.name", albumCount: "a.album_count", createdAt: "a.created_at" }, query.sort, "order by a.name asc"))}
              limit ${query.limit} offset ${query.offset}`,
          sql`select count(*)::int as n from artists`,
        ]),
        ([rows, countRows]) => ({
          items: rows.map((row) => artistSummary(row as Record<string, unknown>)),
          total: num((countRows[0] as Record<string, unknown>).n),
        }),
      )),

  byId: (id: string, userId = 0) =>
    Effect.flatMap(
      Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql`select ${sql.literal(ARTIST_COLS)}, ${sql.literal(starredSub("artist", userId, "a.id"))},
              coalesce((select sum(al.duration_seconds) from library_albums al where al.artist_id = a.id), 0) as duration
            from artists a where a.id = ${id}::bigint`),
      (rows) => {
        const row = rows[0] as Record<string, unknown> | undefined
        if (row === undefined) return Effect.fail(notFound("artist", id))
        return Effect.succeed(
          new ArtistDetail({
            id: String(row.id),
            name: String(row.name),
            albumCount: num(row.album_count),
            trackCount: num(row.track_count),
            durationSeconds: num(row.duration),
            hasCoverArt: Boolean(row.has_cover),
            ...(row.starred_at ? { starred: iso(row.starred_at) } : {}),
            createdAt: iso(row.created_at),
          }),
        )
      },
    ),

  /** 批量取（顺序不保证，调用方自行按 id 重排）；most-played 富化用 */
  byIds: (ids: ReadonlyArray<string>, userId = 0) =>
    ids.length === 0
      ? Effect.succeed([])
      : Effect.map(
          Effect.flatMap(SqlClient.SqlClient, (sql) =>
            sql`select ${sql.literal(ARTIST_COLS)} from artists a
                where a.id in ${sql.in(ids.map((id) => Number(id)))}`),
          (rows) => rows.map((row) => artistSummary(row as Record<string, unknown>)),
        ),

  albumsOf: (id: string, query: PaginationQuery, userId = 0) =>
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      Effect.map(
        Effect.all([
          sql`select ${sql.literal(ALBUM_COLS(userId))} from library_albums al
              join artists a on a.id = al.artist_id
              where al.artist_id = ${id}::bigint
              order by al.year asc nulls last, al.name asc
              limit ${query.limit} offset ${query.offset}`,
          sql`select count(*)::int as n from library_albums where artist_id = ${id}::bigint`,
        ]),
        ([rows, countRows]) => ({
          items: rows.map((row) => albumSummary(row as Record<string, unknown>)),
          total: num((countRows[0] as Record<string, unknown>).n),
        }),
      )),

  topTracks: (id: string, limit: number) =>
    Effect.map(
      Effect.flatMap(SqlClient.SqlClient, (sql) =>
        // canonical 行 + 打点按 (艺人, 归一标题) 快照聚合：同一首歌多副本的
        // 播放计数不再被物理行拆散，top 榜也不会出现同名重复行
        sql`select t.id, sum(coalesce(pc.c, 0))::int as plays
            from canonical_tracks t
            left join (select artist_id, lower(btrim(title)) as k, count(*)::int as c
                       from plays group by 1, 2) pc
              on pc.artist_id = t.artist_id and pc.k = lower(btrim(t.title))
            where t.artist_id = ${id}::bigint
            group by t.id, t.title
            order by plays desc, t.title asc
            limit ${limit}`),
      (rows) => rows.map((row) => String((row as Record<string, unknown>).id)),
    ),
}

// ---- Albums ----

const ALBUM_COLS = (userId = 0) => `al.id, al.name, al.year, al.genre, al.track_count, al.duration_seconds,
  (al.cover_file is not null or exists(
    select 1 from tracks te where te.album_id = al.id and te.has_embedded_cover)) as has_cover,
  al.created_at,
  a.id as artist_id, a.name as artist_name,
  ${starredSub("album", userId, "al.id")}`

export const albumSummary = (r: Record<string, unknown>): AlbumSummary =>
  new AlbumSummary({
    id: String(r.id),
    name: String(r.name),
    artist: new ArtistRef({ id: String(r.artist_id), name: String(r.artist_name) }),
    year: r.year === null || r.year === undefined ? null : Number(r.year),
    genre: r.genre === null || r.genre === undefined ? null : String(r.genre),
    trackCount: num(r.track_count),
    durationSeconds: num(r.duration_seconds),
    hasCoverArt: Boolean(r.has_cover),
    ...(r.starred_at ? { starred: iso(r.starred_at) } : {}),
    createdAt: iso(r.created_at),
  })

export const AlbumRepo = {
  list: (query: PaginationQuery & {
    readonly sort?: string | undefined
    readonly artistId?: string | undefined
    readonly year?: number | undefined
    readonly genre?: string | undefined
  }, userId = 0) =>
    Effect.flatMap(SqlClient.SqlClient, (sql) => {
      const conds: Array<Fragment> = []
      if (query.artistId !== undefined) conds.push(sql`al.artist_id = ${query.artistId}::bigint`)
      if (query.year !== undefined) conds.push(sql`al.year = ${query.year}`)
      if (query.genre !== undefined) conds.push(sql`al.genre = ${query.genre}`)
      const where = whereOf(sql, conds)
      const order = orderBy(
        { name: "al.name", artist: "a.name", year: "al.year", createdAt: "al.created_at", duration: "al.duration_seconds", random: "random()" },
        query.sort,
        "order by a.name asc, al.year asc nulls last, al.name asc",
      )
      return Effect.map(
        Effect.all([
          sql`select ${sql.literal(ALBUM_COLS(userId))} from library_albums al
              join artists a on a.id = al.artist_id${where}
              ${sql.literal(order)} limit ${query.limit} offset ${query.offset}`,
          sql`select count(*)::int as n from library_albums al${where}`,
        ]),
        ([rows, countRows]) => ({
          items: rows.map((row) => albumSummary(row as Record<string, unknown>)),
          total: num((countRows[0] as Record<string, unknown>).n),
        }),
      )
    }),

  byId: (id: string, userId = 0) =>
    Effect.flatMap(
      Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql`select ${sql.literal(ALBUM_COLS(userId))} from library_albums al
            join artists a on a.id = al.artist_id
            where al.id = ${id}::bigint`),
      (rows) => {
        const row = rows[0] as Record<string, unknown> | undefined
        if (row === undefined) return Effect.fail(notFound("album", id))
        return Effect.succeed(new AlbumDetail({ ...albumSummary(row) }))
      },
    ),

  /** 批量取（顺序不保证，调用方自行按 id 重排）；most-played 富化用 */
  byIds: (ids: ReadonlyArray<string>, userId = 0) =>
    ids.length === 0
      ? Effect.succeed([])
      : Effect.map(
          Effect.flatMap(SqlClient.SqlClient, (sql) =>
            sql`select ${sql.literal(ALBUM_COLS(userId))} from library_albums al
                join artists a on a.id = al.artist_id
                where al.id in ${sql.in(ids.map((id) => Number(id)))}`),
          (rows) => rows.map((row) => albumSummary(row as Record<string, unknown>)),
        ),

  /** 库词表（A3 music_facets）：genre/年代/艺人分布——agent 探索曲库的先验知识。
   *  年份数据清洗：脏值两种形态（year=1、YYYYMMDD 未剥），9999 以上取前 4 位，
   *  区间外（<1900 / >2100）丢弃 */
  facets: () =>
    Effect.map(
      Effect.flatMap(SqlClient.SqlClient, (sql) =>
        Effect.all([
          sql`select genre, count(*)::int as n from library_albums
              where genre is not null and genre <> ''
              group by genre order by n desc, genre asc limit 24`,
          sql`select y.decade, count(*)::int as n from (
                select ((case when al.year > 9999 then (al.year / 10000) else al.year end) / 10) * 10 as decade
                from library_albums al where al.year is not null
              ) y
              where y.decade between 1900 and 2100
              group by y.decade order by y.decade asc`,
          sql`select a.name, a.album_count from artists a
              order by a.album_count desc, a.name asc limit 16`,
        ])),
      ([genres, decades, artists]) => ({
        genres: (genres as ReadonlyArray<Record<string, unknown>>).map((r) => ({
          genre: String(r.genre), albums: Number(r.n),
        })),
        decades: (decades as ReadonlyArray<Record<string, unknown>>).map((r) => ({
          decade: Number(r.decade), albums: Number(r.n),
        })),
        topArtists: (artists as ReadonlyArray<Record<string, unknown>>).map((r) => ({
          name: String(r.name), albums: Number(r.album_count),
        })),
      }),
    ),
}

// ---- Tracks ----

const TRACK_COLS = (userId = 0) => `t.id, t.title, t.disc, t.track_no, t.duration_seconds, t.bitrate_kbps,
  t.sample_rate_hz, t.channels, t.format, t.codec, t.size_bytes,
  t.has_embedded_cover, t.created_at,
  ar.id as artist_id, ar.name as artist_name,
  al.id as album_id, al.name as album_name, al.year as album_year,
  (t.has_embedded_cover or al.cover_file is not null
   or exists(select 1 from tracks te where te.album_id = al.id and te.has_embedded_cover)) as has_cover,
  (select count(*)::int from plays p where p.track_id = t.id) as play_count,
  ${starredSub("track", userId, "t.id")}`

/** 浏览面取数（canonical_tracks 视图，docs/03 §2.5）：同槽位多副本只出一份最优，
 *  附 version_count；id 定位/队列等物理行查询仍用 TRACK_COLS */
const CANONICAL_COLS = (userId = 0) => `${TRACK_COLS(userId)}, t.version_count`

export const trackSummary = (r: Record<string, unknown>): TrackSummary =>
  new TrackSummary({
    id: String(r.id),
    title: String(r.title),
    artist: new ArtistRef({ id: String(r.artist_id), name: String(r.artist_name) }),
    album: new AlbumRef({
      id: String(r.album_id),
      name: String(r.album_name),
      year: r.album_year === null || r.album_year === undefined ? null : Number(r.album_year),
    }),
    disc: num(r.disc),
    track: r.track_no === null || r.track_no === undefined ? null : Number(r.track_no),
    durationSeconds: num(r.duration_seconds),
    bitrateKbps: num(r.bitrate_kbps),
    sampleRateHz: num(r.sample_rate_hz),
    channels: num(r.channels),
    format: String(r.format),
    codec: String(r.codec),
    sizeBytes: num(r.size_bytes),
    hasCoverArt: Boolean(r.has_cover),
    userRating: null,
    playCount: num(r.play_count),
    ...(r.version_count === undefined || r.version_count === null
      ? {}
      : { versionCount: num(r.version_count) }),
    ...(r.path === undefined || r.path === null ? {} : { path: String(r.path) }),
    ...(r.starred_at ? { starred: iso(r.starred_at) } : {}),
    createdAt: iso(r.created_at),
  })

export const TrackRepo = {
  ofAlbum: (albumId: string, userId = 0) =>
    Effect.map(
      Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql`select ${sql.literal(CANONICAL_COLS(userId))} from canonical_tracks t
            join artists ar on ar.id = t.artist_id
            join albums al on al.id = t.album_id
            where t.album_id = ${albumId}::bigint
            order by t.disc asc, t.track_no asc nulls last, t.title asc`),
      (rows) => rows.map((row) => trackSummary(row as Record<string, unknown>)),
    ),

  byIds: (ids: ReadonlyArray<string>, userId = 0) =>
    ids.length === 0
      ? Effect.succeed([])
      : Effect.map(
          Effect.flatMap(SqlClient.SqlClient, (sql) =>
            sql`select ${sql.literal(TRACK_COLS(userId))} from tracks t
                join artists ar on ar.id = t.artist_id
                join albums al on al.id = t.album_id
                where t.id in ${sql.in(ids.map((id) => Number(id)))}
                order by t.disc asc, t.track_no asc nulls last`),
          (rows) => rows.map((row) => trackSummary(row as Record<string, unknown>)),
        ),

  list: (query: PaginationQuery & {
    readonly sort?: string | undefined
    readonly albumId?: string | undefined
    readonly artistId?: string | undefined
    readonly genre?: string | undefined
  }, userId = 0) =>
    Effect.flatMap(SqlClient.SqlClient, (sql) => {
      const conds: Array<Fragment> = []
      if (query.albumId !== undefined) conds.push(sql`t.album_id = ${query.albumId}::bigint`)
      if (query.artistId !== undefined) conds.push(sql`t.artist_id = ${query.artistId}::bigint`)
      if (query.genre !== undefined) conds.push(sql`${sql.literal(TRACK_GENRE)} = ${query.genre}`)
      const where = whereOf(sql, conds)
      // playCount 排序特判：ORDER BY 相关子查询要为全表每行探一次 plays 索引，
      // 大库秒级——改一次性聚合 join（返回行仍用 TRACK_COLS 的相关子查询，代价仅 limit 行）
      const byPlayCount = query.sort?.replace(/^-/, "") === "playCount"
      const order = byPlayCount
        ? `order by coalesce(pc.c, 0) ${query.sort!.startsWith("-") ? "desc" : "asc"} nulls last`
        : orderBy(
          { title: "t.title", artist: "ar.name", album: "al.name", createdAt: "t.created_at", playCount: "play_count", random: "random()" },
          query.sort,
          "order by ar.name asc, al.name asc, t.disc asc, t.track_no asc nulls last",
        )
      const playJoin = sql.literal(
        byPlayCount
          ? " left join (select track_id, count(*)::int as c from plays group by track_id) pc on pc.track_id = t.id"
          : "",
      )
      return Effect.map(
        Effect.all([
          sql`select ${sql.literal(CANONICAL_COLS(userId))} from canonical_tracks t
              join artists ar on ar.id = t.artist_id
              join albums al on al.id = t.album_id${playJoin}${where}
              ${sql.literal(order)} limit ${query.limit} offset ${query.offset}`,
          sql`select count(*)::int as n from canonical_tracks t
              join albums al on al.id = t.album_id${where}`,
        ]),
        ([rows, countRows]) => ({
          items: rows.map((row) => trackSummary(row as Record<string, unknown>)),
          total: num((countRows[0] as Record<string, unknown>).n),
        }),
      )
    }),

  byId: (id: string, userId = 0) =>
    Effect.flatMap(
      Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql`select ${sql.literal(TRACK_COLS(userId))} from tracks t
            join artists ar on ar.id = t.artist_id
            join albums al on al.id = t.album_id
            where t.id = ${id}::bigint`),
      (rows) => {
        const row = rows[0] as Record<string, unknown> | undefined
        return row === undefined
          ? Effect.fail(notFound("track", id))
          : Effect.succeed(trackSummary(row))
      },
    ),

  /** 槽位的全部物理副本（版本切换）：id 可以是槽内任意副本（canonical 与否皆可）；
   *  排序复刻 canonical 择优全序——首位即当前标准版本。path 一并带回（辨认来源） */
  ofVersions: (id: string, userId = 0) =>
    Effect.flatMap(
      Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql`select ${sql.literal(`${TRACK_COLS(userId)}, t.path`)} from tracks t
            join artists ar on ar.id = t.artist_id
            join albums al on al.id = t.album_id
            where t.album_id = (select album_id from tracks where id = ${id}::bigint)
              and t.disc = (select disc from tracks where id = ${id}::bigint)
              and lower(btrim(t.title)) = (select lower(btrim(title)) from tracks where id = ${id}::bigint)
            order by (t.codec in ('flac', 'alac', 'wv', 'ape', 'aiff', 'dsf', 'wav')) desc,
                     t.sample_rate_hz desc, t.bitrate_kbps desc,
                     length(t.path) asc, t.id asc`),
      (rows) => {
        const list = rows as ReadonlyArray<Record<string, unknown>>
        if (list.length === 0) return Effect.fail(notFound("track", id))
        return Effect.succeed(list.map((row) => trackSummary(row)))
      },
    ),

  random: (count: number, userId = 0) =>
    Effect.map(
      Effect.flatMap(SqlClient.SqlClient, (sql) =>
        // canonical：重复拷贝不给随机加权（同一专辑 6 份副本不该 6 倍概率被抽中）
        sql`select ${sql.literal(CANONICAL_COLS(userId))} from canonical_tracks t
            join artists ar on ar.id = t.artist_id
            join albums al on al.id = t.album_id
            order by random() limit ${count}`),
      (rows) => rows.map((row) => trackSummary(row as Record<string, unknown>)),
    ),
}

// ---- Genres ----

export const GenreRepo = {
  list: Effect.map(
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql`select genre, count(*)::int as album_count,
                 coalesce(sum(track_count), 0)::int as track_count
          from library_albums where genre is not null
          group by genre order by genre asc`),
    (rows) =>
      rows.map((row) => {
        const r = row as Record<string, unknown>
        return new Genre({
          name: String(r.genre),
          albumCount: num(r.album_count),
          trackCount: num(r.track_count),
        })
      }),
  ),
}
