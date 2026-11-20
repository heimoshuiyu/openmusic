import { Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useRef, useState } from "react"
import {
  Bot,
  Download,
  Heart,
  Menu,
  X,
  ListMusic,
  PictureInPicture2,
  RefreshCw,
  Search,
  Settings2,
} from "lucide-react"
import { api } from "@/api/client"
import { useAgentStore } from "@/agent/store"
import { AssistantPage } from "@/agent/assistant-page"
import { Wordmark } from "@/components/identity"
import "./catalog.css"
import { PlayerBar } from "@/player/player-bar"
import { usePlayer } from "@/player/store"
import { NowPlaying } from "@/player/now-playing"
import { QueueDrawer } from "@/player/queue-drawer"

export function AppLayout() {
  const navigate = useNavigate()
  const location = useRouterState({select: s => s.location})
  const assistantPage = location.pathname.replace(/\/$/, "") === "/assistant"
  const href = location.href
  const session = location.search.session
  const menu = useRef<HTMLDialogElement>(null)
  useEffect(() => { menu.current?.close() }, [href])
  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 768px)")
    const dismiss = () => { if (desktop.matches) menu.current?.close() }
    desktop.addEventListener("change", dismiss)
    return () => desktop.removeEventListener("change", dismiss)
  }, [])
  const queryClient = useQueryClient()
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: api.me })
  const isAdmin = me?.isAdmin ?? false
  const [floatOwner, setFloatOwner] = useState<string | null>(null)
  const lastLibrary = useRef<{owner:string; href:string} | null>(null)
  useEffect(() => {
    if (assistantPage) {
      setFloatOwner(null)
      // Entry from a floating window over Now Playing must reveal the full conversation.
      usePlayer.setState({showNowPlaying:false,nowPlayingDrag:null,showQueue:false})
    }
    else if (me && href.startsWith("/") && !href.startsWith("//")) lastLibrary.current = {owner:me.id, href}
  }, [assistantPage, href, me?.id])
  function openWindow() {
    if (!me) return
    setFloatOwner(me.id)
    if (assistantPage) void navigate({href:lastLibrary.current?.owner === me.id ? lastLibrary.current.href : "/"})
  }
  const windowLauncher = <button type="button" data-assistant-launcher aria-label="打开助手小窗" title="打开助手小窗" aria-haspopup="dialog"
    onClick={openWindow} className="grid size-10 shrink-0 place-items-center rounded-md text-dim hover:bg-raised hover:text-paper"><PictureInPicture2 size={16}/></button>
  // Zustand and EventSource outlive this route. Clear both on logout, 401 redirects or
  // a change of identity in the same tab; navigating away keeps the conversation.
  useEffect(() => useAgentStore.getState().reset, [me?.id])
  const { data: playlists } = useQuery({
    queryKey: ["playlists"],
    queryFn: api.playlists,
    enabled: !!me,
  })

  // 扫描状态全局轮询（登录即可查）：任何页面都能看到进度。
  // 扫描中 1s；空闲 15s 心跳——捕捉其他客户端（TUI/Subsonic）触发的扫描。
  // 与管理页共用同一 query key，无重复请求
  const { data: scan } = useQuery({
    queryKey: ["scanStatus"],
    queryFn: api.scanStatus,
    enabled: !!me,
    refetchInterval: (query) => (query.state.data?.state === "scanning" ? 1000 : 15000),
  })
  // 扫描结束（scanning → idle）：曲库数据已变，全量失效让活跃页面自动刷新
  const prevScanState = useRef<string | null>(null)
  useEffect(() => {
    if (prevScanState.current === "scanning" && scan?.state === "idle") {
      queryClient.invalidateQueries()
    }
    prevScanState.current = scan?.state ?? null
  }, [scan?.state, queryClient])

  const scanning = scan?.state === "scanning"
  const scanLabel = !scanning
    ? null
    : scan?.phase === "walking"
      ? `已发现 ${(scan.total ?? 0).toLocaleString()} 个文件`
      : (scan?.total ?? 0) > 0 && (scan?.processed ?? 0) >= (scan?.total ?? 0)
        ? "收尾中…"
        : (scan?.total ?? 0) > 0
          ? `扫描中 ${Math.min(100, Math.round(((scan.processed ?? 0) / scan.total) * 100))}%`
          : "扫描中…"

  useEffect(() => {
    const handler = () => {
      queryClient.clear()
      navigate({ to: "/login" })
    }
    window.addEventListener("om:unauthorized", handler)
    return () => window.removeEventListener("om:unauthorized", handler)
  }, [navigate, queryClient])

  // A real page, not a second overlay. Repeated presses on this route keep the current conversation.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey && (event.key === "j" || event.key === "J")) {
        event.preventDefault()
        usePlayer.setState({showNowPlaying:false,nowPlayingDrag:null,showQueue:false})
        if (!assistantPage) void navigate({ to:"/assistant" })
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [assistantPage,navigate])

  const navClass = "catalog-nav-link"
  const libraryLinks = [ {to:"/", label:"首页"}, {to:"/artists", label:"艺人"}, {to:"/albums", label:"专辑"}, {to:"/tracks",label:"曲目"} ] as const
  const libraryNav = libraryLinks.map((item, i) => <Link key={item.to} to={item.to} activeOptions={{exact:item.to === "/"}} className={navClass}>
    <span aria-hidden="true" className="catalog-index">[{String(i+1).padStart(2,"0")}]</span>{item.label}
  </Link>)

  const sidebarSection = (label: string, content: React.ReactNode) => (
    <div className="mb-5">
      <div className="catalog-nav-title">{label}</div>
      {content}
    </div>
  )

  return (
    <div className="flex h-full flex-col">
      {!assistantPage && <div className="relative z-10 flex min-h-0 flex-1">
        {/* 桌面侧栏（Apple Music 式分区 + 播放列表） */}
        <aside className="catalog-rail hidden shrink-0 flex-col overflow-y-auto md:flex">
          <Link to="/" aria-label="OpenMusic 首页" className="catalog-brand"><Wordmark/></Link>

          {sidebarSection(
            "资料库",
            <nav className="flex flex-col gap-0.5">
              {libraryNav}
            </nav>,
          )}

          {sidebarSection(
            "工具",
            <nav className="flex flex-col gap-0.5">
              {[
                { to: "/search", label: "搜索", icon: Search },
                { to: "/favorites", label: "收藏", icon: Heart },
                { to: "/imports", label: "导入", icon: Download },
              ].map((item) => (
                <Link
                  key={item.to}
                  to={item.to}
                  className={navClass}
                >
                  <item.icon className="h-4 w-4" strokeWidth={1.75} />
                  {item.label}
                </Link>
              ))}
              <div className="flex items-center"><Link to="/assistant" className={`${navClass} min-w-0 flex-1`}>
                <Bot className="h-4 w-4" strokeWidth={1.75} />
                音乐助手
                <span className="tnum ml-auto text-[10px] text-faint">⌃J</span>
              </Link>{windowLauncher}</div>
            </nav>,
          )}

          {sidebarSection(
            "播放列表",
            <nav className="flex flex-col gap-0.5">
              <Link to="/playlists" className={navClass}>
                <ListMusic className="h-4 w-4" strokeWidth={1.75} />
                全部列表
              </Link>
              {(playlists ?? []).slice(0, 8).map((playlist) => (
                <Link
                  key={playlist.id}
                  to="/playlists/$id"
                  params={{ id: playlist.id }}
                  className="flex items-center gap-2.5 truncate rounded-md px-3 py-1.5 text-[13px] text-dim transition-colors hover:bg-raised/70 hover:text-paper [&.active]:bg-raised/60 [&.active]:text-paper"
                >
                  <span className="truncate">{playlist.name}</span>
                </Link>
              ))}
            </nav>,
          )}

          <div className="mt-auto">
            {scanning && scanLabel !== null && (
              <button
                type="button"
                className="mb-3 flex w-full items-center gap-2 rounded-md border border-line/60 px-2.5 py-1.5 text-left text-[11px] text-dim transition-colors hover:border-accent/40 hover:text-paper"
                onClick={() => {
                  if (isAdmin) navigate({ to: "/admin" })
                }}
                title={isAdmin ? "查看扫描详情" : "扫描进行中"}
              >
                <RefreshCw className="h-3 w-3 shrink-0 animate-spin" />
                <span className="tnum truncate">{scanLabel}</span>
              </button>
            )}
            {isAdmin && (
              <nav className="mb-3 flex flex-col gap-0.5">
                <Link to="/admin" className={navClass}>
                  <Settings2 className="h-4 w-4" strokeWidth={1.75} />
                  管理
                </Link>
              </nav>
            )}
            <div className="flex items-center gap-2 px-3 py-2 text-xs">
              <span className="truncate text-dim">{me ? me.username : ""}</span>
              <button
                type="button"
                className="shrink-0 text-faint transition-colors hover:text-paper"
                onClick={async () => {
                  await api.logout().catch(() => {})
                  queryClient.clear()
                  navigate({ to: "/login" })
                }}
              >
                登出
              </button>
            </div>
          </div>
        </aside>

        {/* 移动端顶栏 */}
        <header className="fixed inset-x-0 top-0 z-40 flex h-14 items-center gap-1 border-b border-line bg-shell px-3 md:hidden">
          <Link to="/" className="mr-auto" aria-label="OpenMusic 首页"><Wordmark/></Link>
          <Link to="/search" aria-label="搜索" className="grid size-10 place-items-center"><Search size={18}/></Link>
          {windowLauncher}
          <button type="button" aria-label="打开导航" aria-haspopup="dialog" className="grid size-10 place-items-center" onClick={()=>menu.current?.showModal()}><Menu size={20}/></button>
          {scanning && scanLabel !== null && (
            <button
              type="button"
              className="ml-auto flex h-11 shrink-0 items-center gap-1.5 rounded-md px-2 text-[11px] text-dim"
              onClick={() => {
                if (isAdmin) navigate({ to: "/admin" })
              }}
            >
              <RefreshCw className="h-3.5 w-3.5 shrink-0 animate-spin" />
              <span className="tnum whitespace-nowrap">{scanLabel}</span>
            </button>
          )}
        </header>
        <dialog ref={menu} aria-label="网站导航" className="catalog-menu">
          <div className="mb-3 flex items-center justify-between"><Wordmark/><button type="button" className="p-3" aria-label="关闭导航" onClick={()=>menu.current?.close()}><X size={18}/></button></div>
          <nav onClick={e=>{if((e.target as Element).closest('a')) menu.current?.close()}}>
            {libraryNav}
            {[{to:"/search",label:"搜索"},{to:"/favorites",label:"收藏"},{to:"/imports",label:"导入"},{to:"/playlists",label:"播放列表"},{to:"/assistant",label:"音乐助手"},...(isAdmin?[{to:"/admin",label:"管理"}]:[])].map(item=><Link key={item.to} to={item.to} className={navClass}>{item.label}</Link>)}
          </nav>
        </dialog>

        <main className="catalog-main min-w-0 flex-1 overflow-y-auto pb-28 pt-14 md:pt-0">
          <Outlet />
        </main>
      </div>}
      {me && (assistantPage || floatOwner === me.id) && <AssistantPage key={me.id} floating={!assistantPage} routeSession={typeof session === "string" && /^ses_[\w-]+$/.test(session) ? session : undefined} onFloat={openWindow} onClose={()=>{
        setFloatOwner(null)
        Array.from(document.querySelectorAll<HTMLButtonElement>("[data-assistant-launcher]")).find(b=>b.offsetWidth)?.focus({preventScroll:true})
      }}/>}
      <div className="relative z-30"><QueueDrawer /></div>
      <PlayerBar />
      <NowPlaying />
    </div>
  )
}
