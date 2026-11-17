import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import { createRoot } from "react-dom/client"
import { AgentConversation } from "@/agent/conversation"
import { StudioWelcome } from "@/agent/studio-identity"
import { useAgentStore } from "@/agent/store"
import { connect, nativeEvents, tell } from "./bridge"
import "@/index.css"
import "@/agent/studio.css"

// Android owns the full-page surface; the shared store retains drafts when the page closes.
function Workspace() {
  const sessions=useAgentStore(s=>s.sessions), active=useAgentStore(s=>s.activeId)
  const error=useAgentStore(s=>s.error), busy=useAgentStore(s=>s.busy)
  const status=useAgentStore(s=>s.questions.length ? '等待你回答' : '正在回复…')
  const [loading,setLoading]=useState(true), [creating,setCreating]=useState(false)
  const live=useRef(false)
  const store=useAgentStore.getState
  useEffect(()=>{
    live.current=true;store().setPageActive(true)
    void store().refreshSessions().then(()=>{if(live.current){setLoading(false);if(store().activeId)void store().refreshThread()}})
    return ()=>{live.current=false;store().setPageActive(false)}
  },[store])
  useEffect(()=>{if(!loading && !active && sessions[0] && !creating)void store().select(sessions[0].id)},[active,sessions,creating,loading,store])
  async function create(){
    if(creating)return
    setCreating(true)
    const id=await store().newSession()
    if(live.current){if(id)await store().select(id);setCreating(false)}
  }
  return <section className="music-studio studio-body flex h-full min-h-0 flex-col" aria-label="对话">
    <div className="flex shrink-0 items-center gap-2 border-b border-line px-2">
      <select aria-label="切换会话" value={active ?? ""} disabled={creating || loading || !sessions.length}
        className="min-w-0 flex-1 truncate bg-shell py-2 text-sm text-paper" onChange={e=>void store().select(e.target.value)}>
        {!active && <option value="">{loading ? "正在读取会话…" : "选择会话"}</option>}
        {sessions.map(s=><option key={s.id} value={s.id}>{s.title || "未命名会话"}</option>)}
      </select>
      {busy && <span role="status" className="text-xs text-dim">{status}</span>}
      <button className="p-2 text-sm text-accent" disabled={creating || loading} onClick={()=>void create()}>新对话</button>
    </div>
    {active ? <AgentConversation key={active} session={active} showKeyboardHints={false}/> : <div className="studio-thread overflow-y-auto">
      {error ? <p role="alert">{error} <button className="underline" onClick={()=>void store().refreshSessions()}>重新读取</button></p> :
        loading ? "正在读取会话…" : <StudioWelcome onCreate={()=>void create()} creating={creating}/>}
    </div>}
  </section>
}
let visible=false
function subscribe(fn:()=>void){nativeEvents.addEventListener("visibility",fn);return ()=>nativeEvents.removeEventListener("visibility",fn)}
function App(){return useSyncExternalStore(subscribe,()=>visible) ? <Workspace/> : null}
connect(()=>{
  nativeEvents.addEventListener("visibility",e=>{visible=(e as CustomEvent).detail === true})
  window.addEventListener("om:unauthorized",()=>{useAgentStore.getState().reset();tell("expired")})
  document.addEventListener("click",e=>{const a=(e.target as Element)?.closest?.("a");if(!a)return
    e.preventDefault();if(e.isTrusted)tell("link",{href:a.getAttribute("href")})})
  createRoot(document.getElementById("root")!).render(<App/>)
})
