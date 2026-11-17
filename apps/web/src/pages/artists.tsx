import { Link } from "@tanstack/react-router"
import { api } from "@/api/client"
import { ArtistCover } from "@/components/cover"
import { PageHeader } from "@/components/page"
import { LoadMoreSentinel, useInfinitePages } from "@/components/infinite"

const PAGE_SIZE = 100

export function ArtistsPage() {
  const { items, total, isLoading, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfinitePages({
    queryKey: ["artists", "all"],
    fetchPage: (offset) => api.artists({ limit: PAGE_SIZE, offset }),
  })

  if (isLoading) return <div className="p-6 text-sm text-dim">加载中…</div>

  return (
    <div className="catalog-page">
      <PageHeader title="艺人" count={total} />
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((artist) => (
          <Link
            key={artist.id}
            to="/artists/$id"
            params={{ id: artist.id }}
            className="group flex items-center gap-3 rounded-lg p-2.5 transition-colors hover:bg-raised/60"
          >
            <ArtistCover
              artistId={artist.id}
              name={artist.name}
              hasCover={artist.hasCoverArt}
              className="h-12 w-12"
              rounded="rounded-full"
            />
            <div className="min-w-0">
              <div className="truncate text-sm font-medium transition-colors group-hover:text-accent">
                {artist.name}
              </div>
              <div className="tnum text-[11px] text-faint">
                {artist.albumCount} 专辑 · {artist.trackCount} 曲目
              </div>
            </div>
          </Link>
        ))}
      </div>
      <LoadMoreSentinel active={hasNextPage === true && !isFetchingNextPage} onLoadMore={fetchNextPage} />
      {isFetchingNextPage && <div className="py-3 text-center text-xs text-faint">加载更多…</div>}
    </div>
  )
}
