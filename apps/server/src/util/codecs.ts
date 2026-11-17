/**
 * 编解码器 ↔ mime ↔ 扩展名映射（tracks.format / Subsonic contentType/suffix 的单一来源）
 */
const table: ReadonlyArray<{ codec: string; mime: string; exts: ReadonlyArray<string> }> = [
  { codec: "flac", mime: "audio/flac", exts: ["flac"] },
  { codec: "mp3", mime: "audio/mpeg", exts: ["mp3"] },
  { codec: "aac", mime: "audio/mp4", exts: ["m4a", "mp4", "m4b"] },
  { codec: "alac", mime: "audio/mp4", exts: [] },
  { codec: "vorbis", mime: "audio/ogg", exts: ["ogg", "oga"] },
  { codec: "opus", mime: "audio/ogg", exts: ["opus"] },
  { codec: "wav", mime: "audio/x-wav", exts: ["wav"] },
  { codec: "ape", mime: "audio/x-ape", exts: ["ape"] },
  { codec: "wavpack", mime: "audio/wavpack", exts: ["wv"] },
  { codec: "aiff", mime: "audio/x-aiff", exts: ["aiff", "aif"] },
  { codec: "dsf", mime: "audio/x-dsf", exts: ["dsf", "dff"] },
  { codec: "pcm", mime: "audio/x-wav", exts: [] },
]

const byExt = new Map<string, { codec: string; mime: string }>()
for (const row of table) {
  for (const ext of row.exts) byExt.set(ext, { codec: row.codec, mime: row.mime })
}
const byCodec = new Map(table.map((row) => [row.codec, { mime: row.mime }]))

/** 扫描白名单：允许入库的音频扩展名 */
export const AUDIO_EXTENSIONS: ReadonlySet<string> = new Set(byExt.keys())

export const fromExtension = (ext: string) => byExt.get(ext.toLowerCase())
export const mimeForCodec = (codec: string) => byCodec.get(codec)?.mime ?? "application/octet-stream"
export const extensionForCodec = (codec: string) =>
  table.find((row) => row.codec === codec)?.exts[0] ?? codec
