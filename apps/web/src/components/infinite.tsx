import { useInfiniteQuery, type QueryFunctionContext } from "@tanstack/react-query"
import { useEffect, useRef } from "react"

/** 分页响应（与后端 Page 对齐） */
export interface Paged<T> {
  readonly items: ReadonlyArray<T>
  readonly total: number
  readonly offset: number
  readonly limit: number
}

/**
 * 无限滚动数据源：大库目录页不再「一次拉满上限、静默截断」。
 * 返回打平后的 items 与首页 total（PageHeader 展示真实总数）。
 * staleTime 可按需覆盖：随机排序必须传 0——order by random() 每次执行都是
 * 新洗牌，缓存命中等同「每次看到同一批」（staleTime 0 = 挂载即重拉）。
 */
export function useInfinitePages<T>(opts: {
  readonly staleTime?: number | undefined
  readonly queryKey: ReadonlyArray<string>
  readonly fetchPage: (offset: number) => Promise<Paged<T>>
}) {
  const query = useInfiniteQuery({
    queryKey: opts.queryKey,
    queryFn: ({ pageParam }: QueryFunctionContext<ReadonlyArray<string>, number>) =>
      opts.fetchPage(pageParam),
    initialPageParam: 0,
    ...(opts.staleTime === undefined ? {} : { staleTime: opts.staleTime }),
    getNextPageParam: (last: Paged<T>, all: ReadonlyArray<Paged<T>>) => {
      const loaded = all.reduce((n, page) => n + page.items.length, 0)
      return loaded < last.total ? loaded : undefined
    },
  })
  const items = query.data?.pages.flatMap((page) => page.items) ?? []
  const total = query.data?.pages[0]?.total
  return {
    items,
    total,
    isLoading: query.isLoading,
    error: query.error,
    hasNextPage: query.hasNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
    fetchNextPage: () => void query.fetchNextPage(),
  }
}

/** 触底哨兵：root=null 对任意滚动容器生效，600px 预取半径 */
export function LoadMoreSentinel({
  onLoadMore,
  active,
}: {
  onLoadMore: () => void
  active: boolean
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!active || el === null) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onLoadMore()
      },
      { rootMargin: "600px" },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [active, onLoadMore])
  return <div ref={ref} className="h-px" aria-hidden />
}
