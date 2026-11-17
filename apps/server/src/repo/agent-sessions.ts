import { SqlClient } from "effect/unstable/sql"
import { Effect } from "effect"

type Sql = SqlClient.SqlClient

export interface AgentSessionRow {
  readonly id: string
  readonly ownerUserId: number
  readonly title: string
  readonly createdAt: string
}

const iso = (v: unknown): string => new Date(v as string).toISOString()

const toRow = (row: Record<string, unknown>): AgentSessionRow => ({
  id: String(row.id),
  ownerUserId: Number(row.owner_user_id),
  title: String(row.title ?? ""),
  createdAt: iso(row.created_at),
})

/** Agent 会话归属（docs/08 §4）：会话内容在宿主 sqlite，PG 只管归属 */
export const AgentSessionRepo = {
  /** 登记归属（幂等：同 id 重复登记以首任为准） */
  register: (ownerUserId: number, id: string, title: string) =>
    Effect.flatMap(SqlClient.SqlClient, (sql: Sql) =>
      sql`insert into agent_sessions (id, owner_user_id, title)
          values (${id}, ${ownerUserId}, ${title})
          on conflict (id) do nothing`),

  byId: (id: string) =>
    Effect.map(
      Effect.flatMap(SqlClient.SqlClient, (sql: Sql) =>
        sql`select * from agent_sessions where id = ${id}`),
      (rows) => {
        const row = (rows as ReadonlyArray<Record<string, unknown>>)[0]
        return row === undefined ? null : toRow(row)
      },
    ),

  /** Never create an ownership record from a host event. Returning the updated row also
   * resolves the SSE recipient even when title generation finishes after execution. */
  saveTitle: (id: string, title: string, onlyIfEmpty = false) => Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql`update agent_sessions
      set title = case when ${onlyIfEmpty}::boolean and title <> '' then title else ${title} end
      where id = ${id} returning *`
    return rows[0] ? toRow(rows[0]) : null
  }),

  /** 工具执行期身份解析：sessionID → 属主（未登记 → null，工具层报错） */
  ownerOf: (id: string) =>
    Effect.map(
      Effect.flatMap(SqlClient.SqlClient, (sql: Sql) =>
        sql`select owner_user_id from agent_sessions where id = ${id}`),
      (rows) => {
        const row = (rows as ReadonlyArray<Record<string, unknown>>)[0]
        return row === undefined ? null : Number(row.owner_user_id)
      },
    ),

  listFor: (ownerUserId: number, limit: number) =>
    Effect.map(
      Effect.flatMap(SqlClient.SqlClient, (sql: Sql) =>
        sql`select * from agent_sessions where owner_user_id = ${ownerUserId}
            order by created_at desc limit ${limit}`),
      (rows) => (rows as ReadonlyArray<Record<string, unknown>>).map(toRow),
    ),

  delete: (id: string) =>
    Effect.flatMap(SqlClient.SqlClient, (sql: Sql) =>
      sql`delete from agent_sessions where id = ${id}`),
}
