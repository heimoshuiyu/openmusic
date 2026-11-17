package dev.hmsy.openmusic.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.hmsy.openmusic.core.Om
import dev.hmsy.openmusic.core.OmType
import dev.hmsy.openmusic.data.AlbumSummary
import dev.hmsy.openmusic.data.ArtistSummary

/** 专辑卡片（Apple Music 横向滑架用）：封面主导 + 标题 + 艺人 */
@Composable
fun AlbumCard(album: AlbumSummary, onClick: () -> Unit, modifier: Modifier = Modifier) {
  Column(
    modifier = modifier
      .width(150.dp)
      .clickable(onClick = onClick),
  ) {
    CoverArt(
      albumId = album.id,
      name = album.name,
      hasCover = album.hasCoverArt,
      cornerRadiusDp = 1,
      modifier = Modifier
        .fillMaxWidth()
        .aspectRatio(1f),
    )
    Spacer(Modifier.height(8.dp))
    Text(
      album.name,
      style = OmType.Row,
      color = Om.Paper,
      maxLines = 1,
      overflow = TextOverflow.Ellipsis,
      modifier = Modifier.padding(horizontal = 1.dp),
    )
    Text(
      album.artist.name,
      style = OmType.Meta,
      color = Om.Dim,
      maxLines = 1,
      overflow = TextOverflow.Ellipsis,
      modifier = Modifier.padding(horizontal = 1.dp),
    )
  }
}

/** 艺人行（列表）：圆形头像 + 名字 + 计数 */
@Composable
fun ArtistRow(artist: ArtistSummary, onClick: () -> Unit, modifier: Modifier = Modifier) {
  Row(
    modifier = modifier
      .fillMaxWidth()
      .clickable(onClick = onClick)
      .padding(horizontal = 16.dp, vertical = 8.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    ArtistCover(
      artistId = artist.id,
      name = artist.name,
      hasCover = artist.hasCoverArt,
      modifier = Modifier.size(48.dp).clip(CircleShape),
    )
    Spacer(Modifier.width(14.dp))
    Column(Modifier.weight(1f)) {
      Text(artist.name, style = OmType.Row, color = Om.Paper, maxLines = 1, overflow = TextOverflow.Ellipsis)
      Text(
        "${artist.albumCount} 张专辑 · ${artist.trackCount} 首",
        style = OmType.Meta,
        color = Om.Faint,
        maxLines = 1,
      )
    }
  }
}

/** 播放列表行：程序化封面（pl- 种子）+ 名字 + 计数 */
@Composable
fun PlaylistCoverRow(
  playlistId: String,
  name: String,
  songCount: Int,
  onClick: () -> Unit,
  modifier: Modifier = Modifier,
) {
  Row(
    modifier = modifier
      .fillMaxWidth()
      .clickable(onClick = onClick)
      .padding(horizontal = 16.dp, vertical = 8.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Box(Modifier.size(48.dp).clip(androidx.compose.foundation.shape.RoundedCornerShape(6.dp))) {
      ProgrammaticCover(seed = "pl-$playlistId", name = name, monogram = true, modifier = Modifier.size(48.dp))
    }
    Spacer(Modifier.width(14.dp))
    Column(Modifier.weight(1f)) {
      Text(name, style = OmType.Row, color = Om.Paper, maxLines = 1, overflow = TextOverflow.Ellipsis)
      Text("$songCount 首", style = OmType.Meta, color = Om.Faint, maxLines = 1)
    }
  }
}

/** 分区标题：标题 + 计数（读数）+ 可选动作 */
@Composable
fun SectionHeader(
  title: String,
  count: Int? = null,
  modifier: Modifier = Modifier,
  action: (@Composable () -> Unit)? = null,
) {
  Column(modifier.fillMaxWidth().padding(horizontal = 16.dp)) {
  Box(Modifier.fillMaxWidth().height(1.dp).background(Om.Line))
  Row(
    modifier = Modifier.fillMaxWidth().padding(vertical = 10.dp),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(8.dp),
  ) {
    Text(title, style = OmType.Title, color = Om.Paper)
    if (count != null) Text("$count", style = OmType.Readout, color = Om.Faint)
    Spacer(Modifier.weight(1f))
    action?.invoke()
  }
  }
}
