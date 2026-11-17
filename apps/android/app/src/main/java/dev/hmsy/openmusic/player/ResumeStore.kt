package dev.hmsy.openmusic.player

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import dev.hmsy.openmusic.data.TrackSummary
import kotlinx.coroutines.flow.first
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

private val Context.resumeDataStore by preferencesDataStore(name = "openmusic_resume")

@Serializable
data class ResumeState(
  val queue: List<TrackSummary>,
  val index: Int,
  val positionMs: Long,
  val savedAtMs: Long,
)

/**
 * 播放现场持久化：Android 11+ 媒体恢复（onPlaybackResumption）的数据源。
 * 队列/当前曲目/进度落 DataStore，进程被杀或重启后系统"继续播放"胶囊一键复活队列。
 */
object ResumeStore {

  /** 存档队列上限（TrackSummary JSON 约 300B/条，120 条 ~36KB） */
  private const val MAX_QUEUE = 120
  /** 裁剪时当前曲目前保留条数 */
  private const val KEEP_BEFORE = 20

  private val keyState = stringPreferencesKey("resume_state")
  private val json = Json { ignoreUnknownKeys = true }

  /** 超长队列窗口裁剪：保留当前曲目前 20 + 后 100，索引随之平移 */
  fun snapshot(queue: List<TrackSummary>, index: Int, positionMs: Long): ResumeState {
    val savedAt = System.currentTimeMillis()
    if (queue.size <= MAX_QUEUE) return ResumeState(queue, index, positionMs, savedAt)
    val from = (index - KEEP_BEFORE).coerceAtLeast(0)
    val to = (from + MAX_QUEUE).coerceAtMost(queue.size)
    return ResumeState(queue.subList(from, to).toList(), index - from, positionMs, savedAt)
  }

  suspend fun save(context: Context, state: ResumeState) {
    runCatching { context.resumeDataStore.edit { it[keyState] = json.encodeToString(state) } }
  }

  suspend fun load(context: Context): ResumeState? = runCatching {
    val raw = context.resumeDataStore.data.first()[keyState] ?: return@runCatching null
    json.decodeFromString<ResumeState>(raw)
  }.getOrNull()

  suspend fun clear(context: Context) {
    runCatching { context.resumeDataStore.edit { it.remove(keyState) } }
  }
}
