import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Effect } from "effect"
import { NeteaseImports } from "../../service/netease/imports"
import { CurrentUser } from "../middleware/session"
import { Api } from "./index"

export const NeteaseApiLive = HttpApiBuilder.group(Api, "netease", Effect.fn(function* (handlers) {
  const imports = yield* NeteaseImports, uid = Effect.map(CurrentUser, u => Number(u.id))
  return handlers.handleAll({
    neteaseSearch: ({ query }) => Effect.flatMap(uid, id => imports.search(id, query.q)),
    neteaseStart: ({ payload }) => Effect.flatMap(uid, id => imports.start(id, payload.sessionID ?? "", payload.url, payload.folderId, payload.subdirectory ?? "")),
    neteaseFolders: () => imports.folders(),
    neteaseSubdirectories: ({ query }) => imports.children(query.folderId, query.subdirectory ?? ""),
    // 查看对任意登录用户开放（与 youtubeInfo 一致）；写操作在服务层核验导入者/管理员。
    neteaseInfo: ({ params }) => imports.info(params.id),
    neteaseEdit: ({ params, payload }) => Effect.flatMap(uid, user => imports.edit(user, params.id, payload)),
    neteaseUnindex: ({ params }) => Effect.flatMap(uid, user => imports.removals.unindex(user, params.id)),
    neteaseRequestDeletion: ({ params }) => Effect.flatMap(uid, user => imports.removals.request(user, params.id)),
    neteaseReviewDeletion: ({ params }) => Effect.flatMap(uid, user => imports.removals.preview(user, params.key)),
    neteaseConfirmDeletion: ({ params, payload }) => Effect.flatMap(uid, user => imports.removals.confirm(user, params.key, payload.token, payload.filename)),
    neteaseCancelDeletion: ({ params }) => Effect.flatMap(uid, user => imports.removals.cancel(user, params.key)),
  })
}))
