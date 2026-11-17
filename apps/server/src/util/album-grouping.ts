/**
 * 专辑归组的目录结构推断（docs/02 §5）：标签缺失时从目录命名还原真相。
 *
 * 两类现实输入（本库实测主力来源的 rip 习惯）：
 * - `Album/Disc 1/01.flac`、`Album/Disc 2/01.flac`——多碟专辑用子目录分碟，
 *   标签里往往既没有 DISCNUMBER 也没有 ALBUMARTIST（Re:Start 实例）
 * - `Album/01.flac`——单碟直接平铺
 *
 * 由此提供两个纯函数：碟号目录段识别 + 文件所属「专辑目录」归一。
 * 只认「整个目录段就是碟号」的命名，Discography / diskografiya 等词根目录不会误伤。
 */

/** 纯碟号目录段：`Disc 1` / `CD 2` / `disk-3` / `cd1`（大小写不敏感；分隔可为空格/-/_） */
export const DISC_DIR_RE = /^(?:cd|disc|disk)[ _-]?([0-9]{1,3})$/i

export const discFromDirName = (name: string): number | null => {
  const match = DISC_DIR_RE.exec(name)
  if (match === null) return null
  const n = Number(match[1])
  return n > 0 ? n : null
}

/** 文件相对路径 → 所属专辑目录：从所在目录起逐级剥掉尾部的纯碟号段。
 *  `Album/Disc 1/x.flac` → `Album`；`Album/Disc 1/CD 1/x.flac` → `Album`；
 *  `Album/x.flac` → `Album`；根目录平铺 `x.flac` → `""`。 */
export const albumDirOf = (relPath: string): string => {
  let dir = relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : ""
  for (;;) {
    const seg = dir.includes("/") ? dir.slice(dir.lastIndexOf("/") + 1) : dir
    if (seg === "" || discFromDirName(seg) === null) return dir
    dir = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : ""
  }
}
