import { Schema } from "effect"

/** 搜索候选：url 为规范化重建的 music.163.com 单曲链接；vip=true 即 fee∈{1,4}（VIP/付费）。 */
export const NeteaseCandidate = Schema.Struct({
  title: Schema.String, artist: Schema.String, album: Schema.String,
  songId: Schema.String.pipe(Schema.check(Schema.isPattern(/^\d{1,20}$/))),
  url: Schema.String, vip: Schema.Boolean,
})
export type NeteaseCandidate = typeof NeteaseCandidate.Type

/** 与 youtube 的 ImportResult 同形（failures/warnings 按 songId）；每首实际音质档位存于 netease_imports。 */
export const NeteaseImportResult = Schema.Struct({
  url: Schema.String,
  kind: Schema.Literals(["song", "playlist", "album", "artist"]),
  state: Schema.Literals(["done", "partial", "failed"]),
  total: Schema.Number, imported: Schema.Number, skipped: Schema.Number, failed: Schema.Number,
  destination: Schema.String,
  trackIds: Schema.Array(Schema.Int),
  files: Schema.Array(Schema.Struct({ trackId: Schema.Int, name: Schema.String })),
  failures: Schema.Array(Schema.Struct({ songId: Schema.String, reason: Schema.String })),
  warnings: Schema.Array(Schema.Struct({ songId: Schema.String, message: Schema.String })),
})
export type NeteaseImportResult = typeof NeteaseImportResult.Type
