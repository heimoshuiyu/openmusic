import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Heart, Play } from "lucide-react"
import { albumRoute } from "@/router"
import { api, formatDuration } from "@/api/client"
import { TrackList } from "@/components/track-list"
import { CoverArt } from "@/components/cover"
import { btnPlay, btnQuiet } from "@/components/page"
import { usePlayer } from "@/player/store"

export function AlbumPage() {
  const { id } = albumRoute.useParams()
  const queryClient = useQueryClient()
  const playNow = usePlayer((s) => s.playNow)
  const { data: album } = useQuery({ queryKey: ["album", id], queryFn: () => api.album(id) })
  const { data: tracks } = useQuery({
    queryKey: ["album", id, "tracks"],
    queryFn: () => api.albumTracks(id),
  })

  const toggleStar = async () => {
    if (!album) return
    if (album.starred) {
      await api.unfavorite("albums", album.id)
    } else {
      await api.favorite("albums", album.id)
    }
    queryClient.invalidateQueries({ queryKey: ["album", id] })
    queryClient.invalidateQueries() // starred 态散布在各列表查询里，全量失效才处处回得来
  }

  return (
    <div className="catalog-page">
      <div className="catalog-detail">
        <div className="flex flex-col items-start gap-5 sm:flex-row sm:items-end">
          <CoverArt
            albumId={id}
            name={album?.name ?? ""}
            hasCover={album?.hasCoverArt ?? false}
            className="size-32 shrink-0 sm:size-44"
            rounded="rounded-none"
          />
          <div className="min-w-0 max-w-full">
            <h1 className="detail-title">
              {album?.name}
            </h1>
            <div className="mt-1.5 text-sm text-dim">
              <Link
                to="/artists/$id"
                params={{ id: album?.artist.id ?? "" }}
                className="transition-colors hover:text-paper"
              >
                {album?.artist.name}
              </Link>
              {album?.year ? <span className="text-faint"> · {album.year}</span> : ""}
              {album?.genre ? <span className="text-faint"> · {album.genre}</span> : ""}
            </div>
            <div className="tnum mt-0.5 text-[11px] text-faint">
              {album?.trackCount ?? 0} 首 · {formatDuration(album?.durationSeconds ?? 0)}
            </div>
            <div className="mt-3 flex gap-2">
              <button type="button" onClick={() => tracks && playNow(tracks)} className={btnPlay}>
                <Play className="h-4 w-4 fill-current" />
                播放全部
              </button>
              <button
                type="button"
                onClick={toggleStar}
                className={btnQuiet}
                title={album?.starred ? "取消收藏" : "收藏"}
              >
                <Heart
                  className={`h-4 w-4 ${album?.starred ? "fill-accent text-accent" : ""}`}
                />
                {album?.starred ? "已收藏" : "收藏"}
              </button>
            </div>
          </div>
        </div>
      </div>
      {tracks && <TrackList tracks={tracks} showAlbum={false} />}
    </div>
  )
}
