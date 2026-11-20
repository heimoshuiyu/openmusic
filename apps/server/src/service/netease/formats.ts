export type NeteaseExt = "mp3" | "flac"

/** Anonymous netease only serves standard/higher/exhigh MP3 tiers; the instance may serve FLAC.
 *  Never reuse YouTube's opus/aac whitelist: netease formats reject it ("Requested format is not available"). */
export const neteaseFormatArgs: ReadonlyArray<string> = ["-f", "bestaudio/best"]

export const neteaseName = (songId: string, ext: NeteaseExt) => `Netease-${songId}.${ext}`

export function importedFilename(name: string): { songId: string; ext: NeteaseExt } | null {
  const match = /^Netease-(\d{1,20})\.(mp3|flac)$/.exec(name)
  return match ? { songId: match[1]!, ext: match[2] as NeteaseExt } : null
}
