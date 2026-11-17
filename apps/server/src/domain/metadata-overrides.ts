import { Schema } from "effect"

const label = Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(300)), Schema.check(Schema.isPattern(/^[^\x00-\x1f\x7f]+$/)), Schema.check(Schema.isPattern(/\S/)))
const position = Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 9999 })))

/** Caller-supplied descriptive fields only. Never pin codec, duration, guessed tags or artwork bytes. */
export const metadataFields = {
  title: Schema.optionalKey(label), artist: Schema.optionalKey(label), album: Schema.optionalKey(label),
  albumArtist: Schema.optionalKey(label), genre: Schema.optionalKey(label),
  trackNumber: Schema.optionalKey(position), discNumber: Schema.optionalKey(position),
}
export const MetadataOverrides = Schema.Struct(metadataFields)
export type MetadataOverrides = typeof MetadataOverrides.Type
