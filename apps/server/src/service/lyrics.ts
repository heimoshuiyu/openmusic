import { Effect } from 'effect'
import type { SqlClient } from 'effect/unstable/sql'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import { parseFile } from 'music-metadata'
import { BadRequest, Forbidden, notFound } from '../domain/errors'
import type { LyricBinding, LyricLine, TrackLyrics } from '../domain/lyrics'
import { LYRIC_BYTES,parseLyrics } from '../util/lyrics'
import { openDestination } from './youtube/downloader'

const bad=(message:string)=>new BadRequest({message})
const basename=(s:string)=>s!=='' && s!=='.' && s!=='..' && !/[\/\\\x00-\x1f]/.test(s)
const lrcName=(s:string)=>basename(s) && !s.startsWith('.') && /\.lrc$/i.test(s)
type TrackRow={root:string;path:string;is_virtual:boolean;mode:TrackLyrics['mode'];filename:string|null;lyrics_id:string|null;body:string|null}

async function localLines(row:TrackRow):Promise<{source:TrackLyrics['source'];filename:string|null;lines:LyricLine[]}> {
  const empty={source:'none' as const,filename:row.filename,lines:[]}
  // One CUE image may contain many songs. Don't attach the entire image's lyrics to every segment.
  if(row.is_virtual && row.mode==='auto')return empty
  const parts=row.path.split('/'); if(!parts.every(basename))throw bad('曲目路径无效')
  const media=parts.pop()!, implicit=media.replace(/\.[^.]+$/,'')+'.lrc', filename=row.filename??implicit
  if(!lrcName(filename))throw bad('歌词文件必须是曲目目录内的 .lrc 文件名')
  const dir=await openDestination(row.root,parts,false), base=`/proc/self/fd/${dir.fd}`
  const open=(name:string)=>fs.open(`${base}/${name}`,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK)
  try {
    const side=await open(filename).catch((e:NodeJS.ErrnoException)=>{if(e.code==='ENOENT')return null;throw e})
    if(side)try {
      const st=await side.stat();if(!st.isFile()||st.size>LYRIC_BYTES)throw bad('歌词文件无效或超过 128 KiB')
      const buf=Buffer.alloc(st.size+1);let n=0
      while(n<buf.length){const r=await side.read(buf,n,buf.length-n,n);if(!r.bytesRead)break;n+=r.bytesRead}
      if(n!==st.size)throw bad('歌词文件已变化，请重试')
      const encoding=buf[0]===255&&buf[1]===254?'utf-16le':buf[0]===254&&buf[1]===255?'utf-16be':'utf-8'
      const lines=parseLyrics(new TextDecoder(encoding,{fatal:true}).decode(buf.subarray(0,n)))
      if(lines.length)return {source:'sidecar',filename,lines}
    } finally {await side.close()}
    if(row.mode==='file')return empty
    const h=await open(media)
    try {
      if(!(await h.stat()).isFile())throw bad('不是普通媒体文件')
      const read=(duration:boolean)=>parseFile(`/proc/self/fd/${h.fd}`,{duration,skipCovers:true})
      const meta=await read(false).catch(()=>read(true))
      // String tags (Vorbis/MP4) may already have been lossily normalised by music-metadata's LRC parser.
      const raw=Object.values(meta.native).flat().find(t=>/^(lyrics|unsyncedlyrics|©lyr)$/i.test(t.id)&&typeof t.value==='string')
      const tag=meta.common.lyrics?.find(t=>t.timeStampFormat===2 && t.syncText?.length)??meta.common.lyrics?.[0]
      let lines:LyricLine[]=[]
      if(raw)lines=parseLyrics(String(raw.value))
      else if(tag?.syncText?.length){
        if(tag.syncText.length>4096 || tag.syncText.reduce((n,l)=>n+l.text.length,0)>LYRIC_BYTES)throw bad('内嵌歌词过大')
        lines=tag.syncText.map(l=>({text:l.text,startMs:tag.timeStampFormat===2 && Number.isSafeInteger(l.timestamp)?Math.max(0,l.timestamp!):null}))
        lines.sort((a,b)=>(a.startMs??0)-(b.startMs??0))
      } else if(tag?.text)lines=parseLyrics(tag.text)
      return lines.length?{source:'embedded',filename:null,lines}:empty
    } finally {await h.close()}
  } finally {await dir.close()}
}

