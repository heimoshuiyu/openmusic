/** Never pass a user-supplied URL through to yt-dlp. Rebuild one of four known music.163.com routes. */
export const songID = /^\d{1,20}$/
const hosts = ["music.163.com", "www.music.163.com", "y.music.163.com"]
const route = /^\/(?:m\/)?(song|playlist|album|artist)(?:\/(\d{1,20}))?\/?$/
export type NeteaseKind = "song" | "playlist" | "album" | "artist"
export interface NeteaseSource { kind: NeteaseKind; id: string; url: string }

function resolve(pathname: string, params: URLSearchParams | null): { kind: NeteaseKind; id: string } | null {
  const match = route.exec(pathname)
  if (!match) return null
  const id = match[2] ?? params?.get("id") ?? null
  return id !== null && songID.test(id) ? { kind: match[1] as NeteaseKind, id } : null
}

export function neteaseSource(input: string): NeteaseSource | null {
  const url = input.length <= 2048 && URL.parse(input.trim())
  if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port) return null
  if (!hosts.includes(url.hostname)) return null
  const direct = resolve(url.pathname, url.searchParams)
  if (direct) return { ...direct, url: `https://music.163.com/${direct.kind}?id=${direct.id}` }
  // SPA shares put the route in the hash: https://music.163.com/#/song?id=…
  if (url.hash.length > 1) {
    const body = url.hash.slice(1), at = body.indexOf("?")
    const hash = resolve(at === -1 ? body : body.slice(0, at), at === -1 ? null : new URLSearchParams(body.slice(at + 1)))
    if (hash) return { ...hash, url: `https://music.163.com/${hash.kind}?id=${hash.id}` }
  }
  return null
}
