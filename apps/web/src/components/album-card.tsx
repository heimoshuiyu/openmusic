import { Link } from "@tanstack/react-router"
import { Play } from "lucide-react"
import { api, coverUrl, formatDuration } from "@/api/client"
import { CoverArt } from "@/components/cover"
import { usePlayer } from "@/player/store"
import type { AlbumSummary } from "@/api/client"

/** Apple Music 式：无框封面 + 悬停浮起播放键 */
export function AlbumCard({ album }: { album: AlbumSummary }) {
  const playNow = usePlayer((s) => s.playNow)

  const playAlbum = async () => {
    playNow(await api.albumTracks(album.id))
  }

  return (
    <article className="album-card group relative min-w-0 shrink-0">
      <div className="relative mb-2.5">
        <div className="aspect-square overflow-hidden bg-raised">
          {album.hasCoverArt ? (
            <img
              src={coverUrl(album.id)}
              alt={album.name}
              className="h-full w-full object-cover"
              loading="lazy"
            />
          ) : (
            <CoverArt
              albumId={album.id}
              name={album.name}
              hasCover={false}
              className="h-full w-full"
            />
          )}
        </div>
        {/* 悬停播放键（Apple Music 行为） */}
        <button
          type="button"
          aria-label={`播放 ${album.name}`}
          title="播放"
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            void playAlbum()
          }}
          className="absolute bottom-2 right-2 z-10 grid size-9 place-items-center bg-paper text-shell transition-opacity hoverable:opacity-0 hoverable:group-hover:opacity-100 focus-visible:opacity-100"
        >
          <Play className="ml-0.5 h-4 w-4 fill-current" />
        </button>
      </div>
      <Link to="/albums/$id" params={{id:album.id}} className="block truncate text-sm font-semibold leading-tight after:absolute after:inset-0 group-hover:text-accent">{album.name}</Link>
      <div className="mt-0.5 truncate text-xs text-dim">{album.artist.name}</div>
      <div className="tnum mt-0.5 text-[11px] text-faint">
        {album.year ?? ""}
        {album.year ? " · " : ""}
        {album.trackCount} 首 · {formatDuration(album.durationSeconds)}
      </div>
    </article>
  )
}
