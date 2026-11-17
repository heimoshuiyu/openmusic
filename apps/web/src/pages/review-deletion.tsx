import { useEffect, useState } from "react"
import { Link } from "@tanstack/react-router"
import { api } from "@/api/client"
import { btnQuiet, inputClass, PageHeader } from "@/components/page"

type Review = Awaited<ReturnType<typeof api.reviewDeletion>>
export function ReviewDeletion({ requestId }: { requestId: string }) {
  const [review, setReview] = useState<Review | null>(null)
  const [typed,setTyped] = useState("")
  const [busy,setBusy] = useState(false)
  const [result,setResult] = useState("")
  useEffect(()=>{
    let mounted=true
    void api.reviewDeletion(requestId).then(v=>{if(mounted)setReview(v)},()=>{if(mounted)setResult("申请不存在、已过期，或不属于当前账号。")})
    return ()=>{mounted=false}
  },[requestId])
  useEffect(()=>{
    if (!review) return
    const timer=setTimeout(()=>setResult("申请已过期，请重新发起。"),Math.max(0,review.expiresAt-Date.now()))
    return ()=>clearTimeout(timer)
  },[review])
  async function resolve(confirm:boolean){
    if(busy || !review || (confirm && typed!==review.filename))return
    setBusy(true)
    try {
      if(confirm)await api.confirmDeletion(requestId,review.token,typed);else await api.cancelDeletion(requestId)
      setResult(confirm ? "此版本的文件和曲库条目已删除。" : "已取消。文件和曲库条目未改动。")
    } catch(e){setResult(e instanceof Error ? e.message : "操作未完成，请重新核对。")}
    finally{setReview(null);setBusy(false)}
  }
  return <div className="catalog-page"><div className="max-w-2xl space-y-5">
    <PageHeader title="核对要删除的原文件"/>
    {result ? <><p role="status">{result}</p><Link to="/" className={btnQuiet}>返回曲库</Link></> : !review ? <p>正在读取申请…</p> : <>
      <section className="space-y-1 border-l-2 border-line pl-4">
        <h2 className="text-lg font-medium">{review.title}</h2><p className="text-sm text-dim">{review.artist} · 曲目 {review.trackId} · {review.format} · {(review.sizeBytes/1048576).toFixed(1)} MiB</p>
        <p className="break-all font-mono text-xs">{review.path}</p>
      </section>
      <p className="text-sm">这会从服务器磁盘永久删除此文件，并将此版本从共享曲库及歌单移除。其他文件版本不会删除。</p>
      <label className="block space-y-2 text-sm"><span>输入完整文件名以确认：<code className="break-all">{review.filename}</code></span>
        <input className={`${inputClass} w-full`} autoComplete="off" spellCheck={false} value={typed} onChange={e=>setTyped(e.target.value)} /></label>
      <div className="flex gap-3"><button className={btnQuiet} disabled={busy} onClick={()=>void resolve(false)}>取消，保留文件</button>
        <button className="rounded-md bg-danger px-3 py-2 text-sm font-medium text-shell disabled:opacity-40" disabled={busy||typed!==review.filename} onClick={()=>void resolve(true)}>永久删除此文件</button></div>
    </>}
  </div></div>
}
