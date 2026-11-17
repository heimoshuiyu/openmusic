import { SqlClient } from "effect/unstable/sql"
import { Effect } from "effect"
import { UNKNOWN_ALBUM, UNKNOWN_ARTIST } from "@openmusic/shared"

export type AnnotationItemType = "artist" | "album" | "track"

/** infra：SqlError die（500），域错误由上层处理 */
const infra = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, Exclude<E, { readonly _tag: "SqlError" }>, R> =>
  Effect.catch(effect, (error) =>
    (error as { readonly _tag?: string })._tag === "SqlError"
      ? Effect.die(error)
      : Effect.fail(error as never)) as Effect.Effect<A, Exclude<E, { readonly _tag: "SqlError" }>, R>

export const AnnotationRepo = {
  /** 收藏写入口的槽位归一：track 收藏落在槽位的 canonical 代表上——收藏的
   *  语义是「这首歌」而不是「这个文件副本」，canonical 换人（扫进更优拷贝）
   *  时星标自动跟随；对任意副本收藏/取消都命中同一行 */
  canonicalizeTrackIds: (sql: SqlClient.SqlClient, itemIds: ReadonlyArray<number>) =>
    Effect.map(
      sql`select t.id as orig, c.id as canon
          from tracks t
          join canonical_tracks c
            on c.album_id = t.album_id and c.disc = t.disc
            and lower(btrim(c.title)) = lower(btrim(t.title))
          where t.id in ${sql.in(itemIds)}`,
      (rows) => {
        const map = new Map(
          (rows as ReadonlyArray<{ orig: string | number; canon: string | number }>).map(
            (r) => [Number(r.orig), Number(r.canon)],
          ),
        )
        return itemIds.map((id) => map.get(id) ?? id)
      },
    ),

  star: (userId: number, itemType: AnnotationItemType, itemIds: ReadonlyArray<number>) =>
    infra(
      Effect.flatMap(
        SqlClient.SqlClient,
        (sql) =>
          Effect.flatMap(
            itemType === "track"
              ? AnnotationRepo.canonicalizeTrackIds(sql, itemIds)
              : Effect.succeed(itemIds),
            (ids) =>
              Effect.forEach(ids, (itemId) =>
                sql`insert into annotations (user_id, item_type, item_id, starred_at)
                    ${itemType === "album"
                      ? sql`select ${userId}, 'album', a.id, now() from (select id from albums where id=${itemId} for key share) a`
                      : sql`values (${userId}, ${itemType}, ${itemId}, now())`}
                    on conflict (user_id, item_type, item_id)
                    do update set starred_at = now()`, { discard: true }),
          ),
      ),
    ),

  unstar: (userId: number, itemType: AnnotationItemType, itemIds: ReadonlyArray<number>) =>
    infra(
      Effect.flatMap(
        SqlClient.SqlClient,
        (sql) =>
          Effect.flatMap(
            itemType === "track"
              ? AnnotationRepo.canonicalizeTrackIds(sql, itemIds)
              : Effect.succeed(itemIds),
            (ids) =>
              Effect.forEach(ids, (itemId) =>
                sql`update annotations set starred_at = null
                    where user_id = ${userId} and item_type = ${itemType} and item_id = ${itemId}`,
                { discard: true }),
          ),
      ),
    ),

  setRating: (userId: number, itemType: AnnotationItemType, itemId: number, rating: number) =>
    infra(
      Effect.flatMap(
        SqlClient.SqlClient,
        (sql) =>
          Effect.flatMap(
            itemType === "track"
              ? AnnotationRepo.canonicalizeTrackIds(sql, [itemId])
              : Effect.succeed([itemId] as ReadonlyArray<number>),
            (ids) =>
               sql`insert into annotations (user_id, item_type, item_id, rating)
                   ${itemType === "album"
                     ? sql`select ${userId}, 'album', a.id, ${rating} from (select id from albums where id=${ids[0]!} for key share) a`
                     : sql`values (${userId}, ${itemType}, ${ids[0]!}, ${rating})`}
                  on conflict (user_id, item_type, item_id)
                  do update set rating = nullif(${rating}, 0)`,
          ),
      ),
    ),

  /** 批量取某用户的注解（starred/rating），供列表查询拼接 */
  mapFor: (userId: number, itemType: AnnotationItemType, itemIds: ReadonlyArray<number>) =>
    Effect.map(
      infra(
        Effect.flatMap(SqlClient.SqlClient, (sql) =>
          itemIds.length === 0
            ? Effect.succeed([])
            : sql`select item_id, starred_at, rating from annotations
                  where user_id = ${userId} and item_type = ${itemType}
                    and item_id in ${sql.in(itemIds)} and (starred_at is not null or rating is not null)`),
      ),
      (rows) => {
        const map = new Map<number, { starredAt: string | null; rating: number | null }>()
        for (const row of rows as ReadonlyArray<Record<string, unknown>>) {
          map.set(Number(row.item_id), {
            starredAt: row.starred_at === null ? null : new Date(row.starred_at as string).toISOString(),
            rating: row.rating === null ? null : Number(row.rating),
          })
        }
        return map
      },
    ),

  /** 某用户收藏的 id 列表（分页；exists 过滤已被重扫清掉的孤儿注解） */
  starredIds: (userId: number, itemType: AnnotationItemType, limit: number, offset: number) => {
    const table = itemType === "track" ? "tracks" : itemType === "album" ? "library_albums" : "artists"
    return Effect.map(
      infra(
        Effect.flatMap(SqlClient.SqlClient, (sql) =>
          Effect.all([
            sql`select item_id from annotations
                where user_id = ${userId} and item_type = ${itemType} and starred_at is not null
                  and exists (select 1 from ${sql.literal(table)} x where x.id = item_id)
                order by starred_at desc limit ${limit} offset ${offset}`,
            sql`select count(*)::int as n from annotations
                where user_id = ${userId} and item_type = ${itemType} and starred_at is not null
                  and exists (select 1 from ${sql.literal(table)} x where x.id = item_id)`,
          ])),
      ),
      ([rows, countRows]) => ({
        ids: (rows as ReadonlyArray<Record<string, unknown>>).map((row) => Number(row.item_id)),
        total: Number((countRows[0] as Record<string, unknown>).n),
      }),
    )
  },
}

