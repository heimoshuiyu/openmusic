package dev.hmsy.openmusic.ui.icons

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.dp

/**
 * 手工移植 lucide 线性图标（Web 端同款，MIT）——保持跨端视觉血统。
 * 24×24 viewport，stroke 1.75（与 web strokeWidth=1.75 一致），圆角端点。
 * tint 经 Icon() 的 ColorFilter 替换，颜色写死 Black 无所谓。
 */
object OmIcons {

  private fun parse(d: String) = addPathNodes(d)

  private fun stroke(name: String, vararg ds: String): ImageVector =
    ImageVector.Builder(name = name, defaultWidth = 24.dp, defaultHeight = 24.dp, viewportWidth = 24f, viewportHeight = 24f).apply {
      ds.forEachIndexed { i, d ->
        addPath(
          pathData = parse(d),
          name = "p$i",
          stroke = SolidColor(Color.Black), strokeLineWidth = 1.75f,
          strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round,
        )
      }
    }.build()

  private fun fill(name: String, vararg ds: String): ImageVector =
    ImageVector.Builder(name = name, defaultWidth = 24.dp, defaultHeight = 24.dp, viewportWidth = 24f, viewportHeight = 24f).apply {
      ds.forEachIndexed { i, d ->
        addPath(pathData = parse(d), name = "p$i", fill = SolidColor(Color.Black))
      }
    }.build()

  private val SolidBlack = Color.Black

  // ── 导航 ──────────────────────────────────────────────
  val House by lazy { stroke("house", "M15 21v-8a1 1 0 0 0 -1 -1h-4a1 1 0 0 0 -1 1v8", "M3 10a2 2 0 0 1 0.71 -1.53l7 -6a2 2 0 0 1 2.58 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1 -2 2H5a2 2 0 0 1 -2 -2z") }
  val Disc by lazy { stroke("disc", "M12 22a10 10 0 1 0 0 -20 10 10 0 0 0 0 20z", "M12 14a2 2 0 1 0 0 -4 2 2 0 0 0 0 4z") }
  val Search by lazy { stroke("search", "M11 19a8 8 0 1 0 0 -16 8 8 0 0 0 0 16z", "m21 21 -4.3 -4.3") }
  val Heart by lazy { stroke("heart", "M19 14c1.49 -1.46 3 -3.21 3 -5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0 -3 0.5 -4.5 2 -1.5 -1.5 -2.74 -2 -4.5 -2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.51 4.04 3 5.5l7 7z") }
  val HeartFilled by lazy { fill("heart-filled", "M19 14c1.49 -1.46 3 -3.21 3 -5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0 -3 0.5 -4.5 2 -1.5 -1.5 -2.74 -2 -4.5 -2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.51 4.04 3 5.5l7 7z") }

  // ── 传送 ──────────────────────────────────────────────
  val Play by lazy { fill("play", "M6 4.5v15a0.5 0.5 0 0 0 0.77 0.42l12 -7.5a0.5 0.5 0 0 0 0 -0.84l-12 -7.5A0.5 0.5 0 0 0 6 4.5z") }
  val Pause by lazy { fill("pause", "M7 4h2.5a0.5 0.5 0 0 1 0.5 0.5v15a0.5 0.5 0 0 1 -0.5 0.5H7a0.5 0.5 0 0 1 -0.5 -0.5v-15A0.5 0.5 0 0 1 7 4z", "M14.5 4H17a0.5 0.5 0 0 1 0.5 0.5v15a0.5 0.5 0 0 1 -0.5 0.5h-2.5a0.5 0.5 0 0 1 -0.5 -0.5v-15a0.5 0.5 0 0 1 0.5 -0.5z") }
  val SkipBack by lazy { fill("skip_back", "M19 20 9.53 12.36a0.5 0.5 0 0 1 0 -0.72L19 4z", "M5.5 19.2V4.8a0.5 0.5 0 0 1 1 -0v14.4a0.5 0.5 0 0 1 -1 0z") }
  val SkipForward by lazy { fill("skip_forward", "M5 4l9.47 7.64a0.5 0.5 0 0 1 0 0.72L5 20z", "M17.5 4.8v14.4a0.5 0.5 0 0 0 1 0V4.8a0.5 0.5 0 0 0 -1 0z") }
  val Shuffle by lazy { stroke("shuffle", "M2 18h1.4c1.3 0 2.5 -0.6 3.3 -1.7l6.1 -8.6C13.6 6.6 14.8 6 16.1 6H22", "m18 2 4 4 -4 4", "M2 6h1.9c1.5 0 2.9 0.9 3.6 2.2", "M22 18h-5.9c-1.3 0 -2.6 -0.7 -3.3 -1.8l-0.5 -0.8", "m18 14 4 4 -4 4") }
  val Repeat by lazy { stroke("repeat", "m17 2 4 4 -4 4", "M3 11v-1a4 4 0 0 1 4 -4h14", "m7 22 -4 -4 4 -4", "M21 13v1a4 4 0 0 1 -4 4H3") }
  val RepeatOne by lazy { stroke("repeat_one", "m17 2 4 4 -4 4", "M3 11v-1a4 4 0 0 1 4 -4h14", "m7 22 -4 -4 4 -4", "M21 13v1a4 4 0 0 1 -4 4H3", "M11 10h1v4") }
  val ListMusic by lazy { stroke("list_music", "M21 15V6", "M18.5 18a2.5 2.5 0 1 0 0 -5 2.5 2.5 0 0 0 0 5z", "M12 12V3", "M10.5 15a2.5 2.5 0 1 0 0 -5 2.5 2.5 0 0 0 0 5z", "M3 14v-2a2 2 0 0 1 2 -2h4") }

