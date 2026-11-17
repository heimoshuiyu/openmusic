import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import type { MetadataOverrides } from "../domain/metadata-overrides"

/** Track-level queries alias tracks/canonical_tracks as t and albums as al. Album lists still use al.genre. */
export const TRACK_GENRE = `coalesce((select o.fields->>'genre' from track_metadata_overrides o where o.track_id=t.id), al.genre)`

/** One query per folder (inference) or write batch (recheck under folder lock), not per track. */
export const loadOverrides = (sql: SqlClient.SqlClient, folder: number, paths?: readonly string[]) =>
  Effect.map(sql<{path:string; fields:MetadataOverrides; revision:string}>`
    select t.path, o.fields, o.track_id::text || ':' || o.xmin::text as revision
    from track_metadata_overrides o join tracks t on t.id=o.track_id
    where t.music_folder_id=${folder} ${paths ? sql`and t.path in ${sql.in(paths)}` : sql``}`,
  rows => new Map(rows.map(r => [r.path, r])))

export const saveOverrides = (sql: SqlClient.SqlClient, id: string, patch: MetadataOverrides) =>
  sql`insert into track_metadata_overrides(track_id,fields) values (${id},${JSON.stringify(patch)}::jsonb)
      on conflict(track_id) do update set fields=track_metadata_overrides.fields || excluded.fields`
