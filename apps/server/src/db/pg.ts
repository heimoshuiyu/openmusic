import { PgClient } from "@effect/sql-pg"
import { SqlClient } from "effect/unstable/sql"
import { Config, Layer, Redacted } from "effect"

/** PostgreSQL 客户端 Layer（@effect/sql-pg，node-postgres 驱动） */
export const PgLive = PgClient.layerConfig(
  Config.map(
    Config.String("DATABASE_URL"),
    (url) => ({ url: Redacted.make(url) }),
  ),
)

export { SqlClient }
