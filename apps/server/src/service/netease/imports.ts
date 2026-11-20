import { Context, Deferred, Effect, Layer } from "effect"
import { join } from "node:path"
import { SqlClient } from "effect/unstable/sql"
import { BadRequest, notFound, type NotFound } from "../../domain/errors"
import type { NeteaseCandidate, NeteaseImportResult } from "../../domain/netease"
import { AppConfig } from "../../config"
import { MusicFolderRepo } from "../../repo/music-folders"
import { AgentSessionRepo } from "../../repo/agent-sessions"
import { lockFolderIndex } from "../../repo/library-exclusions"
import { Scanner } from "../scanner"
import { lyricService } from "../lyrics"
import { childDirectories, openDestination } from "../youtube/downloader"
import { checkSubdirectory } from "../youtube/source"
import { neteaseSource } from "./source"
import {
  VIP_SKIP_REASON, albumDetail, mergeLyrics, neteaseRuntime, searchSongs, songDetails, songLyrics, vipFee,
  type NeteaseRuntime, type SongBrief,
} from "./api"
import { importSong, neteaseSongList, SONG_LIMIT, NeteaseSongFailure } from "./downloader"
import { releaseDay } from "./metadata"

type Fail = BadRequest | NotFound
const bad = (message: string) => new BadRequest({ message })

