/**
 * 集合类视图：搜索（输入 + 三路结果）/ 收藏 / 最近播放 / 最常播放（m 切时段）/
 * 播放列表 / 队列（Enter 跳转 · d 移除）/ 随机播放（行动卡）。
 *
 * 搜索的输入态由 MainScreen 的 textMode 统一门闸：打字期间全局键位全部让路
 * （useKeyboard 订阅底层 emitter，聚焦 input 也会触发——必须显式屏蔽）。
 */
import { useEffect, useRef, useState } from "react"
import type { InputRenderable, SelectOption } from "@opentui/core"
import { useKeyboard } from "@opentui/react"
import {
  formatDuration,
  formatPlayedAt,
  type MostPlayedTrack,
  type Period,
  type PlayEntry,
  type PlaylistSummary,
  type SearchResult,
  type TrackSummary,
} from "../api.js"
import { ListBody, ListPane } from "../components/list-pane.js"
import { C } from "../theme.js"
import { usePaged } from "./use-paged.js"
import {
  actionRow,
  albumRow,
  artistRow,
  descAlbum,
  descTrack,
  headerRow,
  tombstoneRow,
  trackRow,
  type RowItem,
} from "../rows.js"
import type { ViewProps } from "./types.js"

export function SearchView(
  p: ViewProps & {
    sel?: number
    textMode: boolean
    onTextMode: (on: boolean) => void
    /** 把「聚焦输入框」的入口注册给 MainScreen（/ 键重新进入输入态） */
    registerSearch?: (fn: (() => void) | null) => void
  },
) {
  const [query, setQuery] = useState("")
  const [result, setResult] = useState<SearchResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const inputRef = useRef<InputRenderable | null>(null)

  // 挂载即进入输入态（MainScreen 切到搜索分区时同步设了 textMode）
  useEffect(() => {
    inputRef.current?.focus()
    p.registerSearch?.(() => inputRef.current?.focus())
    return () => p.registerSearch?.(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅挂载时执行
  }, [])

  // textMode 关闭 → 焦点让给结果列表
  useEffect(() => {
    if (!p.textMode) inputRef.current?.blur()
  }, [p.textMode])

  const submit = (value: string): void => {
    const q = value.trim()
    if (q === "") {
      // 空查询：退出输入态转到结果区（否则用户卡在输入模式，全局键全被吞）
      p.onTextMode(false)
      return
    }
    if (busy) return
    setBusy(true)
    setError("")
    p.api
      .search(q)
      .then((r) => {
        setResult(r)
        p.onTextMode(false)
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false))
  }

  const options: SelectOption[] = []
  if (result !== null) {
    if (result.artists.length > 0) {
      options.push(headerRow(`艺人`))
      for (const a of result.artists) options.push(artistRow(a, `${a.albumCount} 张专辑 · ${a.trackCount} 曲`))
    }
    if (result.albums.length > 0) {
      options.push(headerRow("专辑"))
      for (const a of result.albums) {
        options.push(albumRow(a, { playing: a.id === p.player.current?.album.id }, descAlbum(a)))
      }
    }
    if (result.tracks.length > 0) {
      options.push(headerRow("曲目"))
      for (const t of result.tracks) {
        options.push(
          trackRow(t, { playing: t.id === p.player.current?.id, starred: p.stars.is(t) }, descTrack(t)),
        )
      }
    }
  }

  const empty =
    result === null
      ? "输入关键词回车搜索艺人、专辑、曲目"
      : "没有匹配结果——换个短一点的关键词"

  const activate = (item: RowItem): void => {
    if (item.kind === "track" && result !== null) {
      const idx = result.tracks.findIndex((t) => t.id === item.track.id)
      if (idx >= 0) p.player.play(result.tracks, idx)
    } else if (item.kind === "album") {
      p.drill({ kind: "album-tracks", album: item.album })
    } else if (item.kind === "artist") {
      p.drill({ kind: "artist", artist: item.artist })
    }
  }

  return (
    <box
      style={{
        flexGrow: 1,
        flexDirection: "column",
        border: true,
        borderColor: p.focused ? C.accent : C.line,
      }}
      title="搜索"
    >
      <box style={{ flexDirection: "row", height: 1, paddingLeft: 1, paddingRight: 1, gap: 1 }}>
        <text fg={p.textMode ? C.accent : C.dim}>❯</text>
        <box style={{ flexGrow: 1, flexDirection: "row" }}>
          <input
            ref={(r) => {
              inputRef.current = r
            }}
            style={{ width: "100%" }}
            value={query}
            onInput={setQuery}
            onSubmit={(value) => submit(String(value))}
            placeholder="艺人 / 专辑 / 曲目…"
          />
        </box>
        <text fg={C.faint}>{busy ? "搜索中…" : result !== null ? `${result.artistCount + result.albumCount + result.trackCount} 条结果` : "回车检索"}</text>
      </box>
      <box style={{ flexGrow: 1, flexDirection: "column" }}>
        <ListBody
          options={options}
          focused={p.focused}
          interactive={p.interactive}
          initialSel={p.sel}
          error={error}
          empty={empty}
          register={p.registerList}
          onSelectionChange={p.reportSel}
          onActivate={activate}
        />
      </box>
    </box>
  )
}

function TrackListView(
  p: ViewProps & {
    sel?: number
    title: string
    tracks: TrackSummary[]
    loading: boolean
    error: string
    empty: string
    desc?: (t: TrackSummary) => string
    onNearEnd?: () => void
    total?: number
  },
) {
  const options = p.tracks.map((t) =>
    trackRow(t, { playing: t.id === p.player.current?.id, starred: p.stars.is(t) }, (p.desc ?? descTrack)(t)),
  )
  return (
    <ListPane
      title={p.title}
      options={options}
      focused={p.focused}
      interactive={p.interactive}
      initialSel={p.sel}
      loading={p.loading}
      error={p.error}
      empty={p.empty}
      total={p.total}
      onNearEnd={p.onNearEnd}
      register={p.registerList}
      onSelectionChange={p.reportSel}
      onActivate={(item: RowItem, index: number) => {
        if (item.kind === "track") p.player.play(p.tracks, index)
      }}
    />
  )
}

export function FavoritesView(p: ViewProps & { sel?: number }) {
  const page = usePaged((offset: number) => p.api.starredTracks(200, offset))
  return (
    <TrackListView
      {...p}
      title={`收藏 · ${page.total ?? "…"}`}
      tracks={page.items}
      loading={page.loading}
      error={page.error}
      empty="还没有收藏——播放时按 s 或点播放条的 ★ 收藏喜欢的曲目"
      total={page.total}
      onNearEnd={page.loadMore}
    />
  )
}

export function RecentView(p: ViewProps & { sel?: number }) {
  const [entries, setEntries] = useState<PlayEntry[]>([])
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    p.api
      .recentPlays()
      .then(setEntries)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 挂载时加载
  }, [])
  // 墓碑行（track null）保留在叙事里；播放上下文只含活曲，索引按活曲表换算
  const alive = entries.flatMap((entry) => (entry.track !== null ? [entry.track] : []))
  const options = entries.map((entry) =>
    entry.track !== null
      ? trackRow(
          entry.track,
          { playing: entry.track.id === p.player.current?.id, starred: p.stars.is(entry.track) },
          `${descTrack(entry.track)} · ${formatPlayedAt(entry.playedAt)}`,
        )
      : tombstoneRow(entry),
  )
  return (
    <ListPane
      title={`最近播放 · ${entries.length}`}
      options={options}
      focused={p.focused}
      interactive={p.interactive}
      initialSel={p.sel}
      loading={loading}
      error={error}
      empty="还没有播放记录——去听点什么吧"
      register={p.registerList}
      onSelectionChange={p.reportSel}
      onActivate={(item: RowItem, index: number) => {
        if (item.kind !== "track") return
        const aliveIndex = alive.findIndex((t) => t.id === item.track.id)
        if (aliveIndex >= 0) p.player.play(alive, aliveIndex)
      }}
    />
  )
}

