import type { LyricLine } from '../domain/lyrics'

export const LYRIC_BYTES=128*1024
/** Multi-time LRC, UTF BOM, fractional seconds, offset (+ = earlier). Equal times often carry translations. */
export function parseLyrics(body:string):LyricLine[] {
  if(Buffer.byteLength(body)>LYRIC_BYTES || body.includes('\0')) throw Error('歌词文本无效或过大')
  const lines=body.replace(/^\uFEFF/,'').split(/\r\n?|\n/), timed:LyricLine[]=[], plain:LyricLine[]=[]
  let offset=0, expanded=0
  for(const line of lines){
    const value=line.trim()
    const meta=/^\[offset:\s*([+-]?\d{1,8})\s*\]$/i.exec(value)
    if(meta){offset=Number(meta[1]);continue}
    if(!value || /^\[(?:ar|al|ti|au|by|re|ve|length|tool|id):.*\]$/i.test(value))continue
    const stamps=/^(?:\s*\[\d{1,4}:[0-5]\d(?:[.:]\d{1,3})?\])+/.exec(value)?.[0]
    if(!stamps){plain.push({startMs:null,text:value});continue}
    const text=value.slice(stamps.length).trim()
    for(const m of stamps.matchAll(/\[(\d+):([0-5]\d)(?:[.:](\d{1,3}))?\]/g)){
      expanded+=text.length+1
      if(timed.length>=4096 || expanded>LYRIC_BYTES)throw Error('歌词行数或文本过大')
      timed.push({startMs:(Number(m[1])*60+Number(m[2]))*1000+Number((m[3]??'').padEnd(3,'0')),text})
    }
  }
  if(!timed.length){if(plain.length>4096)throw Error('歌词行数过多');return plain}
  const sorted=timed.map(l=>({...l,startMs:Math.max(0,l.startMs!-offset)})).sort((a,b)=>a.startMs-b.startMs)
  const grouped:LyricLine[]=[]
  for(const l of sorted){const prev=grouped.at(-1);if(prev?.startMs===l.startMs)grouped[grouped.length-1]={...l,text:[prev.text,l.text].filter(Boolean).join('\n')};else grouped.push(l)}
  return grouped
}
