import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { constants } from "node:fs"
import * as fs from "node:fs/promises"
import { BadRequest, notFound } from "../../domain/errors"
import type { YoutubeInfo, YoutubeTags } from "../../domain/youtube"
import type { Scanner } from "../scanner"
import { openDestination, runDlp } from "./downloader"
import { applyTags, type TagResult, uploadDay, validTags } from "./metadata"
import { checkSubdirectory } from "./source"
import { importedFilename } from "./formats"
import { lockFolderIndex } from "../../repo/library-exclusions"

export function libraryTags(sql:SqlClient.SqlClient, scanner:Scanner["Service"]) {
  const locks=new Set<string>()
  const load=Effect.fnUntraced(function*(id:string){
    if(!/^[1-9]\d{0,15}$/.test(id)) return yield* notFound("youtube_track",id)
    const [r]=yield* sql`select t.title,t.path,t.album_id,t.music_folder_id,t.has_embedded_cover,t.disc,t.track_no,f.path as root,a.name as album,
      ar.name as artist,aa.name as album_artist,coalesce(o.fields->>'genre',y.genre,a.genre) as genre,y.video_id,y.imported_by,y.upload_date::text,y.cover_source
      from tracks t join music_folders f on f.id=t.music_folder_id join albums a on a.id=t.album_id join artists aa on aa.id=a.artist_id
      join artists ar on ar.id=t.artist_id left join youtube_imports y on y.track_id=t.id
      left join track_metadata_overrides o on o.track_id=t.id where t.id=${id} and not t.is_virtual`.pipe(Effect.orDie)
    const parts=String(r?.path??"").split("/"), name=parts.pop()!, media=importedFilename(name)
    if(!r || !media || !checkSubdirectory(parts.join("/")) || (r.video_id ? media.videoId!==r.video_id : media.ext!=="mp3")) return yield* notFound("youtube_track",id)
    const info:YoutubeInfo={trackId:id,filename:name,format:media.format,videoId:media.videoId,title:String(r.title),artist:String(r.artist),album:String(r.album),albumArtist:String(r.album_artist),
      uploadDate:r.upload_date==null?null:String(r.upload_date),genre:r.genre==null?null:String(r.genre),coverSource:r.cover_source==null?null:String(r.cover_source),
      trackNumber:r.track_no==null?null:Number(r.track_no),discNumber:Number(r.disc),hasCover:Boolean(r.has_embedded_cover)}
    return {r,name,parts,info,ext:media.ext}
  })
  // Both scanner upsert and provenance are part of the same database commit.
  const index=(folderId:number,rel:string,file:string,user:number,video:string,meta:TagResult,newFile=false)=>sql.withTransaction(Effect.gen(function*(){
    yield* lockFolderIndex(sql,folderId)
    if (newFile) yield* sql`delete from library_exclusions where music_folder_id=${folderId} and path=${rel}`
    yield* scanner.indexImport(folderId,rel,file,{metadata:meta.overrides,fileDateIsUpload:true})
    yield* sql`insert into youtube_imports(track_id,video_id,imported_by,upload_date,cover_source,genre)
      select id,${video},${user},${meta.uploadDate}::date,${meta.coverSource},${meta.genre} from tracks where music_folder_id=${folderId} and path=${rel}
      on conflict(track_id) do update set upload_date=coalesce(excluded.upload_date,youtube_imports.upload_date),
      cover_source=coalesce(excluded.cover_source,youtube_imports.cover_source),genre=case when ${meta.dbOnly} then coalesce(excluded.genre,youtube_imports.genre) else excluded.genre end`
  }))
  const edit=Effect.fnUntraced(function*(user:number,id:string,input:YoutubeTags){
    const tags=yield* Effect.try({try:()=>validTags(input),catch:()=>new BadRequest({message:"标签字段无效。"})})
    if(!Object.keys(tags).length) return yield* new BadRequest({message:"请提供需要修改的标签或封面。"})
    const {r,name,parts,info,ext}=yield* load(id)
    if(Number(r.imported_by)!==user){const [admin]=yield* sql`select is_admin from users where id=${user}`.pipe(Effect.orDie)
      if(!admin?.is_admin)return yield* notFound("editable_youtube_track",id)}
    if(locks.has(id)||locks.size>=2)return yield* new BadRequest({message:"已有标签修改进行中，请稍后重试。"})
    // The publication + reindex/rollback critical section must finish before releasing the lock.
    return yield* Effect.acquireUseRelease(Effect.sync(()=>locks.add(id)),()=>Effect.uninterruptible(Effect.tryPromise({try:async()=>{
      const signal=AbortSignal.timeout(60_000), dir=await openDestination(String(r.root),parts)
      const base=`/proc/self/fd/${dir.fd}`, target=`${base}/${name}`
      try {
        const h=await fs.open(target,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK)
        try {
          const st=await h.stat();if(!st.isFile()||st.size>105*1024*1024) throw Error("不支持的文件")
          const tmp=await fs.mkdtemp(`${base}/.om-tag-`);let retain=false
          try {
            const copy=`${tmp}/audio.${ext}`,backup=`${tmp}/original.${ext}`
            await fs.copyFile(`/proc/self/fd/${h.fd}`,copy,constants.COPYFILE_EXCL)
            let date=info.uploadDate
            if(!date){const raw=await runDlp(["--skip-download","--no-playlist","--print","%(upload_date)s","--",`https://www.youtube.com/watch?v=${info.videoId}`],signal).catch(()=>"");date=uploadDay(raw.trim())}
            const result=await applyTags(tmp,info.videoId,tags,{},signal,{ext,editing:true,verifyLegacy:!r.video_id,knownDate:date})
            await fs.chmod(copy,st.mode&0o777)
             const current=await fs.lstat(target);if(current.ino!==st.ino || current.dev!==st.dev || current.mtimeMs!==st.mtimeMs || current.size!==st.size) throw Error("文件已变化")
             if(result.dbOnly){await Effect.runPromise(index(Number(r.music_folder_id),String(r.path),target,user,info.videoId,result));return result.warnings}
            await fs.copyFile(`/proc/self/fd/${h.fd}`,backup,constants.COPYFILE_EXCL)
            await fs.rename(copy,target)
            try {await Effect.runPromise(index(Number(r.music_folder_id),String(r.path),target,user,info.videoId,result))}
             catch(e){try{await fs.rename(backup,target)}catch{retain=true};throw e}
             return result.warnings
          } finally {if(!retain)await fs.rm(tmp,{recursive:true,force:true})}
        } finally {await h.close()}
      } finally {await dir.close()}
    },catch:()=>new BadRequest({message:"修改未完成，请检查导入来源、图片类型、目录权限及网络。"})})),()=>Effect.sync(()=>locks.delete(id)))
      .pipe(Effect.flatMap(warnings=>Effect.map(load(id),v=>warnings.length ? {...v.info,warnings} : v.info)))
  })
  return {index,edit,info:(id:string)=>Effect.map(load(id),v=>v.info)}
}
