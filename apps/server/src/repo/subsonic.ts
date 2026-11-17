import { SqlClient } from "effect/unstable/sql"
import { Effect } from "effect"
import { TRACK_GENRE } from "./metadata-overrides"

/**
 * Subsonic 层专用查询：带用户维度（starred/rating/playCount）的实体查询。
 * 返回原始行，属性映射在 http/subsonic/mappers.ts。
 */
const infra = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, Exclude<E, { readonly _tag: "SqlError" }>, R> =>
  Effect.catch(effect, (error) =>
    (error as { readonly _tag?: string })._tag === "SqlError"
      ? Effect.die(error)
      : Effect.fail(error as never)) as Effect.Effect<A, Exclude<E, { readonly _tag: "SqlError" }>, R>

type Sql = SqlClient.SqlClient

const SONG_COLS = (userId: number) => sqlLiteral(`
  t.id, t.title, t.disc, t.track_no, t.duration_seconds, t.bitrate_kbps, t.sample_rate_hz,
  t.channels, t.format, t.codec, t.size_bytes, t.path, t.created_at, t.track_no,
  ar.id as artist_id, ar.name as artist_name,
  al.id as album_id, al.name as album_name, al.year, ${TRACK_GENRE} as genre,
  (t.has_embedded_cover or al.cover_file is not null
   or exists(select 1 from tracks te where te.album_id = al.id and te.has_embedded_cover)) as has_cover,
  (select an.starred_at from annotations an
     where an.user_id = ${userId} and an.item_type = 'track' and an.item_id = t.id) as starred_at,
  (select an.rating from annotations an
     where an.user_id = ${userId} and an.item_type = 'track' and an.item_id = t.id) as rating,
  (select count(*)::int from plays p where p.user_id = ${userId} and p.track_id = t.id) as play_count
`)

function sqlLiteral(text: string) {
  return text.trim().replace(/\s+/g, " ")
}

const SONG_FROM = `from tracks t
  join artists ar on ar.id = t.artist_id
  join albums al on al.id = t.album_id`

/** 浏览面 song 列表（canonical_tracks 视图，docs/03 §2.5）：同槽位多副本只出一份
 *  最优——Feishin 的专辑页/流派/随机/搜索不再出现重复行。id 直查（songById）与
 *  播放列表等显式 id 引用必须走物理表（非 canonical 的 id 在视图里不存在） */
const SONG_LISTING_FROM = `from canonical_tracks t
  join artists ar on ar.id = t.artist_id
  join albums al on al.id = t.album_id`

const ALBUM_COLS = (userId: number) => sqlLiteral(`
  al.id, al.name, al.year, al.genre, al.track_count as song_count, al.duration_seconds,
  al.cover_file,
  (al.cover_file is not null or exists(
    select 1 from tracks te where te.album_id = al.id and te.has_embedded_cover)) as has_cover,
  al.created_at,
  ar.id as artist_id, ar.name as artist_name,
  (select an.starred_at from annotations an
     where an.user_id = ${userId} and an.item_type = 'album' and an.item_id = al.id) as starred_at,
  (select count(*)::int from plays p
     join tracks t2 on t2.id = p.track_id
     where p.user_id = ${userId} and t2.album_id = al.id) as play_count
`)

const ARTIST_COLS = (userId: number) => sqlLiteral(`
  a.id, a.name, a.album_count, a.cover_file,
  (select an.starred_at from annotations an
     where an.user_id = ${userId} and an.item_type = 'artist' and an.item_id = a.id) as starred_at
`)

export type Row = Record<string, unknown>

