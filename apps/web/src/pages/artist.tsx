import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Heart, Play } from "lucide-react"
import { artistRoute } from "@/router"
import { api } from "@/api/client"
import { TrackList } from "@/components/track-list"
import { ArtistCover, CoverArt } from "@/components/cover"
import { btnPlay, btnQuiet } from "@/components/page"
import { usePlayer } from "@/player/store"

export function ArtistPage() {
  const { id } = artistRoute.useParams()
  const queryClient = useQueryClient()
  const playNow = usePlayer((s) => s.playNow)
  const { data: artist } = useQuery({ queryKey: ["artist", id], queryFn: () => api.artist(id) })
  const { data: albums } = useQuery({
    queryKey: ["artist", id, "albums"],
    queryFn: () => api.artistAlbums(id),
  })
  const { data: top } = useQuery({
    queryKey: ["artist", id, "top"],
    queryFn: () => api.artistTopTracks(id),
  })

  const toggleStar = async () => {
    if (!artist) return
    if (artist.starred) {
      await api.unfavorite("artists", artist.id)
    } else {
      await api.favorite("artists", artist.id)
    }
    queryClient.invalidateQueries({ queryKey: ["artist", id] })
    queryClient.invalidateQueries() // starred 态散布在各列表查询里，全量失效才处处回得来
  }

  return (
    <div className="catalog-page">
      <div className="catalog-detail flex flex-wrap items-end gap-5">
        <ArtistCover
          artistId={id}
          name={artist?.name ?? ""}
          hasCover={artist?.hasCoverArt ?? false}
          className="size-28 shrink-0 sm:size-36"
          rounded="rounded-full"
        />
        <div className="min-w-0">
          <h1 className="detail-title">
            {artist?.name}
          </h1>
          <div className="mt-1 tnum text-[11px] text-faint">
            {artist?.albumCount ?? 0} 专辑 · {artist?.trackCount ?? 0} 曲目
          </div>
          <div className="mt-3 flex gap-2">
            {top && top.length > 0 && (
              <button type="button" onClick={() => playNow(top)} className={btnPlay}>
                <Play className="h-4 w-4 fill-current" />
                播放热门
              </button>
            )}
            <button
              type="button"
              onClick={toggleStar}
              className={btnQuiet}
              title={artist?.starred ? "取消收藏" : "收藏"}
            >
              <Heart className={`h-4 w-4 ${artist?.starred ? "fill-accent text-accent" : ""}`} />
              {artist?.starred ? "已收藏" : "收藏"}
            </button>
          </div>
        </div>
      </div>

      <h3 className="mb-3 font-display text-[16px] font-semibold tracking-tight">专辑</h3>
      <div className="mb-8 grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-6">
        {(albums?.items ?? []).map((album) => (
          <Link
            key={album.id}
            to="/albums/$id"
            params={{ id: album.id }}
            className="group"
          >
            <div className="mb-2 aspect-square overflow-hidden rounded-[4px]">
              <CoverArt
                albumId={album.id}
                name={album.name}
                hasCover={album.hasCoverArt}
                className="h-full w-full transition-transform duration-200 group-hover:-translate-y-0.5"
              />
            </div>
            <div className="truncate text-sm font-medium transition-colors group-hover:text-accent">
              {album.name}
            </div>
            <div className="tnum text-[10px] text-faint">
              {album.year ?? ""} · {album.trackCount} 首
            </div>
          </Link>
        ))}
      </div>

      {top && top.length > 0 && (
        <>
          <h3 className="mb-3 font-display text-[16px] font-semibold tracking-tight">热门曲目</h3>
          <TrackList tracks={top} showAlbum={false} />
        </>
      )}
    </div>
  )
}
