import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"

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
 *  直接覆盖「干净 seed / 旧 seed 升级 / 手改保留」三条路径。 */
export async function migrateSeededSkill(existing: string, bundled: string, stale: ReadonlyArray<string> = STALE_NETEASE_SEEDS): Promise<boolean> {
  const checksum = createHash("sha256").update(await fs.readFile(existing)).digest("hex")
  if (!stale.includes(checksum)) return false
  await fs.copyFile(bundled, existing)
  return true
}