export function lyricService(sql:SqlClient.SqlClient){
  const track=Effect.fnUntraced(function*(id:string){
    const [r]=yield* sql<TrackRow>`select f.path as root,t.path,t.is_virtual,coalesce(b.mode,'auto') as mode,b.filename,b.lyric_id::text as lyrics_id,d.body
      from tracks t join music_folders f on f.id=t.music_folder_id left join track_lyrics b on b.track_id=t.id
      left join lyric_documents d on d.id=b.lyric_id where t.id=${id}::bigint`.pipe(Effect.orDie)
    if(!r)return yield* notFound('track',id);return r
  })
  const disk=(row:TrackRow)=>Effect.tryPromise({try:()=>localLines(row),catch:e=>e instanceof BadRequest?e:bad('无法读取歌词，请检查文件、编码和目录权限。')})
  const read=Effect.fnUntraced(function*(id:string){
    const r=yield* track(id)
    const result=r.mode==='saved'?{source:'saved' as const,filename:null,lines:parseLyrics(r.body!)}:
      r.mode==='none'?{source:'none' as const,filename:null,lines:[]}:yield* disk(r)
    return {trackId:id,mode:r.mode,lyricsId:r.lyrics_id,synced:result.lines.some(l=>l.startMs!==null),...result} satisfies TrackLyrics
  })
  const allowed=Effect.fnUntraced(function*(user:number,id:string){
    const [row]=yield* sql`select u.is_admin or coalesce(y.imported_by=u.id,false) as allowed from tracks t join users u on u.id=${user}
      left join youtube_imports y on y.track_id=t.id where t.id=${id}::bigint for update of t`
    if(!row)return yield* notFound('track',id)
    if(!row.allowed)return yield* new Forbidden({message:'只有管理员或该版本的导入者可以修改歌词。'})
  })
  const set=(id:string,b:LyricBinding)=>b.mode==='auto'?sql`delete from track_lyrics where track_id=${id}`:
    sql`insert into track_lyrics(track_id,mode,lyric_id,filename) values(${id},${b.mode},${b.mode==='saved'?b.lyricsId:null},${b.mode==='file'?b.filename:null})
      on conflict(track_id) do update set mode=excluded.mode,lyric_id=excluded.lyric_id,filename=excluded.filename`
  const bind=(user:number,id:string,b:LyricBinding)=>sql.withTransaction(Effect.gen(function*(){
    yield* allowed(user,id)
    if(b.mode==='saved' && !(yield* sql`select id from lyric_documents where id=${b.lyricsId}`).length)return yield* notFound('lyrics',b.lyricsId)
    if(b.mode==='file'){
      if(!lrcName(b.filename))return yield* bad('仅接受同目录 .lrc 文件名')
      const resolved=yield* disk({...yield* track(id),mode:'file',filename:b.filename})
      if(!resolved.lines.length)return yield* bad('指定的歌词文件不存在或为空')
    }
    yield* set(id,b);return {trackId:id,...b}
  })).pipe(Effect.catchTag('SqlError',Effect.die))
  const edit=(user:number,id:string,text:string)=>sql.withTransaction(Effect.gen(function*(){
    yield* allowed(user,id)
    const lines=yield* Effect.try({try:()=>parseLyrics(text),catch:()=>bad('歌词无效或超过大小限制')})
    if(!lines.some(l=>l.text.trim()))return yield* bad('歌词不能为空；请显式解绑')
    const [doc]=yield* sql<{id:string}>`insert into lyric_documents(digest,body) values(${createHash('sha256').update(text).digest('hex')},${text})
      on conflict(digest) do update set digest=excluded.digest returning id::text`
    const b={mode:'saved' as const,lyricsId:doc!.id};yield* set(id,b);return {trackId:id,...b}
  })).pipe(Effect.catchTag('SqlError',Effect.die))
  return {read,edit,bind}
}
