import { Schema } from "effect"

/** 实体不存在（HTTP 404） */
export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {
  entity: Schema.String,
  id: Schema.String,
}, { httpApiStatus: 404 }) {}

export const notFound = (entity: string, id: string | number) =>
  new NotFound({ entity, id: String(id) })

/** 请求参数/语义非法（HTTP 422） */
export class BadRequest extends Schema.TaggedError<BadRequest>()("BadRequest", {
  message: Schema.String,
}, { httpApiStatus: 422 }) {}

/** 扫描正在进行中（HTTP 409） */
export class ScanInProgress extends Schema.TaggedError<ScanInProgress>()("ScanInProgress", {
  startedAt: Schema.String,
}, { httpApiStatus: 409 }) {}

/** 未认证 / 会话无效（HTTP 401） */
export class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", {
  message: Schema.optional(Schema.NullOr(Schema.String)),
}, { httpApiStatus: 401 }) {}

/** 已认证但权限不足（HTTP 403） */
export class Forbidden extends Schema.TaggedError<Forbidden>()("Forbidden", {
  message: Schema.optional(Schema.NullOr(Schema.String)),
}, { httpApiStatus: 403 }) {}

/** 资源冲突（HTTP 409），如用户名已存在 */
export class Conflict extends Schema.TaggedError<Conflict>()("Conflict", {
  message: Schema.String,
}, { httpApiStatus: 409 }) {}
