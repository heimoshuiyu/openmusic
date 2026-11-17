import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { BadRequest, NotFound } from "../../domain/errors"
import { CaptionSource, CaptionRead, CaptionList, CaptionPage, CatalogMatch, DeleteRequest, DeleteReview, ImportResult, YoutubeFormat, YoutubeInfo, YoutubeTags } from "../../domain/youtube"
import { SessionAuth } from "../middleware/session"

const sessionID=Schema.optional(Schema.String.pipe(Schema.check(Schema.isMaxLength(180))))
export class YoutubeGroup extends HttpApiGroup.make("youtube")
  .add(HttpApiEndpoint.post("youtubeListCaptions","/captions/list",{payload:CaptionSource,success:CaptionList,error:[BadRequest,NotFound]}))
  .add(HttpApiEndpoint.post("youtubeReadCaptions","/captions/read",{payload:CaptionRead,success:CaptionPage,error:[BadRequest,NotFound]}))
  .add(HttpApiEndpoint.post("youtubeSearch","/search",{payload:Schema.Struct({query:Schema.NonEmptyString}),success:Schema.Array(Schema.Struct({title:Schema.String,channel:Schema.String,url:Schema.String})),error:BadRequest}))
  .add(HttpApiEndpoint.post("youtubeStart","/requests",{payload:Schema.Struct({url:Schema.NonEmptyString,folderId:Schema.NonEmptyString,subdirectory:Schema.optional(Schema.String),metadata:Schema.optional(YoutubeTags),format:Schema.optional(YoutubeFormat),sessionID}),success:ImportResult,error:[BadRequest,NotFound]}))
  .add(HttpApiEndpoint.get("youtubeCatalog","/catalog",{query:{q:Schema.NonEmptyString,country:Schema.optional(Schema.String)},success:Schema.Array(CatalogMatch),error:BadRequest}))
  .add(HttpApiEndpoint.get("youtubeInfo","/tracks/:id/metadata",{params:{id:Schema.String},success:YoutubeInfo,error:[BadRequest,NotFound]}))
  .add(HttpApiEndpoint.patch("youtubeEdit","/tracks/:id/metadata",{params:{id:Schema.String},payload:YoutubeTags,success:YoutubeInfo,error:[BadRequest,NotFound]}))
  .add(HttpApiEndpoint.make("DELETE")("youtubeUnindex","/tracks/:id/library-entry",{params:{id:Schema.String},success:HttpApiSchema.NoContent,error:[BadRequest,NotFound]}))
  .add(HttpApiEndpoint.post("youtubeRequestDeletion","/tracks/:id/file-deletion-requests",{params:{id:Schema.String},success:DeleteRequest,error:[BadRequest,NotFound]}))
  .add(HttpApiEndpoint.post("youtubeReviewDeletion","/file-deletion-requests/:key/review",{params:{key:Schema.String},success:DeleteReview,error:NotFound}))
  .add(HttpApiEndpoint.post("youtubeConfirmDeletion","/file-deletion-requests/:key/confirm",{params:{key:Schema.String},payload:Schema.Struct({token:Schema.String,filename:Schema.String}),success:HttpApiSchema.NoContent,error:[BadRequest,NotFound]}))
  .add(HttpApiEndpoint.make("DELETE")("youtubeCancelDeletion","/file-deletion-requests/:key",{params:{key:Schema.String},success:HttpApiSchema.NoContent,error:NotFound}))
  .middleware(SessionAuth).prefix("/api/v1/imports/youtube") {}
