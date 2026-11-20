import { useState } from "react"
import { api } from "@/api/client"
import { TrackList } from "@/components/track-list"
import { PageHeader, SortTabs } from "@/components/page"
import { LoadMoreSentinel, useInfinitePages } from "@/components/infinite"
import { TrackManageSlot } from "@/imports/import-manage"

const SORTS = [
  { key: "", label: "默认" },
  { key: "title", label: "标题" },
  { key: "-createdAt", label: "最新" },
  { key: "-playCount", label: "最多播放" },
  { key: "random", label: "随机" },
] as const

const PAGE_SIZE = 100

export function TracksPage() {
  const [sort, setSort] = useState("")
  const { items, total, isLoading, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfinitePages({
    queryKey: ["tracks", sort],
    // 随机排序不吃缓存：每次进入都是新一批（同 albums 页）
    staleTime: sort === "random" ? 0 : undefined,
    fetchPage: (offset) =>
      api.tracks(sort === "" ? { limit: PAGE_SIZE, offset } : { sort, limit: PAGE_SIZE, offset }),
  })

  return (
    <div className="catalog-page">
      <PageHeader title="曲目" count={total}>
        <SortTabs sorts={SORTS} value={sort} onChange={setSort} />
      </PageHeader>
      {isLoading ? (
        <div className="text-sm text-dim">加载中…</div>
      ) : (
        <>
          <TrackList tracks={items} manage={TrackManageSlot} />
          <LoadMoreSentinel active={hasNextPage === true && !isFetchingNextPage} onLoadMore={fetchNextPage} />
          {isFetchingNextPage && <div className="py-3 text-center text-xs text-faint">加载更多…</div>}
          {hasNextPage !== true && items.length > 0 && (
            <div className="py-3 text-center text-xs text-faint">已全部加载</div>
          )}
        </>
      )}
    </div>
  )
}
