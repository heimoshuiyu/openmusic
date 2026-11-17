package dev.hmsy.openmusic.ui.player

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.hmsy.openmusic.core.Om
import dev.hmsy.openmusic.core.OmType
import dev.hmsy.openmusic.data.formatDuration
import dev.hmsy.openmusic.player.PlayerUiState
import dev.hmsy.openmusic.ui.components.TrackCover
import dev.hmsy.openmusic.ui.icons.OmIcons

/**
 * MiniPlayer：底部导航上方的悬浮卡（panel 圆角 + 顶部红发丝进度）。
 * 点按任意处展开正在播放；右侧传送只留 播放/暂停 + 下一首。
 */
@Composable
fun MiniPlayer(
  state: PlayerUiState,
  onOpen: () -> Unit,
  onToggle: () -> Unit,
  onNext: () -> Unit,
  modifier: Modifier = Modifier,
) {
  val track = state.current ?: return
  val pct = if (state.durationMs > 0) (state.positionMs.toFloat() / state.durationMs).coerceIn(0f, 1f) else 0f

  Box(modifier = modifier.fillMaxWidth()) {
    Column(
      Modifier
        .fillMaxWidth()
        .background(Om.Panel)
        .clickable(onClick = onOpen),
    ) {
      // 通栏发丝进度
      Box(Modifier.fillMaxWidth().height(2.dp).background(Om.Line.copy(alpha = 0.6f))) {
        Box(Modifier.fillMaxWidth(pct).height(2.dp).background(Om.Accent))
      }
      Row(
        Modifier.padding(horizontal = 10.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        TrackCover(
          albumId = track.album.id,
          albumName = track.album.name,
          trackId = track.id,
          cornerRadiusDp = 5,
          modifier = Modifier.size(42.dp),
        )
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
          Text(
            track.title,
            style = OmType.Row,
            color = Om.Paper,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
          )
          Text(
            track.artist.name,
            style = OmType.Meta,
            color = Om.Dim,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
          )
        }
        IconButton(onClick = onToggle, modifier = Modifier.size(44.dp).background(Om.Paper)) {
          Icon(
            imageVector = if (state.isPlaying) OmIcons.Pause else OmIcons.Play,
            contentDescription = if (state.isPlaying) "暂停" else "播放",
            tint = Om.Shell,
            modifier = Modifier.size(26.dp),
          )
        }
        IconButton(onClick = onNext, modifier = Modifier.size(44.dp)) {
          Icon(
            imageVector = OmIcons.SkipForward,
            contentDescription = "下一首",
            tint = Om.Paper,
            modifier = Modifier.size(22.dp),
          )
        }
      }
    }
  }
}
