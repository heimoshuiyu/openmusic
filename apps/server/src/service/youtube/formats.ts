import type { YoutubeFormat } from "../../domain/youtube"

export type MediaExt = "opus" | "m4a" | "mp3" | "mp4"
// Only these source codecs are admitted to ExtractAudio's `best` path. yt-dlp stream-copies
// both; its fallback encoder for *unknown* source codecs must never be reached.
const nativeAudio = "[acodec~='^(opus$|aac$|mp4a)']"
const formats: Record<YoutubeFormat, { args: string[]; extensions: MediaExt[] }> = {
  original: { args:["-f", `bestaudio${nativeAudio}/best${nativeAudio}`, "-x", "--audio-format", "best"], extensions:["opus","m4a"] },
  mp3: { args:["-f", "bestaudio/best", "-x", "--audio-format", "mp3"], extensions:["mp3"] },
  video: { args:["-f", "bestvideo[ext=mp4][vcodec^=avc1][height<=1080]+bestaudio[ext=m4a][acodec^=mp4a]/best[ext=mp4][vcodec^=avc1][acodec^=mp4a][height<=1080]", "--merge-output-format", "mp4"], extensions:["mp4"] },
}
export const outputSpec = (mode: YoutubeFormat) => formats[mode]
export function importedFilename(name: string) {
  const match = /^YouTube-([\w-]{11})\.(opus|m4a|mp3|mp4)$/.exec(name)
  if (!match) return null
  const ext = match[2] as MediaExt
  return { videoId: match[1]!, ext, format: ext === "mp3" ? "mp3" as const : ext === "mp4" ? "video" as const : "original" as const }
}
