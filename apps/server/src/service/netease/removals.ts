import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import path from "node:path"
import { BadRequest, notFound } from "../../domain/errors"
import { checkSubdirectory } from "../youtube/source"
import { importedFilename, type NeteaseExt } from "./formats"
import { verifyNeteaseLegacy } from "./metadata"
import { importRemovals, type RemovalTarget } from "../import-removals"

/** 网易云侧适配：netese_imports 的属主/溯源 + `Netease-<songId>.mp3|flac` 文件名。
 *  legacy（无 provenance 行，如曲目行被扫描器重建）时属主列缺失 → 仅管理员可动，
 *  且必须通过 OPENMUSIC_NETEASE_ID 标签核验；mp3 与 flac 都是合法落盘形态（与 youtube
 *  的 legacy 仅 mp3 不同：netease 从第一版起就写全 provenance 标签）。 */
interface NeteaseTarget extends RemovalTarget { songId:string; ext:NeteaseExt }

const load=Effect.fnUntraced(function*(sql:SqlClient.SqlClient,user:number,id:string,lock:boolean){
  if(!/^[1-9]\d{0,15}$/.test(id))return yield* notFound("netease_track",id)
  const [r]=yield* sql`select t.xmin::text as revision,t.path,t.title,t.artist_id,t.album_id,t.size_bytes,t.mtime_ms,
    ar.name as artist,f.id as folder,f.path as root,n.song_id from tracks t join music_folders f on f.id=t.music_folder_id
    join artists ar on ar.id=t.artist_id left join netease_imports n on n.track_id=t.id join users u on u.id=${user}
    where t.id=${id} and not t.is_virtual and (u.is_admin or n.imported_by=u.id) ${lock?sql.literal('for update of t,f'):sql.literal('')}`.pipe(Effect.orDie)
  if(!r)return yield* notFound("netease_track",id)
  const rel=String(r.path), parts=rel.split("/"), name=parts.pop()!, media=importedFilename(name)
  if(!media || path.isAbsolute(rel) || !checkSubdirectory(parts.join("/")) || (r.song_id ? r.song_id!==media.songId : false))return yield* notFound("netease_track",id)
  return {id,folder:Number(r.folder),root:String(r.root),rel,parts,name,title:String(r.title),artist:String(r.artist),version:String(r.revision),
    legacy:!r.song_id,songId:media.songId,ext:media.ext,size:Number(r.size_bytes),mtime:Number(r.mtime_ms),album:String(r.album_id),artistId:String(r.artist_id)} satisfies NeteaseTarget
})

export function neteaseRemovals(sql:SqlClient.SqlClient, guarded:<A,E>(id:string,task:Effect.Effect<A,E>)=>Effect.Effect<A,E|BadRequest>) {
  return importRemovals<NeteaseTarget,NeteaseExt>(sql,guarded,{
    entity:"netease_track",
    load:(user,id,lock)=>load(sql,user,id,lock),
    verifyLegacy:(target,file)=>verifyNeteaseLegacy(target.songId,file),
    formatOf:t=>t.ext,
  })
}
