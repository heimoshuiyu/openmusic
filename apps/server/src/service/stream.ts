import { SqlClient } from "effect/unstable/sql"
import * as fs from "node:fs/promises"
import { Context, Effect, Exit, Layer, Schedule } from "effect"
import * as Semaphore from "effect/Semaphore"
import { NotFound, notFound } from "../domain/errors"
import { AppConfig } from "../config"
import { extensionForCodec, mimeForCodec } from "../util/codecs"
import { planEviction } from "../util/cache"
import { randomToken } from "../util/crypto"
import { ffprobeMeta } from "../util/media-probe"

/** 转码目标格式 → ffmpeg 参数（docs/02 §6.2） */
const TRANSCODE_TARGETS: Record<string, { args: ReadonlyArray<string>; container: string; mime: string }> = {
  mp3: { args: ["-codec:a", "libmp3lame"], container: "mp3", mime: "audio/mpeg" },
  opus: { args: ["-codec:a", "libopus"], container: "ogg", mime: "audio/ogg" },
  ogg: { args: ["-codec:a", "libvorbis"], container: "ogg", mime: "audio/ogg" },
  aac: { args: ["-codec:a", "aac"], container: "adts", mime: "audio/aac" },
  flac: { args: ["-codec:a", "flac"], container: "flac", mime: "audio/flac" },
}

/** 浏览器普遍可直解的 codec（其余默认转码） */
const BROWSER_PLAYABLE = new Set(["mp3", "aac", "alac", "flac", "vorbis", "opus", "wav"])

/** raw + timeOffset 的流拷贝目标（-c:a copy 需要容器匹配源编码；alac 等容器不便的走转码兜底） */
const COPY_TARGETS: Record<string, { container: string; mime: string }> = {
  mp3: { container: "mp3", mime: "audio/mpeg" },
  flac: { container: "flac", mime: "audio/flac" },
  aac: { container: "adts", mime: "audio/aac" },
  vorbis: { container: "ogg", mime: "audio/ogg" },
  opus: { container: "ogg", mime: "audio/ogg" },
  wav: { container: "wav", mime: "audio/wav" },
}

/** 单个转码缓存条目上限：超长曲目完整转码（如 14h 录音 → mp3 ≈ 2GiB）会把
 *  LRU 预算冲刷成单文件独占——超过估算体积的条目纯流式透传，不落盘 */
const CACHE_ENTRY_MAX_BYTES = 256 * 1024 * 1024

/** 估算缓存条目体积用的保守码率（目标未指定 -b:a 时 ffmpeg 缺省 ~128-192k） */
const EST_UNSET_KBPS = 320

export interface StreamTrack {
  readonly id: number
  readonly title: string
  readonly absPath: string
  readonly codec: string
  readonly mime: string
  readonly bitrateKbps: number
  readonly sizeBytes: number
  /** CUE 虚拟分段（docs/03 §2.9）：分段起点/时长；物理行恒为 0/全长/false */
  readonly offsetMs: number
  readonly durationSec: number
  readonly isVirtual: boolean
}

export interface StreamParams {
  /** raw = 原样直传；否则为转码目标格式 */
  readonly format?: string | undefined
  /** kbps，0 = 不限制 */
  readonly maxBitRate?: number | undefined
  /** 从多少秒开始（断点续播/seek；>0 时走 ffmpeg，不读不写转码缓存） */
  readonly timeOffset?: number | undefined
}

export interface RangeHeader {
  readonly start: number
  readonly end: number
}

export interface StreamApi {
  readonly stream: (
    trackId: string,
    params: StreamParams,
    rangeHeader?: string | undefined,
  ) => Effect.Effect<Response, NotFound>
  readonly download: (trackId: string) => Effect.Effect<Response, NotFound>
  readonly cover: (coverId: string) => Effect.Effect<Response, NotFound>
  readonly trackById: (id: string) => Effect.Effect<StreamTrack, NotFound>
}