const PERIOD_LABEL: Record<Period, string> = { all: "全部", month: "本月", year: "本年" }

export function MostPlayedView(p: ViewProps & { sel?: number }) {
  const [period, setPeriod] = useState<Period>("all")
  const [items, setItems] = useState<MostPlayedTrack[]>([])
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    p.api
      .mostPlayedTracks(period)
      .then(setItems)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 时段变化重取
  }, [period])

  // m 键：切换统计时段（本视图挂载期间才生效；MainScreen 不处理 m）
  useKeyboard((key) => {
    if (key.name !== "m") return
    setPeriod((cur) => (cur === "all" ? "month" : cur === "month" ? "year" : "all"))
  })

  const options = items.map((entry, i) =>
    trackRow(
      entry.track,
      { playing: entry.track.id === p.player.current?.id, starred: p.stars.is(entry.track), no: String(i + 1) },
      `${entry.playCount} 次 · ${formatDuration(entry.listenedSeconds)} 累计 · ${descTrack(entry.track)}`,
    ),
  )
  return (
    <ListPane
      title={`最常播放 · ${PERIOD_LABEL[period]}（m 切换）`}
      options={options}
      focused={p.focused}
      interactive={p.interactive}
      initialSel={p.sel}
      loading={loading}
      error={error}
      empty="这个时段还没有播放记录"
      register={p.registerList}
      onSelectionChange={p.reportSel}
      onActivate={(_item: RowItem, index: number) => {
        p.player.play(
          items.map((e) => e.track),
          index,
        )
      }}
    />
  )
}

