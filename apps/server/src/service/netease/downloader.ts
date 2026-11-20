import { constants } from "node:fs"
import * as fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { runDlp } from "../youtube/downloader"
import { ffprobeMeta } from "../../util/media-probe"
import { songID, type NeteaseSource } from "./source"
import { neteaseFormatArgs, neteaseName } from "./formats"
import { neteaseTags, applyNeteaseTags, type NeteaseDump } from "./metadata"
import type { NeteaseRuntime, SongBrief } from "./api"

export const SONG_LIMIT = 25

/** A per-song failure with a user-readable reason; anything else is treated as an unexpected error. */
export class NeteaseSongFailure extends Error {}
const fail = (reason: string) => new NeteaseSongFailure(reason)

const canonicalSong = (id: string) => `https://music.163.com/song?id=${id}`

/** Tolerance: max(2s, 1% of expected). VIP songs download as silent 30s trial segments with exit 0. */
export function durationToleranceMs(expectedMs: number): number {
  return Math.max(2000, Math.round(expectedMs * 0.01))
}
export function durationOk(expectedMs: number, actualSeconds: number): boolean {
  return Math.abs(actualSeconds * 1000 - expectedMs) <= durationToleranceMs(expectedMs)
}

/** Observed quality tier, derived from what actually landed on disk (flac=lossless, else MP3 bitrate). */
export function deliveredQuality(ext: "mp3" | "flac", bitrateKbps: number): string {
  if (ext === "flac") return "lossless"
  if (bitrateKbps >= 320) return "exhigh"
  if (bitrateKbps >= 192) return "higher"
  return "standard"
}

function entries(raw: string): string[] {
  return raw.trim().split("\n").filter(Boolean).map(line => {
    const value = JSON.parse(line) as { id?: string | number }
    const id = typeof value.id === "number" ? String(Math.trunc(value.id)) : typeof value.id === "string" ? value.id : null
    if (id === null || !songID.test(id)) throw Error("列表包含无效歌曲。")
    return id
  })
}

/** Flat enumeration via yt-dlp (song link = itself; playlist must be 1–25; singer hot list caps at 25). */
export async function neteaseSongList(source: NeteaseSource, signal: AbortSignal): Promise<{ ids: string[]; truncated: boolean }> {
  if (source.kind === "song") return { ids: [source.id], truncated: false }
  const ids = [...new Set(entries(await runDlp(["--flat-playlist", "--playlist-end", String(SONG_LIMIT + 1), "--dump-json", "--", source.url], signal)))]
  if (!ids.length) throw Error("empty")
  if (source.kind === "artist") return { ids: ids.slice(0, SONG_LIMIT), truncated: ids.length > SONG_LIMIT }
  if (ids.length > SONG_LIMIT) throw Error("too many")
  return { ids, truncated: false }
}

const MAX_MEDIA = 96 * 1024 * 1024

/** yt-dlp download. Only bestaudio/best — never YouTube's opus/aac format whitelist. */
async function download(songId: string, dir: string, rt: NeteaseRuntime, signal: AbortSignal): Promise<{ dump: NeteaseDump; ext: "mp3" | "flac" }> {
  const summary = await runDlp([
    "--no-playlist", "--no-overwrites", "--max-filesize", "96M", "--match-filters", "!is_live & duration <= 1800",
    ...(rt.realIp ? ["--xff", rt.realIp] : []),
    ...neteaseFormatArgs, "--embed-metadata", "--no-simulate",
    "--print", "after_move:%(.{id,title,creator,creators,album,album_artists,timestamp,thumbnail,duration})j",
    "-o", "audio.%(ext)s", "--", canonicalSong(songId),
  ], signal, dir)
  const outputs = await fs.readdir(dir)
  const found = (["mp3", "flac"] as const).filter(ext => outputs.includes(`audio.${ext}`))
  if (found.length !== 1) throw fail("来源不可用或仅 VIP 可用（未找到可下载的 MP3/FLAC）。")
  return { dump: summary.trim() ? JSON.parse(summary) as NeteaseDump : {}, ext: found[0]! }
}

export type ImportOutcome =
  | { status: "imported"; name: string; quality: string; warnings: string[] }
  | { status: "skipped"; name: string }

/** One song: precheck data → yt-dlp download → duration guard → netease tags → publish via
 *  callback. The trial guard does not depend on any precheck flag: even a fee-0 slip would
 *  be caught here. Existing files are never overwritten. */
export async function importSong(songId: string, destination: fs.FileHandle, signal: AbortSignal, runtime: NeteaseRuntime,
  detail: SongBrief, albumDate: string | null, publish: (file: string, name: string, quality: string) => Promise<void>): Promise<ImportOutcome> {
  if (!songID.test(songId)) throw fail("无效歌曲 ID。")
  const base = `/proc/self/fd/${destination.fd}`
  for (const ext of ["mp3", "flac"] as const) {
    const name = neteaseName(songId, ext)
    const prior = await fs.lstat(`${base}/${name}`).catch((e: NodeJS.ErrnoException) => { if (e.code !== "ENOENT") throw e; return null })
    if (!prior) continue
    if (!prior.isFile() || !prior.size) throw fail("目标名称被其他文件占用。")
    return { status: "skipped", name }
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openmusic-netease-"))
  try {
    let dump: NeteaseDump, ext: "mp3" | "flac"
    try { ({ dump, ext } = await download(songId, dir, runtime, signal)) }
    catch (e) { signal.throwIfAborted(); throw e instanceof NeteaseSongFailure ? e : fail("下载失败：来源不可用、超时或超过时长/大小限制。") }
    const file = path.join(dir, `audio.${ext}`), stat = await fs.lstat(file).catch(() => null)
    if (!stat?.isFile() || !stat.size || stat.size > MAX_MEDIA) throw fail("下载的文件无效或超过 96 MiB 限制。")
    // The silent-trial guard: a VIP song downloads fine (exit 0, no warning) as a ~30s 128k segment.
    const probe = await ffprobeMeta(file)
    if (!probe || !probe.durationSeconds) throw fail("无法解析下载的音频（时长未知），未入库。")
    if (!durationOk(detail.durationMs, probe.durationSeconds)) {
      throw fail(`疑似试听片段：实际 ${probe.durationSeconds.toFixed(1)} 秒 / 预期 ${(detail.durationMs / 1000).toFixed(1)} 秒，已丢弃未入库。`)
    }
    signal.throwIfAborted()
    const built = neteaseTags(detail, dump, albumDate)
    const meta = await applyNeteaseTags(dir, songId, built.tags, built.date, signal, { ext })
      .catch(e => { signal.throwIfAborted(); throw e instanceof NeteaseSongFailure ? e : fail("媒体标签写入失败，未入库。") })
    const quality = deliveredQuality(ext, probe.bitrateKbps), name = neteaseName(songId, ext), target = `${base}/${name}`
    signal.throwIfAborted()
    try { await fs.copyFile(file, target, constants.COPYFILE_EXCL) }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") return { status: "skipped", name }; throw e }
    try { await publish(target, name, quality) } catch (e) { await fs.unlink(target); throw e }
    return { status: "imported", name, quality, warnings: meta.warnings }
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
}
