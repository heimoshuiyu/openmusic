package dev.hmsy.openmusic.ui.player

import androidx.activity.ComponentActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performTouchInput
import dev.hmsy.openmusic.data.AlbumRef
import dev.hmsy.openmusic.data.ArtistRef
import dev.hmsy.openmusic.data.TrackSummary
import dev.hmsy.openmusic.player.PlayerUiState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class NowPlayingSlideTest {
  @get:Rule val ui = createAndroidComposeRule<ComponentActivity>()

  @Test fun backgroundEdgeFollowsHeaderDuringDragReboundAndExit() {
    val visible = mutableStateOf(true)
    val track = TrackSummary("1", "Fixture", ArtistRef("2", "Artist"), AlbumRef("3", "Album"), durationSeconds = 30)
    val player = PlayerUiState(queue = listOf(track), index = 0)
    ui.setContent {
      Box(Modifier.fillMaxSize().background(Color.Magenta)) {
        NowPlayingSheet(visible.value, player, { visible.value = false }, {}, {}, {}, {}, {}, {}, {}, {})
      }
    }
    val root = ui.onRoot()
    val header = ui.onNodeWithText("正在播放")
    fun headerY() = header.fetchSemanticsNode().boundsInRoot.top
    val initial = headerY()
    // Compare real rendered pixels to the text bounds rather than checking an animation target.
    fun assertTogether(): Float {
      val dy = headerY() - initial
      val pixels = root.captureToImage().toPixelMap()
      val edge = (0 until pixels.height).first { pixels[pixels.width / 2, it].toArgb() != Color.Magenta.toArgb() }
      assertEquals(dy, edge.toFloat(), 2f)
      return dy
    }
    ui.mainClock.autoAdvance = false
    fun hold(distance: Float) {
      root.performTouchInput {
        down(Offset(width * .5f, height * .16f))
        moveBy(Offset(0f, distance / 2f)); moveBy(Offset(0f, distance / 2f))
      }
      ui.mainClock.advanceTimeByFrame()
    }
    hold(200f)
    val short = assertTogether()
    assertTrue(short > 0)
    root.performTouchInput { up() }
    ui.mainClock.advanceTimeBy(48)
    assertTrue(assertTogether() in 1f..short)
    ui.mainClock.advanceTimeBy(1000)
    assertEquals(initial, headerY(), 1f)

    hold(520f)
    val long = assertTogether()
    assertTrue(long > 420f)
    root.performTouchInput { up() }
    ui.mainClock.advanceTimeBy(64)
    assertTrue(assertTogether() > long)
    ui.mainClock.advanceTimeBy(1000)
    header.assertDoesNotExist()
    val closed = root.captureToImage().toPixelMap()
    assertEquals(Color.Magenta.toArgb(), closed[closed.width / 2, closed.height - 1].toArgb())
  }
}
