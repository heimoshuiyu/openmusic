package dev.hmsy.openmusic.ui.player

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.hmsy.openmusic.core.Om
import dev.hmsy.openmusic.core.OmType
import dev.hmsy.openmusic.data.formatDuration
import dev.hmsy.openmusic.player.PlayerUiState
import dev.hmsy.openmusic.ui.components.CoverArt
import dev.hmsy.openmusic.ui.components.EqBars
import dev.hmsy.openmusic.ui.icons.OmIcons

/** 播放队列：当前曲红标 + eq，点按跳转，×移除，顶部清空 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun QueueSheet(
  visible: Boolean,
  state: PlayerUiState,
  onDismiss: () -> Unit,
  onJump: (Int) -> Unit,
  onRemove: (Int) -> Unit,
  onClear: () -> Unit,
) {
  if (!visible) return
  ModalBottomSheet(onDismissRequest = onDismiss, containerColor = Om.Panel) {
    Column {
      Row(
        Modifier
          .fillMaxWidth()
          .padding(horizontal = 20.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        Text("播放队列", style = OmType.Title, color = Om.Paper)
        Spacer(Modifier.width(8.dp))
        Text("${state.queue.size}", style = OmType.Readout, color = Om.Faint)
        Spacer(Modifier.weight(1f))
        TextButton(onClick = { onClear(); onDismiss() }) {
          Text("清空", style = OmType.Meta, color = Om.Faint)
        }
      }
      LazyColumn(Modifier.padding(bottom = 28.dp)) {
        itemsIndexed(state.queue, key = { i, t -> "$i-${t.id}" }) { i, track ->
          val isCurrent = i == state.index
          Row(
            Modifier
              .fillMaxWidth()
              .clickable { onJump(i) }
              .padding(horizontal = 20.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
          ) {
            CoverArt(
              albumId = track.album.id,
              name = track.album.name,
              hasCover = track.hasCoverArt,
              trackId = track.id,
              cornerRadiusDp = 4,
              modifier = Modifier.size(40.dp),
            )
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
              Text(
                track.title,
                style = OmType.Row,
                color = if (isCurrent) Om.Accent else Om.Paper,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
              )
              Text(track.artist.name, style = OmType.Meta, color = Om.Dim, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Spacer(Modifier.width(10.dp))
            if (isCurrent) {
              EqBars(playing = state.isPlaying, modifier = Modifier.size(width = 14.dp, height = 14.dp))
              Spacer(Modifier.width(8.dp))
            }
            Text(formatDuration(track.durationSeconds), style = OmType.Readout, color = Om.Faint)
            Spacer(Modifier.width(6.dp))
            Icon(
              OmIcons.X,
              contentDescription = "移除",
              tint = Om.Faint,
              modifier = Modifier
                .size(28.dp)
                .clickable(onClick = { onRemove(i) })
                .padding(6.dp),
            )
          }
        }
      }
    }
  }
}
