import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import path from "node:path"

/** netease-import skill 的官方历史 seed（sha256，逐字节）。seed 策略：
 *  不存在才写（COPYFILE_EXCL），存在时只迁移命中这些精确旧种子的副本；任何
 *  checksum 不匹配的实例视为用户手改，原样保留（skill 有 Watcher 热刷新，手改即生效）。
 *  每次修改 bundled 文案时，把「上一个官方 seed」的 sha256 滚进本清单——只增不减。 */
export const STALE_NETEASE_SEEDS: ReadonlyArray<string> = [
  // d6b8e2d 双后端中间版：文案教模型引导用户配置 NETEASE_API_BASE/NETEASE_QUALITY 自建实例——
  // 该后端已在 9039856 移除，残留文案会诱导模型承诺不存在的配置。
  "8e9edeb1097c30335036c3bf141e913d79e97295f551ea5b778f876b79250a87",
  // 9039856 匿名-only v1 seed：不含曲目管理工具的纪律文案。
  "4d3eea7f78ebe168295aec75d8e70b66e1b35f84554bd09c8720894d09763dcc",
]

/** seed 目录里已存在同名 skill 时决定去留：命中已知官方旧种子 → 用 bundled 版覆盖并返回
 *  true；否则（用户手改或已是新版）不动一个字节并返回 false。独立成函数以便单测
 *  直接覆盖「旧 seed 升级 / 手改保留」两条路径。 */
export async function migrateSeededSkill(existing: string, bundled: string, stale: ReadonlyArray<string> = STALE_NETEASE_SEEDS): Promise<boolean> {
  const checksum = createHash("sha256").update(await fs.readFile(existing)).digest("hex")
  if (!stale.includes(checksum)) return false
  await fs.copyFile(bundled, existing)
  return true
}

/** seed 入口（embedded.seedSkill 调用）：目录不存在 → COPYFILE_EXCL 落 bundled 原文；
 *  已存在 → 交给 migrateSeededSkill（旧种子升级、手改保留）。真实 IO 错误（bundled
 *  缺失、权限等非 EEXIST）原样抛出，走 embedded 既有的 hostError 路径——安装损坏
 *  必须显性失败，绝不静默装作 seed 成功。 */
export async function seedNeteaseSkill(agentHome: string, bundled: string = path.join(import.meta.dir, "skills/netease-import/SKILL.md")): Promise<void> {
  const target = path.join(agentHome, "skills/netease-import/SKILL.md")
  await fs.mkdir(path.dirname(target), { recursive: true })
  try {
    await fs.copyFile(bundled, target, fs.constants.COPYFILE_EXCL)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    await migrateSeededSkill(target, bundled)
  }
}
