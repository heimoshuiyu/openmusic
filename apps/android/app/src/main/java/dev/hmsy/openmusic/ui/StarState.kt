package dev.hmsy.openmusic.ui

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/** ID 只在实体类型内唯一，曲目与专辑的覆盖态不能共用一个键。 */
internal data class StarKey(val kind: String, val id: String)

internal class StarState(
  private val scope: CoroutineScope,
  private val persist: suspend (kind: String, id: String, starred: Boolean) -> Unit,
) {
  private val _stars = MutableStateFlow<Map<StarKey, Boolean>>(emptyMap())
  val stars = _stars.asStateFlow()
  private val pending = mutableSetOf<StarKey>()

  fun isStarred(id: String, fallback: String?, kind: String = "tracks"): Boolean =
    _stars.value[StarKey(kind, id)] ?: (fallback != null)

  fun toggle(
    id: String,
    fallbackStarred: Boolean,
    kind: String = "tracks",
    onError: () -> Unit = {},
    onChanged: () -> Unit = {},
  ) {
    val key = StarKey(kind, id)
    // 请求未完成时忽略重复点击，防止响应乱序把服务端状态反转。
    if (!pending.add(key)) return
    val previous = _stars.value[key] ?: fallbackStarred
    val target = !previous
    _stars.value = _stars.value + (key to target)
    scope.launch {
      try {
        persist(kind, id, target)
      } catch (error: CancellationException) {
        _stars.value = _stars.value + (key to previous)
        throw error
      } catch (_: Exception) {
        _stars.value = _stars.value + (key to previous)
        onError()
        return@launch
      } finally {
        pending.remove(key)
      }
      // 收藏页只能在写入完成后重新查询，否则会读回旧列表。
      onChanged()
    }
  }
}
