import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { constants } from "node:fs"
import * as fs from "node:fs/promises"
import { BadRequest, notFound } from "../../domain/errors"
import type { NeteaseInfo, NeteaseTags } from "../../domain/netease"
import type { MetadataOverrides } from "../../domain/metadata-overrides"
import type { Scanner } from "../scanner"
import { openDestination } from "../youtube/downloader"
import { checkSubdirectory } from "../youtube/source"
import { importedFilename } from "./formats"
import { applyNeteaseEdit, validNeteaseTags, verifyNeteaseLegacy } from "./metadata"
import type { NeteaseRuntime } from "./api"

/** 网易云导入曲目的查看/编辑（N1/N2）。
 *  与 youtube/library-tags.ts 同一安全骨架（staging 拷贝 → 写标签 → inode 复验 → rename 发布 →
 *  失败回滚），但刻意不复用 youtube 实现（其发布路径绑定 youtube_imports 的 upload_date/
 *  cover_source/genre 溯源列）。网易云的差异点：
 *  - 发布走 scanner.indexImport({metadata})，不 upsert netease_imports —— 管理员代编辑不会
 *    改写 imported_by/quality，provenance 行保持导入时的快照；
 *  - 不传 fileDateIsUpload：发行日即专辑年份，重扫自然回填 albums.year；
 *  - legacy 文件（无 provenance 行，仅管理员可见）编辑前须通过 OPENMUSIC_NETEASE_ID 标签核验。 */

interface NeteaseRow {
  title:string; path:string; album_id:string; music_folder_id:string; has_embedded_cover:boolean;
  disc:string; track_no:string|null; root:string; album:string; artist:string; album_artist:string;
  genre:string|null; song_id:string|null; imported_by:string|null; quality:string|null
}

export function neteaseLibraryTags(sql:SqlClient.SqlClient, scanner:Scanner["Service"], rt:NeteaseRuntime) {
  const locks=new Set<string>()
  const load=Effect.fnUntraced(function*(id:string){
    if(!/^[1-9]\d{0,15}$/.test(id)) return yield* notFound("netease_track",id)
    const [r]=yield* sql<NeteaseRow>`select t.title,t.path,t.album_id,t.music_folder_id,t.has_embedded_cover,t.disc,t.track_no,f.path as root,a.name as album,
      ar.name as artist,aa.name as album_artist,coalesce(o.fields->>'genre',a.genre) as genre,n.song_id,n.imported_by,n.quality
      from tracks t join music_folders f on f.id=t.music_folder_id join albums a on a.id=t.album_id join artists aa on aa.id=a.artist_id
      join artists ar on ar.id=t.artist_id left join netease_imports n on n.track_id=t.id
      left join track_metadata_overrides o on o.track_id=t.id where t.id=${id} and not t.is_virtual`.pipe(Effect.orDie)
    const parts=String(r?.path??"").split("/"), name=parts.pop()!, media=importedFilename(name)
    if(!r || !media || !checkSubdirectory(parts.join("/")) || (r.song_id ? r.song_id!==media.songId : false)) return yield* notFound("netease_track",id)
    const info:NeteaseInfo={trackId:id,songId:media.songId,quality:r.quality==null?null:String(r.quality),
      format:media.ext,filename:name,title:String(r.title),artist:String(r.artist),album:String(r.album),albumArtist:String(r.album_artist),
      genre:r.genre==null?null:String(r.genre),trackNumber:r.track_no==null?null:Number(r.track_no),discNumber:Number(r.disc),hasCover:Boolean(r.has_embedded_cover)}
    return {r,name,parts,info,ext:media.ext,songId:media.songId}
  })
  // 发布：重扫入库 + 覆盖值落 track_metadata_overrides（重扫存活）；不触碰 netease_imports。
  // 事务/目录锁/reconcile 全部由 indexImport 自理（与导入路径同一入口）。
  const publish=(folderId:number,rel:string,file:string,overrides:MetadataOverrides)=>
    scanner.indexImport(folderId,rel,file,{metadata:overrides})
  const edit=Effect.fnUntraced(function*(user:number,id:string,input:NeteaseTags){
    const tags=yield* Effect.try({try:()=>validNeteaseTags(input),catch:()=>new BadRequest({message:"标签字段无效。"})})
    if(!Object.keys(tags).length) return yield* new BadRequest({message:"请提供需要修改的标签或封面。"})
    const {r,name,parts,ext,songId}=yield* load(id)
    if(Number(r.imported_by)!==user){const [admin]=yield* sql`select is_admin from users where id=${user}`.pipe(Effect.orDie)
      if(!admin?.is_admin)return yield* notFound("editable_netease_track",id)}
    if(locks.has(id)||locks.size>=2)return yield* new BadRequest({message:"已有标签修改进行中，请稍后重试。"})
    // The publication + reindex/rollback critical section must finish before releasing the lock.
    return yield* Effect.acquireUseRelease(Effect.sync(()=>locks.add(id)),()=>Effect.uninterruptible(Effect.tryPromise({try:async()=>{
      const signal=AbortSignal.timeout(60_000), dir=await openDestination(String(r.root),parts)
      const base=`/proc/self/fd/${dir.fd}`, target=`${base}/${name}`
      try {
        const h=await fs.open(target,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK)
        try {
          const st=await h.stat();if(!st.isFile()||st.size>105*1024*1024) throw Error("不支持的文件")
          if(!r.song_id) await verifyNeteaseLegacy(songId,h)
          const tmp=await fs.mkdtemp(`${base}/.om-tag-`);let retain=false
          try {
            const copy=`${tmp}/audio.${ext}`,backup=`${tmp}/original.${ext}`
            await fs.copyFile(`/proc/self/fd/${h.fd}`,copy,constants.COPYFILE_EXCL)
            const result=await applyNeteaseEdit(tmp,songId,tags,rt,signal,{ext})
            await fs.chmod(copy,st.mode&0o777)
             const current=await fs.lstat(target);if(current.ino!==st.ino || current.dev!==st.dev || current.mtimeMs!==st.mtimeMs || current.size!==st.size) throw Error("文件已变化")
             if(result.dbOnly){await Effect.runPromise(publish(Number(r.music_folder_id),String(r.path),target,result.overrides));return result.warnings}
            await fs.copyFile(`/proc/self/fd/${h.fd}`,backup,constants.COPYFILE_EXCL)
            await fs.rename(copy,target)
            try {await Effect.runPromise(publish(Number(r.music_folder_id),String(r.path),target,result.overrides))}
             catch(e){try{await fs.rename(backup,target)}catch{retain=true};throw e}
             return result.warnings
          } finally {if(!retain)await fs.rm(tmp,{recursive:true,force:true})}
        } finally {await h.close()}
      } finally {await dir.close()}
    },catch:()=>new BadRequest({message:"修改未完成，请检查导入来源、图片类型、目录权限及网络。"})})),()=>Effect.sync(()=>locks.delete(id)))
      .pipe(Effect.flatMap(warnings=>Effect.map(load(id),v=>warnings.length ? {...v.info,warnings} : v.info)))
  })
  return {edit,info:(id:string)=>Effect.map(load(id),v=>v.info)}
}
