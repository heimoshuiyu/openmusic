import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi"

const del = HttpApiEndpoint.make("DELETE")
import { Schema } from "effect"
import { BadRequest, Forbidden, NotFound, ScanInProgress } from "../../domain/errors"
import { SessionAuth } from "../middleware/session"
import { SqlProvider } from "../middleware/sql"
import { MusicFolder, Timestamp } from "../../domain/media"

export const CreateFolderRequest = Schema.Struct({
  name: Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(200))),
  path: Schema.NonEmptyString,
})

export const RenameFolderRequest = Schema.Struct({
  name: Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(200))),
})

export class ScanStatusResponse extends Schema.Class<ScanStatusResponse>("ScanStatusResponse")({
  state: Schema.Literals(["idle", "scanning"]),
  /** 扫描子阶段（idle 时为 null）：walking=遍历磁盘，indexing=解析/入库 */
  phase: Schema.optional(Schema.NullOr(Schema.Literals(["walking", "indexing"]))),
  total: Schema.Number,
  processed: Schema.Number,
  startedAt: Schema.optional(Schema.NullOr(Timestamp)),
  lastScanAt: Schema.optional(Schema.NullOr(Timestamp)),
  errors: Schema.Array(Schema.String),
}) {}

export class LibraryGroup extends HttpApiGroup.make("library")
  .add(
    HttpApiEndpoint.get("folders", "/music-folders", {
      success: Schema.Array(MusicFolder),
    }),
  )
  .add(
    HttpApiEndpoint.post("createFolder", "/music-folders", {
      payload: CreateFolderRequest,
      success: MusicFolder,
      error: [BadRequest, Forbidden],
    }),
  )
  .add(
    HttpApiEndpoint.patch("renameFolder", "/music-folders/:id", {
      params: { id: Schema.String },
      payload: RenameFolderRequest,
      success: MusicFolder,
      error: [NotFound, Forbidden],
    }),
  )
  .add(
    del("deleteFolder", "/music-folders/:id", {
      params: { id: Schema.String },
      success: HttpApiSchema.NoContent,
      error: [NotFound, Forbidden],
    }),
  )
  .add(
    /** force=true 跳过 mtime 增量基线全量重解析（归组规则升级后修存量） */
    HttpApiEndpoint.post("scan", "/library/scan", {
      query: { force: Schema.optional(Schema.Boolean) },
      success: HttpApiSchema.NoContent,
      error: [ScanInProgress, Forbidden],
    }),
  )
  .add(
    /** 幂等取消进行中的扫描：已完成批次保留，重扫增量续上（docs/04 §2.7） */
    del("cancelScan", "/library/scan", {
      success: HttpApiSchema.NoContent,
      error: [Forbidden],
    }),
  )
  .add(
    HttpApiEndpoint.get("scanStatus", "/library/scan-status", {
      success: ScanStatusResponse,
    }),
  )
  .middleware(SessionAuth).middleware(SqlProvider)
  .prefix("/api/v1") {}
