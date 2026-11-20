import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import type { FileHandle } from "node:fs/promises"
import path from "node:path"
import { parseFile } from "music-metadata"
import { BadRequest, notFound } from "../../domain/errors"
import { importedFilename } from "./formats"
import { checkSubdirectory } from "./source"
import type { YoutubeFormat } from "../../domain/youtube"
import { importRemovals, type RemovalTarget } from "../import-removals"

/** YouTube 侧薄适配：load 的属主/provenance 查询与 legacy purl 核验保持原语义，
 *  票据与删除事务全部来自共享内核（service/import-removals.ts）。 */
interface YoutubeTarget extends RemovalTarget { videoId:string; format:YoutubeFormat }

const load=Effect.fnUntraced(function*(sql:SqlClient.SqlClient,user:number,id:string,lock:boolean){
  if(!/^[1-9]\d{0,15}$/.test(id))return yield* notFound("youtube_track",id)
  const [r]=yield* sql`select t.xmin::text as revision,t.path,t.title,t.artist_id,t.album_id,t.size_bytes,t.mtime_ms,
    ar.name as artist,f.id as folder,f.path as root,y.video_id from tracks t join music_folders f on f.id=t.music_folder_id
    join artists ar on ar.id=t.artist_id left join youtube_imports y on y.track_id=t.id join users u on u.id=${user}
    where t.id=${id} and not t.is_virtual and (u.is_admin or y.imported_by=u.id) ${lock?sql.literal('for update of t,f'):sql.literal('')}`.pipe(Effect.orDie)
  if(!r)return yield* notFound("youtube_track",id)
  const rel=String(r.path), parts=rel.split("/"), name=parts.pop()!, media=importedFilename(name)
  if(!media || path.isAbsolute(rel) || !checkSubdirectory(parts.join("/")) || (r.video_id ? r.video_id!==media.videoId : media.ext!=="mp3"))return yield* notFound("youtube_track",id)
  return {id,folder:Number(r.folder),root:String(r.root),rel,parts,name,title:String(r.title),artist:String(r.artist),version:String(r.revision),
    legacy:!r.video_id,videoId:media.videoId,format:media.format,size:Number(r.size_bytes),mtime:Number(r.mtime_ms),album:String(r.album_id),artistId:String(r.artist_id)} satisfies YoutubeTarget
})

export function youtubeRemovals(sql:SqlClient.SqlClient, guarded:<A,E>(id:string,task:Effect.Effect<A,E>)=>Effect.Effect<A,E|BadRequest>) {
  return importRemovals<YoutubeTarget,YoutubeFormat>(sql,guarded,{
    entity:"youtube_track",
    load:(user,id,lock)=>load(sql,user,id,lock),
    // Pre-provenance mp3 rips carry the canonical watch URL in a TXXX purl/comment frame.
    verifyLegacy:async(target,file:FileHandle)=>{
      const tags=await parseFile(`/proc/self/fd/${file.fd}`,{skipCovers:true})
      const url=`https://www.youtube.com/watch?v=${target.videoId}`
      if (!Object.values(tags.native).some(group=>group.some(t=>/^TXXX:(purl|comment)$/i.test(t.id) && t.value===url))) throw Error("unverified legacy file")
    },
    formatOf:t=>t.format,
  })
}