export type MostPlayedType = "track" | "album" | "artist"
export type StatsPeriod = "all" | "month" | "year"

export interface PlayStatRow {
  readonly id: string
  readonly playCount: number
  readonly listenedSeconds: number
}

export const PlayRepo = {
  /** 落库一次播放；10 秒窗口去重（docs/03 §2.7），返回是否真的插入。
   *  打点即快照：曲目死掉后叙事与统计身份都留在事件行上（docs/03 §2.7 墓碑设计）；
   *  from 双 join 使无效 trackId 不落行（返回 false，不触发 FK 违例） */
  record: (userId: number, trackId: number, playedAt: Date, listenedSeconds?: number | undefined) =>
    Effect.map(
      infra(
        Effect.flatMap(SqlClient.SqlClient, (sql) => {
          const iso = playedAt.toISOString()
          return sql`insert into plays (user_id, track_id, played_at, listened_seconds,
                          title, artist_name, album_name, duration_seconds, artist_id, album_id)
              select ${userId}, t.id, ${iso}::timestamptz, ${listenedSeconds ?? null},
                     t.title, ar.name, al.name, t.duration_seconds, ar.id, al.id
              from tracks t
                join albums al on al.id = t.album_id
                join artists ar on ar.id = t.artist_id
              where t.id = ${trackId}
                and not exists (
                  select 1 from plays
                  where user_id = ${userId} and track_id = ${trackId}
                    and played_at between ${iso}::timestamptz - interval '10 seconds'
                                      and ${iso}::timestamptz + interval '10 seconds')
              returning id`
        }),
      ),
      (rows) => (rows as ReadonlyArray<unknown>).length > 0,
    ),

  /** 最近播放（含墓碑行）：trackId null = 曲目已不在库中，快照列承载叙事 */
  recent: (userId: number, limit: number, distinct?: "track", offset = 0) =>
    Effect.map(
      infra(
        Effect.flatMap(SqlClient.SqlClient, (sql) => {
          const events = sql`select id, track_id, played_at, title, artist_name, album_name, duration_seconds
                             from plays where user_id = ${userId}`
          // Keep the latest physical track, never match live tracks by title. Once the FK is
          // gone, only the event snapshot is available to distinguish deleted songs.
          const latest = distinct === "track" ? sql`
            select distinct on (track_id, tombstone) * from (
              select e.*, case when track_id is null then row(title, artist_name, album_name, duration_seconds) end as tombstone
              from (${events}) e
            ) keyed order by track_id, tombstone, played_at desc, id desc` : events
          return sql`select track_id, played_at, title, artist_name, album_name, duration_seconds
                     from (${latest}) p order by played_at desc, id desc limit ${limit} offset ${offset}`
        }),
      ),
      (rows) =>
        (rows as ReadonlyArray<Record<string, unknown>>).map((row) => ({
          trackId: row.track_id === null ? null : Number(row.track_id),
          playedAt: new Date(row.played_at as string).toISOString(),
          title: (row.title as string | null) ?? "未知曲目",
          artistName: (row.artist_name as string | null) ?? "未知艺人",
          albumName: (row.album_name as string | null) ?? "未知专辑",
          durationSeconds: Number(row.duration_seconds ?? 0),
        })),
    ),

  /** 最常播放（docs/04 §2.8）：count 降序，并列时最近听过的在前；归因见 docs/03 §2.7。
   *  分组键直接用事件行快照：artist_id/album_id 是自然键 upsert 的稳定身份，
   *  不随曲目生死/目录重登记漂移；track 型过滤墓碑（导航面不显示死行）。
   *  album/artist 型排除兜底身份（Unknown Album/Unknown Artist）：散文件聚合体没有
   *  专辑/艺人语义，进榜即统计噪音（track 型与 summary 不排——收听时长是真实事实） */
  mostPlayed: (userId: number, type: MostPlayedType, period: StatsPeriod, limit: number) => {
    const groupCol = type === "track" ? "p.track_id" : type === "album" ? "p.album_id" : "p.artist_id"
    const trackFilter = type === "track" ? " and p.track_id is not null" : ""
    const periodClauses: Record<StatsPeriod, string> = {
      all: "",
      month: " and p.played_at >= now() - interval '30 days'",
      year: " and p.played_at >= now() - interval '365 days'",
    }
    return Effect.map(
      infra(
        Effect.flatMap(SqlClient.SqlClient, (sql) => {
          const unknownFilter = type === "album"
            ? sql` and exists (select 1 from library_albums x where x.id = p.album_id and x.name <> ${UNKNOWN_ALBUM})`
            : type === "artist"
              ? sql` and not exists (select 1 from artists x where x.id = p.artist_id and x.name = ${UNKNOWN_ARTIST})`
              : sql``
          return sql`select ${sql.literal(groupCol)} as id, count(*)::int as play_count,
                     sum(coalesce(p.listened_seconds, p.duration_seconds, 0))::bigint as listened_seconds
              from plays p
              where p.user_id = ${userId}${unknownFilter}${sql.literal(periodClauses[period] + trackFilter)}
              group by ${sql.literal(groupCol)}
              order by count(*) desc, max(p.played_at) desc
              limit ${limit}`
        }),
      ),
      (rows) =>
        (rows as ReadonlyArray<Record<string, unknown>>).map((row) => ({
          id: String(row.id),
          playCount: Number(row.play_count),
          listenedSeconds: Number(row.listened_seconds ?? 0),
        })) as ReadonlyArray<PlayStatRow>,
    )
  },

  /** 听歌汇总：不再 join tracks——曲目死掉的打点凭行上快照计入，
   *  累计收听因此单调不回退（listened_seconds 优先，缺省按快照时长估算） */
  summary: (userId: number) =>
    Effect.map(
      infra(
        Effect.flatMap(SqlClient.SqlClient, (sql) =>
          sql`select count(*)::int as plays, count(distinct p.track_id)::int as tracks,
                     coalesce(sum(coalesce(p.listened_seconds, p.duration_seconds, 0)), 0)::bigint as listened_seconds
              from plays p
              where p.user_id = ${userId}`),
      ),
      (rows) => {
        const row = rows[0] as Record<string, unknown>
        return {
          plays: Number(row?.plays ?? 0),
          tracks: Number(row?.tracks ?? 0),
          listenedSeconds: Number(row?.listened_seconds ?? 0),
        }
      },
    ),

  /** 收听画像（A3，docs/08 §6）：一次聚合出注入 agent instruction 槽位的 JSON 值。
   *  **hash 稳定性纪律**：结构键名固定、数组定长上限、不含绝对时间戳——
   *  口味与行为没变 → 序列化字节相同 → 宿主槽位 diff 为空 → 零 token 零缓存影响；
   *  只有真实的收听行为变化（新播放/榜位变动）才产生一条 supersede 增量。 */
  profile: (userId: number) =>
    Effect.map(
      infra(
        Effect.flatMap(SqlClient.SqlClient, (sql) =>
          Effect.all([
            sql`select ar.name, count(*)::int as plays
                from plays p join artists ar on ar.id = p.artist_id
                where p.user_id = ${userId} and p.played_at >= now() - interval '30 days'
                group by ar.name order by count(*) desc, ar.name asc limit 5`,
            sql`select al.name, ar.name as artist, count(*)::int as plays
                from plays p join albums al on al.id = p.album_id join artists ar on ar.id = al.artist_id
                where p.user_id = ${userId} and p.played_at >= now() - interval '30 days'
                group by al.name, ar.name order by count(*) desc, al.name asc limit 5`,
            sql`select p.title, p.artist_name, count(*)::int as plays
                from plays p
                where p.user_id = ${userId} and p.track_id is not null
                group by p.title, p.artist_name order by count(*) desc, p.artist_name asc limit 8`,
            sql`select p.title, p.artist_name from plays p
                where p.user_id = ${userId} order by p.played_at desc limit 8`,
            sql`select count(*)::int as plays,
                       coalesce(sum(coalesce(p.listened_seconds, p.duration_seconds, 0)), 0)::bigint as listened_seconds
                from plays p where p.user_id = ${userId}`,
            sql`select (select count(*)::int from canonical_tracks) as tracks,
                       (select count(*)::int from library_albums) as albums,
                       (select count(*)::int from artists) as artists`,
          ]),
        ),
      ),
      ([artists30d, albums30d, tracksAll, recent, summaryRows, libraryRows]) => {
        const summary = (summaryRows as ReadonlyArray<Record<string, unknown>>)[0] ?? {}
        const library = (libraryRows as ReadonlyArray<Record<string, unknown>>)[0] ?? {}
        return {
          topArtists30d: (artists30d as ReadonlyArray<Record<string, unknown>>).map((r) => ({
            name: String(r.name), plays: Number(r.plays),
          })),
          topAlbums30d: (albums30d as ReadonlyArray<Record<string, unknown>>).map((r) => ({
            name: String(r.name), artist: String(r.artist), plays: Number(r.plays),
          })),
          topTracksAllTime: (tracksAll as ReadonlyArray<Record<string, unknown>>).map((r) => ({
            title: String(r.title), artist: String(r.artist_name), plays: Number(r.plays),
          })),
          recentTitles: (recent as ReadonlyArray<Record<string, unknown>>).map((r) => ({
            title: String(r.title), artist: String(r.artist_name),
          })),
          summary: {
            plays: Number(summary.plays ?? 0),
            listenedHours: Math.round(Number(summary.listened_seconds ?? 0) / 360) / 10,
          },
          library: {
            tracks: Number(library.tracks ?? 0),
            albums: Number(library.albums ?? 0),
            artists: Number(library.artists ?? 0),
          },
        }
      },
    ),

  countsFor: (userId: number, trackIds: ReadonlyArray<number>) =>
    Effect.map(
      infra(
        Effect.flatMap(SqlClient.SqlClient, (sql) =>
          trackIds.length === 0
            ? Effect.succeed([])
            : sql`select track_id, count(*)::int as n from plays
                  where user_id = ${userId} and track_id in ${sql.in(trackIds)}
                  group by track_id`),
      ),
      (rows) => {
        const map = new Map<number, number>()
        for (const row of rows as ReadonlyArray<Record<string, unknown>>) {
          map.set(Number(row.track_id), Number(row.n))
        }
        return map
      },
    ),

  playCountAll: (userId: number, trackId: number) =>
    Effect.map(
      infra(
        Effect.flatMap(SqlClient.SqlClient, (sql) =>
          sql`select count(*)::int as n from plays where user_id = ${userId} and track_id = ${trackId}`),
      ),
      (rows) => Number((rows[0] as Record<string, unknown>).n),
    ),
}
