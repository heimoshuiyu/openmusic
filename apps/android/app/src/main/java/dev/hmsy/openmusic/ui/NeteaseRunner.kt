package dev.hmsy.openmusic.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import dev.hmsy.openmusic.OpenMusicApp
import dev.hmsy.openmusic.data.NeteaseImportResult
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import java.net.SocketTimeoutException

/**
 * MainArea 级网易云导入运行器。
 *
 * 服务端 POST /requests 同步等终态（多曲分钟级），必须挂在比 NavHost 目的地更长命的
 * 组合层：切 tab / 离开导入屏不打断等待，回到导入屏仍能看到进行中状态与结果。
 * 登出（sessionKey 重组 MainArea）时随 scope 一并作废——会话都没了，等待无意义。
 *
 * 「放弃等待 ≠ 服务端取消」：本类不提供取消（没有对应端点）；客户端超时只意味着
 * 我们不再等，服务器可能仍在导入并占着单飞槽位。此时重试同一链接与目标即可取回
 * 终态（同目录同 songId 的既有文件按 skipped 幂等，不会重复下载）。
 */
class NeteaseRunner(
  private val scope: CoroutineScope,
  /** 注入点：单测替换；默认直连共享会话的 OmApi（其内部自带 Dispatchers.IO） */
  private val import: suspend (url: String, folderId: String, subdirectory: String?) -> NeteaseImportResult =
    { url, folderId, subdirectory -> OpenMusicApp.api.neteaseImport(url, folderId, subdirectory) },
) {

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
      runCatching { import(url, folderId, subdirectory) }.fold(
        onSuccess = {
          busy = null
          outcome = it
        },
        onFailure = { e ->
          busy = null
          error = when (e) {
            is SocketTimeoutException ->
              "等待服务器结果超时：导入可能仍在服务器进行（放弃等待不会取消它）。" +
                "稍后用相同链接与同一曲库目录、子目录重新提交：任务仍在进行时直接共享其终态；" +
                "若已结束则幂等重跑——已入库文件标记为跳过、失败项可能重试，不保证重现原始 failures。"
            else -> e.message ?: "导入失败：网络或服务器错误。"
          }
        },
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
