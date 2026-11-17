package dev.hmsy.openmusic.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import dev.hmsy.openmusic.OpenMusicApp
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.flow.StateFlow

/**
 * 收藏乐观覆盖层（与 TUI star-overlay 同思路）：
 * 各屏 fetch 到的实体是独立副本，全局会话级 Map 叠加在 starred 上，
 * UI 订阅同一状态，失败回滚。
 */
object StarOverlay {

  private val state = StarState(MainScope()) { kind, id, starred ->
    if (starred) OpenMusicApp.api.favorite(kind, id)
    else OpenMusicApp.api.unfavorite(kind, id)
  }

  fun isStarred(id: String, fallback: String?, kind: String = "tracks"): Boolean =
    state.isStarred(id, fallback, kind)

  /** 通知栏收藏按钮等非 Compose 订阅方使用（与 rememberStarred 同源） */
  internal val starStates: StateFlow<Map<StarKey, Boolean>> get() = state.stars

  @Composable
  fun rememberStarred(id: String, fallback: String?, kind: String = "tracks"): Boolean {
    val stars by state.stars.collectAsState()
    return stars[StarKey(kind, id)] ?: (fallback != null)
  }

  fun toggle(
    id: String,
    fallbackStarred: Boolean,
    kind: String = "tracks",
    onError: () -> Unit = {},
    onChanged: () -> Unit = {},
  ) = state.toggle(id, fallbackStarred, kind, onError, onChanged)
}
