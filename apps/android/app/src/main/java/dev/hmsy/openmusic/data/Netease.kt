package dev.hmsy.openmusic.data

/**
 * 网易云导入纯函数层：链接解析与子目录校验平移服务端语义（source.ts / checkSubdirectory），
 * 便于提交前给用户即时反馈；服务端仍是唯一权威，任何漏网都会得到可读的 422 文案。
 */

enum class NeteaseKind(val label: String) {
  SONG("单曲"), PLAYLIST("歌单"), ALBUM("专辑"), ARTIST("歌手热门");
  companion object {
    fun of(route: String): NeteaseKind? = when (route) {
      "song" -> SONG; "playlist" -> PLAYLIST; "album" -> ALBUM; "artist" -> ARTIST; else -> null
    }
  }
}

/** 解析后的网易云链接：canonicalUrl 为规范化重建值（与服务端一致），绝不透传用户原始输入。 */
data class NeteaseLink(val kind: NeteaseKind, val id: String, val canonicalUrl: String)

private val neteaseSongId = Regex("^\\d{1,20}$")
private val neteaseHosts = setOf("music.163.com", "www.music.163.com", "y.music.163.com")
private val neteaseRoute = Regex("^/(?:m/)?(song|playlist|album|artist)(?:/(\\d{1,20}))?/?$")
private val neteaseIdParam = Regex("(?:^|&)id=([^&]*)")

/** 只接受 music.163.com 的单曲/歌单/专辑/歌手链接（含 #/song、m/song/<id>、y. 前缀变体）。 */
fun parseNeteaseLink(input: String): NeteaseLink? {
  val raw = input.trim()
  if (raw.isEmpty() || raw.length > 2048) return null
  // 分享链接可能夹带未转义的 CJK：先按原样解析，失败再对非 ASCII 做一次百分号编码重试。
  val uri = runCatching { java.net.URI(raw) }.getOrElse {
    runCatching { java.net.URI(encodeNonAscii(raw)) }.getOrNull()
  } ?: return null
  if (uri.scheme !in setOf("http", "https")) return null
  if (uri.userInfo != null || uri.port != -1) return null
  val host = uri.host?.lowercase() ?: return null
  if (host !in neteaseHosts) return null
  resolveNetease(uri.rawPath ?: "", uri.rawQuery)?.let { return neteaseLink(it.first, it.second) }
  // SPA 分享链接把路由放在 hash 里：https://music.163.com/#/song?id=…
  val hash = uri.rawFragment ?: return null
  if (hash.isEmpty()) return null
  val at = hash.indexOf('?')
  val path = if (at == -1) hash else hash.substring(0, at)
  val query = if (at == -1) null else hash.substring(at + 1)
  resolveNetease(path, query)?.let { return neteaseLink(it.first, it.second) }
  return null
}

private fun neteaseLink(kind: NeteaseKind, id: String) =
  NeteaseLink(kind, id, "https://music.163.com/${kind.name.lowercase()}?id=$id")

private fun resolveNetease(path: String, query: String?): Pair<NeteaseKind, String>? {
  val match = neteaseRoute.find(path) ?: return null
  val kind = NeteaseKind.of(match.groupValues[1]) ?: return null
  val id = match.groupValues[2].ifBlank { query?.let(neteaseIdParam::find)?.groupValues?.get(1) ?: "" }
  if (!neteaseSongId.matches(id)) return null
  return kind to id
}

private fun encodeNonAscii(input: String): String = buildString(input.length) {
  for (byte in input.encodeToByteArray()) {
    val value = byte.toInt() and 0xFF
    if (value in 0x21..0x7E) append(value.toChar()) else append('%').append("%02X".format(value))
  }
}

/**
 * 子目录相对路径校验（平移服务端 checkSubdirectory）：
 * ≤360 字符、≤8 段、每段 1–100、段首不是「.」、不含 \ : 与控制字符。
 */
object NeteaseSubdirectory {
  private val forbidden = Regex("[\\\\:\\x00-\\x1f\\x7f]")

  fun check(input: String): Boolean {
    if (input.isEmpty()) return true
    if (input.length > 360) return false
    val parts = input.split('/')
    if (parts.size > 8) return false
    return parts.all { p -> p.isNotEmpty() && p.length <= 100 && !p.startsWith(".") && !forbidden.containsMatchIn(p) }
  }

  /** 拼接一段子目录（超出校验规则时返回 null） */
  fun append(current: String, child: String): String? {
    val next = if (current.isEmpty()) child else "$current/$child"
    return if (check(next)) next else null
  }

  fun parent(current: String): String {
    if (current.isEmpty()) return ""
    val parts = current.split('/').toMutableList()
    parts.removeAt(parts.size - 1)
    return parts.joinToString("/")
  }
}

// ── 展示辅助（纯函数，供 Compose 与单测共用）──────────────────

fun neteaseKindLabel(kind: String): String = when (kind) {
  "song" -> NeteaseKind.SONG.label
  "playlist" -> NeteaseKind.PLAYLIST.label
  "album" -> NeteaseKind.ALBUM.label
  "artist" -> NeteaseKind.ARTIST.label
  else -> kind
}

fun neteaseStateLabel(state: String): String = when (state) {
  "done" -> "完成"; "partial" -> "部分成功"; "failed" -> "失败"; else -> state
}

fun neteaseCountSummary(r: NeteaseImportResult): String =
  "共 ${r.total} · 导入 ${r.imported} · 跳过 ${r.skipped} · 失败 ${r.failed}"

/** 封面来源白名单（服务端语义）：netease 恢复原封面，或 https 的 *.music.126.net 图片。 */
fun neteaseCoverUrlOk(url: String): Boolean {
  val uri = runCatching { java.net.URI(url) }.getOrNull() ?: return false
  return uri.scheme == "https" && (uri.host ?: "").lowercase().endsWith(".music.126.net")
}

/** 文本标签校验（镜像服务端 metadataFields）：非空、≤300、含非空白字符、无控制字符 */
fun neteaseLabelOk(value: String): Boolean =
  value.isNotEmpty() && value.length <= 300 &&
    !Regex("[\\x00-\\x1f\\x7f]").containsMatchIn(value) &&
    value.any { !it.isWhitespace() }

/** 曲目/碟号输入框文本：留空合法（= 保持不变），填了须是 1..9999 */
fun neteasePositionTextOk(text: String): Boolean {
  if (text.isBlank()) return true
  return text.trim().toIntOrNull()?.let { it in 1..9999 } == true
}

fun formatSizeBytes(bytes: Long): String {
  if (bytes < 0) return "—"
  if (bytes < 1024) return "$bytes B"
  val kb = bytes / 1024.0
  if (kb < 1024) return "%.1f KB".format(kb)
  val mb = kb / 1024.0
  if (mb < 1024) return "%.1f MB".format(mb)
  return "%.1f GB".format(mb / 1024.0)
}

/** epoch 毫秒 → 本地时区「yyyy-MM-dd HH:mm」；解析失败原样返回输入。 */
fun formatEpochMs(ms: Long): String = runCatching {
  val time = java.time.Instant.ofEpochMilli(ms).atZone(java.time.ZoneId.systemDefault())
  "%04d-%02d-%02d %02d:%02d".format(time.year, time.monthValue, time.dayOfMonth, time.hour, time.minute)
}.getOrElse { ms.toString() }
