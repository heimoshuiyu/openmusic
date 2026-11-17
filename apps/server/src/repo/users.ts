import { SqlClient } from "effect/unstable/sql"
import { Effect, Option } from "effect"
import { notFound } from "../domain/errors"
import { UserPublic } from "../domain/user"
import { page } from "../domain/media"

export interface UserRow {
  id: string | number
  username: string
  password_hash: string
  subsonic_token_seed: string
  is_admin: boolean
  created_at: string | Date
  last_seen_at: string | Date | null
}

const iso = (v: unknown): string => new Date(v as string).toISOString()
const num = (v: unknown): number => Number(v ?? 0)

export const toUserPublic = (row: UserRow): UserPublic =>
  new UserPublic({
    id: String(row.id),
    username: row.username,
    isAdmin: row.is_admin,
    createdAt: iso(row.created_at),
    lastSeenAt: row.last_seen_at === null ? null : iso(row.last_seen_at),
  })

const USER_COLS = "id, username, password_hash, subsonic_token_seed, is_admin, created_at, last_seen_at"

export const UserRepo = {
  count: Effect.map(
    Effect.flatMap(SqlClient.SqlClient, (sql) => sql`select count(*)::int as n from users`),
    (rows) => Number((rows[0] as Record<string, unknown>).n),
  ),

  findByUsername: (username: string) =>
    Effect.map(
      Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql`select ${sql.literal(USER_COLS)} from users where username = ${username}`),
      (rows) => {
        const row = rows[0] as UserRow | undefined
        return row === undefined ? Option.none<UserRow>() : Option.some(row)
      },
    ),

  byId: (id: string) =>
    Effect.flatMap(
      Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql`select ${sql.literal(USER_COLS)} from users where id = ${id}::bigint`),
      (rows) => {
        const row = rows[0] as UserRow | undefined
        return row === undefined
          ? Effect.fail(notFound("user", id))
          : Effect.succeed(toUserPublic(row))
      },
    ),

  list: (query: { limit: number; offset: number }) =>
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      Effect.map(
        Effect.all([
          sql`select ${sql.literal(USER_COLS)} from users order by id limit ${query.limit} offset ${query.offset}`,
          sql`select count(*)::int as n from users`,
        ]),
        ([rows, countRows]) => {
          const items = rows.map((row) => toUserPublic(row as unknown as UserRow))
          return page(items, num((countRows[0] as Record<string, unknown>).n), query.offset, query.limit)
        },
      )),

  create: (input: { username: string; passwordHash: string; secret: string; isAdmin: boolean }) =>
    Effect.map(
      Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql`insert into users (username, password_hash, subsonic_token_seed, is_admin)
            values (${input.username}, ${input.passwordHash}, ${input.secret}, ${input.isAdmin})
            returning ${sql.literal(USER_COLS)}`),
      (rows) => toUserPublic(rows[0] as unknown as UserRow),
    ),

  setPassword: (id: string, passwordHash: string, secret: string) =>
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql`update users set password_hash = ${passwordHash}, subsonic_token_seed = ${secret}
          where id = ${id}::bigint`),

  setRole: (id: string, isAdmin: boolean) =>
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql`update users set is_admin = ${isAdmin} where id = ${id}::bigint`),

  delete: (id: string) =>
    Effect.flatMap(
      Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql`delete from users where id = ${id}::bigint returning id`),
      (rows) => rows.length === 0 ? Effect.fail(notFound("user", id)) : Effect.void,
    ),

  // ---- sessions ----

  createSession: (input: { token: string; userId: number; expiresAt: Date; userAgent: string | null }) =>
    Effect.flatMap(
      SqlClient.SqlClient,
      (sql) => sql`insert into sessions (token, user_id, expires_at, user_agent)
        values (${input.token}, ${input.userId}, ${input.expiresAt.toISOString()}, ${input.userAgent})`,
    ),

  findSession: (token: string) =>
    Effect.map(
      Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql`select s.token, s.expires_at,
              u.id, u.username, u.password_hash, u.subsonic_token_seed, u.is_admin, u.created_at, u.last_seen_at
            from sessions s join users u on u.id = s.user_id
            where s.token = ${token}`),
      (rows) => {
        const row = rows[0] as
          | (Record<string, unknown> & { token: string; expires_at: string })
          | undefined
        if (row === undefined) return Option.none()
        const user: UserRow = {
          id: row.id as string,
          username: row.username as string,
          password_hash: row.password_hash as string,
          subsonic_token_seed: row.subsonic_token_seed as string,
          is_admin: row.is_admin as boolean,
          created_at: row.created_at as string,
          last_seen_at: (row.last_seen_at as string | null) ?? null,
        }
        return Option.some({ token: row.token, user, expiresAt: new Date(row.expires_at) })
      },
    ),

  extendSession: (token: string, expiresAt: Date) =>
    Effect.flatMap(
      SqlClient.SqlClient,
      (sql) => sql`update sessions set expires_at = ${expiresAt.toISOString()} where token = ${token}`,
    ),

  /** SSE: check the original grant before writing; receiving traffic must not extend its TTL. */
  sessionActive: (token: string, userId: string) => Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql`select 1 from sessions where token = ${token} and user_id = ${userId}::bigint and expires_at > now()`
    return rows.length !== 0
  }),

  deleteSession: (token: string) =>
    Effect.flatMap(SqlClient.SqlClient, (sql) => sql`delete from sessions where token = ${token}`),

  deleteExpiredSessions: Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`delete from sessions where expires_at < now()`,
  ),

  touchLastSeen: (userId: number) =>
    Effect.flatMap(
      SqlClient.SqlClient,
      (sql) => sql`update users set last_seen_at = now() where id = ${userId}`,
    ),
}
