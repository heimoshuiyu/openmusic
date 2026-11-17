import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { ChevronRight, Shuffle } from "lucide-react"
import { api, formatDuration, type MostPlayedItem } from "@/api/client"
import { AlbumCard } from "@/components/album-card"
import { TrackList } from "@/components/track-list"
import { btnPlay } from "@/components/page"
import { usePlayer } from "@/player/store"

export function HomePage() {
  const { data: recentAlbums } = useQuery({
    queryKey: ["albums", "recent"],
    queryFn: () => api.albums({ sort: "-createdAt", limit: 12 }),
  })
  const { data: mostPlayed } = useQuery({
    queryKey: ["plays", "most-played", "album"],
    queryFn: () => api.mostPlayed("album", { limit: 12 }),
  })
  const { data: stats } = useQuery({
    queryKey: ["plays", "summary"],
    queryFn: () => api.playSummary(),
  })
  const { data: recentPlays } = useQuery({
    queryKey: ["plays", "recent", "distinct-tracks", 12],
    queryFn: () => api.recentPlays(12, "track"),
  })
  const playNow = usePlayer((s) => s.playNow)

  return (
    <div className="catalog-page">
      <header className="library-mast"><div><h1>我的音乐库</h1>
        <p>{recentAlbums ? `${recentAlbums.total.toLocaleString()} 张专辑` : "正在读取曲库…"}{stats && stats.listenedSeconds > 0 && ` · 累计收听 ${formatTotal(stats.listenedSeconds)}`}</p>
      </div><button type="button" className={btnPlay} onClick={async()=>playNow(await api.random(20))}><Shuffle size={16}/>随机 20 首</button></header>
      <section className="record-section">
        <header>
          <h2>最近添加</h2>
          <Link
            to="/albums"
            className="mt-1 inline-flex items-center text-sm text-accent hover:underline"
          >
            全部
            <ChevronRight className="h-3.5 w-3.5" />
          </Link>
        </header>
        <div className="record-shelf">
          {recentAlbums?.items.length === 0 && <p className="text-sm text-dim">还没有入库的专辑</p>}
          {(recentAlbums?.items ?? []).map((album) => (
            <AlbumCard key={album.id} album={album} />
          ))}
        </div>
      </section>

      {mostPlayed && mostPlayed.length > 0 && (
        <section className="record-section">
          <header><h2>最常播放</h2></header>
          <div className="record-shelf">
            {mostPlayed
              .filter((item): item is MostPlayedItem & { kind: "album" } => item.kind === "album")
              .map((item) => (
                <AlbumCard key={item.album.id} album={item.album} />
              ))}
          </div>
        </section>
      )}

      <section className="record-section">
        <header><h2>最近播放</h2></header>
        {recentPlays && recentPlays.length > 0 ? (
          <TrackList
            tracks={recentPlays.map((entry) =>
              entry.track ?? {
                deleted: true as const,
                title: entry.title,
                artistName: entry.artistName,
                albumName: entry.albumName,
                durationSeconds: entry.durationSeconds,
              })}
          />
        ) : (
          <p className="text-sm text-faint">还没有播放记录</p>
        )}
      </section>
    </div>
  )
}

export function formatTotal(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return h > 0 ? `${h} 小时 ${m} 分钟` : `${m} 分钟`
}
