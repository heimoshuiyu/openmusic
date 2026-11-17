package dev.hmsy.openmusic.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import coil3.compose.AsyncImage
import dev.hmsy.openmusic.core.Om

/**
 * 全屏环境晕染的共享状态：当前屏幕声明封面 URL，根布局统一画在最底层——
 * 晕染因此能延伸到 MiniPlayer / 底部导航后面（屏内自画会在播放条上缘截断）。
 */
object Ambient {
  var coverUrl by mutableStateOf<String?>(null)
}

/** 屏幕侧声明：加载到封面时设置，离开屏幕自动清除 */
@Composable
fun SetAmbientCover(coverUrl: String?) {
  DisposableEffect(coverUrl) {
    Ambient.coverUrl = coverUrl
    onDispose { if (Ambient.coverUrl == coverUrl) Ambient.coverUrl = null }
  }
}

/** 封面全屏铺底 + 渐变压暗至近实色（Apple Music 招牌）。
 *  渐变从不全不透明——页面底部仍留一丝色，底栏区域才不会像另一块底。 */
@Composable
fun AmbientBackdrop(coverUrl: String?, modifier: Modifier = Modifier) {
  if (coverUrl == null) return
  Box(modifier.fillMaxSize()) {
    AsyncImage(
      model = coverUrl,
      contentDescription = null,
      contentScale = ContentScale.Crop,
      modifier = Modifier
        .fillMaxSize()
        .graphicsLayer { scaleX = 1.4f; scaleY = 1.4f; alpha = 0.35f },
    )
    Box(
      Modifier
        .fillMaxSize()
        .background(
          Brush.verticalGradient(
            0f to Om.Shell.copy(alpha = 0.55f),
            0.6f to Om.Shell.copy(alpha = 0.82f),
            1f to Om.Shell.copy(alpha = 0.96f),
          ),
        ),
    )
  }
}
