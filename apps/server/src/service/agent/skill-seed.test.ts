import { expect, test } from "bun:test"
import * as fs from "node:fs/promises"
import { readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import os from "node:os"
import path from "node:path"
import { migrateSeededSkill, STALE_NETEASE_SEEDS } from "./skill-seed"

/** netease-import skill 迁移决策单测（免 DB）：干净 seed 由 embedded.seedSkill 的
 *  COPYFILE_EXCL 路径覆盖（agent-embed 集成里断言）；这里钉住「已存在」时的三分支：
 *  ① 官方旧种子（含 d6b8e2d 双后端中间版）逐字节命中 → 升级到 bundled；
 *  ② 手改副本（任何 checksum 不匹配）原样保留；
 *  ③ 当前 bundled 版自身不进 stale 清单（防止升级后的新 seed 被反复重写）。 */

const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex")

// 逐字节历史 seed（由 git show d6b8e2d / 9039856 固化，改文案时勿动这两段）
const SEED_D6B8E2D = "---\nname: netease-import\ndescription: 从网易云音乐导入歌曲、歌单、专辑或歌手热门曲目时使用；含 VIP/付费行为、25 首上限、时长校验与可选自建实例（兼容 NeteaseCloudMusicApi 协议）的说明。\n---\n\n1. **来源选择**：用户给出 music.163.com 链接、点名「网易云/网易/163」，或想要华语/日韩主流发行的录音室版本时用网易云导入；视频、现场、自唱、播客仍走 YouTube 导入。两个工具不会替用户跨来源重复导入已入库的歌曲。\n2. `tools.netease.search_netease({query})` 只搜不下载，返回 `{title,artist,album,songId,url,vip}`；`vip:true` 是 VIP/付费曲目，匿名模式拿不到完整版，导入前先告知用户。确认后 `await tools.netease.start_import_netease({url,folderId,subdirectory?})` 等到终态再回复，如实报告 `state`、数量、`trackIds`、`failures` 与 `warnings`。目标目录与来源无关，用 `tools.youtube.list_folders` / `tools.youtube.list_subdirectories` 选择；用户明确指定的目标不可写或不存在时在对话中澄清。\n3. **范围与上限**：支持单曲、歌单、专辑、歌手热门四种链接；歌单/专辑最多 25 首，超过会整组拒绝并提示分批或逐首导入；歌手热门超过 25 首只导入前 25。逐首独立处理，一首失败继续其余，`failures` 逐条给出原因。\n4. **VIP 与试听防护**：服务器未配置 `NETEASE_API_BASE`（匿名 yt-dlp，MP3 至多 320k）时，VIP/付费歌会在 `failures` 里标注「配置 NETEASE_API_BASE 后可重试」并跳过，不会下载残缺片段；下载后还会用 ffprobe 核对实际时长，疑似 30 秒试听片段直接丢弃不入库。配置了自建实例（兼容 NeteaseCloudMusicApi 协议）时这些歌照常尝试，成败由实例与时长校验决定；音质档位取服务器 `NETEASE_QUALITY` 配置，我们服务器不接触用户的网易云 cookie——账号配置在用户自己的实例上（建议小号，2024-10 曾有第三方登录封号潮）。\n5. **入库内容**：导入成功自动内嵌网易云元数据（曲名/歌手/专辑/发行日/封面，发行日作为专辑年份）并写 `netease_imports` 溯源；原文与翻译歌词（若有）自动存进曲库歌词，歌词失败只是 `warnings`，不影响音频。文件名 `Netease-<songId>.mp3|flac`，同目录同 ID 已有文件标记 `skipped` 不覆盖；想要更高音质请让用户换目录或先移除旧文件。\n"
const SEED_9039856 = "---\nname: netease-import\ndescription: 从网易云音乐导入歌曲、歌单、专辑或歌手热门曲目时使用；含 VIP/付费行为、25 首上限与试听片段时长校验的说明。\n---\n\n1. **来源选择**：用户给出 music.163.com 链接、点名「网易云/网易/163」，或想要华语/日韩主流发行的录音室版本时用网易云导入；视频、现场、自唱、播客仍走 YouTube 导入。两个工具不会替用户跨来源重复导入已入库的歌曲。\n2. `tools.netease.search_netease({query})` 只搜不下载，返回 `{title,artist,album,songId,url,vip}`；`vip:true` 是 VIP/付费曲目，匿名模式拿不到完整版，导入前先告知用户。确认后 `await tools.netease.start_import_netease({url,folderId,subdirectory?})` 等到终态再回复，如实报告 `state`、数量、`trackIds`、`failures` 与 `warnings`。目标目录与来源无关，用 `tools.youtube.list_folders` / `tools.youtube.list_subdirectories` 选择；用户明确指定的目标不可写或不存在时在对话中澄清。\n3. **范围与上限**：支持单曲、歌单、专辑、歌手热门四种链接；歌单/专辑最多 25 首，超过会整组拒绝并提示分批或逐首导入；歌手热门超过 25 首只导入前 25。逐首独立处理，一首失败继续其余，`failures` 逐条给出原因。\n4. **VIP 与试听防护**：VIP/付费歌（`vip:true`，fee∈{1,4}）在导入前的预检阶段就被明确跳过，`failures` 里说明「VIP/付费歌曲需要会员账号，未导入」——不下载残缺片段；下载后的 ffprobe 时长校验是第二道保险（容差 max(2 秒, 预期 1%)），疑似 30 秒试听片段直接丢弃不入库。匿名导入为 MP3 至多 320k，海外网络对部分曲库有地区差异，如实告知用户，不要承诺导不出的内容。\n5. **入库内容**：导入成功自动内嵌网易云元数据（曲名/歌手/专辑/发行日/封面，发行日作为专辑年份）并写 `netease_imports` 溯源；原文与翻译歌词（若有）自动存进曲库歌词，歌词失败只是 `warnings`，不影响音频。文件名 `Netease-<songId>.mp3|flac`，同目录同 ID 已有文件标记 `skipped` 不覆盖。\n"

const withTemp = async (fn: (dir: string) => Promise<void>) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "om-skill-seed-"))
  try { await fn(dir) } finally { await fs.rm(dir, { recursive: true, force: true }) }
}

