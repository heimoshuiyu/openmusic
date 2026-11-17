package dev.hmsy.openmusic.player

import org.junit.Assert.assertEquals
import org.junit.Test

class PlayModeTest {

  @Test
  fun `state mapping covers orthogonal shuffle-repeat combos`() {
    // 顺序：shuffle=false + OFF
    assertEquals(PlayMode.SEQUENCE, PlayerUiState(shuffle = false, repeat = RepeatMode.OFF).playMode())
    // 列表循环：shuffle=false + ALL
    assertEquals(PlayMode.LIST_LOOP, PlayerUiState(shuffle = false, repeat = RepeatMode.ALL).playMode())
    // 单曲循环：ONE 优先于 shuffle
    assertEquals(PlayMode.ONE_LOOP, PlayerUiState(shuffle = false, repeat = RepeatMode.ONE).playMode())
    assertEquals(PlayMode.ONE_LOOP, PlayerUiState(shuffle = true, repeat = RepeatMode.ONE).playMode())
    // 随机：shuffle 覆盖 ALL/OFF
    assertEquals(PlayMode.SHUFFLE, PlayerUiState(shuffle = true, repeat = RepeatMode.ALL).playMode())
    assertEquals(PlayMode.SHUFFLE, PlayerUiState(shuffle = true, repeat = RepeatMode.OFF).playMode())
  }

  @Test
  fun `cycle visits all four modes in order and wraps`() {
    assertEquals(PlayMode.LIST_LOOP, PlayMode.SEQUENCE.next())
    assertEquals(PlayMode.ONE_LOOP, PlayMode.LIST_LOOP.next())
    assertEquals(PlayMode.SHUFFLE, PlayMode.ONE_LOOP.next())
    assertEquals(PlayMode.SEQUENCE, PlayMode.SHUFFLE.next())
  }

  @Test
  fun `labels are distinct`() {
    assertEquals(4, PlayMode.entries.map { it.label }.toSet().size)
  }
}
