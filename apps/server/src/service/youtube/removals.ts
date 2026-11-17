import { Effect, Exit } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import * as fs from "node:fs/promises"
import { constants, type BigIntStats } from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { parseFile } from "music-metadata"
import { BadRequest, notFound } from "../../domain/errors"
import { lockFolderIndex } from "../../repo/library-exclusions"
import { reconcileAlbums } from "../../repo/album-lifecycle"
import { openDestination } from "./downloader"
import { importedFilename } from "./formats"
import { checkSubdirectory } from "./source"
import type { YoutubeFormat } from "../../domain/youtube"

const bad = (message:string) => new BadRequest({message})
const io = <T>(fn:()=>Promise<T>, message:string) => Effect.tryPromise({try:fn,catch:()=>bad(message)})
interface Target {
  id:string; folder:number; root:string; rel:string; parts:string[]; name:string; title:string; artist:string;
  version:string; legacy:boolean; videoId:string; format:YoutubeFormat; size:number; mtime:number; album:string; artistId:string
}
type Ticket = {owner:number; target:Target; identity:string; token:string; expires:number}
const identity=(s:BigIntStats) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}`
async function inspect(target:Target, pinned:fs.FileHandle) {
  const file=await fs.open(`/proc/self/fd/${pinned.fd}/${target.name}`,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK)
  try {
    const stat=await file.stat({bigint:true})
    if (!stat.isFile() || Number(stat.size)!==target.size || Number(stat.mtimeNs/1000000n)!==target.mtime) throw Error("file changed")
    if (target.legacy) {
      const tags=await parseFile(`/proc/self/fd/${file.fd}`,{skipCovers:true})
      const url=`https://www.youtube.com/watch?v=${target.videoId}`
      if (!Object.values(tags.native).some(group=>group.some(t=>/^TXXX:(purl|comment)$/i.test(t.id) && t.value===url))) throw Error("unverified legacy file")
    }
    return identity(stat)
  } finally {await file.close()}
}

// Keep the approved file until PostgreSQL commits. Never recursively delete quarantine or
// overwrite a newly created file during compensation. On recovery failure keep the backup.
type Stage = {dir:fs.FileHandle; target:string; tmp:string; held:string}
async function finish(stage:Stage, commit:boolean) {
  try {
    if (!commit) await fs.link(stage.held,stage.target)
    await fs.unlink(stage.held)
    await fs.rmdir(stage.tmp)
  } finally {await stage.dir.close()}
}
async function stageFile(t:Target, approved:string) {
  const dir=await openDestination(t.root,t.parts)
  let moved=false, tmp=""
  try {
    if (await inspect(t,dir)!==approved) throw Error("file changed")
    const base=`/proc/self/fd/${dir.fd}`, target=`${base}/${t.name}`
    tmp=await fs.mkdtemp(`${base}/.openmusic-delete-`)
    const held=`${tmp}/media`; await fs.rename(target,held); moved=true
    const stage={dir,target,tmp,held}
    const actual=await fs.lstat(held,{bigint:true})
    if (!actual.isFile() || identity(actual)!==approved) {
      // File swapped during rename: restore without clobbering, NEVER unlink the wrong object.
      await finish(stage,false); throw Error("file replaced")
    }
    return stage
  } catch(e) {
    if(!moved && tmp) await fs.rmdir(tmp).catch(()=>{})
    await dir.close().catch(()=>{}); throw e
  }
}