export class NeteaseImports extends Context.Service<NeteaseImports, {
  search(owner: number, query: string): Effect.Effect<NeteaseCandidate[], BadRequest>
  folders(): Effect.Effect<Array<{ id: string; name: string; path: string; writable: boolean }>>
  children(folderId: string, subdirectory: string): Effect.Effect<{ directories: string[]; truncated: boolean }, Fail>
  start(owner: number, session: string, url: string, folderId: string, subdirectory: string): Effect.Effect<NeteaseImportResult, Fail>
}>()("openmusic/NeteaseImports") {
  static readonly layer = Layer.effect(NeteaseImports, Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient, scanner = yield* Scanner, appConfig = yield* AppConfig
    // Invalid NETEASE_* values fail loudly at startup instead of degrading silently.
    const runtime: NeteaseRuntime = neteaseRuntime(appConfig)
    const lyrics = lyricService(sql)
    // Scanner upsert and provenance commit together, like the YouTube import.
    const index = (folderId: number, rel: string, file: string, user: number, songId: string, quality: string) =>
      sql.withTransaction(Effect.gen(function* () {
        yield* lockFolderIndex(sql, folderId)
        yield* sql`delete from library_exclusions where music_folder_id=${folderId} and path=${rel}`
        yield* scanner.indexImport(folderId, rel, file)
        yield* sql`insert into netease_imports(track_id,song_id,imported_by,quality)
          select id,${songId},${user},${quality} from tracks where music_folder_id=${folderId} and path=${rel}
          on conflict(track_id) do update set song_id=excluded.song_id,quality=excluded.quality,imported_by=excluded.imported_by`
      }))
    // Single-flight only (same posture as YouTube): no queue, no polling, shared terminal state.
    const active = new Map<number, { key: string; result: Deferred.Deferred<NeteaseImportResult, BadRequest> }>()
    const searches = new Set<number>()
    const sessionOK = (owner: number, session: string) => !session ? Effect.void : AgentSessionRepo.ownerOf(session).pipe(
      Effect.provideService(SqlClient.SqlClient, sql), Effect.orDie,
      Effect.flatMap(id => id === owner ? Effect.void : Effect.fail(notFound("agent_session", session))))
    const locate = Effect.fnUntraced(function* (folderId: string, subdirectory: string) {
      const parts = checkSubdirectory(subdirectory)
      if (!parts || !/^[1-9]\d{0,15}$/.test(folderId)) return yield* bad("目标必须是已注册的曲库 ID 和已有的相对子目录。")
      const folder = yield* MusicFolderRepo.byId(folderId).pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.catchTag("SqlError", Effect.die))
      return { folder, parts }
    })
    const candidate = (brief: SongBrief): NeteaseCandidate => ({
      title: brief.title, artist: brief.artist, album: brief.album, songId: brief.songId,
      url: `https://music.163.com/song?id=${brief.songId}`, vip: vipFee(brief.fee),
    })
    return NeteaseImports.of({
      folders: () => MusicFolderRepo.list.pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.orDie,
        Effect.flatMap(folders => Effect.forEach(folders, f => Effect.promise(async () => ({
          id: f.id, name: f.name, path: f.path,
          writable: await openDestination(f.path, []).then(async h => { await h.close(); return true }, () => false),
        })), { concurrency: 4 }))),
      children: (id, sub) => Effect.flatMap(locate(id, sub), ({ folder, parts }) => Effect.tryPromise({
        try: () => childDirectories(folder.path, parts), catch: () => bad("无法查看该子目录；目录必须存在且不能是符号链接。"),
      })),
      search: (owner, query) => Effect.suspend(() => {
        if (!query.trim() || query.length > 160 || /[\x00-\x1f]/.test(query)) return Effect.fail(bad("搜索词须为 1–160 个字符。"))
        if (searches.has(owner) || searches.size >= 4) return Effect.fail(bad("正在搜索，请稍后再试。"))
        return Effect.acquireUseRelease(Effect.sync(() => searches.add(owner)), () => Effect.tryPromise({
          try: signal => searchSongs(query.trim(), runtime, signal).then(rows => rows.map(candidate)),
          catch: () => bad("搜索失败，请检查服务器到网易云或 NETEASE_API_BASE 实例的网络连接。"),
        }), () => Effect.sync(() => searches.delete(owner)))
      }),
      start: (owner, session, url, folderId, subdirectory) => Effect.gen(function* () {
        yield* sessionOK(owner, session)
        const source = neteaseSource(url)
        if (!source) return yield* bad("仅接受网易云音乐歌曲、歌单、专辑或歌手链接。")
        const { folder, parts } = yield* locate(folderId, subdirectory)
        const destination = join(folder.path, ...parts)
        const key = JSON.stringify([session, source.url, folderId, subdirectory])
        const existing = active.get(owner)
        if (existing?.key === key) return yield* Deferred.await(existing.result)
        if (existing || active.size >= 2) return yield* bad("已有导入正在执行，请稍后再试。")

        const run = async (signal: AbortSignal): Promise<NeteaseImportResult> => {
          const dest = await openDestination(folder.path, parts).catch(() => { throw bad("目标目录不存在、不可写或包含符号链接；尚未开始下载。") })
          try {
            // 1) Enumerate + batch precheck (fee/duration/title metadata per song).
            let items: Array<{ songId: string; brief: SongBrief | null }>, truncated = false, albumDate: string | null = null
            if (source.kind === "album") {
              const album = await albumDetail(source.id, runtime, signal).catch(() => { signal.throwIfAborted(); throw bad("暂时无法读取专辑（接口风控或限制），请稍后重试或配置 NETEASE_API_BASE 实例。") })
              if (!album.songs.length) throw bad("专辑内没有可导入的歌曲。")
              if (album.songs.length > SONG_LIMIT) throw bad(`专辑超过 ${SONG_LIMIT} 首（共 ${album.songs.length} 首），请分批或逐首导入。`)
              items = album.songs.map(brief => ({ songId: brief.songId, brief }))
              albumDate = releaseDay(album.publishTimeMs, "ms")
            } else {
              let ids: string[]
              try { const list = await neteaseSongList(source, signal); ids = list.ids; truncated = list.truncated }
              catch { signal.throwIfAborted(); throw bad(source.kind === "artist" ? "无法读取歌手热门曲目，请检查网络。" : `无法读取歌单，请检查网络及条目数（1–${SONG_LIMIT} 首）。`) }
              const details = await songDetails(ids, runtime, signal).catch(() => { signal.throwIfAborted(); throw bad("无法读取歌曲详情，请检查网络与 NETEASE_API_BASE 实例配置。") })
              items = ids.map(songId => ({ songId, brief: details.get(songId) ?? null }))
            }
            const trackIds: number[] = [], files: { trackId: number; name: string }[] = []
            const failures: { songId: string; reason: string }[] = [], warnings: { songId: string; message: string }[] = []
            if (truncated) warnings.push({ songId: source.id, message: `歌手热门曲目超过 ${SONG_LIMIT} 首，仅导入前 ${SONG_LIMIT} 首。` })
            let imported = 0, skipped = 0
            for (const { songId, brief } of items) {
              signal.throwIfAborted()
              if (!brief) { failures.push({ songId, reason: "歌曲详情不可用（可能已下架或地区限制），已跳过。" }); continue }
              if (!runtime.base && vipFee(brief.fee)) { failures.push({ songId, reason: VIP_SKIP_REASON }); continue }
              if (!brief.durationMs) { failures.push({ songId, reason: "无法核对歌曲时长（详情缺失），已跳过。" }); continue }
              try {
                const item = await importSong(songId, dest, signal, runtime, brief, albumDate,
                  (file, name, quality) => Effect.runPromise(index(Number(folder.id), [...parts, name].join("/"), file, owner, songId, quality)))
                const { status, name } = item
                if (status === "imported") warnings.push(...item.warnings.map(message => ({ songId, message })))
                const rel = [...parts, name].join("/")
                const [row] = await Effect.runPromise(sql`select id from tracks where music_folder_id=${folder.id} and path=${rel}`)
                const trackId = Number(row?.id)
                if (!Number.isSafeInteger(trackId) || trackId <= 0) {
                  failures.push({ songId, reason: "文件存在，但未找到已入库的曲目。" }); continue
                }
                trackIds.push(trackId); files.push({ trackId, name })
                if (status === "imported") {
                  imported++
                  // Lyrics never block the import: original + merged translation into the shared lyric store.
                  try {
                    const lyric = await songLyrics(songId, runtime, signal)
                    const body = lyric && lyric.lrc.trim() ? mergeLyrics(lyric.lrc, lyric.tlyrc) : null
                    if (body) await Effect.runPromise(lyrics.edit(owner, String(trackId), body))
                    else warnings.push({ songId, message: "未取得歌词。" })
                  } catch { warnings.push({ songId, message: "歌词入库失败，不影响已导入的音频。" }) }
                } else skipped++
              } catch (e) {
                signal.throwIfAborted()
                failures.push({ songId, reason: e instanceof NeteaseSongFailure ? e.message : "导入失败：网络、来源或目录权限问题。" })
              }
            }
            return {
              url: source.url, kind: source.kind,
              state: !failures.length ? "done" : trackIds.length ? "partial" : "failed",
              total: items.length, imported, skipped, failed: failures.length, destination,
              quality: runtime.base ? runtime.level : "anonymous",
              trackIds, files, failures, warnings,
            }
          } finally { await dest.close() }
        }
        const result = Deferred.makeUnsafe<NeteaseImportResult, BadRequest>()
        active.set(owner, { key, result })
        const call = Effect.callback<NeteaseImportResult, BadRequest>(resume => {
          const abort = new AbortController()
          const settled = run(abort.signal).then(
            value => resume(Effect.succeed(value)),
            e => resume(Effect.fail(e instanceof BadRequest ? e : bad("导入失败。"))),
          )
          // Keep the concurrency slot until the child process and its temp files are gone.
          return Effect.promise(async () => { abort.abort(); await settled })
        })
        yield* Deferred.into(call, result).pipe(Effect.ensuring(Effect.sync(() => active.delete(owner))))
        return yield* Deferred.await(result)
      }),
    })
  }))
}
