import { api } from "@/api/client"
import { usePlayer } from "@/player/store"

export function openAgentEvents(open: () => void, data: (s: string) => void) {
  const source = new EventSource("/api/v1/agent/events")
  source.onopen = open
  source.onmessage = event => data(event.data)
  return () => source.close()
}

export async function playConfirmedTracks(kind: "play-now" | "enqueue", ids: string[], current: () => boolean) {
  const tracks = await Promise.all(ids.map(id => api.track(id)))
  if (!current()) return
  const player = usePlayer.getState()
  if (kind === "play-now") player.playNow(tracks); else player.enqueue(tracks)
}
