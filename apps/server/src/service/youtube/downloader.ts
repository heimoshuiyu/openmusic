import { spawn } from "node:child_process"
import { constants } from "node:fs"
import * as fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { checkSubdirectory, videoID, type youtubeSource } from "./source"
import { applyTags, type TagResult } from "./metadata"
import type { YoutubeTags, YoutubeFormat } from "../../domain/youtube"
import { outputSpec } from "./formats"

type Source = NonNullable<ReturnType<typeof youtubeSource>>
export interface Candidate { title: string; url: string; channel: string }
const LIMIT = 25
const watch = (id: string) => `https://www.youtube.com/watch?v=${id}`

/** Direct argv, bounded output/deadline, no stdin or user config. Kill ffmpeg descendants too. */
export function runDlp(args: string[], signal: AbortSignal, cwd?: string): Promise<string> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn("yt-dlp", ["--ignore-config", "--no-plugin-dirs", "--no-cache-dir", "--no-progress", "--js-runtimes", "bun", "--socket-timeout", "15", "--retries", "2", ...args], {
      cwd: cwd ?? os.tmpdir(), detached: true, stdio: ["ignore", "pipe", "ignore"],
      env: Object.fromEntries(["PATH", "LANG", "LC_ALL", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy"].flatMap(k => process.env[k] ? [[k, process.env[k]]] : [])),
    })
    const chunks: Buffer[] = []; let bytes = 0; let stopped = false
    const stop = () => { stopped = true; if (child.pid) { try { process.kill(-child.pid, "SIGKILL") } catch { /* exited */ } } }
    signal.addEventListener("abort", stop, { once: true }); if (signal.aborted) stop()
    const timer = setTimeout(stop, cwd ? 8*60_000 : 45_000)
    child.stdout!.on("data", (b: Buffer) => { bytes += b.length; if (bytes > 2*1024*1024) stop(); else chunks.push(b) })
    const clean = () => { clearTimeout(timer); signal.removeEventListener("abort", stop) }
    child.on("error", () => { clean(); reject(new Error("无法启动 yt-dlp，请检查服务器安装。")) })
    child.on("close", code => { clean(); if (stopped || code !== 0) reject(new Error("YouTube 请求失败、受限或超时。")); else resolve(Buffer.concat(chunks).toString("utf8")) })
  })
}

function entries(raw: string) {
  return raw.trim().split("\n").filter(Boolean).map(line => {
    const value = JSON.parse(line) as { id?: string; title?: string; uploader?: string; channel?: string }
    if (typeof value.id !== "string" || !videoID.test(value.id)) throw Error("列表包含无效视频。")
    return { id: value.id, title: String(value.title ?? value.id).slice(0,200), channel: String(value.channel ?? value.uploader ?? "").slice(0,150) }
  })
}
export async function searchYoutube(q: string, signal: AbortSignal): Promise<Candidate[]> {
  return entries(await runDlp(["--flat-playlist", "--dump-json", "--", `ytsearch5:${q}`], signal)).slice(0,5)
    .map(({id,title,channel}) => ({ title, channel, url:watch(id) }))
}
export async function videoList(source: Source, signal: AbortSignal) {
  if (source.kind === "video") return [new URL(source.url).searchParams.get("v")!]
  const ids = entries(await runDlp(["--flat-playlist", "--playlist-end", String(LIMIT+1), "--dump-json", "--", source.url], signal)).map(e=>e.id)
  if (ids.length > LIMIT || !ids.length) throw Error(`播放列表必须包含 1–${LIMIT} 首，请拆分后重试。`)
  return [...new Set(ids)]
}

/** Pin each existing directory (Linux deployment). No traversal via a symlink below the registered root. */
export async function openDestination(root: string, parts: string[], writable = true) {
  if (!path.isAbsolute(root)) throw Error("曲库目录无效。")
  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  let handle = await fs.open(await fs.realpath(root), flags)
  try {
    for (const part of parts) {
      const next = await fs.open(`/proc/self/fd/${handle.fd}/${part}`, flags)
      await handle.close(); handle = next
    }
    if (writable) await fs.access(`/proc/self/fd/${handle.fd}`, constants.W_OK | constants.X_OK)
    return handle
  } catch (e) { await handle.close(); throw e }
}

/** One level only; don't walk a remote music library or return file names. */
export async function childDirectories(root: string, parts: string[]) {
  const parent = await openDestination(root, parts, false)
  const directories: string[] = []
  try {
    const dir = await fs.opendir(`/proc/self/fd/${parent.fd}`)
    let seen = 0
    for await (const entry of dir) {
      if (++seen > 512 || directories.length >= 80) return { directories, truncated: true }
      const relative = [...parts, entry.name].join("/")
      if (entry.isDirectory() && checkSubdirectory(relative)) directories.push(relative)
    }
    return { directories, truncated: false }
  } finally { await parent.close() }
}

/** Publish only a completed, validated file. Requests for different formats never overwrite each other. */
export async function downloadOne(id: string, destination: fs.FileHandle, signal: AbortSignal, index: (file: string, name: string, meta:TagResult) => Promise<void>, tags:YoutubeTags={}, format:YoutubeFormat="original") {
  if (!videoID.test(id)) throw Error("无效视频 ID。")
  const spec = outputSpec(format), base = `/proc/self/fd/${destination.fd}`
  // Avoid another outbound download for an existing item, without following the target.
  for (const ext of spec.extensions) {
    const name = `YouTube-${id}.${ext}`
    const prior = await fs.lstat(`${base}/${name}`).catch((e:NodeJS.ErrnoException) => { if(e.code!=="ENOENT") throw e; return null })
    if (!prior) continue
    if (!prior.isFile() || !prior.size) throw Error("目标名称被其他文件占用。")
    return {status:"skipped",name} as const
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openmusic-youtube-"))
  try {
    const summary=await runDlp(["--no-playlist", "--no-overwrites", "--max-filesize", "96M", "--match-filters", "!is_live & duration <= 1800", ...spec.args, "--embed-metadata", "--no-simulate", "--print", "after_move:%(.{id,title,description,channel,upload_date,track,artist,album,genre,duration})j", "-o", "audio.%(ext)s", "--", watch(id)], signal, dir)
    const outputs = await fs.readdir(dir)
    const matches = spec.extensions.filter(ext=>outputs.includes(`audio.${ext}`))
    if (matches.length!==1) throw Error("未找到匹配格式的媒体。")
    const ext = matches[0]!, name = `YouTube-${id}.${ext}`, target=`${base}/${name}`
    const file = path.join(dir,`audio.${ext}`), stat = await fs.lstat(file).catch(()=>null)
    if (!stat?.isFile() || !stat.size || stat.size > 96*1024*1024) throw Error("视频不可用或超过 30 分钟 / 96 MiB 限制。")
    const meta=await applyTags(dir,id,tags,summary.trim()?JSON.parse(summary):{},signal,{ext})
    signal.throwIfAborted()
    try { await fs.copyFile(file, target, constants.COPYFILE_EXCL) }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") return {status:"skipped",name} as const; throw e }
    try { await index(target,name,meta) } catch (e) { await fs.unlink(target); throw e }
    return {status:"imported",name,warnings:meta.warnings} as const
  } finally { await fs.rm(dir,{recursive:true,force:true}) }
}
