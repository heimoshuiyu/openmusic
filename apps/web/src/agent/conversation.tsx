import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { flushSync } from "react-dom"
import { ArrowUp, ListEnd, Square } from "lucide-react"
import type { AgentDelivery } from "@/api/client"
import { useAgentStore } from "@/agent/store"
import { ActionCard } from "./action-card"
import { QuestionCard } from './question-card'
import { ToolGroup } from "./tool-group"
import { VoiceInput } from "./voice-input"
import { timelineRows } from "./timeline"
import { StudioWelcome } from "./studio-identity"

// Keep the Markdown parser off the music player's startup path.
const AssistantMarkdown = lazy(() => import("./assistant-markdown").then((m) => ({ default: m.AssistantMarkdown })))

/** Keyed by session: new selection gets a fresh scroll anchor and disposes any active recording. */
export function AgentConversation({session: activeId, showKeyboardHints = true}: {session:string; showKeyboardHints?: boolean}) {
  const entries = useAgentStore((s) => s.entries)
  const questions = useAgentStore(s=>s.questions)
  const rows = useMemo(() => timelineRows(entries,questions), [entries,questions])
  const busy = useAgentStore((s) => s.busy)
  const loading = useAgentStore((s) => s.loading)
  const sending = useAgentStore(s => s.sending)
  const pending = useAgentStore(s => s.pending)
  const error = useAgentStore((s) => s.error)
  const input = useAgentStore(s => s.drafts.get(activeId) ?? "")
  const setInput = (text:string) => useAgentStore.getState().setDraft(activeId, text)
  const [dictating, setDictating] = useState(false)
  const editor = useRef<HTMLTextAreaElement>(null)
  function insertTranscript(text: string) {
    const box = editor.current
    if (!box) return
    const start = box.selectionStart, end = box.selectionEnd
    const left = box.value.slice(0, start), right = box.value.slice(end)
    const space = (a: string, b: string) => /[a-z\d]$/i.test(a) && /^[a-z\d]/i.test(b) ? " " : ""
    const prefix = left + space(left, text) + text
    flushSync(() => setInput(prefix + space(text, right) + right))
    box.focus({ preventScroll: true }); box.setSelectionRange(prefix.length, prefix.length)
  }
  const threadRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const follow = useRef(true)
  const trackScroll = useCallback(() => {
    const thread = threadRef.current
    if (thread) follow.current = thread.scrollHeight - thread.clientHeight - thread.scrollTop < 40
  }, [])

  const { send, interrupt, changePending } = useAgentStore.getState()

  useEffect(() => {
    const thread = threadRef.current
    const content = contentRef.current
    if (!thread || !content) return
    // Markdown can commit its layout after the SSE update (lazy load, table/fence settling).
    const followEnd = () => { if (follow.current) thread.scrollTop = thread.scrollHeight }
    followEnd()
    const observer = new ResizeObserver(followEnd)
    observer.observe(content)
    observer.observe(thread)
    return () => observer.disconnect()
  }, [activeId])

  const submit = async (delivery:AgentDelivery="steer") => {
    const text = input.trim()
    if (text === "" || sending || loading || dictating || !activeId) return
    follow.current = true
    await send(text,delivery)
  }

  return (
    <>

      {/* 对话线程 */}
      <div ref={threadRef} onScroll={trackScroll} aria-label="对话记录" className="studio-thread min-h-0 flex-1 overflow-y-auto">
        <div ref={contentRef} className="studio-measure">
          {loading && <p className="text-xs text-dim">正在读取对话…</p>}
          {rows.length === 0 && !loading && !busy && (
            <StudioWelcome onPrompt={prompt=>{setInput(prompt);editor.current?.focus()}}/>
          )}
          {rows.map((row,i) => {
            const user = row.type === "user", start = user || !i || rows[i-1]?.type === "user"
            return <div key={row.id} className="studio-entry" data-start={start || undefined} data-author={user ? "user" : "assistant"}>
              {start && <span className="studio-author">{user ? "你" : "助手"}</span>}
              <div className="studio-content">{row.type === "group" ? <ToolGroup tools={row.tools} onToggle={trackScroll}/> :
                row.type === "action" ? <ActionCard entry={row}/> :
                row.type === 'question' ? <QuestionCard session={activeId} question={row.question}/> :
                row.type === 'answered' ? <dl className="studio-answers">{row.answered.map((a,i)=><div key={i}><dt>{a.prompt}</dt><dd>{a.answers.join('、')}</dd></div>)}</dl> :
                row.type === "assistant" ? <Suspense fallback={null}><AssistantMarkdown text={row.text} streaming={!!row.streaming}/></Suspense> :
                <p className="whitespace-pre-wrap break-words">{row.text}</p>}</div>
            </div>
          })}
          {error !== null && (
            <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">{error}</div>
          )}
        </div>
      </div>

      {/* 输入区 */}
      <div className="studio-dock shrink-0"><div className="studio-measure">
        {!!pending.length && <ul aria-label="待投递消息" className="mb-2 max-h-28 space-y-1 overflow-y-auto text-xs">
          {pending.map(item=><li key={item.id} className="flex items-center gap-2 border-l-2 border-line pl-2">
            <span className="shrink-0 text-dim">{item.delivery==="steer" ? "待补充" : "已排队"}</span>
            <span className="flex-1 truncate" title={item.text}>{item.text}</span>
            <button className="shrink-0 p-1" onClick={()=>void changePending(item.id,item.delivery==="queue"?"steer":"queue")}>{item.delivery==="queue"?"改为补充":"移到队列"}</button>
            <button className="p-1 text-dim" onClick={()=>void changePending(item.id,null)}>撤回</button>
          </li>)}
        </ul>}
        <div className="studio-editor relative flex items-end gap-0.5">
          <textarea
            ref={editor}
            aria-label="给音乐助手发消息"
            className="max-h-28 min-h-11 min-w-0 flex-1 resize-none bg-transparent px-2 py-3 text-sm text-paper outline-none placeholder:text-faint"
            rows={1}
            value={input}
            maxLength={20_000}
            placeholder={busy ? "补充当前任务…" : "问问曲库…"}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                void submit(busy && event.altKey ? "queue" : "steer")
              }
            }}
          />
          {activeId && !loading && <VoiceInput key={activeId} session={activeId} insert={insertTranscript} onActive={setDictating} />}
          {busy && <button type="button" title="排到下一轮 (Alt+Enter)" aria-label="排到下一轮" disabled={!input.trim() || sending || loading || dictating}
            className="grid h-10 w-9 shrink-0 place-items-center rounded-md text-dim disabled:opacity-40" onClick={()=>void submit("queue")}><ListEnd size={17}/></button>}
          {busy && (
            <button
              type="button"
              title="停止生成"
              aria-label="停止生成"
              className="flex h-10 w-10 items-center justify-center rounded-md border border-line/60 text-dim transition-colors hover:text-accent"
              onClick={() => void interrupt()}
            >
              <Square className="h-4 w-4 fill-current" />
            </button>
          )}
            <button
              type="button"
              title={busy ? "补充当前任务 (Enter)" : "发送"}
              aria-label={busy ? "补充当前任务" : "发送"}
              className="studio-send flex h-10 w-10 shrink-0 items-center justify-center"
              disabled={input.trim() === "" || activeId === null || loading || dictating || sending}
              onClick={()=>void submit()}
            >
               <ArrowUp className="size-5" />
            </button>
        </div>
        {showKeyboardHints && <p className="studio-keys">{dictating ? <>录音最长 60 秒 <span><kbd>Esc</kbd> 取消</span></> : <><span><kbd>Enter</kbd> {busy ? "补充" : "发送"}</span>{busy && <span><kbd>Alt+Enter</kbd> 排队</span>}<span><kbd>Shift+Enter</kbd> 换行</span><span><kbd>F8</kbd> 听写</span></>}</p>}
      </div></div>
    </>
  )
}
