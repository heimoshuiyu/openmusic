import { useCallback, useEffect, useRef, useState } from "react"

/** 触底分页的公共状态机（albums/artists/favorites 用） */
export function usePaged<T>(fetch: (offset: number) => Promise<{ items: T[]; total: number }>) {
  const [items, setItems] = useState<T[]>([])
  const [total, setTotal] = useState<number | undefined>(undefined)
  const [error, setError] = useState("")
  const busyRef = useRef(false)
  const doneRef = useRef(false)

  const load = useCallback(
    (mode: "init" | "more") => {
      if (busyRef.current || doneRef.current) return
      busyRef.current = true
      fetch(mode === "init" ? 0 : items.length)
        .then((page) => {
          setItems((prev) => (mode === "init" ? page.items : [...prev, ...page.items]))
          setTotal(page.total)
          const merged = mode === "init" ? page.items.length : items.length + page.items.length
          if (merged >= page.total) doneRef.current = true
        })
        .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
        .finally(() => {
          busyRef.current = false
        })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch 每视图固定
    [items.length],
  )

  useEffect(() => {
    load("init")
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅挂载时执行
  }, [])
  return { items, total, error, loading: total === undefined && error === "", loadMore: () => load("more") }
}
