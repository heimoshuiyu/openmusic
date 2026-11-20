package dev.hmsy.openmusic.data

import kotlinx.serialization.Serializable

/** 与 server domain schema 对齐的 DTO（docs/04；字段与 apps/web api/client.ts 同源） */

@Serializable
data class UserPublic(
  val id: String,
  val username: String,
  val isAdmin: Boolean = false,
  val createdAt: String,
  val lastSeenAt: String? = null,
)

@Serializable
data class ArtistRef(val id: String, val name: String)

@Serializable
data class AlbumRef(val id: String, val name: String, val year: Int? = null)

@Serializable
data class ArtistSummary(
  val id: String,
  val name: String,
  val albumCount: Int,
  val trackCount: Int,
  val hasCoverArt: Boolean,
  val starred: String? = null,
  val createdAt: String,
)

@Serializable
data class AlbumSummary(
  val id: String,
  val name: String,
  val artist: ArtistRef,
  val year: Int? = null,
  val genre: String? = null,
  val trackCount: Int,
  val durationSeconds: Int,
  val hasCoverArt: Boolean,
  val starred: String? = null,
  val createdAt: String,
)

@Serializable
data class TrackSummary(
  val id: String,
  val title: String,
  val artist: ArtistRef,
  val album: AlbumRef,
  val disc: Int = 1,
  val track: Int? = null,
  val durationSeconds: Int,
  val bitrateKbps: Int = 0,
  val sampleRateHz: Int = 0,
  val channels: Int = 2,
  val format: String = "",
  val codec: String = "",
  val sizeBytes: Long = 0,
  val hasCoverArt: Boolean = false,
  val starred: String? = null,
  val userRating: Int? = null,
  val playCount: Int = 0,
  /** 同一槽位的物理拷贝数（canonical 视图口径；>1 时行尾出 ×N 版本徽标） */
  val versionCount: Int? = null,
  /** 相对路径；仅版本列表（/tracks/:id/versions）填充 */
  val path: String? = null,
  val createdAt: String = "",
)

@Serializable
data class Page<T>(
  val items: List<T>,
  val total: Int,
  val offset: Int,
  val limit: Int,
)

@Serializable
data class PlaylistSummary(
  val id: String,
  val name: String,
  val comment: String? = null,
  val isPublic: Boolean = false,
  val owner: String,
  val isMine: Boolean = false,
  val songCount: Int,
  val durationSeconds: Int,
  val createdAt: String = "",
  val updatedAt: String = "",
)

@Serializable
data class ScanStatus(
  val state: String,
  /** walking=遍历磁盘（total 随发现增长），indexing=解析入库，idle 为 null */
  val phase: String? = null,
  val total: Int = 0,
  val processed: Int = 0,
  val startedAt: String? = null,
  val lastScanAt: String? = null,
  val errors: List<String> = emptyList(),
)

@Serializable
data class SearchResult(
  val artists: List<ArtistSummary> = emptyList(),
  val albums: List<AlbumSummary> = emptyList(),
  val tracks: List<TrackSummary> = emptyList(),
  val artistCount: Int = 0,
  val albumCount: Int = 0,
  val trackCount: Int = 0,
)

/** 最近播放条目：track 为 null = 曲目已不在库中（墓碑行）——快照字段承载叙事，灰显不可播 */
@Serializable
data class PlayEntry(
  val track: TrackSummary? = null,
  val title: String = "",
  val artistName: String = "",
  val albumName: String = "",
  val durationSeconds: Long = 0,
  val playedAt: String = "",
)

@Serializable
data class PlayStat(val playCount: Int, val listenedSeconds: Int)

@Serializable
data class MostPlayedTrack(val kind: String = "track", val playCount: Int, val listenedSeconds: Int, val track: TrackSummary)

@Serializable
data class MostPlayedAlbum(val kind: String = "album", val playCount: Int, val listenedSeconds: Int, val album: AlbumSummary)

@Serializable
data class MostPlayedArtist(val kind: String = "artist", val playCount: Int, val listenedSeconds: Int, val artist: ArtistSummary)

@Serializable
data class ListeningSummary(
  val plays: Int,
  val tracks: Int,
  val listenedSeconds: Int,
)

