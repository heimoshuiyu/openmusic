import { useQuery } from '@tanstack/react-query'
import { useEffect,useRef } from 'react'
import { api } from '@/api/client'

export function LyricsPanel({id,position}:{id:string;position:number}) {
  const q=useQuery({queryKey:['lyrics',id],queryFn:()=>api.lyrics(id),retry:false,staleTime:0})
  const panel=useRef<HTMLDivElement>(null)
  const lines=q.data?.lines??[]
  let lo=0,hi=lines.length
  while(lo<hi){const m=(lo+hi)>>>1;if((lines[m]!.startMs??Infinity)<=position*1000)lo=m+1;else hi=m}
  const active=q.data?.synced?lo-1:-1
  useEffect(()=>{
    const el=panel.current, line=el?.querySelector<HTMLElement>('[aria-current="true"]')
    if(el && line)el.scrollTop+=line.getBoundingClientRect().top-el.getBoundingClientRect().top-(el.clientHeight-line.offsetHeight)/2
  },[id,active])
  return <div ref={panel} aria-label="歌词正文" tabIndex={0} onPointerDown={e=>e.stopPropagation()}
    className="playback-lyrics overflow-y-auto overscroll-contain px-3 py-4 text-center leading-relaxed" style={{touchAction:'pan-y'}}>
    {q.isPending?'正在读取歌词…':q.isError?<button onClick={()=>void q.refetch()}>歌词读取失败，重试</button>:!lines.length?'此版本暂无歌词':
      lines.map((line,i)=><p key={i} aria-current={active===i?true:undefined} className={`whitespace-pre-wrap py-1.5 ${!q.data?.synced || active===i?'text-paper':'text-dim'} ${active===i?'font-semibold':''}`}>{line.text||'\u00a0'}</p>)}
  </div>
}
