package dev.hmsy.openmusic.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import androidx.compose.ui.unit.dp
import coil3.compose.AsyncImage
import dev.hmsy.openmusic.OpenMusicApp
import dev.hmsy.openmusic.core.InterFamily
import dev.hmsy.openmusic.core.Om
import kotlin.math.min

/** id → 确定性散列（与 web cover.tsx 同算法：djb2 变体） */
private fun hashOf(id: String): Long {
  var h = 5381L
  for (c in id) h = ((h * 33) xor c.code.toLong()) and 0xFFFFFFFFL
  return h
}

private fun hsl(h: Int, s: Float, l: Float, alpha: Float = 1f): Color =
  Color.hsl(h.toFloat(), s, l, alpha)

/**
 * 程序化占位封面（与 web 同视觉）：柔和双色渐变 + 微弱环形纹 + 首字。
 * 颜色由 id 确定性生成——同一专辑恒定、不同专辑可辨。
 */
@Composable
fun ProgrammaticCover(seed: String, name: String, monogram: Boolean, modifier: Modifier = Modifier) {
  val h = hashOf(seed)
  val hue = (h % 360).toInt()
  val hue2 = (hue + 40 + (h % 50).toInt()) % 360
  val tiltRad = Math.toRadians((100 + (h % 80)).toDouble())
  val cx = 50f + ((h shr 3) % 9).toInt() - 4
  val cy = 50f + ((h shr 5) % 9).toInt() - 4
  val initial = name.trim().firstOrNull()?.toString() ?: "♪"

  BoxWithConstraints(modifier) {
    val sizePx = with(LocalDensity.current) { maxWidth.toPx() }
    val dir = Offset(tiltRad.cos().toFloat(), tiltRad.sin().toFloat())
    val center = Offset(sizePx * cx / 100f, sizePx * cy / 100f)

    androidx.compose.foundation.Canvas(modifier = Modifier.fillMaxSize()) {
      drawRect(
        Brush.linearGradient(
          colors = listOf(hsl(hue, 0.26f, 0.30f), hsl(hue2, 0.30f, 0.16f)),
          start = center - dir * sizePx,
          end = center + dir * sizePx,
        ),
      )
      val rings = listOf(44f, 34f, 24f)
      rings.forEachIndexed { i, r ->
        drawCircle(
          color = hsl(hue2, 0.22f, 0.70f, (0.10f - i * 0.025f)),
          radius = sizePx * r / 200f,
          center = center,
          style = Stroke(width = sizePx * 0.007f),
        )
      }
    }
    if (monogram) {
      val fontSize = with(LocalDensity.current) {
        val m = if (maxWidth < maxHeight) maxWidth else maxHeight
        m.toSp() * 0.30f
      }
      androidx.compose.foundation.layout.Box(
        modifier = Modifier.fillMaxSize(),
        contentAlignment = androidx.compose.ui.Alignment.Center,
      ) {
        androidx.compose.material3.Text(
          text = initial,
          style = androidx.compose.ui.text.TextStyle(
            fontFamily = InterFamily,
            fontWeight = FontWeight.SemiBold,
            fontSize = fontSize,
            color = hsl(hue, 0.25f, 0.82f, 0.85f),
          ),
        )
      }
    }
  }
}

/**
 * 封面统一出口：真封面（Coil + cookie 会话）优先，否则程序化占位——网格永远有色彩层次。
 * 曲目场景传 trackId：tr- 端点一次解析「自身内嵌 → 专辑链（文件夹→兄弟内嵌）」的精确
 * 封面，失败回退 al- 专辑统一封面，再回退程序化占位（任何一步不得白屏）。
 */
