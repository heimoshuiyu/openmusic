package dev.hmsy.openmusic.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.hmsy.openmusic.OpenMusicApp
import dev.hmsy.openmusic.core.Om
import dev.hmsy.openmusic.core.OmType
import dev.hmsy.openmusic.data.PlayEntry
import dev.hmsy.openmusic.data.formatDuration
import dev.hmsy.openmusic.data.formatTotal
import dev.hmsy.openmusic.player.PlayerBus
import dev.hmsy.openmusic.ui.UiActions
import dev.hmsy.openmusic.ui.components.AlbumCard
import dev.hmsy.openmusic.ui.components.EmptyView
import dev.hmsy.openmusic.ui.components.ErrorView
import dev.hmsy.openmusic.ui.components.LoadingView
import dev.hmsy.openmusic.ui.components.SectionHeader
import dev.hmsy.openmusic.ui.components.StarTrailing
import dev.hmsy.openmusic.ui.components.TrackRow
import dev.hmsy.openmusic.ui.components.rememberLoad
import dev.hmsy.openmusic.ui.icons.OmIcons
import kotlinx.coroutines.launch

/** 首页：最近添加 / 最常播放（滑架）+ 最近播放（随机入口） */
@Composable
fun HomeScreen(actions: UiActions) {
  val scope = rememberCoroutineScope()
  val (recentAlbums, _) = rememberLoad { OpenMusicApp.api.albums(limit = 12, sort = "-createdAt") }
  val (mostPlayed, _) = rememberLoad { OpenMusicApp.api.mostPlayedAlbums(12) }
  val (recentPlays, _) = rememberLoad { OpenMusicApp.api.recentTracks(12) }
  val (summary, _) = rememberLoad { OpenMusicApp.api.playSummary() }
  val bus by PlayerBus.state.collectAsState()

  LazyColumn(Modifier.fillMaxSize().statusBarsPadding(), contentPadding = PaddingValues(bottom = 20.dp)) {
    // 大标题 + 副题（累计收听读数）+ 设置入口
    item {
      Row(
        Modifier
          .fillMaxWidth()
          .padding(start = 16.dp, end = 8.dp, top = 14.dp, bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        Column(Modifier.weight(1f)) {
          dev.hmsy.openmusic.ui.components.CatalogWordmark()
        }
        androidx.compose.material3.IconButton(onClick = actions.openSettings) {
          Icon(OmIcons.Settings2, contentDescription = "设置", tint = Om.Dim, modifier = Modifier.size(20.dp))
        }
      }
      Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 18.dp)) {
        Text("我的音乐库", style = OmType.Headline, color = Om.Paper)
        val caption = listOfNotNull(recentAlbums.data?.let { "${it.total} 张专辑" }, summary.data?.takeIf { it.listenedSeconds > 0 }?.let { "累计收听 ${formatTotal(it.listenedSeconds)}" }).joinToString(" · ")
        if (caption.isNotEmpty()) Text(caption, style = OmType.Readout, color = Om.Dim, modifier = Modifier.padding(top = 6.dp))
      }
    }

    // 最近添加
    item {
      SectionHeader("最近添加", recentAlbums.data?.total)
      val albums = recentAlbums.data?.items
      when {
        albums == null && recentAlbums.error == null -> LoadingView()
        albums != null && albums.isNotEmpty() -> LazyRow(
          contentPadding = PaddingValues(horizontal = 16.dp),
          horizontalArrangement = Arrangement.spacedBy(14.dp),
        ) {
          items(albums, key = { it.id }) { album ->
            AlbumCard(album = album, onClick = { actions.openAlbum(album.id) })
          }
        }
      }
    }

    // 最常播放
    val most = mostPlayed.data?.map { it.album }
    if (!most.isNullOrEmpty()) {
      item {
        SectionHeader("最常播放", most.size, modifier = Modifier.padding(top = 26.dp))
        LazyRow(
          contentPadding = PaddingValues(horizontal = 16.dp),
          horizontalArrangement = Arrangement.spacedBy(14.dp),
        ) {
          items(most, key = { it.id }) { album ->
            AlbumCard(album = album, onClick = { actions.openAlbum(album.id) })
          }
        }
      }
    }

    // 最近播放 + 随机
    item {
      SectionHeader("最近播放", recentPlays.data?.size, modifier = Modifier.padding(top = 26.dp)) {
        Row(
          Modifier
            .clip(RoundedCornerShape(2.dp))
            .background(Om.Paper)
            .clickable {
              scope.launch {
                runCatching { OpenMusicApp.api.random(20) }.getOrNull()?.let {
                  actions.playNow(it, 0)
                }
              }
            }
            .padding(horizontal = 10.dp, vertical = 6.dp),
          verticalAlignment = Alignment.CenterVertically,
        ) {
          Icon(OmIcons.Shuffle, contentDescription = null, tint = Om.Shell, modifier = Modifier.size(14.dp))
          Spacer(Modifier.width(5.dp))
          Text("随机 20 首", style = OmType.Meta, color = Om.Shell)
        }
      }
    }

    val plays = recentPlays.data
    when {
      plays == null && recentPlays.error == null -> item { LoadingView() }
      plays != null && plays.isEmpty() -> item { EmptyView("还没有播放记录") }
      plays != null -> {
        // 播放队列/长按上下文只含活曲（墓碑不可播）；索引按活曲表换算
        val alive = plays.mapNotNull { it.track }
        itemsIndexed(plays, key = { i, e -> "$i-${e.track?.id ?: e.title}" }) { _, entry ->
          val track = entry.track
          if (track == null) {
            DeletedPlayRow(entry)
          } else {
            val index = alive.indexOfFirst { it.id == track.id }
            TrackRow(
              track = track,
              isCurrent = bus.current?.id == track.id,
              isPlaying = bus.isPlaying,
              onClick = { actions.playNow(alive, index) },
              onLongClick = { actions.trackActions(track, alive, index) },
              onVersions = { actions.pickVersion(track, alive, index) },
              trailing = { StarTrailing(track) },
            )
          }
        }
      }
    }

    if (recentPlays.error != null) item { ErrorView(recentPlays.error ?: "") }
  }
}

/** 墓碑行：曲目已不在库中（plays 事件快照，docs/04 §2.8）——灰显、不可播。
 *  列对齐与 TrackRow 一致（封面 44 + 间距 12 + 序号 22 + 间距 10）。 */
@Composable
private fun DeletedPlayRow(entry: PlayEntry) {
  Row(
    Modifier
      .fillMaxWidth()
      .padding(horizontal = 16.dp, vertical = 7.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    // 虚线空框 = 封面已无处可取；空即信息
    Box(
      Modifier
        .size(44.dp)
        .clip(RoundedCornerShape(4.dp))
        .border(1.dp, Om.Line, RoundedCornerShape(4.dp)),
    )
    Spacer(Modifier.width(34.dp))
    Column(Modifier.weight(1f)) {
      Row(verticalAlignment = Alignment.CenterVertically) {
        Text(
          entry.title,
          style = OmType.Row,
          color = Om.Dim,
          maxLines = 1,
          overflow = TextOverflow.Ellipsis,
          modifier = Modifier.weight(1f, fill = false),
        )
        Spacer(Modifier.width(8.dp))
        Text("已删除", style = OmType.Meta, color = Om.Faint)
      }
      Text(
        "${entry.artistName} · ${entry.albumName}",
        style = OmType.Meta,
        color = Om.Faint,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
      )
    }
    Spacer(Modifier.width(12.dp))
    Text(formatDuration(entry.durationSeconds.toInt()), style = OmType.Readout, color = Om.Dim)
  }
}
