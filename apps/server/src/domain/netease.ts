import { Schema } from "effect"
import { metadataFields } from "./metadata-overrides"

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

/** 导入文件的两种落盘形态（匿名音源：MP3 三档；实例模式可出 FLAC）。 */
export const neteaseFormats = ["mp3", "flac"] as const
export const NeteaseFormat = Schema.Literals(neteaseFormats)
export type NeteaseFormat = typeof NeteaseFormat.Type

/** 管理编辑入参（N2）：与 YoutubeTags 同构的文本覆盖 + cover。
 *  cover 语义：`"netease"` 回源恢复该曲的网易云封面；否则须是 *.music.126.net 的
 *  （http 会归一为 https）图片 URL，或 data:image/jpeg|png|webp 内联图。不做目录补全。 */
export const NeteaseTags = Schema.Struct({
  ...metadataFields,
  cover: Schema.optionalKey(Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(5_600_000)))),
})
export type NeteaseTags = typeof NeteaseTags.Type

/** 曲目级来源信息（N1）：纯 DB 读，不碰文件。quality 为导入时探针得到的交付档位
 *  快照（standard/higher/exhigh/lossless）；发行日是专辑年份语义，走 albums.year，
 *  与 youtube 的逐曲 upload_date 不同，故无该字段。 */
export const NeteaseInfo = Schema.Struct({
  trackId: Schema.String, songId: Schema.String, quality: Schema.NullOr(Schema.String),
  format: NeteaseFormat, filename: Schema.String,
  title: Schema.String, artist: Schema.String, album: Schema.String, albumArtist: Schema.String,
  genre: Schema.NullOr(Schema.String), trackNumber: Schema.NullOr(Schema.Int), discNumber: Schema.Int,
  hasCover: Schema.Boolean, warnings: Schema.optionalKey(Schema.Array(Schema.String)),
})
export type NeteaseInfo = typeof NeteaseInfo.Type

/** 删除票据（N4）：与 youtube 的 DeleteRequest 同形但独立定义，避免跨域改动 youtube。 */
export const NeteaseDeleteRequest = Schema.Struct({ requestId: Schema.String, reviewPath: Schema.String, expiresAt: Schema.Number })
export const NeteaseDeleteReview = Schema.Struct({ trackId: Schema.String, title: Schema.String, artist: Schema.String,
  filename: Schema.String, format: NeteaseFormat, path: Schema.String, sizeBytes: Schema.Number, expiresAt: Schema.Number, token: Schema.String })
