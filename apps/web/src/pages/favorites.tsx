import { useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Heart, Play } from "lucide-react"
import { api } from "@/api/client"
import type { TrackSummary } from "@/api/client"
import { TrackList } from "@/components/track-list"
import { PageHeader, btnPlay, btnDangerGhost } from "@/components/page"
import { LoadMoreSentinel, useInfinitePages, type Paged } from "@/components/infinite"
import { usePlayer } from "@/player/store"

const PAGE_SIZE = 100

export function FavoritesPage() {
  const queryClient = useQueryClient()
  const playNow = usePlayer((s) => s.playNow)
  const { items, total, isLoading, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfinitePages<TrackSummary>({
    queryKey: ["favorites", "track"],
    fetchPage: (offset) => api.favorites("track", PAGE_SIZE, offset) as Promise<Paged<TrackSummary>>,
  })

  const unstar = async (trackId: string) => {
    await api.unfavorite("tracks", trackId)
    queryClient.invalidateQueries({ queryKey: ["favorites"] })
    queryClient.invalidateQueries() // 列表里的红心也要跟着熄灭
  }

  return (
    <div className="catalog-page">
      <PageHeader title="收藏的曲目" count={total}>
        {items.length > 0 && (
          <button type="button" onClick={() => playNow(items)} className={btnPlay}>
            <Play className="h-4 w-4 fill-current" />
            播放全部
          </button>
        )}
      </PageHeader>
      {isLoading ? (
        <div className="text-sm text-dim">加载中…</div>
      ) : items.length > 0 ? (
        <div>
          <TrackList tracks={items} />
          <LoadMoreSentinel active={hasNextPage === true && !isFetchingNextPage} onLoadMore={fetchNextPage} />
          {isFetchingNextPage && <div className="py-3 text-center text-xs text-faint">加载更多…</div>}
          <div className="mt-3 flex flex-wrap gap-2">
            {items.map((track) => (
              <button
                key={track.id}
                type="button"
                onClick={() => unstar(track.id)}
                className={`${btnDangerGhost} flex items-center gap-1 rounded border border-line/60 bg-panel px-2 py-1`}
                title="取消收藏"
              >
                <Heart className="h-3 w-3 fill-accent text-accent" />
                <span className="max-w-40 truncate">{track.title}</span>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="text-sm text-dim">
          还没有收藏——在{" "}
          <Link to="/albums" className="text-dim underline decoration-line underline-offset-2 transition-colors hover:text-accent">
            专辑页
          </Link>
          点收藏
        </div>
      )}
    </div>
  )
}