test("常量与历史种子逐字节对应，且当前 bundled 不在 stale 清单", async () => {
  expect(STALE_NETEASE_SEEDS).toHaveLength(2)
  expect(createHash("sha256").update(Buffer.from(SEED_D6B8E2D)).digest("hex")).toBe(STALE_NETEASE_SEEDS[0]!)
  expect(createHash("sha256").update(Buffer.from(SEED_9039856)).digest("hex")).toBe(STALE_NETEASE_SEEDS[1]!)
  const bundled = path.join(import.meta.dir, "skills/netease-import/SKILL.md")
  expect(STALE_NETEASE_SEEDS).not.toContain(sha256(bundled))
})

test("官方旧 seed（d6b8e2d 双后端文案 / 9039856 无管理工具版）升级为 bundled", async () => {
  await withTemp(async dir => {
    const bundled = path.join(import.meta.dir, "skills/netease-import/SKILL.md")
    for (const stale of [SEED_D6B8E2D, SEED_9039856]) {
      const existing = path.join(dir, "SKILL.md")
      await fs.writeFile(existing, stale)
      expect(await migrateSeededSkill(existing, bundled)).toBe(true)
      expect(await fs.readFile(existing, "utf8")).toEqual(await fs.readFile(bundled, "utf8"))
    }
  })
})

test("用户手改副本（旧 seed + 自定义一行 / 任意内容）逐字节保留", async () => {
  await withTemp(async dir => {
    const bundled = path.join(import.meta.dir, "skills/netease-import/SKILL.md")
    for (const tuned of [SEED_D6B8E2D + "\n6. 我自己调教过的段落，不许覆盖。\n", "完全无关的内容"]) {
      const existing = path.join(dir, "SKILL.md")
      await fs.writeFile(existing, tuned)
      expect(await migrateSeededSkill(existing, bundled)).toBe(false)
      expect(await fs.readFile(existing, "utf8")).toEqual(tuned)
    }
  })
})
