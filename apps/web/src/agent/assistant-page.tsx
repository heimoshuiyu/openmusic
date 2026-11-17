import { useEffect, useRef, useState } from "react"
import { Link, useNavigate, useRouter } from "@tanstack/react-router"
import { ArrowLeft, PanelLeft, PictureInPicture2, Plus, X } from "lucide-react"
import type { AgentSessionDto } from "@/api/client"
import { useAgentStore } from "./store"
import { AgentConversation } from "./conversation"
import { AssistantFrame } from "./assistant-frame"
import { StudioWelcome } from "./studio-identity"
import { Wordmark } from "@/components/identity"

function SessionList({ sessions, selected, creating, onCreate, onPick }: {
  sessions: readonly AgentSessionDto[]; selected?: string | undefined; creating: boolean; onCreate: () => void; onPick: () => void
}) {
  return <>
    <button type="button" className="studio-new" disabled={creating} onClick={onCreate}>
      {creating ? "正在新建…" : "新对话"}<Plus size={16}/>
    </button>
    <h2 className="studio-index-title">会话索引 <span>{sessions.length}</span></h2>
    <nav aria-label="会话列表" className="studio-index min-h-0 flex-1 overflow-y-auto">
      {sessions.map((s,i) => <Link key={s.id} to="/assistant" search={{session:s.id}} onClick={onPick}
        aria-current={s.id===selected ? "page" : undefined} title={s.title || "未命名会话"}
        className="studio-index-link" data-selected={s.id===selected || undefined}>
        <span aria-hidden="true" className="studio-index-no">[{String(sessions.length-i).padStart(2,"0")}]</span><span className="truncate">{s.title || "未命名会话"}</span>
      </Link>)}
      {!sessions.length && <p className="px-3 py-1 text-xs text-faint">暂无历史会话</p>}
    </nav>
  </>
}

