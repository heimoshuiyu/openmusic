package dev.hmsy.openmusic.player

import dev.hmsy.openmusic.data.TrackSummary
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/** 播放 UI 状态（PlaybackService 内更新，UI 直接收集——同进程） */
data class PlayerUiState(
  val queue: List<TrackSummary> = emptyList(),
  val index: Int = -1,
  val isPlaying: Boolean = false,
  val isBuffering: Boolean = false,
  val shuffle: Boolean = false,
  val repeat: RepeatMode = RepeatMode.OFF,
  val positionMs: Long = 0L,
  val durationMs: Long = 0L,
  val error: String? = null,
) {
  val current: TrackSummary? get() = queue.getOrNull(index)
  val hasNext: Boolean get() = index < queue.size - 1
}

enum class RepeatMode { OFF, ALL, ONE }

object PlayerBus {
  private val _state = MutableStateFlow(PlayerUiState())
  val state: StateFlow<PlayerUiState> = _state

  fun update(transform: (PlayerUiState) -> PlayerUiState) {
    _state.value = transform(_state.value)
  }

  fun reset() {
    _state.value = PlayerUiState()
  }
}
