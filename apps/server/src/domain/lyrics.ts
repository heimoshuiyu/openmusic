import { Schema } from 'effect'

export const LyricId = Schema.String.pipe(Schema.check(Schema.isPattern(/^[1-9]\d{0,17}$/)))
export const LyricEdit = Schema.Struct({text:Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(131072)))})
export const LyricBinding = Schema.Union([
  Schema.Struct({mode:Schema.Literal('auto')}), Schema.Struct({mode:Schema.Literal('none')}),
  Schema.Struct({mode:Schema.Literal('saved'),lyricsId:LyricId}),
  Schema.Struct({mode:Schema.Literal('file'),filename:Schema.String.pipe(Schema.check(Schema.isMaxLength(255)))}),
])
export type LyricBinding = typeof LyricBinding.Type
export const BindingResult = Schema.Struct({trackId:LyricId, mode:Schema.Literals(['auto','none','file','saved']),
  lyricsId:Schema.optionalKey(LyricId), filename:Schema.optionalKey(Schema.String)})
export const LyricLines = Schema.Array(Schema.Struct({startMs:Schema.NullOr(Schema.Int),text:Schema.String}))
export type LyricLine = typeof LyricLines.Type[number]
export const TrackLyrics = Schema.Struct({trackId:LyricId,mode:Schema.Literals(['auto','none','file','saved']),
  source:Schema.Literals(['none','sidecar','embedded','saved']), filename:Schema.NullOr(Schema.String), lyricsId:Schema.NullOr(LyricId),
  synced:Schema.Boolean,lines:LyricLines})
export type TrackLyrics = typeof TrackLyrics.Type
