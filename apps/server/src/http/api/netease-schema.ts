import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { BadRequest, NotFound } from "../../domain/errors"
import { NeteaseCandidate, NeteaseImportResult } from "../../domain/netease"
import { SessionAuth } from "../middleware/session"

const sessionID = Schema.optional(Schema.String.pipe(Schema.check(Schema.isMaxLength(180))))

export class NeteaseGroup extends HttpApiGroup.make("netease")
  .add(HttpApiEndpoint.get("neteaseSearch", "/search", { query: { q: Schema.NonEmptyString }, success: Schema.Array(NeteaseCandidate), error: BadRequest }))
  .add(HttpApiEndpoint.post("neteaseStart", "/requests", { payload: Schema.Struct({ url: Schema.NonEmptyString, folderId: Schema.NonEmptyString, subdirectory: Schema.optional(Schema.String), sessionID }), success: NeteaseImportResult, error: [BadRequest, NotFound] }))
  .middleware(SessionAuth).prefix("/api/v1/imports/netease") {}
