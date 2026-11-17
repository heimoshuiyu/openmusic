package dev.hmsy.openmusic.ui.components

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.hmsy.openmusic.core.Om
import dev.hmsy.openmusic.core.OmType
import dev.hmsy.openmusic.data.TrackSummary
import dev.hmsy.openmusic.data.formatDuration
import dev.hmsy.openmusic.ui.icons.OmIcons

/**
 * 曲目行：[封面?] [序号/eq] 标题 [×N?] / 艺人·专辑 …… 时长(读数) [尾部插槽]
 * 当前曲：标题红 + eq 跳动——「红=声音正在发生」。
 * ×N 徽标 = 同一首歌有 N 份物理拷贝（canonical 去重后仍保留的选择面），点击选版本。
 * 尾部插槽：收藏心（StarOverlay 乐观）或播放列表移除 ×，由调用方决定。
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun TrackRow(
  track: TrackSummary,
  isCurrent: Boolean,
  isPlaying: Boolean,
  modifier: Modifier = Modifier,
  index: Int? = null,
  showCover: Boolean = true,
  showAlbum: Boolean = true,
  showArtist: Boolean = true,
  onClick: () -> Unit = {},
  onLongClick: () -> Unit = {},
  onVersions: ((TrackSummary) -> Unit)? = null,
  trailing: (@Composable () -> Unit)? = null,
) {
  Row(
    modifier = modifier
      .combinedClickable(onClick = onClick, onLongClick = onLongClick)
      .padding(horizontal = 16.dp, vertical = 7.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    if (showCover) {
      TrackCover(
        albumId = track.album.id,
        albumName = track.album.name,
        trackId = track.id,
        cornerRadiusDp = 4,
        modifier = Modifier.size(44.dp),
      )
      Spacer(Modifier.width(12.dp))
    }
    // 序号 / eq
    Row(Modifier.width(if (showCover) 22.dp else 30.dp), verticalAlignment = Alignment.CenterVertically) {
      if (isCurrent) {
        EqBars(playing = isPlaying, modifier = Modifier.size(width = 14.dp, height = 14.dp))
      } else if (index != null) {
        Text("$index", style = OmType.Readout, color = Om.Faint)
      }
    }
    Spacer(Modifier.width(10.dp))
    Column(Modifier.weight(1f)) {
      Text(
        track.title,
        style = OmType.Row,
        color = if (isCurrent) Om.Accent else Om.Paper,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
      )
      val second = buildString {
        if (showArtist) append(track.artist.name)
        if (showAlbum) {
          if (isNotEmpty()) append(" · ")
          append(track.album.name)
        }
      }
      Text(second, style = OmType.Meta, color = if (isCurrent) Om.Dim else Om.Dim, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
    Spacer(Modifier.width(8.dp))
    val versions = track.versionCount ?: 1
    if (versions > 1) {
      Text(
        "×$versions",
        style = OmType.Readout,
        color = if (onVersions != null) Om.Dim else Om.Faint,
        modifier = Modifier
          .clip(RoundedCornerShape(3.dp))
          .background(Om.Raised)
          .clickable(enabled = onVersions != null) { onVersions?.invoke(track) }
          .padding(horizontal = 5.dp, vertical = 1.dp),
      )
      Spacer(Modifier.width(8.dp))
    }
    Text(
      formatDuration(track.durationSeconds),
      style = OmType.Readout,
      color = Om.Dim,
    )
    if (trailing != null) {
      Spacer(Modifier.width(6.dp))
      trailing()
    }
  }
}

/** 尾部插槽：收藏心（乐观） */
@Composable
fun StarTrailing(track: TrackSummary, onChanged: () -> Unit = {}) {
  val context = androidx.compose.ui.platform.LocalContext.current
  val starred = dev.hmsy.openmusic.ui.StarOverlay.rememberStarred(track.id, track.starred)
  Box(
    modifier = Modifier
      .size(32.dp)
      .clickable {
        dev.hmsy.openmusic.ui.StarOverlay.toggle(
          track.id,
          starred,
          "tracks",
          onError = { android.widget.Toast.makeText(context, "操作失败", android.widget.Toast.LENGTH_SHORT).show() },
          onChanged = onChanged,
        )
      },
    contentAlignment = Alignment.Center,
  ) {
    Icon(
      imageVector = if (starred) OmIcons.HeartFilled else OmIcons.Heart,
      contentDescription = if (starred) "取消收藏" else "收藏",
      tint = if (starred) Om.Accent else Om.Faint,
      modifier = Modifier.size(16.dp),
    )
  }
}