export function AssistantPage({floating, routeSession, onFloat, onClose}: {floating:boolean; routeSession:string|undefined; onFloat:()=>void; onClose:()=>void}) {
  const navigate = useNavigate()
  const router = useRouter()
  const sessions = useAgentStore(s=>s.sessions), activeId = useAgentStore(s=>s.activeId)
  const session = (!floating && routeSession) || activeId || undefined
  const error = useAgentStore(s=>s.error), busy = useAgentStore(s=>s.busy)
  const status = useAgentStore(s=>s.questions.length ? '等待你回答' : '正在回复…')
  const {select, refreshSessions, setPageActive, newSession} = useAgentStore.getState()
  const [ready,setReady] = useState(false), [creating,setCreating] = useState(false)
  const live = useRef(false), createLock = useRef(false), dialog = useRef<HTMLDialogElement>(null)
  useEffect(()=>{
    let disposed=false
    live.current=true; setPageActive(true)
    void refreshSessions().then(()=>{if (!disposed) setReady(true)})
    return ()=>{ disposed=true; live.current=false; setPageActive(false) }
  },[refreshSessions,setPageActive])
  useEffect(()=>{
    if (!floating && routeSession) void select(routeSession)
  },[floating,routeSession,select])
  useEffect(()=>{
    if (!ready || creating || (floating ? activeId : routeSession) || !sessions.length) return
    const last = sessions.find(s=>s.id===activeId) ?? sessions[0]!
    if (floating) void select(last.id)
    else void navigate({to:"/assistant",search:{session:last.id},replace:true})
  },[floating,ready,creating,routeSession,sessions,activeId,navigate,select])
  useEffect(()=>{
    const desktop=window.matchMedia("(min-width: 768px)")
    const resized=()=>{if(desktop.matches)dialog.current?.close()}
    desktop.addEventListener("change",resized);return ()=>desktop.removeEventListener("change",resized)
  },[])
  async function create() {
    if (createLock.current) return
    createLock.current=true;setCreating(true)
    try {
      const id = await newSession()
      if (live.current && id) {
        dialog.current?.close()
        // The user can expand the window while the POST is still in flight.
        if (router.state.location.pathname.replace(/\/$/, "") === "/assistant") await navigate({to:"/assistant",search:{session:id}})
        else await select(id)
      }
    } finally {createLock.current=false;if(live.current)setCreating(false)}
  }
  const listProps={sessions,selected:session,creating:creating||!ready,onCreate:()=>void create(),onPick:()=>dialog.current?.close()}
  const selected = sessions.find(s=>s.id===session)
  return <AssistantFrame floating={floating} onClose={onClose} onExpand={()=>void navigate({to:"/assistant",search:activeId ? {session:activeId} : {}})}>
    <div className="flex min-h-0 flex-1 bg-shell">
    {!floating && <aside aria-label="会话导航" className="studio-rail hidden shrink-0 flex-col md:flex">
      <Link to="/" className="studio-brand" title="返回音乐库" aria-label="OpenMusic · 返回音乐库"><Wordmark/></Link>
      <SessionList {...listProps}/>
      <Link to="/" className="studio-back"><ArrowLeft size={15}/>返回音乐库</Link>
    </aside>}
    {!floating && <dialog ref={dialog} aria-label="选择会话" className="m-0 h-full max-h-full w-72 max-w-[85vw] border-r border-line bg-panel p-0 text-paper backdrop:bg-black/60" onClick={e=>{
      if(e.target===dialog.current && e.clientX>dialog.current!.getBoundingClientRect().right)dialog.current?.close()
    }}>
      <div className="flex h-full flex-col"><div className="flex h-14 shrink-0 items-center justify-between border-b border-line/60 px-4">
        <Link to="/" className="flex items-center gap-2 text-sm"><ArrowLeft size={16}/>返回音乐库</Link>
        <button type="button" aria-label="关闭会话列表" className="p-3" onClick={()=>dialog.current?.close()}><X size={18}/></button>
      </div><SessionList {...listProps}/></div>
    </dialog>}
    <section aria-label="音乐助手" className="studio-body flex min-h-0 min-w-0 flex-1 flex-col">
      {floating ? <div className="flex shrink-0 items-center gap-2 border-b border-line/60 pl-3 pr-1.5">
        <select aria-label="切换会话" className="min-w-0 flex-1 truncate bg-shell py-2 text-xs text-dim" value={activeId ?? ""} disabled={!ready || !sessions.length || creating} onChange={e=>void select(e.target.value)}>
          {!activeId && <option value="">{ready ? "选择会话" : "正在读取会话…"}</option>}
          {sessions.map(s=><option key={s.id} value={s.id}>{s.title || "未命名会话"}</option>)}
        </select>
        {busy && <span role="status" className="shrink-0 text-xs text-dim">{status}</span>}
        <button type="button" aria-label="新对话" title="新对话" className="grid size-10 place-items-center text-dim hover:bg-raised" disabled={listProps.creating} onClick={listProps.onCreate}><Plus size={16}/></button>
      </div> : <header className="studio-head"><div className="studio-measure">
        <div className="studio-toolbar">
          <button type="button" aria-label="打开会话列表" aria-haspopup="dialog" className="py-2 pr-2 text-dim md:hidden" onClick={()=>dialog.current?.showModal()}><PanelLeft size={18}/></button>
          <span>音乐助手</span>{selected?.createdAt && <time dateTime={selected.createdAt}>/ {selected.createdAt.slice(0,10)}</time>}
          {busy && activeId===session && <span role="status" className="studio-status">{status}</span>}
          <button type="button" aria-label="切换到小窗" disabled={creating} title="切换到小窗" className="studio-pop" onClick={onFloat}><PictureInPicture2 size={16}/><span>小窗</span></button>
        </div>
        <h1 title={selected?.title} className="truncate">{selected?.title || (session ? "未命名会话" : "新对话")}</h1>
        </div>
      </header>}
      {session && activeId===session ? <AgentConversation key={session} session={session}/> : <div className="studio-thread min-h-0 overflow-y-auto"><div className="studio-measure">
        {ready && !session && !sessions.length && !error ? <StudioWelcome onCreate={listProps.onCreate} creating={creating}/> : <p className="py-4 text-sm text-dim">{error || "正在读取会话…"} {error && <button type="button" className="underline" onClick={()=>void refreshSessions()}>重新读取</button>}</p>}
        </div>
      </div>}
    </section>
  </div></AssistantFrame>
}
