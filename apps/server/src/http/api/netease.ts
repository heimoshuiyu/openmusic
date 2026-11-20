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
  })
}))
