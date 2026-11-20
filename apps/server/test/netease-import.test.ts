import { expect, test } from "bun:test"
import * as fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { parseFile } from "music-metadata"
import type { NeteaseCandidate, NeteaseImportResult } from "../src/domain/netease"
import { migrateTestDb, startServer, TestServer, TEST_DB_URL, truncateDomainTables } from "./helpers"
import { Pool } from "pg"

/** 网易云管理面黑盒：REST 搜索/目录/导入 → info/edit（覆盖值重扫存活、发行年）→ 移出库
 *  （不删文件、排除防复活）→ 物理删除票据全流程（属主/token/文件名/inode/过期/FK 双侧完好）
 *  → legacy 文件核验。全程零外网：yt-dlp 换 PATH 注入的本地 fixture，music.163.com 与
 *  *.music.126.net 由 globalThis.fetch mock。物理删除只作用于指定 trackId 且必须由票据
 *  属主本人逐字文件名确认——所有 fail-closed 分支都在这里断言。 */

const rewriteProvenance = (file: string, id: string) =>
  Bun.spawnSync(["python3", "-I", "-c", `import sys
from mutagen.id3 import ID3
tags = ID3(sys.argv[1])
for frame in tags.getall('TXXX'):
    if frame.desc == 'OPENMUSIC_NETEASE_ID':
        frame.text = [sys.argv[2]]
tags.save(sys.argv[1], v1=0, v2_version=4)`, file, id]).exitCode

