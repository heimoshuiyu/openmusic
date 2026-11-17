import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { BadRequest, notFound } from "../../domain/errors"
import type { CaptionSource, CaptionRead, CaptionTrack } from "../../domain/youtube"
import { youtubeSource, videoID } from "./source"
import { runDlp } from "./downloader"
import { boundedFetch } from "./metadata"

type Track = typeof CaptionTrack.Type & {url:URL}
type Cue = {startMs:number;endMs:number|null;text:string}
const bad = (message:string) => new BadRequest({message})
const watch = (id:string) => `https://www.youtube.com/watch?v=${id}`

// Signed caption URLs are private transport data. Accept only YouTube's timedtext route for this video,
// never a redirect, live chat, translated track or URL supplied by the assistant.
export function captionTracks(info: Record<string,unknown>, id:string): Track[] {
  if (info.id!==id) throw Error('video mismatch')
  const tracks: Track[]=[]
  const entries=info.subtitles
  if (entries && typeof entries==='object') {
    for (const [language,formats] of Object.entries(entries)) {
      if (language==='live_chat' || !/^[A-Za-z0-9][\w-]{0,39}$/.test(language) || !Array.isArray(formats)) continue
      for (const format of formats) {
        if (format?.ext!=='json3' || typeof format.url!=='string') continue
        const u=URL.parse(format.url)
        if (u?.origin!=='https://www.youtube.com' || u.username || u.password || u.pathname!=='/api/timedtext' ||
          u.searchParams.get('v')!==id || u.searchParams.has('tlang') || u.searchParams.getAll('kind').some(k=>k.toLowerCase()==='asr')) continue
        tracks.push({language,kind:'manual',url:u}); break
      }
    }
  }
  return tracks
}

export function captionCues(data: {events?:unknown}): Cue[] {
  if (!Array.isArray(data?.events) || data.events.length>100000) throw Error('invalid caption events')
  const cues:Cue[]=[]
  for (const event of data.events) {
    if (!Number.isSafeInteger(event?.tStartMs) || event.tStartMs<0 || !Array.isArray(event.segs)) continue
    const text=event.segs.map((s:{utf8?:unknown}|null)=>typeof s?.utf8==='string'?s.utf8:'').join('').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g,' ').trim()
    if (!text) continue
    if (text.length>12000) throw Error('oversized cue')
    const end=event.tStartMs+event.dDurationMs
    cues.push({startMs:event.tStartMs,endMs:Number.isSafeInteger(end) && end>=event.tStartMs ? end : null,text})
  }
  return cues
}

function cache<T>() {
  const entries=new Map<string,{expires:number;value:T}>()
  return {
    get(key:string) { const hit=entries.get(key); if (hit && hit.expires>Date.now()) return hit.value; entries.delete(key) },
    put(key:string,value:T) { if(entries.size>=12) entries.delete(entries.keys().next().value!); entries.set(key,{value,expires:Date.now()+120_000}); return value },
  }
}

export function youtubeCaptions(sql:SqlClient.SqlClient) {
  const catalog=cache<Track[]>(), texts=cache<Cue[]>(), busy=new Set<number>()
  const resolve = Effect.fnUntraced(function*(input:CaptionSource) {
    if ((input.url===undefined)===(input.trackId===undefined)) return yield* bad('请指定一个 YouTube 视频链接或已导入的 trackId，不要同时提供。')
    if (input.trackId!==undefined) {
      const [row]=yield* sql<{video_id:string}>`select video_id from youtube_imports where track_id=${input.trackId}::bigint`.pipe(Effect.orDie)
      if (!row || !videoID.test(row.video_id)) return yield* notFound('youtube_track',input.trackId)
      return row.video_id
    }
    const source=youtubeSource(input.url!)
    if (source?.kind!=='video') return yield* bad('字幕只支持单个 YouTube 视频。')
    return new URL(source.url).searchParams.get('v')!
  })
  const load = async (id:string, signal:AbortSignal) => {
    const prior=catalog.get(id); if(prior) return prior
    const raw=await runDlp(['--skip-download','--no-write-auto-subs','--no-playlist','--ignore-no-formats-error','--extractor-args','youtube:skip=translated_subs',
      '--print','%(.{id,subtitles})j','--',watch(id)],signal)
    return catalog.put(id,captionTracks(JSON.parse(raw),id))
  }
  const query = <T>(owner:number,input:CaptionSource,action:(id:string,tracks:Track[],signal:AbortSignal)=>Promise<T>) => Effect.gen(function*(){
    const id=yield* resolve(input)
    if (busy.has(owner)||busy.size>=4) return yield* bad('已有字幕请求正在执行，请稍后再试。')
    return yield* Effect.acquireUseRelease(Effect.sync(()=>busy.add(owner)),()=>Effect.tryPromise({
      try:async signal=>action(id,await load(id,signal),signal),catch:e=>e instanceof BadRequest?e:bad('暂时无法从 YouTube 读取字幕（网络、限流、响应过大或无访问权限）。'),
    }),()=>Effect.sync(()=>busy.delete(owner)))
  })
  return {
    list:(owner:number,input:CaptionSource)=>query(owner,input,async(videoId,tracks)=>({videoId,tracks:tracks.map(({language,kind})=>({language,kind}))})),
    read:(owner:number,input:CaptionRead)=>query(owner,input,async(videoId,tracks,signal)=>{
      const track=tracks.find(t=>t.language===input.language)
      if(!track) throw bad(tracks.length?'没有此语言的人工字幕，请先列出可用语言。':'没有人工字幕。')
      const key=[videoId,track.language,track.kind].join('/')
      const all=texts.get(key) ?? texts.put(key,captionCues(JSON.parse((await boundedFetch(track.url,1024*1024,signal)).toString('utf8'))))
      const start=input.offset??0, cues:Cue[]=[]; let chars=0
      for (const cue of all.slice(start,start+80)) { if(chars+cue.text.length>12000) break; cues.push(cue);chars+=cue.text.length }
      return {videoId,language:track.language,kind:track.kind,cues,total:all.length,nextOffset:start+cues.length<all.length?start+cues.length:null}
    }),
  }
}
