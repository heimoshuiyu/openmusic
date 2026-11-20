import { Effect, Exit } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import * as fs from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"
import { constants, type BigIntStats } from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { BadRequest, notFound, type NotFound } from "../domain/errors"
import { lockFolderIndex } from "../repo/library-exclusions"
import { reconcileAlbums } from "../repo/album-lifecycle"
import { openDestination } from "./youtube/downloader"

/** 两个导入源（youtube / netease）共享的「移出曲库 + 物理删除」内核。
 *  来源差异（属主查询、provenance 列、文件名形态、legacy 核验、review 的 format 字面量）
 *  全部经由 RemovalSource 适配器注入；本文件的票据与事务语义与来源无关，是安全红线：
 *  - 物理删除只能由票据属主在 5 分钟内持 token + 逐字文件名确认，且仅作用于指定 trackId；
 *  - 指纹（dev:ino:size:mtimeNs）与行版本（xmin）双重复验，多注册根重叠拒绝（fail closed）；
 *  - 先 PostgreSQL 提交后 unlink；失败补偿只回链不覆盖，恢复失败保留备份；
 *  - unindex 永不触碰磁盘文件。 */

const bad = (message:string) => new BadRequest({message})
const io = <T>(fn:()=>Promise<T>, message:string) => Effect.tryPromise({try:fn,catch:()=>bad(message)})

export interface RemovalTarget {
  id:string; folder:number; root:string; rel:string; parts:string[]; name:string; title:string; artist:string;
  version:string; legacy:boolean; size:number; mtime:number; album:string; artistId:string
}
export type RemovalTicket<T> = {owner:number; target:T; identity:string; token:string; expires:number}

export interface RemovalSource<T extends RemovalTarget, F extends string> {
  /** 404 实体名（对非属主与不存在同样 NotFound，不泄露存在性） */
  readonly entity:string
  /** 属主/来源/文件名校验（实现捕获自己的 sql 客户端，R=never）；lock=true 时带 for update。
   *  非属主或非本源目标 → NotFound */
  readonly load:(user:number,id:string,lock:boolean)=>Effect.Effect<T, NotFound>
  /** legacy 文件（无 provenance 行）经 pinned fd 的来源核验；不符即 throw */
  readonly verifyLegacy:(target:T,file:FileHandle)=>Promise<void>
  /** review 响应的 format 字面量（youtube: original|mp3|video；netease: mp3|flac） */
  readonly formatOf:(target:T)=>F
}

const identity=(s:BigIntStats)=>`${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}`
async function inspect<T extends RemovalTarget>(target:T, pinned:FileHandle, verifyLegacy:(t:T,file:FileHandle)=>Promise<void>) {
  const file=await fs.open(`/proc/self/fd/${pinned.fd}/${target.name}`,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK)
  try {
    const stat=await file.stat({bigint:true})
    if (!stat.isFile() || Number(stat.size)!==target.size || Number(stat.mtimeNs/1000000n)!==target.mtime) throw Error("file changed")
    if (target.legacy) await verifyLegacy(target,file)
    return identity(stat)
  } finally {await file.close()}
}