export function PlaylistsView(p: ViewProps & { sel?: number }) {
  const [lists, setLists] = useState<PlaylistSummary[]>([])
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    p.api
      .playlists()
      .then(setLists)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 挂载时加载
  }, [])
  const options = lists.map((pl) =>
    actionRow(
      pl.name,
      `${pl.songCount} 曲 · ${formatDuration(pl.durationSeconds)} · ${pl.owner}${pl.isPublic ? " · 公开" : ""}`,
    ),
  )
  return (
    <ListPane
      title={`播放列表 · ${lists.length}`}
      options={options}
      focused={p.focused}
      interactive={p.interactive}
      initialSel={p.sel}
      loading={loading}
      error={error}
      empty="还没有播放列表——在 Web 端创建后这里可以直接播放"
      register={p.registerList}
      onSelectionChange={p.reportSel}
      onActivate={(item: RowItem, index: number) => {
        if (item.kind === "action" && lists[index] !== undefined) {
          p.drill({ kind: "playlist-tracks", playlist: lists[index]! })
        }
      }}
    />
  )
}

export function PlaylistTracksView(p: ViewProps & { playlist: PlaylistSummary; sel?: number }) {
  const [tracks, setTracks] = useState<TrackSummary[]>([])
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    p.api
      .playlistTracks(p.playlist.id)
      .then(setTracks)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 列表固定
  }, [])
  return (
    <TrackListView
      {...p}
      title={`${p.playlist.name} · ${p.playlist.owner}`}
      tracks={tracks}
      loading={loading}
      error={error}
      empty="播放列表是空的——在 Web 端往里添加曲目"
    />
  )
}

export function QueueView(p: ViewProps & { sel?: number }) {
  const snap = p.player.queueSnapshot()
  const options = snap.queue.map((t, i) =>
    trackRow(
      t,
      { playing: i === snap.index, starred: p.stars.is(t) },
      `${descTrack(t)} · 队列 ${i + 1}/${snap.queue.length}`,
    ),
  )
  return (
    <ListPane
      title={`队列 · ${snap.queue.length} 曲${p.player.shuffle ? " · 随机" : ""}${p.player.repeat !== "off" ? ` · 循环${p.player.repeat === "one" ? "单曲" : ""}` : ""}`}
      options={options}
      focused={p.focused}
      interactive={p.interactive}
      initialSel={p.sel ?? snap.index}
      empty="队列为空——选一张专辑或搜索结果回车起播"
      register={p.registerList}
      onSelectionChange={p.reportSel}
      onActivate={(_item: RowItem, index: number) => {
        p.player.jumpTo(index)
      }}
    />
  )
}

export function RandomView(p: ViewProps) {
  const [busy, setBusy] = useState(false)
  const play = (): void => {
    if (busy) return
    setBusy(true)
    p.api
      .randomTracks(50)
      .then((tracks) => {
        if (tracks.length === 0) {
          p.toast("曲库为空，没有可随机的曲目")
          return
        }
        p.player.play(tracks, 0)
        p.toast(`随机队列 · ${tracks.length} 首`)
      })
      .catch((e: unknown) => p.toast(`随机播放失败: ${e instanceof Error ? e.message : String(e)}`, "error"))
      .finally(() => setBusy(false))
  }
  return (
    <ListPane
      title="随机播放"
      options={[actionRow("把整个曲库洗进队列", "回车或点击 · 随机取 50 首立即播放 · 再按一次重新洗")]}
      focused={p.focused}
      interactive={p.interactive}
      empty="曲库为空"
      register={p.registerList}
      onActivate={play}
    />
  )
}
