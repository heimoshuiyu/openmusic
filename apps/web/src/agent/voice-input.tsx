import { useEffect, useRef, useState } from "react"
import { Loader2, Mic, RotateCcw, Square, X } from "lucide-react"
import { api } from "@/api/client"
import { useAgentStore } from "./store"
import { VoiceScope } from "./voice-scope"
import "./voice-input.css"

type Job = { abort: AbortController; stream?: MediaStream; recorder?: MediaRecorder; timer?: number }
function release(job: Job) {
  window.clearTimeout(job.timer)
  if (job.recorder?.state === "recording") job.recorder.stop()
  job.stream?.getTracks().forEach(t => t.stop())
}

/** Mounted for a single open drawer/session; never apply an old permission grant or transcript. */
export function VoiceInput({ session, insert, onActive }: { session: string; insert: (s: string) => void; onActive: (v: boolean) => void }) {
  const current = useRef<Job | null>(null)
  const take = useRef<Blob | null>(null)
  const [phase, setPhase] = useState<"idle" | "permission" | "recording" | "upload" | "retry">("idle")
  const [notice, setNotice] = useState("")
  const recording = phase === "recording", processing = phase === "upload"
  const working = recording || processing || phase === "permission"
  useEffect(() => { onActive(working); return () => onActive(false) }, [working, onActive])
  const active = (job: Job) => current.current === job && useAgentStore.getState().open && useAgentStore.getState().activeId === session
  function cancel() {
    const job = current.current; current.current = null
    take.current = null
    if (job) { job.abort.abort(); release(job) }
  }
  useEffect(() => cancel, [])
  function discard() { cancel(); setPhase("idle"); setNotice("") }
  async function upload(job: Job, blob: Blob) {
    take.current = blob; setPhase("upload"); setNotice("")
    try {
      const text = await api.transcribe(session, blob, job.abort.signal)
      if (!active(job)) return
      discard()
      if (text.trim()) insert(text.trim())
      else setNotice("没有识别到文字，请重新录音。")
    } catch (e) {
      if (!active(job)) return
      setNotice(e instanceof Error ? e.message : "听写失败，请重试。")
      setPhase("retry") // Same take, in memory only; never retry a paid request automatically.
    }
  }
  async function start() {
    if (current.current) return
    if (!window.isSecureContext) { setNotice("录音需要 HTTPS 或 localhost。"); return }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") { setNotice("此浏览器不支持录音。"); return }
    const mimeType = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus", "audio/webm"].find(t => MediaRecorder.isTypeSupported(t))
    if (!mimeType) { setNotice("此浏览器不支持可用的录音格式。"); return }
    const job: Job = { abort: new AbortController() }; current.current = job
    const finish = (message: string) => { if (active(job)) { cancel(); setPhase("idle"); setNotice(message) } }
    setPhase("permission"); setNotice("")
    job.timer = window.setTimeout(() => finish("未获得麦克风权限，请检查浏览器设置。"), 60_000)
    try {
      // Dictation, not a live call: request the mic without browser speech processing.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      })
      job.stream = stream
      if (!active(job)) { release(job); return }
      window.clearTimeout(job.timer)
      const rec = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 64000 }); job.recorder = rec
      const chunks: Blob[] = []; let size = 0
      rec.ondataavailable = e => { if (!active(job)) return; size += e.data.size; if (size > 2*1024*1024) finish("录音太大，请缩短后重试。"); else chunks.push(e.data) }
      rec.onerror = () => finish("录音中断，请重新录制。")
      rec.onstop = () => {
        release(job); if (!active(job)) return
        if (!size) { finish("没有录到声音。"); return }
        const blob = new Blob(chunks, { type: rec.mimeType || mimeType })
        rec.ondataavailable = null; rec.onstop = null; rec.onerror = null
        delete job.recorder; delete job.stream
        void upload(job, blob)
      }
      rec.start(500); setPhase("recording")
      job.timer = window.setTimeout(() => { if (rec.state === "recording") rec.stop() }, 60_000)
    } catch { finish("无法使用麦克风，请检查设备与浏览器权限。") }
  }
  function toggle() {
    if (recording) { if (current.current?.recorder?.state === "recording") current.current.recorder.stop(); return }
    if (working) { discard(); return }
    if (phase === "retry" && current.current && take.current) { void upload(current.current, take.current); return }
    void start()
  }
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.isComposing || e.repeat || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
      if (e.key === "F8") { e.preventDefault(); toggle() }
      if (e.key === "Escape" && (working || notice)) { e.preventDefault(); e.stopImmediatePropagation(); discard() }
    }
    window.addEventListener("keydown", key, true)
    return () => window.removeEventListener("keydown", key, true)
  })
  const title = recording ? "停止录音并转写" : working ? "取消听写" : phase === "retry" ? "重试听写" : "语音输入"
  return <>
    <button type="button" className="voice-trigger" data-recording={recording || undefined} onMouseDown={e => e.preventDefault()} onClick={toggle}
      title={`${title} (F8)${phase === "idle" ? " · 参考当前会话最近 3 轮，只回填文字" : ""}`} aria-label={title} aria-keyshortcuts="F8">
      {recording ? <Square size={15} fill="currentColor" /> : processing || phase === "permission" ? <Loader2 size={18} className="motion-safe:animate-spin" /> : phase === "retry" ? <RotateCcw size={18} /> : <Mic size={18} />}
    </button>
    {working && <div className="voice-capsule">
      <VoiceScope stream={recording ? current.current?.stream : undefined} processing={processing} />
      <span role="status">{recording ? "录音中" : processing ? "转写中" : "等待麦克风"}</span>
      <button type="button" onClick={discard} className="voice-dismiss" title="取消 (Esc)" aria-label="放弃本次听写"><X size={14}/></button>
    </div>}
    {notice && <div className="voice-notice"><span role="alert">{notice}</span>
      {phase === "retry" && <button type="button" className="shrink-0 underline" onClick={toggle}>重试</button>}
      <button type="button" className="voice-dismiss" onClick={discard} aria-label="关闭提示并丢弃录音"><X size={14}/></button>
    </div>}
  </>
}