export class Stream extends Context.Service<Stream, StreamApi>()("app/Stream") {
  static readonly layer = Layer.effect(
    Stream,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const config = yield* AppConfig

    yield* Effect.promise(() => fs.mkdir(config.transcodeCacheDir, { recursive: true }))
    const coversDir = `${config.dataDir}/covers`
    yield* Effect.promise(() => fs.mkdir(coversDir, { recursive: true }))

    // 并发转码上限：流生命周期跨越响应构造，手动管理许可
    // （take 在 Effect 内执行；release 在流结束/取消回调中以 runSync 语义执行）
    const semaphore: Semaphore.Semaphore = yield* Semaphore.make(config.transcodeMaxConcurrency)

    /** SqlError 等基础设施错误 → defect；域错误保持类型化 */
    const infra = <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, Exclude<E, { readonly _tag: "SqlError" }>, R> =>
      Effect.catch(effect, (error) =>
        (error as { readonly _tag?: string })._tag === "SqlError"
          ? Effect.die(error)
          : Effect.fail(error as never)) as Effect.Effect<A, Exclude<E, { readonly _tag: "SqlError" }>, R>

    const trackById = (id: string) =>
      Effect.flatMap(
        infra(sql`select t.id, t.title, t.path, t.codec, t.format, t.bitrate_kbps, t.size_bytes,
                       t.offset_ms, t.duration_seconds, t.is_virtual,
                       f.path as folder_path
                from tracks t join music_folders f on f.id = t.music_folder_id
                where t.id = ${id}::bigint`),
        (rows) => {
          const row = rows[0] as Record<string, unknown> | undefined
          if (row === undefined) return Effect.fail(notFound("track", id))
          return Effect.succeed({
            id: Number(row.id),
            title: String(row.title),
            // 虚拟行 path 带 "#NNN" 合成后缀：物理镜像是流/下载的真实载体
            absPath: `${String(row.folder_path)}/${String(row.path).replace(/#\d+$/, "")}`,
            codec: String(row.codec),
            mime: String(row.format),
            bitrateKbps: Number(row.bitrate_kbps ?? 0),
            sizeBytes: Number(row.size_bytes ?? 0),
            offsetMs: Number(row.offset_ms ?? 0),
            durationSec: Number(row.duration_seconds ?? 0),
            isVirtual: row.is_virtual === true,
          })
        },
      )

    // ---- 直传（含 Range） ----

    const serveFile = (absPath: string, mime: string, size: number, range: RangeHeader | null, extraHeaders?: Record<string, string>) =>
      Effect.promise(async (): Promise<Response> => {
        let file = Bun.file(absPath)
        // fromWeb forwards a ReadableStream, not the BunFile; Bun cannot infer its length at
        // the HTTP boundary. Unknown length makes Media3 treat a finite file as live/no-cache.
        const headers: Record<string, string> = { "content-type": mime, ...extraHeaders }
        if (range !== null) {
          file = file.slice(range.start, range.end + 1)
          headers["content-length"] = String(file.size)
          headers["content-range"] = `bytes ${range.start}-${range.end}/${size}`
          headers["accept-ranges"] = "bytes"
          return new Response(file, { status: 206, headers })
        }
        headers["accept-ranges"] = "bytes"
        headers["content-length"] = String(file.size)
        return new Response(file, { status: 200, headers })
      })

    /** ffmpeg 流式响应（转码或断点流拷贝）；offsetSec > 0 时不读不写缓存（断点流是瞬态的）。
     *  durationSec > 0 时加输出侧 `-t`（虚拟分段的边界：流在分段终点自然 EOF，
     *  客户端无需感知边界）；缓存条目估算体积超上限的纯透传不落盘 */
    const serveFFmpeg = (
      track: StreamTrack,
      opts: {
        container: string
        mime: string
        audioArgs: ReadonlyArray<string>
        cacheKey?: string | undefined
        offsetSec?: number | undefined
        /** 输出时长上限（秒）；虚拟分段 = 剩余段长 */
        durationSec?: number | undefined
        /** 估算缓存条目体积用的码率（copy = 源码率，转码 = 目标码率） */
        estKbps?: number | undefined
      },
    ): Effect.Effect<Response> =>
      Effect.gen(function* () {
        const offset = Math.max(0, opts.offsetSec ?? 0)
        const estKbps = opts.estKbps ?? (track.bitrateKbps > 0 ? track.bitrateKbps : EST_UNSET_KBPS)
        const estBytes = track.durationSec > 0 ? (track.durationSec * estKbps * 1000) / 8 : 0
        const cacheFile =
          opts.cacheKey !== undefined && offset <= 0 && estBytes <= CACHE_ENTRY_MAX_BYTES
            ? `${config.transcodeCacheDir}/${opts.cacheKey}.${opts.container}`
            : null

        // 缓存命中：直接回发（支持 Range 由上层处理——转码产物大小已知后再支持）。
        // 0 字节条目是 ffmpeg 失败留下的坏缓存（历史残留也会命中），清掉重生成，
        // 否则该曲永远回 200 空响应
        if (cacheFile !== null) {
          const cached = yield* Effect.promise(async () => {
            try {
              const stat = await fs.stat(cacheFile)
              if (stat.isFile() && stat.size > 0) return stat
              if (stat.isFile()) await fs.unlink(cacheFile).catch(() => {})
              return null
            } catch {
              return null
            }
          })
          if (cached !== null) {
            return yield* serveFile(cacheFile, opts.mime, cached.size, null)
          }
        }

        // 未命中：ffmpeg 实时流（-ss 放 -i 前 = 输入端 seek，O(1)）+ tee 到缓存文件。
        // 并发上限对所有 ffmpeg 进程生效（含不缓存的断点流）
        yield* semaphore.take(1)
        const proc = Bun.spawn(
          [
            "ffmpeg", "-hide_banner", "-loglevel", "error",
            ...(offset > 0 ? ["-ss", String(offset)] : []),
            "-i", track.absPath,
            ...(opts.durationSec !== undefined && opts.durationSec > 0
              ? ["-t", String(Math.ceil(opts.durationSec))]
              : []),
            "-map", "0:a:0", "-vn",
            ...opts.audioArgs,
            "-f", opts.container,
            "pipe:1",
          ],
          { stdout: "pipe", stderr: "ignore" },
        )
        const tmpFile = cacheFile !== null ? `${cacheFile}.${randomToken(8)}.part` : null
        const writer = tmpFile !== null ? Bun.file(tmpFile).writer() : null
        let released = false
        const release = () => {
          if (!released) {
            released = true
            Effect.runSync(semaphore.release(1))
          }
        }

        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            try {
              for await (const chunk of proc.stdout) {
                controller.enqueue(chunk as Uint8Array)
                writer?.write(chunk)
              }
              if (writer !== null) {
                await writer.end()
                // ffmpeg 失败/空输出不落缓存：否则 0 字节条目会被当成命中永久回发
                const exitCode = await proc.exited
                const written = exitCode === 0 ? await fs.stat(tmpFile!).catch(() => null) : null
                if (written !== null && written.size > 0) {
                  await fs.rename(tmpFile!, cacheFile!)
                } else {
                  await fs.unlink(tmpFile!).catch(() => {})
                }
              }
              controller.close()
            } catch (error) {
              if (writer !== null) {
                await Promise.resolve(writer.end()).catch(() => {})
                await fs.unlink(tmpFile!).catch(() => {})
              }
              controller.error(error)
            } finally {
              release()
            }
          },
          cancel() {
            proc.kill()
            if (writer !== null) {
              Promise.resolve(writer.end()).catch(() => {})
              fs.unlink(tmpFile!).catch(() => {})
            }
            release()
          },
        })
        return new Response(stream, {
          status: 200,
          headers: { "content-type": opts.mime, "cache-control": "no-store" },
        })
      })

    const serveTranscoded = (track: StreamTrack, format: string, maxBitRate: number, offsetSec = 0, durationSec?: number) => {
      const target = TRANSCODE_TARGETS[format]
      if (target === undefined) {
        return Effect.succeed(new Response(`unsupported format: ${format}`, { status: 400 }))
      }
      const bitRateArgs = maxBitRate > 0 ? ["-b:a", `${maxBitRate}k`] : []
      return serveFFmpeg(track, {
        container: target.container,
        mime: target.mime,
        audioArgs: [...target.args, ...bitRateArgs],
        cacheKey: `${track.id}-${format}-${maxBitRate}`,
        offsetSec,
        durationSec,
        estKbps: maxBitRate > 0 ? maxBitRate : EST_UNSET_KBPS,
      })
    }

    /** raw + timeOffset：流拷贝（容器匹配源编码时无损零转码；不匹配 → 转码 mp3 兜底） */
    const serveCopyOffset = (track: StreamTrack, offsetSec: number, maxBitRate: number, durationSec?: number) => {
      const copy = COPY_TARGETS[track.codec]
      if (copy === undefined) {
        return serveTranscoded(track, "mp3", maxBitRate, offsetSec, durationSec)
      }
      return serveFFmpeg(track, {
        container: copy.container,
        mime: copy.mime,
        audioArgs: ["-codec:a", "copy"],
        offsetSec,
        durationSec,
        estKbps: track.bitrateKbps > 0 ? track.bitrateKbps : EST_UNSET_KBPS,
      })
    }

    // ---- 决策与入口 ----

    const stream = (trackId: string, params: StreamParams, rangeHeader?: string | undefined) =>
      Effect.flatMap(trackById(trackId), (track) => {
        const offset = Math.max(0, params.timeOffset ?? 0)
        const format = params.format ?? (BROWSER_PLAYABLE.has(track.codec) ? "raw" : "opus")

        // CUE 虚拟分段（docs/03 §2.9）：永远经 ffmpeg——起点 = 分段偏移 + 客户端
        // seek，输出侧 -t 卡在分段终点（客户端 audio 元素自然 ended）。分段内
        // seek 换算对客户端完全透明
        if (track.isVirtual) {
          if (offset >= track.durationSec) {
            return Effect.succeed(
              new Response(null, { status: 200, headers: { "content-type": track.mime, "cache-control": "no-store" } }),
            )
          }
          const start = track.offsetMs / 1000 + offset
          const remaining = track.durationSec - offset
          if (format === "raw" || format === track.codec) {
            return serveCopyOffset(track, start, params.maxBitRate ?? 0, remaining)
          }
          return serveTranscoded(track, format, params.maxBitRate ?? 0, start, remaining)
        }

        // 断点续播（timeOffset>0）：不读不写缓存、忽略 Range（ffmpeg 输出长度未知）
        if (offset > 0) {
          if (format === "raw" || format === track.codec) {
            return serveCopyOffset(track, offset, params.maxBitRate ?? 0)
          }
          return serveTranscoded(track, format, params.maxBitRate ?? 0, offset)
        }
        if (format === "raw" || format === track.codec) {
          return serveFile(
            track.absPath,
            track.mime,
            track.sizeBytes,
            parseRange(rangeHeader, track.sizeBytes),
            { "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(track.title)}` },
          )
        }
        return serveTranscoded(track, format, params.maxBitRate ?? 0)
      })

    const download = (trackId: string) =>
      Effect.flatMap(trackById(trackId), (track) =>
        serveFile(track.absPath, track.mime, track.sizeBytes, null, {
          "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(track.title)}`,
        }))

    // ---- 封面（coverArt ID: al-<albumId> / tr-<trackId>，见 docs/03 §2.4） ----

    /** 封面提取并发上限 + 同目标 single-flight：随机页一屏冷缓存全 miss 时，
     *  不至于几十个 ffmpeg 同时抢远程盘 IO（同目标并发请求共享同一次提取） */
    const coverSemaphore = yield* Semaphore.make(2)
    const inflightExtractions = new Map<string, Promise<boolean>>()
    const singleFlight = (key: string, task: () => Promise<boolean>): Promise<boolean> => {
      const existing = inflightExtractions.get(key)
      if (existing !== undefined) return existing
      const created = task().finally(() => inflightExtractions.delete(key))
      inflightExtractions.set(key, created)
      return created
    }
    const withCoverPermit = <A, E, R>(eff: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      Effect.flatMap(
        coverSemaphore.take(1),
        () => Effect.ensuring(eff, coverSemaphore.release(1)),
      )

    /** 音频内嵌封面 → JPEG（≤1000px）落盘缓存。产物存在性为准——
     *  样本其实无图时 ffmpeg 静默成功退出，不能信 exit code */
    const extractEmbedded = (absTrackPath: string, cachedCover: string): Effect.Effect<boolean> =>
      withCoverPermit(Effect.promise(() =>
         singleFlight(cachedCover, async () => {
          const cover = (await ffprobeMeta(absTrackPath))?.coverStream
          if (cover == null) return false
          const proc = Bun.spawn(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", absTrackPath,
               "-map", `0:${cover}`, "-frames:v", "1", "-vf", "scale='min(1000,iw)':-2", "-q:v", "4",
              "-f", "image2", "-y", cachedCover],
            { stdout: "ignore", stderr: "pipe" },
          )
          await proc.exited
          return await fs.stat(cachedCover).then(() => true).catch(() => false)
        })))

    const COVER_CACHE_HEADERS = { "cache-control": "public, max-age=86400" } as const
    const statOf = (abs: string) =>
      Effect.exit(Effect.promise(() => fs.stat(abs)))
    const serveCachedCover = (path: string, size: number, editable: boolean) =>
      serveFile(path, "image/jpeg", size, null, editable ? { "cache-control":"private, no-cache" } : { ...COVER_CACHE_HEADERS })

    /** 专辑封面链：文件夹封面（cover_file，流式回发源文件）→ 内嵌样本（惰性提取）→ 404。
     *  cover_file 是 folder 根的相对路径，多目录/多 folder 时只有文件真实存在的那行才算数；
     *  失配/被删 → 降级到内嵌，而不是 500 */
    const albumCoverResponse = (albumId: string): Effect.Effect<Response, NotFound> =>
      Effect.gen(function* () {
        // sample_embedded = 真正带内嵌图的样本（min(path) 可能恰好是无图文件，
        // 对它跑 ffmpeg 提不出帧，stat 缓存文件会直接 defect 500）；
        // 虚拟行 path 带 "#NNN" 合成后缀，提取前剥掉（物理镜像是真正的载体）
        const rows = (yield* infra(sql`select al.cover_file, f.path as folder_path,
                       max(extract(epoch from t.updated_at)) filter(where y.track_id is not null)::text as revision,
                       min(regexp_replace(t.path, '#[0-9]+$', '')) filter (where t.has_embedded_cover) as sample_embedded
                from albums al
                join tracks t on t.album_id = al.id
                left join youtube_imports y on y.track_id=t.id
                join music_folders f on f.id = t.music_folder_id
                where al.id = ${albumId}::bigint
                group by al.cover_file, f.path`)) as ReadonlyArray<{
          cover_file: string | null
          folder_path: string
           sample_embedded: string | null
           revision: string | null
        }>

        // 1) 专辑文件夹封面（按扩展名给 mime——写死 jpeg 会把 PNG 谎报成 JPEG）
        for (const row of rows) {
          if (row.cover_file === null) continue
          const stat = yield* statOf(`${row.folder_path}/${row.cover_file}`)
          if (Exit.isSuccess(stat)) {
            const ext = row.cover_file.split(".").pop()?.toLowerCase()
            const mime = ext === "png" ? "image/png" : "image/jpeg"
            return yield* serveFile(
              `${row.folder_path}/${row.cover_file}`,
              mime,
              stat.value.size,
              null,
              { ...COVER_CACHE_HEADERS },
            )
          }
        }
        // 2) 内嵌封面（惰性提取到 DATA_DIR/covers）：提取失败（样本无图/ffmpeg 出错）
        //    换下一行试，全失败 → 404（前端落程序化封面）
        for (const row of rows) {
          if (row.sample_embedded === null) continue
          const cachedCover = `${coversDir}/al-${albumId}${row.revision ? `-${row.revision}` : ""}.jpg`
          let have = Exit.isSuccess(yield* statOf(cachedCover))
          if (!have) {
            have = yield* extractEmbedded(`${row.folder_path}/${row.sample_embedded}`, cachedCover)
          }
          if (!have) continue
          const stat = yield* statOf(cachedCover)
          if (Exit.isSuccess(stat)) {
            return yield* serveCachedCover(cachedCover, stat.value.size, row.revision !== null)
          }
        }
        return yield* Effect.fail(notFound("cover", `al-${albumId}`))
      })

    /** 曲目封面链（tr-）：自身内嵌图（惰性提取，虚拟行剥 #NNN）→ 专辑封面链兜底
     *  （歌曲没图但专辑有图 → 用专辑的）→ 404。合辑里单曲各自内嵌不同封面时，
     *  tr- 给出这首自己的图（al- 只会给 min(path) 样本那张） */
    const trackCoverResponse = (trackId: string): Effect.Effect<Response, NotFound> =>
      Effect.gen(function* () {
        const rows = (yield* infra(sql`select t.has_embedded_cover, t.album_id,
                       case when y.track_id is not null then extract(epoch from t.updated_at)::text end as revision,
                       regexp_replace(t.path, '#[0-9]+$', '') as phys_path,
                       f.path as folder_path
                from tracks t join music_folders f on f.id = t.music_folder_id left join youtube_imports y on y.track_id=t.id
                where t.id = ${trackId}::bigint`)) as ReadonlyArray<{
           has_embedded_cover: boolean
           revision: string | null
          album_id: string | number
          phys_path: string
          folder_path: string
        }>
        const row = rows[0]
        if (row === undefined) {
          return yield* Effect.fail(notFound("cover", `tr-${trackId}`))
        }
        if (row.has_embedded_cover) {
          const cachedCover = `${coversDir}/tr-${trackId}${row.revision ? `-${row.revision}` : ""}.jpg`
          let have = Exit.isSuccess(yield* statOf(cachedCover))
          if (!have) {
            have = yield* extractEmbedded(`${row.folder_path}/${row.phys_path}`, cachedCover)
          }
          if (have) {
            const stat = yield* statOf(cachedCover)
            if (Exit.isSuccess(stat)) {
            return yield* serveCachedCover(cachedCover, stat.value.size, row.revision !== null)
            }
          }
        }
        return yield* albumCoverResponse(String(row.album_id))
      })

    const cover = (coverId: string): Effect.Effect<Response, NotFound> => {
      const dash = coverId.indexOf("-")
      const kind = dash === -1 ? "" : coverId.slice(0, dash)
      const id = dash === -1 ? "" : coverId.slice(dash + 1)
      if (kind === "al" && id !== "") return albumCoverResponse(id)
      if (kind === "tr" && id !== "") return trackCoverResponse(id)
      // ar-（艺人）/ pl-（播放列表）暂无独立封面源：通告与实现的差距见 docs/05 §2
      return Effect.fail(notFound("cover", coverId))
    }

    // ---- LRU 淘汰守护（docs/02 §6.2；转码与封面缓存共用 planEviction） ----

    const evictDir = (dir: string, maxBytes: number) =>
      Effect.promise(async () => {
        const entries = await fs.readdir(dir)
        const stats = await Promise.all(
          entries
            .filter((name) => !name.endsWith(".part"))
            .map(async (name) => {
              const path = `${dir}/${name}`
              const stat = await fs.stat(path)
              return { path, size: stat.size, atimeMs: stat.atimeMs, mtimeMs: stat.mtimeMs }
            }),
        )
        for (const victim of planEviction(stats, maxBytes)) {
          await fs.unlink(victim).catch(() => {})
        }
      })

    const evictOnce = Effect.andThen(
      Effect.catchCause(evictDir(config.transcodeCacheDir, config.transcodeCacheMaxBytes), (cause) =>
        Effect.logWarning("transcode cache eviction failed", cause)),
      Effect.catchCause(evictDir(coversDir, config.coversCacheMaxBytes), (cause) =>
        Effect.logWarning("covers cache eviction failed", cause)),
    )

    yield* Effect.forkDetach(
      Effect.repeat(
        Effect.flatMap(
          Effect.catchCause(evictOnce, (cause) =>
            Effect.logWarning("transcode cache eviction failed", cause)),
          () => Effect.void,
        ),
        Schedule.spaced("5 minutes"),
      ),
    )

    return {
      stream,
      download,
      cover,
      trackById,
    } as const
    }),
  )
}

/** 解析 Range 请求头（仅支持单区间 bytes=start-end；后缀形式 bytes=-N 取最后 N 字节） */
export const parseRange = (header: string | undefined, size: number): RangeHeader | null => {
  if (header === undefined) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (match === null) return null
  const [, startStr, endStr] = match
  if (size <= 0) return null
  // 后缀形式 bytes=-N：最后 N 字节
  if (startStr === "") {
    if (endStr === "") return null
    const length = Number(endStr)
    if (Number.isNaN(length) || length <= 0) return null
    return { start: Math.max(0, size - length), end: size - 1 }
  }
  const start = Number(startStr)
  if (Number.isNaN(start) || start < 0 || start >= size) return null
  const end = endStr === "" ? size - 1 : Math.min(Number(endStr), size - 1)
  if (Number.isNaN(end) || start > end) return null
  return { start, end }
}

export const transcodeMime = (format: string) => TRANSCODE_TARGETS[format]?.mime ?? "application/octet-stream"