  // ── 通用 ──────────────────────────────────────────────
  val ChevronRight by lazy { stroke("chevron_right", "m9 18 6 -6 -6 -6") }
  val ChevronLeft by lazy { stroke("chevron_left", "m15 18 -6 -6 6 -6") }
  val ChevronDown by lazy { stroke("chevron_down", "m6 9 6 6 6 -6") }
  val ChevronUp by lazy { stroke("chevron_up", "m18 15 -6 -6 -6 6") }
  val X by lazy { stroke("x", "M18 6 6 18", "m6 6 12 12") }
  val Plus by lazy { stroke("plus", "M5 12h14", "M12 5v14") }
  val MoreVertical by lazy { stroke("more_vertical", "M12 5.5h0.01", "M12 12h0.01", "M12 18.5h0.01") }
  val Settings2 by lazy { stroke("settings_2", "M20 7h-9", "M14 17H5", "M17 20a3 3 0 1 0 0 -6 3 3 0 0 0 0 6z", "M7 10a3 3 0 1 0 0 -6 3 3 0 0 0 0 6z") }
  val Mic2 by lazy { stroke("mic2", "M12 2a3 3 0 0 0 -3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0 -3 -3z", "M19 10v2a7 7 0 0 1 -14 0v-2", "M12 19v3") }
  val Refresh by lazy { stroke("refresh", "M21 12a9 9 0 1 1 -2.64 -6.36", "M21 3v6h-6") }
  val Logout by lazy { stroke("logout", "M9 21H5a2 2 0 0 1 -2 -2V5a2 2 0 0 1 2 -2h4", "m16 17 5 -5 -5 -5", "M21 12H9") }
  val PlayCircle by lazy { stroke("play_circle", "M12 22a10 10 0 1 0 0 -20 10 10 0 0 0 0 20z", "M10 8.5l6 3.5 -6 3.5z") }
  val Trash2 by lazy { stroke("trash2", "M3 6h18", "M19 6v14a2 2 0 0 1 -2 2H7a2 2 0 0 1 -2 -2V6", "M8 6V4a2 2 0 0 1 2 -2h4a2 2 0 0 1 2 2v2", "M10 11v6", "M14 11v6") }

  // ── 音乐助手 ──────────────────────────────────────────
  val Bot by lazy { stroke("bot", "M12 8V4H8", "M4 10a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2H6a2 2 0 0 1 -2 -2z", "M2 14h2", "M20 14h2", "M15 13v2", "M9 13v2") }
  val Send by lazy { stroke("send", "M14.536 21.686a.5.5 0 0 0 .937 -.024l6.5 -19a.496.496 0 0 0 -.635 -.635l-19 6.5a.5.5 0 0 0 -.024 .937l7.93 3.18a2 2 0 0 1 1.112 1.11z", "m21.854 2.147 -10.94 10.939") }
  val Square by lazy { stroke("square", "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2H5a2 2 0 0 1 -2 -2V5a2 2 0 0 1 2 -2z") }
  val Wrench by lazy { stroke("wrench", "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.106 -3.105c.32 -.322 .863 -.22 .983 .218a6 6 0 0 1 -8.259 7.057l-7.91 7.91a1 1 0 0 1 -2.999 -3l7.91 -7.91a6 6 0 0 1 7.057 -8.259c.438 .12 .54 .662 .219 .984z") }
  val Check by lazy { stroke("check", "M20 6 9 17l-5 -5") }
  val CircleAlert by lazy { stroke("circle_alert", "M12 22a10 10 0 1 0 0 -20 10 10 0 0 0 0 20z", "M12 8v4", "M12 16h0.01") }
  val Layers by lazy { stroke("layers", "M12.83 2.18a2 2 0 0 0 -1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58 -3.9a1 1 0 0 0 0 -1.83z", "M2 12a1 1 0 0 0 .58 .91l8.6 3.91a2 2 0 0 0 1.65 0l8.58 -3.9A1 1 0 0 0 22 12", "M2 17a1 1 0 0 0 .58 .91l8.6 3.91a2 2 0 0 0 1.65 0l8.58 -3.9A1 1 0 0 0 22 17") }
}
