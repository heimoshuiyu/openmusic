import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { BadRequest, NotFound } from "../../domain/errors"
import { NeteaseCandidate, NeteaseDeleteRequest, NeteaseDeleteReview, NeteaseImportResult, NeteaseInfo, NeteaseTags } from "../../domain/netease"
import { SessionAuth } from "../middleware/session"

const sessionID = Schema.optional(Schema.String.pipe(Schema.check(Schema.isMaxLength(180))))

const NeteaseFolder = Schema.Struct({ id: Schema.String, name: Schema.String, path: Schema.String, writable: Schema.Boolean })
const NeteaseChildren = Schema.Struct({ directories: Schema.Array(Schema.String), truncated: Schema.Boolean })

export class NeteaseGroup extends HttpApiGroup.make("netease")
  .add(HttpApiEndpoint.get("neteaseSearch", "/search", { query: { q: Schema.NonEmptyString }, success: Schema.Array(NeteaseCandidate), error: BadRequest }))
  .add(HttpApiEndpoint.post("neteaseStart", "/requests", { payload: Schema.Struct({ url: Schema.NonEmptyString, folderId: Schema.NonEmptyString, subdirectory: Schema.optional(Schema.String), sessionID }), success: NeteaseImportResult, error: [BadRequest, NotFound] }))
  // 目录选择（与 youtube MCP 的 list_folders/list_subdirectories 同源服务方法）
  .add(HttpApiEndpoint.get("neteaseFolders", "/folders", { success: Schema.Array(NeteaseFolder), error: [BadRequest, NotFound] }))
  .add(HttpApiEndpoint.get("neteaseSubdirectories", "/subdirectories", { query: { folderId: Schema.String, subdirectory: Schema.optional(Schema.String) }, success: NeteaseChildren, error: [BadRequest, NotFound] }))
  // 曲目管理：查看/编辑/移出库/物理删除票据（语义与 youtube 组对齐，见 docs/04 网易云导入组）
  .add(HttpApiEndpoint.get("neteaseInfo", "/tracks/:id/metadata", { params: { id: Schema.String }, success: NeteaseInfo, error: [BadRequest, NotFound] }))
  .add(HttpApiEndpoint.patch("neteaseEdit", "/tracks/:id/metadata", { params: { id: Schema.String }, payload: NeteaseTags, success: NeteaseInfo, error: [BadRequest, NotFound] }))
  .add(HttpApiEndpoint.make("DELETE")("neteaseUnindex", "/tracks/:id/library-entry", { params: { id: Schema.String }, success: HttpApiSchema.NoContent, error: [BadRequest, NotFound] }))
  .add(HttpApiEndpoint.post("neteaseRequestDeletion", "/tracks/:id/file-deletion-requests", { params: { id: Schema.String }, success: NeteaseDeleteRequest, error: [BadRequest, NotFound] }))
  .add(HttpApiEndpoint.post("neteaseReviewDeletion", "/file-deletion-requests/:key/review", { params: { key: Schema.String }, success: NeteaseDeleteReview, error: NotFound }))
  .add(HttpApiEndpoint.post("neteaseConfirmDeletion", "/file-deletion-requests/:key/confirm", { params: { key: Schema.String }, payload: Schema.Struct({ token: Schema.String, filename: Schema.String }), success: HttpApiSchema.NoContent, error: [BadRequest, NotFound] }))
  .add(HttpApiEndpoint.make("DELETE")("neteaseCancelDeletion", "/file-deletion-requests/:key", { params: { key: Schema.String }, success: HttpApiSchema.NoContent, error: NotFound }))
  .middleware(SessionAuth).prefix("/api/v1/imports/netease") {}
