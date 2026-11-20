package dev.hmsy.openmusic.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import dev.hmsy.openmusic.OpenMusicApp
import dev.hmsy.openmusic.data.NeteaseImportResult
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * MainArea 级网易云导入运行器。
 *
 * 服务端 POST /requests 同步等终态（多曲分钟级），必须挂在比 NavHost 目的地更长命的
 * 组合层：切 tab / 离开导入屏不打断等待，回到导入屏仍能看到进行中状态与结果。
 * 登出（sessionKey 重组 MainArea）时随 scope 一并作废——会话都没了，等待无意义。
 *
 * 「放弃等待 ≠ 服务端取消」：本类不提供取消（没有对应端点）；App 进程若被杀，
 * 服务器可能仍占着单飞槽位继续导入，此时重新提交会得到 422「已有导入正在执行，
 * 请稍后再试」，文案如实转述即可，不做假进度。
 */
class NeteaseRunner(private val scope: CoroutineScope) {

  /** 进行中的导入（null = 空闲）；target 为「目录/子目录」展示用摘要 */
  data class Busy(val url: String, val target: String, val startedAtMs: Long)

  var busy by mutableStateOf<Busy?>(null)
    private set
  var outcome by mutableStateOf<NeteaseImportResult?>(null)
    private set
  var error by mutableStateOf<String?>(null)
    private set

  /** 服务器每用户单飞：进行中时拒绝新请求，返回如实转述的错误文案（null = 已受理） */
  fun start(url: String, folderId: String, subdirectory: String?, target: String): String? {
    if (busy != null) {
      return "已有一次导入正在等待结果（服务器每位用户同时只允许一个导入任务）；稍后回来看结果，或等它结束后再试。"
    }
    busy = Busy(url, target, System.currentTimeMillis())
    error = null
    scope.launch {
      val result = withContext(Dispatchers.IO) { runCatching { OpenMusicApp.api.neteaseImport(url, folderId, subdirectory) } }
      busy = null
      result.fold(
        onSuccess = { outcome = it },
        onFailure = { error = it.message ?: "导入失败：网络或服务器错误。" },
      )
    }
    return null
  }

  /** 用户关掉结果面板 */
  fun clearOutcome() {
    outcome = null
    error = null
  }
}
