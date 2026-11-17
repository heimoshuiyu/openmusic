package dev.hmsy.openmusic.ui.components

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import dev.hmsy.openmusic.core.Om

/**
 * 正在播放指示：三根跳动的杆（与 web eq-bounce 同语义——装饰必须是信息）。
 * playing=false 时静止在低水位。
 */
@Composable
fun EqBars(playing: Boolean, modifier: Modifier = Modifier, color: androidx.compose.ui.graphics.Color = Om.Accent) {
  val transition = rememberInfiniteTransition(label = "eq")
  val a by transition.animateFloat(
    initialValue = 0.35f, targetValue = 1f,
    animationSpec = infiniteRepeatable(tween(620, easing = LinearEasing), RepeatMode.Reverse),
    label = "a",
  )
  val b by transition.animateFloat(
    initialValue = 1f, targetValue = 0.3f,
    animationSpec = infiniteRepeatable(tween(540, easing = LinearEasing), RepeatMode.Reverse),
    label = "b",
  )
  val c by transition.animateFloat(
    initialValue = 0.55f, targetValue = 0.9f,
    animationSpec = infiniteRepeatable(tween(700, easing = LinearEasing), RepeatMode.Reverse),
    label = "c",
  )

  Canvas(modifier) {
    val barW = size.width / 5f
    val levels = if (playing) listOf(a, b, c) else listOf(0.3f, 0.22f, 0.3f)
    levels.forEachIndexed { i, level ->
      val h = size.height * level
      drawRoundRect(
        color = color,
        topLeft = Offset(barW * (i * 2 + 1), size.height - h),
        size = Size(barW, h),
        cornerRadius = CornerRadius(barW / 2f),
      )
    }
  }
}
