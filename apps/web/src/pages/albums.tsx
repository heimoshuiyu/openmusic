import { api } from "@/api/client"
import { AlbumCard } from "@/components/album-card"
import { PageHeader } from "@/components/page"
import { LoadMoreSentinel, useInfinitePages } from "@/components/infinite"

const PAGE_SIZE = 60

/** 专辑页只有一种浏览方式：随机洗牌 */
export function AlbumsPage() {
  const { items, total, isLoading, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfinitePages({
    queryKey: ["albums", "random"],
    // 随机排序不吃缓存：服务端 order by random() 本就次次新洗牌（staleTime 0 = 挂载即重拉）
    staleTime: 0,
    fetchPage: (offset) => api.albums({ sort: "random", limit: PAGE_SIZE, offset }),
  })

  return (
    <div className="catalog-page">
      <PageHeader title="专辑" count={total} />
      {isLoading ? (
        <div className="text-sm text-dim">加载中…</div>
      ) : (
        <>
          <div className="album-grid">
            {items.map((album) => (
              <AlbumCard key={album.id} album={album} />
            ))}
          </div>
          <LoadMoreSentinel active={hasNextPage === true && !isFetchingNextPage} onLoadMore={fetchNextPage} />
          {isFetchingNextPage && <div className="py-3 text-center text-xs text-faint">加载更多…</div>}
        </>
      )}
    </div>
  )
}
