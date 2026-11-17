import { HttpApiBuilder } from "effect/unstable/httpapi"
import { SqlClient } from "effect/unstable/sql"
import { Effect } from "effect"
import { SERVER_NAME, SERVER_VERSION } from "@openmusic/shared"
import { SystemHealth, SystemVersionInfo } from "./system-schema"
import { Api } from "./index"

export const SystemApiLive = HttpApiBuilder.group(Api, "system", Effect.fn(function* (handlers) {
  return handlers.handleAll({
    health: () =>
      Effect.as(
        Effect.flatMap(SqlClient.SqlClient, (sql) => sql`select 1`).pipe(Effect.orDie),
        new SystemHealth({ status: "ok", version: SERVER_VERSION, db: "ok" }),
      ),
    version: () =>
      Effect.succeed(new SystemVersionInfo({ name: SERVER_NAME, version: SERVER_VERSION })),
  })
}))
