import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { ChevronLeft, Play } from "lucide-react"
import { playlistRoute } from "@/router"
import { api } from "@/api/client"
import { TrackList } from "@/components/track-list"
import { btnPlay } from "@/components/page"
import { usePlayer } from "@/player/store"

export function PlaylistPage() {
  const { id } = playlistRoute.useParams()
  const queryClient = useQueryClient()
  const playNow = usePlayer((s) => s.playNow)
  const { data: playlist } = useQuery({
    queryKey: ["playlist", id],
    queryFn: () => api.playlist(id),
  })
  const { data: tracks } = useQuery({
    queryKey: ["playlist", id, "tracks"],
    queryFn: () => api.playlistTracks(id),
  })

  const removeAt = useMutation({
    mutationFn: (position: number) => api.removeFromPlaylist(id, position),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["playlist", id] }),
  })

  return (
    <div className="catalog-page">
      <div className="catalog-detail">
        <Link
          to="/playlists"
          className="mb-2 inline-flex items-center gap-1 text-xs text-dim transition-colors hover:text-paper"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
          播放列表
        </Link>
        <h1 className="detail-title">{playlist?.name}</h1>
        <div className="mt-1 tnum text-[11px] text-faint">
          {playlist?.songCount ?? 0} 首 · {playlist?.owner}
        </div>
        {tracks && tracks.length > 0 && (
          <button type="button" onClick={() => playNow(tracks)} className={`mt-3 ${btnPlay}`}>
            <Play className="h-4 w-4 fill-current" />
            播放全部
          </button>
        )}
      </div>

      {tracks && tracks.length > 0 ? (
        <div className="relative">
          <TrackList tracks={tracks} />
          <div className="mt-3 flex flex-wrap gap-2">
            {tracks.map((track, position) => (
              <button
                key={`${track.id}-${position}`}
                type="button"
                onClick={() => removeAt.mutate(position)}
                className="rounded border border-line/60 bg-panel px-2 py-1 tnum text-[10px] text-faint transition-colors hover:border-danger/50 hover:text-danger"
              >
                移除 {position + 1}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="text-sm text-dim">播放列表为空——在专辑/曲目页把歌曲加入队列或列表</div>
      )}
    </div>
  )
}
