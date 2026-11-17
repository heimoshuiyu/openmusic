package dev.hmsy.openmusic.player

/**
 * 通知栏"播放模式"按钮的四态循环（对齐网易云系单按钮心智）：
 * 顺序 → 列表循环 → 单曲循环 → 随机 → 顺序
 *
 * 与播放器的 (shuffle, repeat) 正交状态映射：
 * - 顺序：shuffle=false + REPEAT_MODE_OFF
 * - 列表循环：shuffle=false + REPEAT_MODE_ALL
 * - 单曲循环：shuffle=false + REPEAT_MODE_ONE
 * - 随机：shuffle=true + REPEAT_MODE_ALL（随机下 OFF 会在播完一轮后停，ALL 才符合预期）
 */
enum class PlayMode { SEQUENCE, LIST_LOOP, ONE_LOOP, SHUFFLE }

/** 从播放状态反推模式；单曲循环优先于随机（ONE + shuffle 视作单曲循环） */
fun PlayerUiState.playMode(): PlayMode = when {
  repeat == RepeatMode.ONE -> PlayMode.ONE_LOOP
  shuffle -> PlayMode.SHUFFLE
  repeat == RepeatMode.ALL -> PlayMode.LIST_LOOP
  else -> PlayMode.SEQUENCE
}

fun PlayMode.next(): PlayMode = when (this) {
  PlayMode.SEQUENCE -> PlayMode.LIST_LOOP
  PlayMode.LIST_LOOP -> PlayMode.ONE_LOOP
  PlayMode.ONE_LOOP -> PlayMode.SHUFFLE
  PlayMode.SHUFFLE -> PlayMode.SEQUENCE
}

val PlayMode.label: String
  get() = when (this) {
    PlayMode.SEQUENCE -> "顺序播放"
    PlayMode.LIST_LOOP -> "列表循环"
    PlayMode.ONE_LOOP -> "单曲循环"
    PlayMode.SHUFFLE -> "随机播放"
  }
