import { Effect, Result } from "effect"
import { PgTypes } from "@effect/sql-pg"
import type { SqlClient } from "effect/unstable/sql"

type Id = string | number | bigint
const idArray = (ids: readonly Id[]) => Result.getOrThrow(PgTypes.array([...new Set(ids.map(BigInt))], PgTypes.OID.int8))

/** Call inside the track mutation's transaction. Omit ids only at normal scanner finalization.
 * Lock parents before rechecking in a fresh statement: albums → tracks has ON DELETE CASCADE,
 * and another folder may have just indexed a version under the same album. */
export const reconcileAlbums = Effect.fnUntraced(function* (sql: SqlClient.SqlClient, ids?: readonly Id[]) {
  if (ids?.length === 0) return
  const scope = ids ? sql`a.id = any(${idArray(ids)})` : sql`not exists (select 1 from tracks t where t.album_id=a.id)`
  const locked = yield* sql<{id:string}>`select a.id from albums a where ${scope} order by a.id for update`
  if (!locked.length) return
  const affected = idArray(locked.map(r=>r.id))
  // Never change plays or move annotations to a similarly named album. An inactive
  // annotation (unstarred, no rating) isn't a reason to retain an otherwise unused id.
  yield* sql`with gone as (
    delete from albums a where a.id=any(${affected})
      and not exists (select 1 from tracks t where t.album_id=a.id)
      and not exists (select 1 from plays p where p.album_id=a.id)
      and not exists (select 1 from annotations n where n.item_type='album' and n.item_id=a.id
                      and (n.starred_at is not null or n.rating > 0)) returning id
  ) delete from annotations n using gone where n.item_type='album' and n.item_id=gone.id`
  yield* sql`update albums a set (track_count,duration_seconds)=(select count(*),coalesce(sum(t.duration_seconds),0)
             from canonical_tracks t where t.album_id=a.id) where a.id=any(${affected})`
})

export const refreshTrackArtists = (sql: SqlClient.SqlClient, ids: readonly Id[]) =>
  ids.length ? sql`update artists a set (album_count,track_count)=(select count(distinct t.album_id),count(*)
                   from canonical_tracks t where t.artist_id=a.id) where a.id=any(${idArray(ids)})` : Effect.void