// Keep the approved file until PostgreSQL commits. Never recursively delete quarantine or
// overwrite a newly created file during compensation. On recovery failure keep the backup.
type Stage = {dir:FileHandle; target:string; tmp:string; held:string}
async function finish(stage:Stage, commit:boolean) {
  try {
    if (!commit) await fs.link(stage.held,stage.target)
    await fs.unlink(stage.held)
    await fs.rmdir(stage.tmp)
  } finally {await stage.dir.close()}
}
async function stageFile<T extends RemovalTarget>(t:T, approved:string, verifyLegacy:(target:T,file:FileHandle)=>Promise<void>) {
  const dir=await openDestination(t.root,t.parts)
  let moved=false, tmp=""
  try {
    if (await inspect(t,dir,verifyLegacy)!==approved) throw Error("file changed")
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

/** 纯票据簿（导出供单测）：惰性过期、属主隔离、每 (属主,目标) 单票、全局 256 上限。 */
export interface TicketedTarget { readonly id:string; readonly name:string }
export function ticketBook<T extends TicketedTarget>(clock:()=>number=()=>Date.now()) {
  const tickets=new Map<string,RemovalTicket<T>>()
  const clean=()=>{for(const [k,v] of tickets)if(v.expires<=clock())tickets.delete(k)}
  const find=(user:number,key:string)=>{clean();const v=tickets.get(key);return v?.owner===user?v:undefined}
  return {
    find,
    /** 全局上限已满时返回 false（先惰性清理，再查上限，再按 (属主,目标) 换票） */
    put:(user:number,target:T,fingerprint:string,token:string)=>{clean()
      if(tickets.size>=256)return false as const
      for(const [k,v] of tickets)if(v.owner===user&&v.target.id===target.id)tickets.delete(k)
      const key=randomUUID(), expires=clock()+5*60_000
      tickets.set(key,{owner:user,target,expires,identity:fingerprint,token})
      return {key,expires} as const},
    drop:(key:string)=>{tickets.delete(key)},
  }
}

export interface ImportRemovals<F extends string> {
  unindex:(user:number,id:string)=>Effect.Effect<void,NotFound|BadRequest>
  request:(user:number,id:string)=>Effect.Effect<{requestId:string;reviewPath:string;expiresAt:number},NotFound|BadRequest>
  preview:(user:number,key:string)=>Effect.Effect<{trackId:string;title:string;artist:string;filename:string;format:F;
    path:string;sizeBytes:number;expiresAt:number;token:string},NotFound>
  cancel:(user:number,key:string)=>Effect.Effect<void,NotFound>
  confirm:(user:number,key:string,token:string,filename:string)=>Effect.Effect<void,NotFound|BadRequest>
}

export function importRemovals<T extends RemovalTarget,F extends string>(
  sql:SqlClient.SqlClient,
  guarded:<A,E>(id:string,task:Effect.Effect<A,E>)=>Effect.Effect<A,E|BadRequest>,
  source:RemovalSource<T,F>,
  clock:()=>number=()=>Date.now(),
):ImportRemovals<F> {
  const book=ticketBook<T>(clock)
  const observe=(t:T)=>io(async()=>{const dir=await openDestination(t.root,t.parts,false);try{return await inspect(t,dir,source.verifyLegacy)}finally{await dir.close()}},"文件不可用、来源未核实或已改变；未删除。")
  const remove=Effect.fnUntraced(function*(user:number,id:string,ticket?:RemovalTicket<T>){
    const initial=yield* source.load(user,id,false)
    let staged:Stage|undefined
    const tx=sql.withTransaction(Effect.gen(function*(){
      yield* lockFolderIndex(sql,initial.folder)
      const t=yield* source.load(user,id,true)
      if(t.folder!==initial.folder) return yield* bad("曲库位置已改变。")
      if(ticket){
        if(ticket.expires<=clock() || t.version!==ticket.target.version || t.rel!==ticket.target.rel || t.root!==ticket.target.root) return yield* bad("确认已过期或曲目已更改，请重新申请。")
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
        staged=yield* io(()=>stageFile(t,ticket.identity,source.verifyLegacy),"文件已改变或无法安全移除；请检查原文件后重新申请。")
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
      const t=yield* source.load(user,id,false);const fingerprint=yield* observe(t)
      const entry=book.put(user,t,fingerprint,randomUUID())
      if(entry===false)return yield* bad("待确认请求过多，请稍后再试。")
      return {requestId:entry.key,reviewPath:`/review-deletion/${entry.key}`,expiresAt:entry.expires}
    }),
    preview:Effect.fnUntraced(function*(user:number,key:string){
      const v=book.find(user,key);if(!v)return yield* notFound("deletion_request",key)
      const t=v.target
      return {trackId:t.id,title:t.title,artist:t.artist,filename:t.name,path:path.join(t.root,t.rel),format:source.formatOf(t),sizeBytes:t.size,expiresAt:v.expires,token:v.token}
    }),
    cancel:Effect.fnUntraced(function*(user:number,key:string){if(!book.find(user,key))return yield* notFound("deletion_request",key);book.drop(key)}),
    confirm:Effect.fnUntraced(function*(user:number,key:string,token:string,filename:string){
      const v=book.find(user,key);if(!v)return yield* notFound("deletion_request",key)
      if(v.token!==token || v.target.name!==filename)return yield* bad("确认凭据或文件名不匹配。")
      book.drop(key);yield* guarded(v.target.id,remove(user,v.target.id,v))
    }),
  }
}
