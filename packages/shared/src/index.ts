/**
 * 前后端共享的常量（单一事实源）。
 */
export const SERVER_NAME = "OpenMusic"
export const SERVER_VERSION = "0.1.0"

/** 通告的 Subsonic 协议版本（Feishin 按此 + openSubsonic 标记走 OpenSubsonic 协商） */
export const SUBSONIC_API_VERSION = "1.16.1"

/** OpenSubsonic 扩展通告列表——只通告已实现的扩展（见 docs/05 §2） */
export const OPEN_SUBSONIC_EXTENSIONS: ReadonlyArray<{ name: string; versions: ReadonlyArray<number> }> = []

/** 无标签回退身份（scanner 回退链与统计排除共用的单一事实源）。
 *  这两个字符串是数据语义的一部分：改动等于把存量库里已聚合的散文件拆散重灌，慎动。 */
export const UNKNOWN_ARTIST = "Unknown Artist"
export const UNKNOWN_ALBUM = "Unknown Album"

/** 合辑推断身份（scanner VA 推断与展示/统计口径共用的单一事实源）。
 *  albumartist 标签缺失时，若同一专辑目录 + 同一专辑名下出现多名曲作者，
 *  专辑整体归到此艺人名下（推断规则见 docs/02 §5 与 docs/03 §2.1）。
 *  与 Unknown 系不同：它是「有内容的真实归组」，不进统计排除名单。 */
export const VARIOUS_ARTISTS = "Various Artists"
