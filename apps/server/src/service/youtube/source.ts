/** Never pass a user-supplied URL through to yt-dlp. Rebuild one of two known YouTube routes. */
export const videoID = /^[A-Za-z0-9_-]{11}$/
const playlistID = /^[A-Za-z0-9_-]{2,100}$/
const watch = (id: string) => `https://www.youtube.com/watch?v=${id}`
export function youtubeSource(input: string) {
  const url = input.length <= 2048 && URL.parse(input.trim())
  if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port) return null
  const host = url.hostname
  let id: string | null = null
  if (host === "youtu.be") id = url.pathname.slice(1)
  else if (["youtube.com", "www.youtube.com", "music.youtube.com", "m.youtube.com"].includes(host)) {
    if (url.pathname === "/playlist") {
      const list = url.searchParams.get("list")
      return list && playlistID.test(list) ? { kind: "playlist" as const, url: `https://www.youtube.com/playlist?list=${list}` } : null
    }
    // A watch link *within* a playlist imports just the video. Never silently expand it.
    if (url.pathname === "/watch") id = url.searchParams.get("v")
    else id = /^\/(?:shorts|live|embed)\/([\w-]+)\/?$/.exec(url.pathname)?.[1] ?? null
  }
  return id && videoID.test(id) ? { kind: "video" as const, url: watch(id) } : null
}

export function checkSubdirectory(input: string): string[] | null {
  if (!input) return []
  const parts = input.split("/")
  return input.length <= 360 && parts.length <= 8 && parts.every(p => p.length > 0 && p.length <= 100 && !p.startsWith(".") && !/[\\:\x00-\x1f\x7f]/.test(p)) ? parts : null
}
