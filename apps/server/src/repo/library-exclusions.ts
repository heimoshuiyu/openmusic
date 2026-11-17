import type { SqlClient } from "effect/unstable/sql"

// Serialise only the short DB write phase of indexing/removal, never the disk walk.
export const lockFolderIndex = (sql: SqlClient.SqlClient, folder: number) =>
  sql`select pg_advisory_xact_lock(-${folder}::bigint)`
