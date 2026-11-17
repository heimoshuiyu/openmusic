/**
 * 曲库浏览视图：专辑（分页）/ 专辑曲目 / 艺人 / 艺人页（热门曲目 + 专辑）。
 *
 * 正在播放标记：曲目按 id、专辑按 current.album.id 比对（行首 ASCII `>`）。
 */
import { useEffect, useState } from "react"
import type { SelectOption } from "@opentui/core"
import { usePaged } from "./use-paged.js"
import type { AlbumSummary, ArtistSummary, TrackSummary } from "../api.js"
import { ListPane } from "../components/list-pane.js"
import {
  albumRow,
  artistRow,
  descAlbum,
  descTrackNoAlbum,
  headerRow,
  trackRow,
  type RowItem,
} from "../rows.js"
import type { ViewProps } from "./types.js"

const PAGE = 100

export function AlbumsView(p: ViewProps & { sel?: number }) {
  const page = usePaged((offset) => p.api.albums(PAGE, offset))
  const options = page.items.map((album: AlbumSummary) =>
    albumRow(
      album,
      { playing: album.id === p.player.current?.album.id },
      descAlbum(album),
    ),
  )
  return (
    <ListPane
      title={`专辑 · ${page.total ?? "…"}`}
      options={options}
      focused={p.focused}
      interactive={p.interactive}
      initialSel={p.sel}
      loading={page.loading}
      error={page.error}
      empty="曲库为空——把音乐放进服务器的音乐文件夹后触发扫描"
      total={page.total}
      onNearEnd={page.loadMore}
      register={p.registerList}
      onSelectionChange={p.reportSel}
      onActivate={(item: RowItem) => {
        if (item.kind === "album") p.drill({ kind: "album-tracks", album: item.album })
      }}
    />
  )
}

export function AlbumTracksView(p: ViewProps & { album: AlbumSummary; sel?: number }) {
  const [tracks, setTracks] = useState<TrackSummary[]>([])
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    p.api
      .albumTracks(p.album.id)
      .then(setTracks)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 专辑固定
  }, [])

  const options = tracks.map((t) =>
    trackRow(
      t,
      {
        playing: t.id === p.player.current?.id,
        starred: p.stars.is(t),
        no: t.track !== null ? String(t.track).padStart(2, "0") : undefined,
      },
      descTrackNoAlbum(t),
    ),
  )
  return (
    <ListPane
      title={`${p.album.name} · ${p.album.artist.name}`}
      options={options}
      focused={p.focused}
      interactive={p.interactive}
      initialSel={p.sel}
      loading={loading}
      error={error}
      empty="专辑没有曲目（重新扫描试试）"
      register={p.registerList}
      onSelectionChange={p.reportSel}
      onActivate={(item: RowItem, index: number) => {
        if (item.kind === "track") p.player.play(tracks, index)
      }}
    />
  )
}

export function ArtistsView(p: ViewProps & { sel?: number }) {
  const page = usePaged((offset) => p.api.artists(PAGE, offset))
  const options = page.items.map((artist: ArtistSummary) =>
    artistRow(artist, `${artist.albumCount} 张专辑 · ${artist.trackCount} 曲`),
  )
  return (
    <ListPane
      title={`艺人 · ${page.total ?? "…"}`}
      options={options}
      focused={p.focused}
      interactive={p.interactive}
      initialSel={p.sel}
      loading={page.loading}
      error={page.error}
      empty="还没有艺人——扫描音乐文件夹后出现"
      total={page.total}
      onNearEnd={page.loadMore}
      register={p.registerList}
      onSelectionChange={p.reportSel}
      onActivate={(item: RowItem) => {
        if (item.kind === "artist") p.drill({ kind: "artist", artist: item.artist })
      }}
    />
  )
}

export function ArtistView(p: ViewProps & { artist: ArtistSummary; sel?: number }) {
  const [top, setTop] = useState<TrackSummary[]>([])
  const [albums, setAlbums] = useState<AlbumSummary[]>([])
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    void Promise.all([p.api.artistTopTracks(p.artist.id), p.api.artistAlbums(p.artist.id)])
      .then(([t, a]) => {
        setTop(t)
        setAlbums(a)
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 艺人固定
  }, [])

  const options: SelectOption[] = []
  if (top.length > 0) {
    options.push(headerRow("热门曲目"))
    top.forEach((t) => {
      options.push(
        trackRow(
          t,
          { playing: t.id === p.player.current?.id, starred: p.stars.is(t) },
          `${t.playCount} 次 · ${descTrackNoAlbum(t)}`,
        ),
      )
    })
  }
  if (albums.length > 0) {
    options.push(headerRow("专辑"))
    albums.forEach((a) => {
      options.push(albumRow(a, { playing: a.id === p.player.current?.album.id }, descAlbum(a)))
    })
  }

  const activate = (item: RowItem): void => {
    if (item.kind === "track") {
      const trackIdx = top.findIndex((t) => t.id === item.track.id)
      if (trackIdx >= 0) p.player.play(top, trackIdx)
    } else if (item.kind === "album") {
      p.drill({ kind: "album-tracks", album: item.album })
    }
  }
  return (
    <ListPane
      title={p.artist.name}
      options={options}
      focused={p.focused}
      interactive={p.interactive}
      initialSel={p.sel}
      loading={loading}
      error={error}
      empty="这位艺人还没有曲目"
      register={p.registerList}
      onSelectionChange={p.reportSel}
      onActivate={activate}
    />
  )
}