export const SubsonicRepo = {
  folders: Effect.map(
    infra(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`select id, name from music_folders order by id`)),
    (rows) => rows as ReadonlyArray<Row>,
  ),

  folderIdOfTrack: (trackId: number) =>
    Effect.map(
      infra(
        Effect.flatMap(SqlClient.SqlClient, (sql) =>
          sql`select music_folder_id::int as fid from tracks where id = ${trackId}`),
      ),
      (rows) => {
        const row = (rows as ReadonlyArray<Row>)[0]
        return row === undefined ? null : Number(row.fid)
      },
    ),

  /** song 查询们 */
  songById: (sql: Sql, userId: number, trackId: number) =>
    sql`select ${sql.literal(SONG_COLS(userId))} ${sql.literal(SONG_FROM)} where t.id = ${trackId}`,

  songsByAlbum: (sql: Sql, userId: number, albumId: number) =>
    sql`select ${sql.literal(SONG_COLS(userId))} ${sql.literal(SONG_LISTING_FROM)}
        where t.album_id = ${albumId}
        order by t.disc asc, t.track_no asc nulls last, t.title asc`,

  /** top-tracks：ORDER BY 走一次聚合 join（相关子查询排序 = 全表逐行探索引，大库秒级） */
  songsByArtistTop: (sql: Sql, userId: number, artistId: number, count: number) =>
    sql`select ${sql.literal(SONG_COLS(userId))} ${sql.literal(SONG_LISTING_FROM)}
        left join (select track_id, count(*)::int as c from plays
                   where user_id = ${userId} group by track_id) pc on pc.track_id = t.id
        where t.artist_id = ${artistId} or al.artist_id = ${artistId}
        order by coalesce(pc.c, 0) desc, t.title asc
        limit ${count}`,

  songsSimilar: (sql: Sql, userId: number, artistId: number, count: number) =>
    sql`select ${sql.literal(SONG_COLS(userId))} ${sql.literal(SONG_LISTING_FROM)}
        where (t.artist_id = ${artistId} or al.artist_id = ${artistId})
        order by random() limit ${count}`,

  songsByGenre: (sql: Sql, userId: number, genre: string, count: number, offset: number) =>
    sql`select ${sql.literal(SONG_COLS(userId))} ${sql.literal(SONG_LISTING_FROM)}
        where ${sql.literal(TRACK_GENRE)} = ${genre}
        order by ar.name asc, al.name asc, t.disc asc, t.track_no asc nulls last
        limit ${count} offset ${offset}`,

  songsRandom: (sql: Sql, userId: number, count: number, genre: string | null, fromYear: number | null, toYear: number | null) => {
    const conds: Array<string> = []
    const params: Array<unknown> = []
    if (genre !== null) {
      params.push(genre)
      conds.push(`${TRACK_GENRE} = $${params.length}`)
    }
    if (fromYear !== null) {
      params.push(fromYear)
      conds.push(`al.year >= $${params.length}`)
    }
    if (toYear !== null) {
      params.push(toYear)
      conds.push(`al.year <= $${params.length}`)
    }
    const where = conds.length === 0 ? "" : `where ${conds.join(" and ")}`
    return sql.unsafe(
      `select ${SONG_COLS(userId)} ${SONG_LISTING_FROM} ${where} order by random() limit ${count}`,
      params,
    )
  },

  songsByGenreCount: (sql: Sql, genre: string) =>
    sql`select count(*)::int as n from canonical_tracks t join albums al on al.id = t.album_id where ${sql.literal(TRACK_GENRE)} = ${genre}`,

  /** album 查询们 */
  albumById: (sql: Sql, userId: number, albumId: number) =>
    sql`select ${sql.literal(ALBUM_COLS(userId))} from library_albums al
        join artists ar on ar.id = al.artist_id
        where al.id = ${albumId}`,

  albumsByArtist: (sql: Sql, userId: number, artistId: number) =>
    sql`select ${sql.literal(ALBUM_COLS(userId))} from library_albums al
        join artists ar on ar.id = al.artist_id
        where al.artist_id = ${artistId}
        order by al.year asc nulls last, al.name asc`,

  albumsList: (
    sql: Sql,
    userId: number,
    type: string,
    size: number,
    offset: number,
    extra: { fromYear?: number | undefined; toYear?: number | undefined; genre?: string | undefined },
  ) => {
    const orders: Record<string, string> = {
      random: "order by random()",
      newest: "order by al.created_at desc",
      highest: "order by al.created_at desc",
      frequent: "order by play_count desc",
      recent: "order by play_count desc",
      starred: "",
      alphabeticalByName: "order by al.name asc",
      alphabeticalByArtist: "order by ar.name asc, al.name asc",
    }
    const params: Array<unknown> = []
    let where = ""
    if (type === "starred") {
      where = `where exists (select 1 from annotations an
        where an.user_id = ${userId} and an.item_type = 'album' and an.item_id = al.id and an.starred_at is not null)`
    } else if (type === "byYear") {
      where = `where al.year between ${extra.fromYear ?? 0} and ${extra.toYear ?? 9999}`
    } else if (type === "byGenre") {
      params.push(extra.genre ?? "")
      where = `where al.genre = $${params.length}`
    }
    const order = type === "starred"
      ? "order by (select starred_at from annotations an where an.user_id = "
        + `${userId} and an.item_type = 'album' and an.item_id = al.id) desc nulls last`
      : (orders[type] ?? "order by al.name asc")
    return sql.unsafe(
      `select ${ALBUM_COLS(userId)} from library_albums al join artists ar on ar.id = al.artist_id
       ${where} ${order} limit ${size} offset ${offset}`,
      params,
    )
  },

  /** artist 查询们 */
  artistsAll: (sql: Sql, userId: number) =>
    sql`select ${sql.literal(ARTIST_COLS(userId))} from artists a order by a.name asc`,

  artistById: (sql: Sql, userId: number, artistId: number) =>
    sql`select ${sql.literal(ARTIST_COLS(userId))} from artists a where a.id = ${artistId}`,

  /** starred 集合 */
  starredArtists: (sql: Sql, userId: number) =>
    sql`select ${sql.literal(ARTIST_COLS(userId))} from artists a
        where exists (select 1 from annotations an
          where an.user_id = ${userId} and an.item_type = 'artist' and an.item_id = a.id
            and an.starred_at is not null)
        order by a.name asc`,

  starredAlbums: (sql: Sql, userId: number) =>
    sql`select ${sql.literal(ALBUM_COLS(userId))} from library_albums al
        join artists ar on ar.id = al.artist_id
        where exists (select 1 from annotations an
          where an.user_id = ${userId} and an.item_type = 'album' and an.item_id = al.id
            and an.starred_at is not null)
        order by al.name asc`,

  starredSongs: (sql: Sql, userId: number) =>
    sql`select ${sql.literal(SONG_COLS(userId))} ${sql.literal(SONG_FROM)}
        where exists (select 1 from annotations an
          where an.user_id = ${userId} and an.item_type = 'track' and an.item_id = t.id
            and an.starred_at is not null)
        order by t.title asc`,

  /** search3：三路 ILIKE */
  searchArtists: (sql: Sql, userId: number, q: string, count: number, offset: number) =>
    sql`select ${sql.literal(ARTIST_COLS(userId))} from artists a
        where a.name ilike ${`%${q}%`}
        order by a.name asc limit ${count} offset ${offset}`,

  searchAlbums: (sql: Sql, userId: number, q: string, count: number, offset: number) =>
    sql`select ${sql.literal(ALBUM_COLS(userId))} from library_albums al
        join artists ar on ar.id = al.artist_id
        where al.name ilike ${`%${q}%`}
        order by al.name asc limit ${count} offset ${offset}`,

  searchSongs: (sql: Sql, userId: number, q: string, count: number, offset: number) =>
    sql`select ${sql.literal(SONG_COLS(userId))} ${sql.literal(SONG_LISTING_FROM)}
        where t.title ilike ${`%${q}%`}
        order by t.title asc limit ${count} offset ${offset}`,

  /** genres */
  genres: (sql: Sql) =>
    sql`select genre as value, coalesce(sum(track_count), 0)::int as song_count, count(*)::int as album_count
         from library_albums where genre is not null group by genre order by genre asc`,

  /** 虚拟目录（folder browsing）：SQL 侧只取当前层的行——
   *  此前把该 folder 全部 (id, path) 拉进 TS 建树，10 万曲目级每请求 5-10MB；
   *  下推后代价 = 该层子目录数/文件数。LIKE 前缀走 (music_folder_id, path) 索引 */
  dirChildDirs: (sql: Sql, folderId: number, rel: string) => {
    const prefix = rel === "" ? "" : `${rel}/`
    const start = prefix.length + 1
    return sql`select distinct split_part(substr(path, ${start}), '/', 1) as name from tracks
        where music_folder_id = ${folderId}
          and path like ${escapeLike(prefix)} || '%' escape '\\'
          and position('/' in substr(path, ${start})) > 0`
  },

  dirChildFiles: (sql: Sql, folderId: number, rel: string) => {
    const prefix = rel === "" ? "" : `${rel}/`
    const start = prefix.length + 1
    return sql`select id, path from tracks
        where music_folder_id = ${folderId}
          and path like ${escapeLike(prefix)} || '%' escape '\\'
          and position('/' in substr(path, ${start})) = 0
        order by path asc`
  },
}

/** LIKE 模式转义（\ % _）；escape '\' 声明在 SQL 侧 */
const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`)

export { infra }