test("Netease import: search → start → metadata/edit → unindex → deletion tickets → legacy", async () => {
  await migrateTestDb(); await truncateDomainTables(true)
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "om-netease-test-")), previous = process.env.PATH
  const app = await startServer(), a = new TestServer(app.handler), b = new TestServer(app.handler)
  const base = "/api/v1/imports/netease", library = path.join(tmp, "Library"), dest = path.join(library, "Singles")
  const originalFetch = globalThis.fetch
  try {
    const image = (color: string) => Bun.spawnSync(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", `color=c=${color}:s=40x40`, "-frames:v", "1", "-c:v", "mjpeg", "-f", "image2pipe", "pipe:1"]).stdout
    const red = image("red"), blue = image("blue")
    // 曲目详情 fixture：5264842/186016/999000 可导入；2606227455 是 VIP（预检即跳过）
    const detail = (id: string) => id === "5264842"
      ? { id: 5264842, name: "晴天", artists: [{ name: "周杰伦" }], album: { name: "叶惠美", picUrl: "http://p1.music.126.net/6TqR_U__xy.jpg" }, fee: 8, duration: 2000 }
      : id === "2606227455"
        ? { id: 2606227455, name: "VIP 歌曲", artists: [{ name: "某人" }], album: { name: "专辑" }, fee: 1, duration: 281000 }
        : { id: Number(id), name: `网易歌曲 ${id}`, artists: [{ name: "歌手甲" }], album: { name: "网易专辑", picUrl: "http://p1.music.126.net/6TqR_U__xy.jpg" }, fee: 8, duration: 2000 }
    globalThis.fetch = Object.assign((arg: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const u = new URL(arg instanceof Request ? arg.url : arg.toString())
      if (u.hostname === "music.163.com") {
        if (u.pathname === "/api/search/get") return Promise.resolve(Response.json({ code: 200, result: { songs: [detail("5264842"), detail("2606227455")] } }))
        if (u.pathname === "/api/song/detail") {
          const ids = (u.searchParams.get("ids") ?? "").replace(/^\[|\]$/g, "").split(",").filter(Boolean)
          return Promise.resolve(Response.json({ code: 200, songs: ids.map(detail) }))
        }
        if (u.pathname === "/api/song/lyric") return Promise.resolve(Response.json({ code: 200, lrc: { lyric: "[00:01.00]原文" }, tlyric: { lyric: "[00:01.00]译文" } }))
      }
      if (u.hostname === "p1.music.126.net") return Promise.resolve(new Response(new Uint8Array(red)))
      return originalFetch(arg, init)
    }, { preconnect: originalFetch.preconnect })
    // 本地确定性 yt-dlp：单曲下载 = 真 ffmpeg 产物 + after_move 摘要；其他形态一律失败
    await fs.mkdir(dest, { recursive: true }); await fs.symlink(tmp, path.join(library, "escape")); await fs.mkdir(path.join(library, "Other"))
    await fs.writeFile(path.join(tmp, "yt-dlp"), `#!/bin/sh
for arg do last="$arg"; done
id=\${last##*id=}
case "$id" in ''|*[!0-9]*) exit 3;; esac
ffmpeg -v error -f lavfi -i sine=frequency=440:duration=2 -c:a libmp3lame -b:a 128k audio.mp3 || exit 1
printf '{"id":"%s","title":"网易云歌曲 %s","creators":[{"name":"歌手甲"}],"album":"网易专辑","album_artists":[{"name":"专辑艺人"}],"timestamp":1060646400,"thumbnail":"http://p1.music.126.net/6TqR_U__xy.jpg"}\\n' "$id" "$id"`, { mode: 0o700 })
    process.env.PATH = `${tmp}:${previous}`
    expect((await a.get(`${base}/search?q=x`)).status).toBe(401); await a.login()
    expect((await a.post("/api/v1/users", { username: "importer", password: "user123456", isAdmin: false })).status).toBe(200); await b.login("importer", "user123456")
    expect((await b.post("/api/v1/music-folders", { name: "bad", path: tmp })).status).toBe(403)
    const f = await a.post("/api/v1/music-folders", { name: "Test music", path: library }); const folderId = (f.body as { id: string }).id
    // 目录端点（UI/助手选择目标用）
    const folders = await b.get(`${base}/folders`)
    expect(folders.status).toBe(200)
    expect(folders.body).toEqual([{ id: folderId, name: "Test music", path: library, writable: true }])
    const subs = await b.get(`${base}/subdirectories?folderId=${folderId}`)
    expect(subs.status).toBe(200)
    expect((subs.body as { directories: string[] }).directories.slice().sort()).toEqual(["Other", "Singles"])
    expect((subs.body as { truncated: boolean }).truncated).toBe(false)
    expect((await b.get(`${base}/subdirectories?folderId=missing`)).status).toBe(422)
    expect((await b.get(`${base}/subdirectories?folderId=${folderId}&subdirectory=escape`)).status).toBe(422)
    // 搜索：GET /search，候选带 vip 标记
    const found = await b.get(`${base}/search?q=${encodeURIComponent("晴天")}`)
    expect(found.status).toBe(200)
    const candidates = found.body as NeteaseCandidate[]
    expect(candidates).toHaveLength(2)
    expect(candidates[0]).toMatchObject({ songId: "5264842", title: "晴天", artist: "周杰伦", url: "https://music.163.com/song?id=5264842", vip: false })
    expect(candidates[1]).toMatchObject({ songId: "2606227455", vip: true })
    // 导入：非法目标 422；他人 session 404；同 key 并发共享终态
    const single = (subdirectory: string) => b.post(base + "/requests", { url: "https://music.163.com/song?id=5264842", folderId, subdirectory })
    for (const invalid of ["../", "/tmp", "escape", "missing"]) expect((await single(invalid)).status).toBe(422)
    expect((await b.post(base + "/requests", { url: "https://music.163.com/song?id=5264842", folderId, sessionID: "someone-elses-session" })).status).toBe(404)
    expect(await fs.readdir(dest)).toEqual([])
    const replies = await Promise.all([1, 2].map(() => single("Singles")))
    expect(replies.map(r => r.status)).toEqual([200, 200])
    const j = replies[0]!.body as NeteaseImportResult
    expect(replies[1]!.body).toEqual(j)
    expect(j).toMatchObject({ url: "https://music.163.com/song?id=5264842", kind: "song", state: "done", total: 1, imported: 1, skipped: 0, failed: 0, destination: dest })
    expect(j.trackIds).toHaveLength(1)
    const id = j.trackIds[0]!
    expect(j.files).toEqual([{ trackId: id, name: "Netease-5264842.mp3" }])
    expect(j.failures).toEqual([]); expect(j.warnings).toEqual([])
    expect(await fs.readdir(dest)).toEqual(["Netease-5264842.mp3"])
    // VIP/付费在预检即被明确跳过，不下载
    const vip = await b.post(base + "/requests", { url: "https://music.163.com/song?id=2606227455", folderId, subdirectory: "Singles" })
    expect(vip.body).toMatchObject({ state: "failed", trackIds: [], failures: [{ songId: "2606227455", reason: "VIP/付费歌曲需要会员账号，未导入。" }] })
    // 歌词自动入共享歌词体系（原文+译文等时间戳合并）
    const lyric = await b.get(`/api/v1/tracks/${j.trackIds[0]}/lyrics`)
    expect(lyric.body).toMatchObject({ mode: "saved", source: "saved", synced: true })
    expect((lyric.body as { lines: unknown[] }).lines[0]).toEqual({ startMs: 1000, text: "原文\n译文" })
    // N1：任意登录用户可读；quality 是交付档位快照（128k → standard）
    const endpoint = `${base}/tracks/${id}/metadata`
    expect((await new TestServer(app.handler).get(endpoint)).status).toBe(401)
    expect((await b.get(`${base}/tracks/0/metadata`)).status).toBe(404)
    const info = await b.get(endpoint)
    expect(info.status).toBe(200)
    expect(info.body).toMatchObject({ trackId: String(id), songId: "5264842", quality: "standard", format: "mp3", filename: "Netease-5264842.mp3", title: "网易云歌曲 5264842", artist: "歌手甲", album: "网易专辑", albumArtist: "专辑艺人", hasCover: true })
    expect((await a.post("/api/v1/users", { username: "another", password: "user123456", isAdmin: false })).status).toBe(200)
    const other = new TestServer(app.handler); await other.login("another", "user123456")
    expect((await other.get(endpoint)).status).toBe(200)
    // N2：非属主 404（不泄露存在性）；空 payload/非法封面 422
    expect((await other.patch(endpoint, { title: "denied" })).status).toBe(404)
    expect((await b.patch(endpoint, {})).status).toBe(422)
    expect((await b.patch(endpoint, { cover: "http://127.0.0.1/private" })).status).toBe(422)
    const disk = path.join(dest, "Netease-5264842.mp3")
    const art = "data:image/jpeg;base64," + blue.toString("base64")
    const edited = await b.patch(endpoint, { title: "编辑后的标题", genre: "J-Pop", cover: art })
    expect(edited.status).toBe(200)
    expect(edited.body).toMatchObject({ trackId: String(id), title: "编辑后的标题", genre: "J-Pop", hasCover: true, songId: "5264842" })
    const onDisk = await parseFile(disk)
    expect(onDisk.common.title).toBe("编辑后的标题"); expect(onDisk.common.picture?.length).toBe(1); expect(onDisk.common.date).toBe("2003-08-12")
    expect(Object.values(onDisk.native).flat().some(t => /^(?:TXXX:)?OPENMUSIC_NETEASE_ID$/i.test(String(t.id)) && t.value === "5264842")).toBe(true)
    expect((await b.get(`/api/v1/covers/tr-${id}`)).status).toBe(200)
    // cover:"netease" 回源恢复（仍仅 *.music.126.net）
    expect((await b.patch(endpoint, { cover: "netease" })).status).toBe(200)
    // 覆盖值重扫存活；发行日即专辑年份（编辑保留）
    expect((await a.post("/api/v1/library/scan?force=true")).status).toBe(204); await a.waitScanIdle()
    expect((await b.get(endpoint)).body).toMatchObject({ title: "编辑后的标题", genre: "J-Pop", format: "mp3" })
    const track = await b.get(`/api/v1/tracks/${id}`)
    expect((track.body as { album: { year: number | null } }).album.year).toBe(2003)
    // 导入第二首（删除流程的目标）与第三首（legacy 与终态兄弟）
    const second = await b.post(base + "/requests", { url: "https://music.163.com/song?id=186016", folderId, subdirectory: "Singles" })
    const third = await b.post(base + "/requests", { url: "https://music.163.com/song?id=999000", folderId, subdirectory: "Singles" })
    expect([second.status, third.status]).toEqual([200, 200])
    const c = (second.body as NeteaseImportResult).trackIds[0]!, d = (third.body as NeteaseImportResult).trackIds[0]!
    // N3：移出曲库不删文件，排除防复活
    const entry = `${base}/tracks/${id}/library-entry`
    expect((await other.del(entry)).status).toBe(404)
    expect((await b.del(entry)).status).toBe(204)
    expect(await Bun.file(disk).exists()).toBe(true)
    expect((await b.get(endpoint)).status).toBe(404)
    expect((await a.post("/api/v1/library/scan?force=true")).status).toBe(204); await a.waitScanIdle()
    expect((await single("Singles")).body).toMatchObject({ state: "failed", trackIds: [] })
    // N4–N7：物理删除票据全流程
    const ask = `${base}/tracks/${c}/file-deletion-requests`, target = path.join(dest, "Netease-186016.mp3")
    expect((await other.post(ask)).status).toBe(404)
    const ticket = async () => { const req = await b.post(ask); expect(req.status).toBe(200); expect(req.body).not.toHaveProperty("token"); return `${base}/file-deletion-requests/${(req.body as { requestId: string }).requestId}` }
    const canceled = await ticket(); expect((await b.del(canceled)).status).toBe(204); expect((await b.post(canceled + "/review")).status).toBe(404)
    const once = await ticket(); expect((await other.post(once + "/review")).status).toBe(404)
    const review = await b.post(once + "/review")
    expect(review.status).toBe(200)
    expect(review.body).toMatchObject({ trackId: String(c), filename: "Netease-186016.mp3", format: "mp3", path: target })
    const { token } = review.body as { token: string }
    expect((await b.post(once + "/confirm", { token: "invented", filename: "Netease-186016.mp3" })).status).toBe(422)
    expect((await b.post(once + "/confirm", { token, filename: "Netease-5264842.mp3" })).status).toBe(422)
    expect((await other.post(once + "/confirm", { token, filename: "Netease-186016.mp3" })).status).toBe(404)
    // A different inode must never inherit a prior approval, even at the same path.
    await fs.rename(target, target + ".saved"); await fs.symlink(disk, target)
    expect((await b.post(once + "/confirm", { token, filename: "Netease-186016.mp3" })).status).toBe(422)
    expect((await fs.lstat(target)).isSymbolicLink()).toBe(true)
    await fs.unlink(target); await fs.rename(target + ".saved", target)
    const exp = await ticket(); const now = Date.now
    try { Date.now = () => now() + 6 * 60_000; expect((await b.post(exp + "/review")).status).toBe(404) } finally { Date.now = now }
    // An FK that rejects the deletion after staging must leave both source and DB intact.
    const pool = new Pool({ connectionString: TEST_DB_URL })
    try {
      await pool.query("create table netease_test_block_remove(id bigint references tracks(id))")
      await pool.query("insert into netease_test_block_remove values($1)", [c])
      const blocked = await ticket(), v = (await b.post(blocked + "/review")).body as { token: string }
      expect((await b.post(blocked + "/confirm", { token: v.token, filename: "Netease-186016.mp3" })).status).toBe(422)
      expect(await Bun.file(target).exists()).toBe(true); expect((await b.get(`${base}/tracks/${c}/metadata`)).status).toBe(200)
    } finally { await pool.query("drop table if exists netease_test_block_remove"); await pool.end() }
    const fresh = await ticket(), final = await b.post(fresh + "/review")
    expect(final.body).toMatchObject({ filename: "Netease-186016.mp3", format: "mp3" })
    const payload = { token: (final.body as { token: string }).token, filename: "Netease-186016.mp3" }
    expect((await b.post(fresh + "/confirm", payload)).status).toBe(204)
    expect((await b.post(fresh + "/confirm", payload)).status).toBe(404)
    expect(await Bun.file(target).exists()).toBe(false)
    expect((await b.get(`${base}/tracks/${c}/metadata`)).status).toBe(404)
    expect(await Bun.file(disk).exists()).toBe(true)
    expect((await b.get(`${base}/tracks/${d}/metadata`)).status).toBe(200)
    // legacy（无 provenance 行，例如曲目行被扫描器重建）：仅管理员可管理，标签核验 fail closed
    const legacyPool = new Pool({ connectionString: TEST_DB_URL })
    try {
      expect((await legacyPool.query("select count(*)::int as n from netease_imports where track_id=$1", [c])).rows[0]!.n).toBe(0)
      await legacyPool.query("delete from netease_imports where track_id=$1", [d])
      expect((await b.get(`${base}/tracks/${d}/metadata`)).body).toMatchObject({ songId: "999000", quality: null })
      expect((await b.del(`${base}/tracks/${d}/library-entry`)).status).toBe(404) // 属主列已不存在，非管理员 NotFound
      expect((await b.patch(`${base}/tracks/${d}/metadata`, { title: "denied" })).status).toBe(404)
      expect((await a.patch(`${base}/tracks/${d}/metadata`, { title: "legacy 编辑" })).status).toBe(200) // 管理员 + 标签核验通过
      // 篡改 OPENMUSIC_NETEASE_ID → 先 force 扫描让 DB 指纹与磁盘一致，
      // 这样 422 只能来自标签核验本身（而非 mtime 失配），文件原样保留
      const legacy = path.join(dest, "Netease-999000.mp3")
      expect(rewriteProvenance(legacy, "111")).toBe(0)
      expect((await a.post("/api/v1/library/scan?force=true")).status).toBe(204); await a.waitScanIdle()
      expect((await a.post(`${base}/tracks/${d}/file-deletion-requests`)).status).toBe(422)
      expect(await Bun.file(legacy).exists()).toBe(true)
      expect(rewriteProvenance(legacy, "999000")).toBe(0)
      expect((await a.post("/api/v1/library/scan?force=true")).status).toBe(204); await a.waitScanIdle()
      const verified = await a.post(`${base}/tracks/${d}/file-deletion-requests`)
      expect(verified.status).toBe(200)
      const key = (verified.body as { requestId: string }).requestId
      const human = (await a.post(`${base}/file-deletion-requests/${key}/review`)).body as { token: string }
      expect((await a.post(`${base}/file-deletion-requests/${key}/confirm`, { token: human.token, filename: "Netease-999000.mp3" })).status).toBe(204)
      expect(await Bun.file(legacy).exists()).toBe(false)
    } finally { await legacyPool.end() }
  } finally { globalThis.fetch = originalFetch; process.env.PATH = previous; await app.dispose(); await fs.rm(tmp, { recursive: true, force: true }) }
}, 60_000)
