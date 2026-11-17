import { useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { GripVertical, Maximize2, X } from "lucide-react"
import { windowBounds, type Point, type Viewport } from "./window-bounds"
import "./studio.css"

// Only geometry is kept in tab storage. Never persist the conversation or draft here.
const positionKey = "om:assistant-window-position"
function savedPosition(): Point | null {
  try {
    const p = JSON.parse(sessionStorage.getItem(positionKey) ?? "null")
    return p && Number.isFinite(p.x) && Number.isFinite(p.y) ? { x: p.x, y: p.y } : null
  } catch { return null }
}
function viewport(): Viewport {
  const v = window.visualViewport
  return { left: v?.offsetLeft ?? 0, top: v?.offsetTop ?? 0, width: v?.width ?? window.innerWidth,
    height: v?.height ?? window.innerHeight, playerTop: document.querySelector("footer")?.getBoundingClientRect().top ?? window.innerHeight }
}

const control = "grid size-10 shrink-0 place-items-center rounded-md text-dim hover:bg-raised hover:text-paper"

/** Keep the same content subtree when docking: no second microphone, composer or scroll anchor. */
export function AssistantFrame({ floating, onExpand, onClose, children }: {
  floating: boolean; onExpand: () => void; onClose: () => void; children: ReactNode
}) {
  const [view, setView] = useState(viewport)
  const [position, setPosition] = useState(savedPosition)
  const drag = useRef<{id:number; dx:number; dy:number} | null>(null)
  const grip = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (!floating) return
    const update = () => setView(viewport())
    update()
    // Don't steal the caret from an existing composer when changing display mode.
    if (!frame.current?.contains(document.activeElement)) grip.current?.focus({preventScroll:true})
    window.addEventListener("resize", update)
    window.visualViewport?.addEventListener("resize", update)
    window.visualViewport?.addEventListener("scroll", update)
    return () => {
      drag.current = null
      window.removeEventListener("resize", update)
      window.visualViewport?.removeEventListener("resize", update)
      window.visualViewport?.removeEventListener("scroll", update)
    }
  }, [floating])
  const bounds = windowBounds(view, position)
  function move(x: number, y: number, save: boolean) {
    const {left,top} = windowBounds(view, {x,y})
    const next = {x:left,y:top}
    setPosition(next)
    if (save) try { sessionStorage.setItem(positionKey, JSON.stringify(next)) } catch { /* optional preference */ }
  }
  return <div ref={frame} role={floating ? "dialog" : "main"} aria-label={floating ? "音乐助手小窗" : "音乐助手页面"}
    style={floating ? bounds : undefined}
    data-view={floating ? "window" : "page"}
    className={`music-studio ${floating ? "studio-window fixed z-[60] flex flex-col overflow-hidden" : "relative z-10 flex min-h-0 flex-1 flex-col pb-[4.375rem]"}`}>
    {floating && <header className="studio-window-bar flex shrink-0 items-center gap-0.5 px-1.5">
      <div ref={grip} tabIndex={0} aria-label="移动小窗，可拖动或使用方向键" title="拖动标题栏移动，或使用方向键"
        className="flex min-h-11 min-w-0 flex-1 cursor-grab touch-none select-none items-center gap-1.5 rounded px-1.5 text-sm font-medium active:cursor-grabbing"
        onPointerDown={e => {
          if (!e.isPrimary || e.button !== 0) return
          e.currentTarget.setPointerCapture(e.pointerId)
          drag.current = {id:e.pointerId, dx:e.clientX-bounds.left, dy:e.clientY-bounds.top}
        }}
        onPointerMove={e => { const d=drag.current; if (d?.id === e.pointerId) move(e.clientX-d.dx,e.clientY-d.dy,false) }}
        onPointerUp={e => { const d=drag.current; if (d?.id === e.pointerId) move(e.clientX-d.dx,e.clientY-d.dy,true) }}
        onLostPointerCapture={() => {drag.current=null}}
        onKeyDown={e => {
          const step = e.shiftKey ? 48 : 12
          const delta: Record<string,Point> = {ArrowLeft:{x:-step,y:0},ArrowRight:{x:step,y:0},ArrowUp:{x:0,y:-step},ArrowDown:{x:0,y:step}}
          const d=delta[e.key]; if(d){e.preventDefault();move(bounds.left+d.x,bounds.top+d.y,true)}
        }}>
        <GripVertical size={16}/><b className="studio-window-name">openmusic</b> / 音乐助手
      </div>
      <button type="button" className={control} aria-label="展开为全屏对话" title="展开为全屏对话" onClick={onExpand}><Maximize2 size={16}/></button>
      <button type="button" className={control} aria-label="关闭小窗" title="关闭小窗" onClick={onClose}><X size={18}/></button>
    </header>}
    {children}
  </div>
}
