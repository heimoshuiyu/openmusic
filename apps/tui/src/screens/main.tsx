/**
 * 主屏：顶栏（上下文）+ 导航轨（9 分区）+ 内容（视图栈）+ 播放面板 + 状态行。
 *
 * 导航模型：stack[0] = 分区根视图，钻入（专辑曲目/艺人页/列表曲目）压栈，
 * ←/Esc 弹栈；选中行写回视图条目（返回时恢复位置）。
 *
 * 全局键位在此统一处理。textMode（搜索输入期间）必须整段让路——
 * useKeyboard 订阅底层 emitter，聚焦 input 时照样触发（AGENTS 实录）。
 * mini 模式（窗口过小）只保留播放键。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react"
import type { OmApi, ScanStatus } from "../api.js"
import type { Player } from "../player.js"
import { StarOverlay } from "../star-overlay.js"
import { C } from "../theme.js"
import { usePlayerTick } from "../use-player-tick.js"
import { HelpOverlay } from "../components/help-overlay.js"
import { NavRail, SECTIONS, type SectionId } from "../components/nav-rail.js"
import { PlayerBar } from "../components/player-bar.js"
import type { ListHandle } from "../components/list-pane.js"
import {
  AlbumTracksView,
  AlbumsView,
  ArtistView,
  ArtistsView,
} from "../views/library.js"
import {
  FavoritesView,
  MostPlayedView,
  PlaylistsView,
  PlaylistTracksView,
  QueueView,
  RandomView,
  RecentView,
  SearchView,
} from "../views/collections.js"
import { sectionRoot, type View, type ViewProps } from "../views/types.js"

const REPEAT_LABEL = { off: "关", all: "全部", one: "单曲" } as const

export function MainScreen({
  api,
  player,
  interactive,
  username,
  host,
}: {
  api: OmApi
  player: Player
  /** false = mini 模式（本树隐藏）：不抢焦点、不吃鼠标，只留播放键 */
  interactive: boolean
  username: string
  host: string
}) {
  const [stack, setStack] = useState<View[]>([{ kind: "albums" }])
  const [focusPane, setFocusPane] = useState<"rail" | "content">("content")
  const [toast, setToast] = useState<{ message: string; kind: "info" | "error" } | null>(null)
  const [helpOpen, setHelpOpen] = useState(false)
  const [textMode, setTextMode] = useState(false)
  const [scan, setScan] = useState<ScanStatus | null>(null)
  const listRef = useRef<ListHandle | null>(null)
  const textEntryRef = useRef<(() => void) | null>(null)
  const stars = useMemo(() => new StarOverlay(api), [api])
  const renderer = useRenderer()
  const dims = useTerminalDimensions()
  usePlayerTick(player)

  const view = stack[stack.length - 1]!
  const section = stack[0]!.kind as SectionId

  // —— toast：4 秒自动消退 ——
  const toastAt = useRef(0)
  const showToast = useCallback((message: string, kind: "info" | "error" = "info") => {
    toastAt.current = Date.now()
    setToast({ message, kind })
  }, [])
  useEffect(() => {
    if (toast === null) return
    const id = setTimeout(() => setToast(null), 4000)
    return () => clearTimeout(id)
  }, [toast])

  // —— 扫描状态轮询（登录即可查；扫描中顶栏亮红提示） ——
  useEffect(() => {
    let stopped = false
    const poll = () => {
      api
        .scanStatus()
        .then((s) => {
          if (!stopped) setScan(s)
        })
        .catch(() => {})
    }
    poll()
    const id = setInterval(poll, 15000)
    return () => {
      stopped = true
      clearInterval(id)
    }
  }, [api])

  // —— 导航动作 ——
  const switchSection = useCallback((id: SectionId) => {
    setStack([sectionRoot(id)])
    setHelpOpen(false)
    setTextMode(id === "search")
    setFocusPane("content")
  }, [])

  const drill = useCallback((next: View) => {
    setStack((s) => [...s, next])
    setFocusPane("content")
  }, [])

  const back = useCallback(() => {
    setStack((s) => (s.length > 1 ? s.slice(0, -1) : s))
  }, [])

  /** 选中行写回栈顶视图（返回导航恢复位置） */
  const reportSel = useCallback((sel: number) => {
    setStack((s) => {
      const top = s[s.length - 1]!
      if (top.sel === sel) return s
      const copy = [...s]
      copy[copy.length - 1] = { ...top, sel } as View
      return copy
    })
  }, [])

  const registerList = useCallback((handle: ListHandle | null) => {
    listRef.current = handle
  }, [])

  // —— 收藏（全局 s）：优先选中行，否则正在播放曲 ——
  const starAction = () => {
    const handle = listRef.current
    const selected = handle?.select?.getSelectedIndex() ?? -1
    const item = handle?.itemAt(selected)
    const target = item?.kind === "track" ? item.track : player.current
    if (target === null || target === undefined) {
      showToast("没有可收藏的曲目（列表选中一行或先播放）")
      return
    }
    void stars.toggle(target).then(({ next, ok }) => {
      showToast(
        ok ? (next ? `已收藏 ${target.title}` : `已取消收藏 ${target.title}`) : "收藏失败（服务端错误）",
        ok ? "info" : "error",
      )
    })
  }

  const quit = () => {
    player.dispose()
    renderer.destroy()
    setTimeout(() => process.exit(0), 150)
  }

  // —— 全局键位 ——
  useKeyboard((key) => {
    const name = key.name
    if (textMode) {
      // 输入期间只有 Esc 能退出（SearchView 的 Enter 走 input.onSubmit）
      if (name === "escape") setTextMode(false)
      return
    }
    if (helpOpen) {
      if (name === "escape" || name === "?") setHelpOpen(false)
      return
    }

    // mini 模式：只保留播放控制
    if (!interactive) {
      switch (name) {
        case "space":
          player.toggle()
          break
        case "n":
          player.next()
          break
        case "p":
          player.prev()
          break
        case ",":
          player.seekBy(-10)
          break
        case ".":
          player.seekBy(10)
          break
        case "+":
        case "=":
          player.volumeUp()
          break
        case "-":
          player.volumeDown()
          break
        case "z":
          player.toggleShuffle()
          break
        case "r":
          player.cycleRepeat()
          break
        case "x":
          player.stop()
          break
        case "q":
          quit()
          break
      }
      return
    }

    switch (name) {
      case "tab":
        setFocusPane((f) => (f === "rail" ? "content" : "rail"))
        break
      case "left":
      case "h":
        if (stack.length > 1) back()
        else setFocusPane("rail")
        break
      case "right":
      case "l":
        if (focusPane === "rail") {
          setFocusPane("content")
        } else {
          // 钻入当前选中行（容器类：专辑/艺人；曲目行 = Enter 同效）
          const handle = listRef.current
          const selected = handle?.select?.getSelectedIndex() ?? -1
          const item = handle?.itemAt(selected)
          if (item !== null && item !== undefined && item.kind !== "header" && item.kind !== "action") {
            handle?.activate(selected)
          }
        }
        break
      case "escape":
        if (stack.length > 1) back()
        else setFocusPane("rail")
        break
      case "space":
        player.toggle()
        break
      case "n":
        player.next()
        break
      case "p":
        player.prev()
        break
      case ",":
        player.seekBy(-10)
        break
      case ".":
        player.seekBy(10)
        break
      case "+":
      case "=":
        player.volumeUp()
        break
      case "-":
        player.volumeDown()
        break
      case "s":
        starAction()
        break
      case "z":
        player.toggleShuffle()
        showToast(player.shuffle ? "随机：开（下一首随机跳）" : "随机：关")
        break
      case "r": {
        const mode = player.cycleRepeat()
        showToast(`循环：${REPEAT_LABEL[mode]}`)
        break
      }
      case "d": {
        if (view.kind !== "queue") break
        const handle = listRef.current
        const selected = handle?.select?.getSelectedIndex() ?? -1
        if (selected < 0) break
        const removed = player.removeAt(selected)
        if (removed !== null) showToast(`已从队列移除 ${removed.title}`)
        break
      }
      case "x":
        player.stop()
        break
      case "/":
        if (section === "search" && view.kind === "search") {
          setTextMode(true)
          textEntryRef.current?.()
        } else {
          switchSection("search")
        }
        break
      case "?":
        setHelpOpen(true)
        break
      case "g": {
        // 大写字母到达时 name 归一为小写 + shift=true（parse.keypress.ts）
        const handle = listRef.current
        if (handle === null || handle.count === 0) break
        if (key.shift) handle.select?.setSelectedIndex(handle.count - 1)
        else handle.select?.setSelectedIndex(0)
        break
      }
      case "home":
        if (listRef.current !== null && listRef.current.count > 0) {
          listRef.current.select?.setSelectedIndex(0)
        }
        break
      case "end":
        if (listRef.current !== null && listRef.current.count > 0) {
          listRef.current.select?.setSelectedIndex(listRef.current.count - 1)
        }
        break
      case "q":
        quit()
        break
      default: {
        // 1-9 跳分区
        const digit = Number(name)
        if (Number.isInteger(digit) && digit >= 1 && digit <= SECTIONS.length) {
          switchSection(SECTIONS[digit - 1]!.id)
        }
        break
      }
    }
  })

  // —— 视图公共 props ——
  const viewProps: ViewProps = {
    api,
    player,
    stars,
    focused: interactive && focusPane === "content" && !textMode && !helpOpen,
    interactive,
    drill,
    toast: showToast,
    registerList,
    reportSel,
  }

  const content = () => {
    if (helpOpen) return <HelpOverlay />
    switch (view.kind) {
      case "albums":
        return <AlbumsView {...viewProps} sel={view.sel} />
      case "album-tracks":
        return <AlbumTracksView {...viewProps} album={view.album} sel={view.sel} />
      case "artists":
        return <ArtistsView {...viewProps} sel={view.sel} />
      case "artist":
        return <ArtistView {...viewProps} artist={view.artist} sel={view.sel} />
      case "search":
        return (
          <SearchView
            {...viewProps}
            sel={view.sel}
            textMode={textMode}
            onTextMode={setTextMode}
            registerSearch={(fn) => {
              textEntryRef.current = fn
            }}
          />
        )
      case "favorites":
        return <FavoritesView {...viewProps} sel={view.sel} />
      case "recent":
        return <RecentView {...viewProps} sel={view.sel} />
      case "most":
        return <MostPlayedView {...viewProps} sel={view.sel} />
      case "playlists":
        return <PlaylistsView {...viewProps} sel={view.sel} />
      case "playlist-tracks":
        return <PlaylistTracksView {...viewProps} playlist={view.playlist} sel={view.sel} />
      case "queue":
        return <QueueView {...viewProps} sel={view.sel} />
      case "random":
        return <RandomView {...viewProps} />
    }
  }

  const statusMessage =
    player.errorText !== ""
      ? player.errorText
      : toast !== null
        ? toast.message
        : ""

  return (
    <box style={{ flexGrow: 1, flexDirection: "column" }}>
      {/* 顶栏：品牌 + 会话上下文 + 快捷提示 + 扫描指示 */}
      <box style={{ flexDirection: "row", gap: 1, paddingLeft: 1, alignItems: "center" }}>
        <text fg={C.accent} attributes={1}>
          OpenMusic
        </text>
        <text fg={C.faint}>·</text>
        <text fg={C.dim}>{`${username}@${host}`}</text>
        <box style={{ flexGrow: 1 }} />
        {scan?.state === "scanning" && (
          <text fg={C.accent}>
            {scan.phase === "walking"
              ? `扫描 遍历 ${scan.total}`
              : scan.total > 0 && scan.processed >= scan.total
                ? `扫描 收尾 ${scan.processed}/${scan.total}`
                : `扫描 ${scan.processed}/${scan.total}`}
          </text>
        )}
        <text fg={C.faint}>{"[/] 搜索 · [?] 键位 · [1-9] 分区"}</text>
      </box>

      {/* 内容区：导航轨 + 视图 */}
      <box style={{ flexGrow: 1, flexDirection: "row", gap: 1 }}>
        <NavRail
          section={section}
          focused={interactive && focusPane === "rail"}
          interactive={interactive}
          onSwitch={switchSection}
        />
        {content()}
      </box>

      {/* 播放面板 + 状态行 */}
      <PlayerBar player={player} stars={stars} width={dims.width} onToast={showToast} />
      <box style={{ height: 1, paddingLeft: 1 }}>
        <text
          fg={
            player.errorText !== ""
              ? C.danger
              : toast?.kind === "error"
                ? C.danger
                : C.faint
          }
        >
          {statusMessage}
        </text>
      </box>
    </box>
  )
}