// ── 网易云导入（docs/04 导入组；与 server domain/netease.ts 及 netease 管理端点同形）──────

/** 搜索候选：url 为规范化重建的 music.163.com 单曲链接；vip=true 即 VIP/付费（导入时明确跳过） */
@Serializable
data class NeteaseCandidate(
  val title: String,
  val artist: String,
  val album: String,
  val songId: String,
  val url: String,
  val vip: Boolean = false,
)

@Serializable
data class NeteaseFile(val trackId: Long, val name: String)

/** failures 按 {songId, reason}、warnings 按 {songId, message}；两侧共用一个宽容 DTO */
@Serializable
data class NeteaseSongMessage(val songId: String, val reason: String = "", val message: String = "")

/** 同步等终态结果：state ∈ done/partial/failed；trackIds 为已入库的曲目 id（可直接播放） */
@Serializable
data class NeteaseImportResult(
  val url: String,
  val kind: String,
  val state: String,
  val total: Int = 0,
  val imported: Int = 0,
  val skipped: Int = 0,
  val failed: Int = 0,
  val destination: String = "",
  val trackIds: List<Long> = emptyList(),
  val files: List<NeteaseFile> = emptyList(),
  val failures: List<NeteaseSongMessage> = emptyList(),
  val warnings: List<NeteaseSongMessage> = emptyList(),
)

/** 导入目标：folders 含 writable（不可写目录前置禁止提交）；children 单层、可能截断 */
@Serializable
data class NeteaseFolder(val id: String, val name: String, val path: String, val writable: Boolean = false)

@Serializable
data class NeteaseChildren(val directories: List<String> = emptyList(), val truncated: Boolean = false)

/** 曲目来源信息（登录可读）：quality 为匿名音源实际档位（如 exhigh） */
@Serializable
data class NeteaseInfo(
  val trackId: String = "",
  val songId: String = "",
  val quality: String? = null,
  val format: String = "mp3",
  val filename: String = "",
  val title: String = "",
  val artist: String = "",
  val album: String = "",
  val albumArtist: String? = null,
  val genre: String? = null,
  val trackNumber: Int? = null,
  val discNumber: Int? = null,
  val hasCover: Boolean = false,
  val warnings: List<String> = emptyList(),
)

/** 删除申请票据：reviewPath 为 Web 核对页路径；expiresAt 为 epoch 毫秒（同 YouTube 形状） */
@Serializable
data class NeteaseDeletionRequest(
  val requestId: String = "",
  val reviewPath: String = "",
  val expiresAt: Long = 0,
)

/** 人工核对视图：token 只保存在内存，confirm 时随逐字输入的 filename 一并提交 */
@Serializable
data class NeteaseDeletionReview(
  val trackId: String = "",
  val title: String = "",
  val artist: String = "",
  val filename: String = "",
  val format: String = "",
  val path: String = "",
  val sizeBytes: Long = 0,
  val expiresAt: Long = 0,
  val token: String = "",
)

// ── 音乐助手（docs/08；与 web api/client.ts 同源）─────────

@Serializable
data class AgentSession(
  val id: String,
  val title: String,
  val createdAt: String,
)

@Serializable
data class AgentMessage(
  val id: String,
  val role: String,
  val text: String,
  val createdAt: String,
)

/** client-action 卡片的精简曲目投影（完整域对象按 id 再拉） */
@Serializable
data class AgentTrackBrief(
  val id: String,
  val title: String,
  val artist: String,
  val durationSeconds: Int = 0,
)

fun formatDuration(seconds: Int): String {
  val h = seconds / 3600
  val m = (seconds % 3600) / 60
  val s = seconds % 60
  // 超 1 小时进位 h:mm:ss（超长曲/演唱会录音）
  return if (h > 0) "%d:%02d:%02d".format(h, m, s) else "%d:%02d".format(m, s)
}

fun formatTotal(seconds: Int): String {
  val h = seconds / 3600
  val m = (seconds % 3600) / 60
  return if (h > 0) "%d 小时 %d 分钟".format(h, m) else "%d 分钟".format(m)
}