@Composable
fun CoverArt(
  albumId: String,
  name: String,
  hasCover: Boolean,
  modifier: Modifier = Modifier,
  trackId: String? = null,
  monogram: Boolean = true,
  cornerRadiusDp: Int = 0,
) {
  // 0 = tr-（有 trackId 才起步），1 = al-，2 = 程序化
  var stage by remember(albumId, trackId) { mutableStateOf(if (trackId != null) 0 else 1) }
  val shape = if (cornerRadiusDp > 0) RoundedCornerShape(cornerRadiusDp.dp) else RoundedCornerShape(0.dp)
  Box(modifier = modifier.clip(shape).background(Om.Raised)) {
    when {
      !hasCover && trackId == null -> ProgrammaticCover(seed = albumId, name = name, monogram = monogram, modifier = Modifier.fillMaxSize())
      !hasCover -> ProgrammaticCover(seed = trackId ?: albumId, name = name, monogram = monogram, modifier = Modifier.fillMaxSize())
      stage <= 0 -> AsyncImage(
        model = OpenMusicApp.api.trackCoverUrl(trackId!!),
        contentDescription = name,
        contentScale = ContentScale.Crop,
        onState = { state -> if (state is coil3.compose.AsyncImagePainter.State.Error) stage = 1 },
        modifier = Modifier.fillMaxSize(),
      )
      stage == 1 -> AsyncImage(
        model = OpenMusicApp.api.albumCoverUrl(albumId),
        contentDescription = name,
        contentScale = ContentScale.Crop,
        onState = { state -> if (state is coil3.compose.AsyncImagePainter.State.Error) stage = 2 },
        modifier = Modifier.fillMaxSize(),
      )
      else -> ProgrammaticCover(seed = albumId, name = name, monogram = monogram, modifier = Modifier.fillMaxSize())
    }
  }
}

/** 艺人封面（ar- 前缀，圆形用） */
@Composable
fun ArtistCover(
  artistId: String,
  name: String,
  hasCover: Boolean,
  modifier: Modifier = Modifier,
  cornerRadiusDp: Int = 0,
) {
  val shape = if (cornerRadiusDp > 0) RoundedCornerShape(cornerRadiusDp.dp) else RoundedCornerShape(0.dp)
  Box(modifier = modifier.clip(shape).background(Om.Raised)) {
    if (hasCover) {
      AsyncImage(
        model = OpenMusicApp.api.artistCoverUrl(artistId),
        contentDescription = name,
        contentScale = ContentScale.Crop,
        modifier = Modifier.fillMaxSize(),
      )
    } else {
      ProgrammaticCover(seed = "ar-$artistId", name = name, monogram = true, modifier = Modifier.fillMaxSize())
    }
  }
}

/**
 * 曲目封面（不带 hasCoverArt 的便捷出口）：tr- 曲目精确封面 → al- 专辑统一封面 →
 * 程序化占位，分级回退。hasCoverArt 语义（2026-09 起）= 自身内嵌 OR 专辑有任何封面。
 */
@Composable
fun TrackCover(
  albumId: String,
  albumName: String,
  modifier: Modifier = Modifier,
  trackId: String? = null,
  cornerRadiusDp: Int = 0,
  monogram: Boolean = true,
) {
  var stage by remember(albumId, trackId) { mutableStateOf(if (trackId != null) 0 else 1) }
  val shape = if (cornerRadiusDp > 0) RoundedCornerShape(cornerRadiusDp.dp) else RoundedCornerShape(0.dp)
  Box(modifier = modifier.clip(shape).background(Om.Raised)) {
    when {
      stage <= 0 -> AsyncImage(
        model = OpenMusicApp.api.trackCoverUrl(trackId!!),
        contentDescription = albumName,
        contentScale = ContentScale.Crop,
        onState = { state -> if (state is coil3.compose.AsyncImagePainter.State.Error) stage = 1 },
        modifier = Modifier.fillMaxSize(),
      )
      stage == 1 -> AsyncImage(
        model = OpenMusicApp.api.albumCoverUrl(albumId),
        contentDescription = albumName,
        contentScale = ContentScale.Crop,
        onState = { state -> if (state is coil3.compose.AsyncImagePainter.State.Error) stage = 2 },
        modifier = Modifier.fillMaxSize(),
      )
      else -> ProgrammaticCover(seed = albumId, name = albumName, monogram = monogram, modifier = Modifier.fillMaxSize())
    }
  }
}

private fun Double.cos() = kotlin.math.cos(this)
private fun Double.sin() = kotlin.math.sin(this)