export function youtubeRemovals(sql:SqlClient.SqlClient, guarded:<A,E>(id:string,task:Effect.Effect<A,E>)=>Effect.Effect<A,E|BadRequest>) {
  const tickets=new Map<string,Ticket>()
  function clean(){for(const [k,v] of tickets)if(v.expires<=Date.now())tickets.delete(k)}
  const find=(user:number,key:string)=>{clean();const v=tickets.get(key);return v?.owner===user?v:undefined}
  const load=Effect.fnUntraced(function*(user:number,id:string,lock=false){
    if(!/^[1-9]\d{0,15}$/.test(id))return yield* notFound("youtube_track",id)
    const [r]=yield* sql`select t.xmin::text as revision,t.path,t.title,t.artist_id,t.album_id,t.size_bytes,t.mtime_ms,
      ar.name as artist,f.id as folder,f.path as root,y.video_id from tracks t join music_folders f on f.id=t.music_folder_id
      join artists ar on ar.id=t.artist_id left join youtube_imports y on y.track_id=t.id join users u on u.id=${user}
      where t.id=${id} and not t.is_virtual and (u.is_admin or y.imported_by=u.id) ${lock?sql.literal('for update of t,f'):sql.literal('')}`.pipe(Effect.orDie)
    if(!r)return yield* notFound("youtube_track",id)
    const rel=String(r.path), parts=rel.split("/"), name=parts.pop()!, media=importedFilename(name)
    if(!media || path.isAbsolute(rel) || !checkSubdirectory(parts.join("/")) || (r.video_id ? r.video_id!==media.videoId : media.ext!=="mp3"))return yield* notFound("youtube_track",id)
    return {id,folder:Number(r.folder),root:String(r.root),rel,parts,name,title:String(r.title),artist:String(r.artist),version:String(r.revision),
      legacy:!r.video_id,videoId:media.videoId,format:media.format,size:Number(r.size_bytes),mtime:Number(r.mtime_ms),album:String(r.album_id),artistId:String(r.artist_id)} satisfies Target
  })
  const observe=(t:Target)=>io(async()=>{const dir=await openDestination(t.root,t.parts,false);try{return await inspect(t,dir)}finally{await dir.close()}},"文件不可用、来源未核实或已改变；未删除。")
  const remove=Effect.fnUntraced(function*(user:number,id:string,ticket?:Ticket){
    const initial=yield* load(user,id)
    let staged:Stage|undefined
    const tx=sql.withTransaction(Effect.gen(function*(){
      yield* lockFolderIndex(sql,initial.folder)
      const t=yield* load(user,id,true)
      if(t.folder!==initial.folder) return yield* bad("曲库位置已改变。")
      if(ticket){
        if(ticket.expires<=Date.now() || t.version!==ticket.target.version || t.rel!==ticket.target.rel || t.root!==ticket.target.root) return yield* bad("确认已过期或曲目已更改，请重新申请。")
        // Nested/aliased registered roots can expose one file under multiple track IDs. Fail
        // closed rather than making the human's single-version approval affect another root.
        const roots=yield* sql`select path from music_folders where id<>${t.folder}`
        const overlaps=yield* io(async()=>{
          const original=path.join(await fs.realpath(t.root),t.rel)
          for(const row of roots){
            const other=await fs.realpath(String(row.path)).catch((e:NodeJS.ErrnoException)=> {if(e.code==="ENOENT")return null;throw e})
            if(other!==null){const rel=path.relative(other,original);if(rel!==".."&&!rel.startsWith("../")&&!path.isAbsolute(rel))return true}
          }
          return false
        },"无法核对曲库根目录，未删除文件。")
        if(overlaps)return yield* bad("这个文件同时位于其他注册曲库根目录中；拒绝删除原件。")
        staged=yield* io(()=>stageFile(t,ticket.identity),"文件已改变或无法安全移除；请检查原文件后重新申请。")
      } else if(t.legacy) yield* observe(t)
      yield* sql`insert into library_exclusions(music_folder_id,path) values(${t.folder},${t.rel}) on conflict do nothing`
      const lists=yield* sql`select id from playlists where id in (select playlist_id from playlist_tracks where track_id=${id}) order by id for update`
      yield* sql`delete from annotations where item_type='track' and item_id=${id}`
      yield* sql`delete from tracks where id=${id}`
      for(const p of lists){
        // Use a disjoint temporary range to avoid primary-key conflicts when closing gaps.
        yield* sql`update playlist_tracks set position=-1-position where playlist_id=${p.id}`
        yield* sql`with ranked as (select position,row_number() over(order by position desc)-1 as n from playlist_tracks where playlist_id=${p.id})
          update playlist_tracks pt set position=r.n from ranked r where pt.playlist_id=${p.id} and pt.position=r.position`
        yield* sql`update playlists set updated_at=now(),duration_seconds=(select coalesce(sum(t.duration_seconds),0) from playlist_tracks pt join tracks t on t.id=pt.track_id where pt.playlist_id=${p.id}) where id=${p.id}`
      }
      yield* reconcileAlbums(sql,[t.album])
      yield* sql`update artists set (album_count,track_count)=(select count(distinct album_id),count(*) from canonical_tracks where artist_id=artists.id) where id=${t.artistId} or id in (select artist_id from tracks where album_id=${t.album})`
    })).pipe(Effect.catchTag("SqlError",()=>Effect.fail(bad("曲库删除事务失败。"))))
    const result=yield* Effect.exit(tx)
    if(staged){const s=staged;yield* io(()=>finish(s,Exit.isSuccess(result)),"文件收尾失败；请管理员检查目标目录的 .openmusic-delete- 暂存目录，不要重复删除。")}
    if(Exit.isFailure(result))return yield* Effect.failCause(result.cause)
  },Effect.uninterruptible)
  return {
    unindex:(user:number,id:string)=>guarded(id,remove(user,id)),
    request:Effect.fnUntraced(function*(user:number,id:string){
      const t=yield* load(user,id);const fingerprint=yield* observe(t);clean()
      if(tickets.size>=256)return yield* bad("待确认请求过多，请稍后再试。")
      const key=randomUUID(), expires=Date.now()+5*60_000
      for(const [k,v] of tickets)if(v.owner===user&&v.target.id===id)tickets.delete(k)
      tickets.set(key,{owner:user,target:t,expires,identity:fingerprint,token:randomUUID()})
      return {requestId:key,reviewPath:`/review-deletion/${key}`,expiresAt:expires}
    }),
    preview:Effect.fnUntraced(function*(user:number,key:string){
      const v=find(user,key);if(!v)return yield* notFound("deletion_request",key)
      const t=v.target
      return {trackId:t.id,title:t.title,artist:t.artist,filename:t.name,path:path.join(t.root,t.rel),format:t.format,sizeBytes:t.size,expiresAt:v.expires,token:v.token}
    }),
    cancel:Effect.fnUntraced(function*(user:number,key:string){if(!find(user,key))return yield* notFound("deletion_request",key);tickets.delete(key)}),
    confirm:Effect.fnUntraced(function*(user:number,key:string,token:string,filename:string){
      const v=find(user,key);if(!v)return yield* notFound("deletion_request",key)
      if(v.token!==token || v.target.name!==filename)return yield* bad("确认凭据或文件名不匹配。")
      tickets.delete(key);yield* guarded(v.target.id,remove(user,v.target.id,v))
    }),
  }
}
