import { Context, Deferred, Effect, Layer } from "effect"
import { join } from "node:path"
import { SqlClient } from "effect/unstable/sql"
import { BadRequest, notFound, type NotFound } from "../../domain/errors"
import type { CatalogMatch, ImportResult, YoutubeFormat, YoutubeInfo, YoutubeTags } from "../../domain/youtube"
import { catalogSearch, validTags } from "./metadata"
import { libraryTags } from "./library-tags"
import { youtubeCaptions } from "./captions"
import { youtubeRemovals } from "./removals"
import { createHash } from "node:crypto"
import { MusicFolderRepo } from "../../repo/music-folders"
import { AgentSessionRepo } from "../../repo/agent-sessions"
import { Scanner } from "../scanner"
import { checkSubdirectory, youtubeSource } from "./source"
import { childDirectories, downloadOne, openDestination, searchYoutube, videoList, type Candidate } from "./downloader"

type Fail = BadRequest | NotFound
const bad = (message: string) => new BadRequest({message})
export class YoutubeImports extends Context.Service<YoutubeImports, {
  removals:ReturnType<typeof youtubeRemovals>
  captions:ReturnType<typeof youtubeCaptions>
  search(owner:number, query:string): Effect.Effect<Candidate[], BadRequest>
  folders(): Effect.Effect<Array<{id:string; name:string; path:string; writable:boolean}>>
  children(folderId:string, subdirectory:string): Effect.Effect<{directories:string[];truncated:boolean}, Fail>
  start(owner:number, session:string, url:string, folderId:string, subdirectory:string, tags?:YoutubeTags, format?:YoutubeFormat): Effect.Effect<ImportResult, Fail>
  info(id:string):Effect.Effect<YoutubeInfo,Fail>
  edit(owner:number,id:string,tags:YoutubeTags):Effect.Effect<YoutubeInfo,Fail>
  catalog(query:string,country:string):Effect.Effect<(typeof CatalogMatch.Type)[],BadRequest>
}>()("openmusic/YoutubeImports") {
  static readonly layer = Layer.effect(YoutubeImports, Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient, scanner = yield* Scanner
    const metadata=libraryTags(sql,scanner)
    const mutating = new Set<string>()
    const guarded = <A,E>(id:string, task:Effect.Effect<A,E>) => Effect.suspend(() => {
      if(mutating.has(id))return Effect.fail(bad("此版本正被修改，请稍后再试。")) as Effect.Effect<A,E|BadRequest>
      mutating.add(id); return task.pipe(Effect.ensuring(Effect.sync(()=>mutating.delete(id))))
    })
    const removals=youtubeRemovals(sql,guarded)
    // Single-flight only: no background job, completed-job cache or polling endpoint.
    const active = new Map<number, { key: string; result: Deferred.Deferred<ImportResult, BadRequest> }>()
    const searches = new Set<number>()
    const sessionOK = (owner:number, session:string) => !session ? Effect.void : AgentSessionRepo.ownerOf(session).pipe(
      Effect.provideService(SqlClient.SqlClient,sql), Effect.orDie,
      Effect.flatMap(id => id === owner ? Effect.void : Effect.fail(notFound("agent_session", session))))
    const locate = Effect.fnUntraced(function* (folderId:string, subdirectory:string) {
      const parts = checkSubdirectory(subdirectory)
      if (!parts || !/^[1-9]\d{0,15}$/.test(folderId)) return yield* bad("目标必须是已注册的曲库 ID 和已有的相对子目录。")
      const folder = yield* MusicFolderRepo.byId(folderId).pipe(Effect.provideService(SqlClient.SqlClient,sql), Effect.catchTag("SqlError",Effect.die))
      return { folder, parts }
    })
    return YoutubeImports.of({
      info:metadata.info,edit:(user,id,tags)=>guarded(id,metadata.edit(user,id,tags)),removals,captions:youtubeCaptions(sql),
      catalog:(q,country)=>Effect.tryPromise({try:signal=>catalogSearch(q,country,signal),catch:()=>bad("音乐目录查询失败，请检查搜索词、地区和网络。")}),
      folders: () => MusicFolderRepo.list.pipe(Effect.provideService(SqlClient.SqlClient,sql), Effect.orDie,
        Effect.flatMap(folders => Effect.forEach(folders, f => Effect.promise(async () => ({
          id:f.id, name:f.name, path:f.path,
          writable:await openDestination(f.path,[]).then(async h=>{ await h.close(); return true },()=>false),
        })), {concurrency:4}))),
      children: (id,sub) => Effect.flatMap(locate(id,sub), ({folder,parts}) => Effect.tryPromise({
        try: () => childDirectories(folder.path,parts), catch: () => bad("无法查看该子目录；目录必须存在且不能是符号链接。"),
      })),
      search: (owner, query) => Effect.suspend(() => {
        if (!query.trim() || query.length > 160 || /[\x00-\x1f]/.test(query)) return Effect.fail(bad("搜索词须为 1–160 个字符。"))
        if (searches.has(owner) || searches.size >= 4) return Effect.fail(bad("正在搜索，请稍后再试。"))
        return Effect.acquireUseRelease(Effect.sync(() => searches.add(owner)), () => Effect.tryPromise({
          try: signal => searchYoutube(query.trim(),signal), catch: () => bad("搜索失败，请检查服务器的 yt-dlp 和 YouTube 网络连接。"),
        }), () => Effect.sync(() => searches.delete(owner)))
      }),
      start: (owner,session,url,folderId,subdirectory,overrides={},format="original") => Effect.gen(function* () {
        yield* sessionOK(owner,session)
        const source = youtubeSource(url); if (!source) return yield* bad("仅接受 YouTube 视频或播放列表链接。")
        const tags=yield* Effect.try({try:()=>validTags(overrides),catch:()=>bad("无效的元数据字段。")})
        if(source.kind==="playlist" && Object.keys(tags).length) return yield* bad("不要给整张播放列表套用同一套标签；请在入库后按 trackId 修改。")
        const { folder, parts } = yield* locate(folderId,subdirectory)
        const destination = join(folder.path,...parts)
        const key = JSON.stringify([session,source.url,folderId,subdirectory,format,createHash("sha256").update(JSON.stringify(tags)).digest("hex")])
        const existing = active.get(owner)
        if (existing?.key === key) return yield* Deferred.await(existing.result)
        if (existing || active.size >= 2) return yield* bad("已有导入正在执行，请稍后再试。")

        const run = async (signal: AbortSignal): Promise<ImportResult> => {
          const dest = await openDestination(folder.path,parts).catch(()=>{throw bad("目标目录不存在、不可写或包含符号链接；尚未开始下载。")})
          try {
            const ids = await videoList(source,signal).catch(()=>{throw bad("无法读取 YouTube 列表，请检查网络及条目数（1–25 首）。")})
            const trackIds: number[] = [], failures: {videoId:string; reason:string}[] = []
            const files: {trackId:number;name:string}[] = []
            const warnings: {videoId:string;message:string}[]=[]
            let imported = 0, skipped = 0
            for (const video of ids) {
              signal.throwIfAborted()
              try {
                const item = await downloadOne(video,dest,signal,(file,name,meta)=>Effect.runPromise(metadata.index(Number(folder.id),[...parts,name].join("/"),file,owner,video,meta,true)),tags,format)
                const {status,name}=item
                if(status==="imported") warnings.push(...item.warnings.map(message=>({videoId:video,message})))
                else if(Object.keys(tags).length) warnings.push({videoId:video,message:"已有文件未覆盖。请用 edit_metadata 按 trackId 修改。"})
                const rel = [...parts,name].join("/")
                const [row] = await Effect.runPromise(sql`select id from tracks where music_folder_id=${folder.id} and path=${rel}`)
                const trackId = Number(row?.id)
                if (!Number.isSafeInteger(trackId) || trackId <= 0) {
                  failures.push({videoId:video,reason:"文件存在，但未找到已入库的曲目。"}); continue
                }
                trackIds.push(trackId)
                files.push({trackId,name})
                if (status === "imported") imported++; else skipped++
              } catch {
                signal.throwIfAborted()
                failures.push({videoId:video,reason:`${format} 导入失败：请检查可用音视频流、时长、大小、网络和目录权限。未改用其他格式。`})
              }
            }
            return {...source,format,files,destination,state:!failures.length ? "done" : trackIds.length ? "partial" : "failed",
              total:ids.length,imported,skipped,failed:failures.length,trackIds,failures,warnings}
          } finally { await dest.close() }
        }
        const result = Deferred.makeUnsafe<ImportResult, BadRequest>()
        active.set(owner,{key,result})
        const call = Effect.callback<ImportResult, BadRequest>(resume => {
          const abort = new AbortController()
          const settled = run(abort.signal).then(
            value => resume(Effect.succeed(value)),
            e => resume(Effect.fail(e instanceof BadRequest ? e : bad("导入失败。"))),
          )
          // Keep the concurrency slot until the child process and its temp files are gone.
          return Effect.promise(async () => { abort.abort(); await settled })
        })
        yield* Deferred.into(call,result).pipe(Effect.ensuring(Effect.sync(()=>active.delete(owner))))
        return yield* Deferred.await(result)
      }),
    })
  }))
}
