import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Search as SearchIcon } from "lucide-react"
import { api } from "@/api/client"
import { TrackList } from "@/components/track-list"
import { ArtistCover, CoverArt } from "@/components/cover"
import { PageHeader } from "@/components/page"

export function SearchPage() {
  const [query, setQuery] = useState("")
  const [submitted, setSubmitted] = useState("")
  const { data, isFetching } = useQuery({
    queryKey: ["search", submitted],
    queryFn: () => api.search(submitted),
    enabled: submitted !== "",
  })

  return (
    <div className="catalog-page">
      <PageHeader title="搜索" />
      <form
        onSubmit={(event) => {
          event.preventDefault()
          setSubmitted(query)
        }}
        className="mb-8"
      >
        <div className="relative flex max-w-3xl items-center border border-paper bg-panel focus-within:border-accent">
          <SearchIcon className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" />
          <input
            value={query}
            aria-label="搜索曲库"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索艺人 / 专辑 / 曲目…"
            autoFocus
            className="h-12 min-w-0 flex-1 bg-transparent pl-10 pr-2 text-base placeholder:text-faint"
          /><button type="submit" className="self-stretch bg-paper px-5 text-sm text-shell">搜索</button>
        </div>
      </form>

      {submitted === "" ? (
        <div className="text-sm text-dim">输入关键词开始搜索（支持中日文）</div>
      ) : isFetching ? (
        <div className="text-sm text-dim">搜索中…</div>
      ) : (
        <div className="space-y-10">
          {data && data.artists.length > 0 && (
            <section>
              <h3 className="mb-3 flex items-baseline gap-2.5 font-display text-[16px] font-semibold tracking-tight">
                艺人
                <span className="tnum text-xs font-normal text-faint">
                  {data.artistCount}
                </span>
              </h3>
              <div className="flex flex-wrap gap-2">
                {data.artists.map((artist) => (
                  <Link
                    key={artist.id}
                    to="/artists/$id"
                    params={{ id: artist.id }}
                    className="flex items-center gap-2.5 rounded-full border border-line/60 bg-panel py-1.5 pl-1.5 pr-4 text-sm transition-colors hover:border-accent/50"
                  >
                    <ArtistCover
                      artistId={artist.id}
                      name={artist.name}
                      hasCover={artist.hasCoverArt}
                      className="h-7 w-7"
                      rounded="rounded-full"
                    />
                    {artist.name}
                  </Link>
                ))}
              </div>
            </section>
          )}
          {data && data.albums.length > 0 && (
            <section>
              <h3 className="mb-3 flex items-baseline gap-2.5 font-display text-[16px] font-semibold tracking-tight">
                专辑
                <span className="tnum text-xs font-normal text-faint">
                  {data.albumCount}
                </span>
              </h3>
              <div className="flex flex-wrap gap-3">
                {data.albums.map((album) => (
                  <Link
                    key={album.id}
                    to="/albums/$id"
                    params={{ id: album.id }}
                    className="flex w-56 items-center gap-3 rounded-md border border-line/60 bg-panel p-2 transition-colors hover:border-accent/50"
                  >
                    <CoverArt
                      albumId={album.id}
                      name={album.name}
                      hasCover={album.hasCoverArt}
                      className="h-12 w-12"
                      rounded="rounded-[3px]"
                      monogram={false}
                    />
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{album.name}</div>
                      <div className="truncate text-xs text-dim">{album.artist.name}</div>
                    </div>
                  </Link>
                ))}
              </div>
            </section>
          )}
          {data && data.tracks.length > 0 && (
            <section>
              <h3 className="mb-3 flex items-baseline gap-2.5 font-display text-[16px] font-semibold tracking-tight">
                曲目
                <span className="tnum text-xs font-normal text-faint">
                  {data.trackCount}
                </span>
              </h3>
              <TrackList tracks={data.tracks} />
            </section>
          )}
          {data && data.artists.length + data.albums.length + data.tracks.length === 0 && (
            <div className="text-sm text-dim">没有匹配「{submitted}」的结果</div>
          )}
        </div>
      )}
    </div>
  )
}
