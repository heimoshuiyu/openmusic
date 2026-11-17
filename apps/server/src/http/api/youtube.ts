import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Effect } from "effect"
import { YoutubeImports } from "../../service/youtube/imports"
import { CurrentUser } from "../middleware/session"
import { Api } from "./index"

export const YoutubeApiLive = HttpApiBuilder.group(Api,"youtube",Effect.fn(function* (handlers) {
  const imports=yield* YoutubeImports, uid=Effect.map(CurrentUser,u=>Number(u.id))
  return handlers.handleAll({
    youtubeListCaptions: ({payload}) => Effect.flatMap(uid,user=>imports.captions.list(user,payload)),
    youtubeReadCaptions: ({payload}) => Effect.flatMap(uid,user=>imports.captions.read(user,payload)),
    youtubeSearch: ({payload}) => Effect.flatMap(uid,id=>imports.search(id,payload.query)),
    youtubeStart: ({payload}) => Effect.flatMap(uid,id=>imports.start(id,payload.sessionID??"",payload.url,payload.folderId,payload.subdirectory??"",payload.metadata,payload.format)),
    youtubeCatalog: ({query}) => imports.catalog(query.q,query.country??"US"),
    youtubeInfo: ({params}) => imports.info(params.id),
    youtubeEdit: ({params,payload}) => Effect.flatMap(uid,user=>imports.edit(user,params.id,payload)),
    youtubeUnindex: ({params}) => Effect.flatMap(uid,user=>imports.removals.unindex(user,params.id)),
    youtubeRequestDeletion: ({params}) => Effect.flatMap(uid,user=>imports.removals.request(user,params.id)),
    youtubeReviewDeletion: ({params}) => Effect.flatMap(uid,user=>imports.removals.preview(user,params.key)),
    youtubeConfirmDeletion: ({params,payload}) => Effect.flatMap(uid,user=>imports.removals.confirm(user,params.key,payload.token,payload.filename)),
    youtubeCancelDeletion: ({params}) => Effect.flatMap(uid,user=>imports.removals.cancel(user,params.key)),
  })
}))
