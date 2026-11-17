import { Schema } from "effect"
import { metadataFields } from "./metadata-overrides"

export const youtubeFormats = ["original", "mp3", "video"] as const
export const YoutubeFormat = Schema.Literals(youtubeFormats)
export type YoutubeFormat = typeof YoutubeFormat.Type

const captionSourceFields = {
  url: Schema.optionalKey(Schema.String.pipe(Schema.check(Schema.isMaxLength(2048)))),
  trackId: Schema.optionalKey(Schema.String.pipe(Schema.check(Schema.isPattern(/^[1-9]\d{0,15}$/)))),
}
export const CaptionSource = Schema.Struct(captionSourceFields)
export type CaptionSource = typeof CaptionSource.Type
const CaptionKind = Schema.Literal("manual")
export const CaptionRead = Schema.Struct({...captionSourceFields,
  language: Schema.String.pipe(Schema.check(Schema.isPattern(/^[A-Za-z0-9][\w-]{0,39}$/))),
  kind: Schema.optionalKey(CaptionKind), offset: Schema.optionalKey(Schema.Int.pipe(Schema.check(Schema.isBetween({minimum:0,maximum:100000})))),
})
export type CaptionRead = typeof CaptionRead.Type
export const CaptionTrack = Schema.Struct({language: Schema.String, kind: CaptionKind})
export const CaptionList = Schema.Struct({videoId: Schema.String, tracks: Schema.Array(CaptionTrack)})
export const CaptionPage = Schema.Struct({videoId: Schema.String, ...CaptionTrack.fields,
  cues: Schema.Array(Schema.Struct({startMs: Schema.Int, endMs: Schema.NullOr(Schema.Int), text: Schema.String})),
  nextOffset: Schema.NullOr(Schema.Int), total: Schema.Int,
})

export const YoutubeTags = Schema.Struct({
  ...metadataFields,
  // "youtube" explicitly restores the thumbnail. Otherwise a trusted HTTPS image or inline image.
  cover: Schema.optionalKey(Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(5_600_000)))),
})
export type YoutubeTags = typeof YoutubeTags.Type

export const CatalogMatch = Schema.Struct({title:Schema.String,artist:Schema.String,album:Schema.String,genre:Schema.String,
  durationSeconds:Schema.Number, releaseDate:Schema.String, trackNumber:Schema.Number, discNumber:Schema.Number,
  source:Schema.String,cover:Schema.String})
export const YoutubeInfo = Schema.Struct({trackId:Schema.String,videoId:Schema.String,uploadDate:Schema.NullOr(Schema.String),
  format:YoutubeFormat, filename:Schema.String,
  coverSource:Schema.NullOr(Schema.String),title:Schema.String,artist:Schema.String,album:Schema.String,albumArtist:Schema.String,
  genre:Schema.NullOr(Schema.String),trackNumber:Schema.NullOr(Schema.Int),discNumber:Schema.Int,hasCover:Schema.Boolean,
  warnings:Schema.optionalKey(Schema.Array(Schema.String))})
export type YoutubeInfo = typeof YoutubeInfo.Type

export const DeleteRequest = Schema.Struct({requestId:Schema.String, reviewPath:Schema.String, expiresAt:Schema.Number})
export const DeleteReview = Schema.Struct({trackId:Schema.String,title:Schema.String,artist:Schema.String,filename:Schema.String,
  format:YoutubeFormat,path:Schema.String, sizeBytes:Schema.Number, expiresAt:Schema.Number, token:Schema.String})

export const ImportResult = Schema.Struct({
  url: Schema.String, kind: Schema.Literals(["video","playlist"]),
  state: Schema.Literals(["done","partial","failed"]),
  total: Schema.Number, imported: Schema.Number, skipped: Schema.Number, failed: Schema.Number,
  destination: Schema.String,
  trackIds: Schema.Array(Schema.Int),
  format: YoutubeFormat, files: Schema.Array(Schema.Struct({trackId:Schema.Int,name:Schema.String})),
  failures: Schema.Array(Schema.Struct({ videoId: Schema.String, reason: Schema.String })),
  warnings: Schema.Array(Schema.Struct({videoId:Schema.String, message:Schema.String})),
})
export type ImportResult = typeof ImportResult.Type
