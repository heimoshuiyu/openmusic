package dev.hmsy.openmusic.ui.screens

import androidx.activity.compose.LocalOnBackPressedDispatcherOwner
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.hmsy.openmusic.OpenMusicApp
import dev.hmsy.openmusic.core.Om
import dev.hmsy.openmusic.core.OmType
import dev.hmsy.openmusic.data.formatDuration
import dev.hmsy.openmusic.player.PlayerBus
import dev.hmsy.openmusic.ui.UiActions
import dev.hmsy.openmusic.ui.components.AlbumCard
import dev.hmsy.openmusic.ui.components.ArtistCover
import dev.hmsy.openmusic.ui.components.CoverArt
import dev.hmsy.openmusic.ui.components.DetailTopBar
import dev.hmsy.openmusic.ui.components.EmptyView
import dev.hmsy.openmusic.ui.components.ErrorView
import dev.hmsy.openmusic.ui.components.LoadingView
import dev.hmsy.openmusic.ui.components.ProgrammaticCover
import dev.hmsy.openmusic.ui.components.SectionHeader
import dev.hmsy.openmusic.ui.components.SetAmbientCover
import dev.hmsy.openmusic.ui.components.StarTrailing
import dev.hmsy.openmusic.ui.components.TrackRow
import dev.hmsy.openmusic.ui.components.rememberLoad
import dev.hmsy.openmusic.ui.icons.OmIcons
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** 主操作按钮：播放全部（红=交互） */
@Composable
private fun PlayAllButton(onClick: () -> Unit, modifier: Modifier = Modifier) {
  Row(
    modifier
      .clip(RoundedCornerShape(999.dp))
      .background(Om.Paper)
      .clickable(onClick = onClick)
      .padding(horizontal = 18.dp, vertical = 9.dp),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(6.dp),
  ) {
    Icon(OmIcons.Play, contentDescription = null, tint = Om.Shell, modifier = Modifier.size(14.dp))
    Text("播放全部", style = OmType.Row, color = Om.Shell)
  }
}

// ── 专辑 ──────────────────────────────────────────────
@Composable
fun AlbumScreen(id: String, actions: UiActions) {
  val back = LocalOnBackPressedDispatcherOwner.current?.onBackPressedDispatcher
  val (albumState, _) = rememberLoad { OpenMusicApp.api.album(id) }
  val (tracksState, _) = rememberLoad { OpenMusicApp.api.albumTracks(id) }
  val bus by PlayerBus.state.collectAsState()
  val album = albumState.data
  SetAmbientCover(album?.let { if (it.hasCoverArt) OpenMusicApp.api.albumCoverUrl(id) else null })

  Box(Modifier.fillMaxSize()) {

    when {
      album == null && albumState.error == null -> LoadingView(Modifier.align(Alignment.Center))
      // 专辑已不在（例如其中唯一曲目刚被移出曲库）：给出人话与可见的返回，而不是裸 404 死胡同
      album == null -> Column(Modifier.fillMaxSize()) {
        Box(Modifier.padding(horizontal = 12.dp)) { DetailTopBar("", onBack = { back?.onBackPressed() }) }
        Box(Modifier.weight(1f).fillMaxWidth()) {
          ErrorView("这张专辑已不在曲库中（可能它的曲目都已被移出）。", retry = null, modifier = Modifier.align(Alignment.Center))
        }
      }
      else -> LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 20.dp)) {
        item {
          Column(Modifier.padding(top = 6.dp)) {
            Box(Modifier.padding(horizontal = 12.dp)) {
              DetailTopBar("", onBack = { back?.onBackPressed() })
            }
            // 头部：封面 + 信息
            Row(
              Modifier
                .fillMaxWidth()
                .padding(horizontal = 20.dp, vertical = 8.dp),
              verticalAlignment = Alignment.Bottom,
            ) {
              CoverArt(
                albumId = album.id,
                name = album.name,
                hasCover = album.hasCoverArt,
                cornerRadiusDp = 10,
                modifier = Modifier
                  .size(140.dp)
                  .shadow(14.dp, RoundedCornerShape(10.dp), spotColor = Color.Black, ambientColor = Color.Black),
              )
              Spacer(Modifier.width(16.dp))
              Column(Modifier.weight(1f).padding(bottom = 2.dp)) {
                Text(album.name, style = OmType.Display, color = Om.Paper, maxLines = 3, overflow = TextOverflow.Ellipsis)
                Spacer(Modifier.height(6.dp))
                Text(album.artist.name, style = OmType.Body, color = Om.Dim, maxLines = 1, overflow = TextOverflow.Ellipsis)
                val meta = buildString {
                  album.year?.let { append(it) }
                  album.genre?.let { if (isNotEmpty()) append(" · "); append(it) }
                }
                if (meta.isNotEmpty()) {
                  Text(meta, style = OmType.Meta, color = Om.Faint, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                Text(
                  "${album.trackCount} 首 · ${formatDuration(album.durationSeconds)}",
                  style = OmType.Readout,
                  color = Om.Faint,
                )
              }
            }
            // 操作
            Row(
              Modifier
                .fillMaxWidth()
                .padding(horizontal = 20.dp, vertical = 12.dp),
              verticalAlignment = Alignment.CenterVertically,
              horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
              PlayAllButton({
                val tracks = tracksState.data
                if (!tracks.isNullOrEmpty()) actions.playNow(tracks, 0)
              })
              val starred = dev.hmsy.openmusic.ui.StarOverlay.rememberStarred(album.id, album.starred, "albums")
              val context = androidx.compose.ui.platform.LocalContext.current
              IconButton(onClick = {
                dev.hmsy.openmusic.ui.StarOverlay.toggle(
                  album.id, starred, "albums",
                  onError = { android.widget.Toast.makeText(context, "操作失败", android.widget.Toast.LENGTH_SHORT).show() },
                )
              }) {
                Icon(
                  imageVector = if (starred) OmIcons.HeartFilled else OmIcons.Heart,
                  contentDescription = if (starred) "取消收藏" else "收藏",
                  tint = if (starred) Om.Accent else Om.Dim,
                  modifier = Modifier.size(20.dp),
                )
              }
            }
          }
        }

        val tracks = tracksState.data
        when {
          tracks == null && tracksState.error == null -> item { LoadingView() }
          tracks != null && tracks.isEmpty() -> item { EmptyView("专辑没有曲目") }
          tracks != null -> itemsIndexed(tracks, key = { _, t -> t.id }) { i, track ->
            val isCurrent = bus.current?.id == track.id
            TrackRow(
              track = track,
              isCurrent = isCurrent,
              isPlaying = bus.isPlaying,
              index = track.track ?: (i + 1),
              showCover = false,
              showAlbum = false,
              onClick = { actions.playNow(tracks, i) },
              onLongClick = { actions.trackActions(track, tracks, i) },
              onVersions = { actions.pickVersion(track, tracks, i) },
              trailing = { StarTrailing(track) },
            )
          }
        }
      }
    }
  }
}

// ── 艺人 ──────────────────────────────────────────────
@Composable
fun ArtistScreen(id: String, actions: UiActions) {
  val back = LocalOnBackPressedDispatcherOwner.current?.onBackPressedDispatcher
  val (artistState, _) = rememberLoad { OpenMusicApp.api.artist(id) }
  val (topState, _) = rememberLoad { OpenMusicApp.api.artistTopTracks(id) }
  val (albumsState, _) = rememberLoad { OpenMusicApp.api.artistAlbums(id) }
  val bus by PlayerBus.state.collectAsState()
  val artist = artistState.data
  SetAmbientCover(artist?.let { if (it.hasCoverArt) OpenMusicApp.api.artistCoverUrl(it.id) else null })

  Box(Modifier.fillMaxSize()) {
    when {
      artist == null && artistState.error == null -> LoadingView(Modifier.align(Alignment.Center))
      // 艺人已不在（例如其唯一曲目刚被移出曲库）：给出人话与可见的返回
      artist == null -> Column(Modifier.fillMaxSize()) {
        Box(Modifier.padding(horizontal = 12.dp)) { DetailTopBar("", onBack = { back?.onBackPressed() }) }
        Box(Modifier.weight(1f).fillMaxWidth()) {
          ErrorView("这位艺人已不在曲库中（可能其曲目都已被移出）。", retry = null, modifier = Modifier.align(Alignment.Center))
        }
      }
      else -> LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 20.dp)) {
      item {
        Column(Modifier.statusBarsPadding().padding(top = 6.dp)) {
          Box(Modifier.padding(horizontal = 12.dp)) {
            DetailTopBar("", onBack = { back?.onBackPressed() })
          }
          Column(
            Modifier.fillMaxWidth(),
            horizontalAlignment = Alignment.CenterHorizontally,
          ) {
            ArtistCover(
              artistId = artist.id,
              name = artist.name,
              hasCover = artist.hasCoverArt,
              modifier = Modifier
                .size(120.dp)
                .shadow(12.dp, CircleShape, spotColor = Color.Black, ambientColor = Color.Black)
                .clip(CircleShape),
            )
            Spacer(Modifier.height(14.dp))
            Text(artist.name, style = OmType.Display, color = Om.Paper, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Spacer(Modifier.height(4.dp))
            Text("${artist.albumCount} 张专辑 · ${artist.trackCount} 首", style = OmType.Readout, color = Om.Faint)
            Spacer(Modifier.height(12.dp))
            PlayAllButton({
              val top = topState.data
              if (!top.isNullOrEmpty()) actions.playNow(top, 0)
            })
          }
        }
      }

      val top = topState.data
      if (!top.isNullOrEmpty()) {
        item { SectionHeader("热门曲目", top.size, Modifier.padding(top = 20.dp)) }
        itemsIndexed(top, key = { i, t -> "top$i-${t.id}" }) { i, track ->
          val isCurrent = bus.current?.id == track.id
          TrackRow(
            track = track,
            isCurrent = isCurrent,
            isPlaying = bus.isPlaying,
            index = i + 1,
            showArtist = false,
            showAlbum = true,
            onClick = { actions.playNow(top, i) },
            onLongClick = { actions.trackActions(track, top, i) },
            onVersions = { actions.pickVersion(track, top, i) },
            trailing = { StarTrailing(track) },
          )
        }
      }

      val albums = albumsState.data?.items
      if (!albums.isNullOrEmpty()) {
        item { SectionHeader("专辑", albums.size, Modifier.padding(top = 20.dp)) }
        // 三列成排（chunked 行——避免嵌套滚动）
        albums.chunked(3).forEachIndexed { rowIndex, row ->
          item("albums-$rowIndex") {
            Row(
              Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp),
              horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
              row.forEach { album ->
                AlbumCard(
                  album = album,
                  onClick = { actions.openAlbum(album.id) },
                  modifier = Modifier.weight(1f),
                )
              }
              repeat(3 - row.size) { Spacer(Modifier.weight(1f)) }
            }
          }
        }
      }
    }
    }
  }
}

// ── 播放列表 ──────────────────────────────────────────
@Composable
fun PlaylistScreen(id: String, actions: UiActions) {
  val back = LocalOnBackPressedDispatcherOwner.current?.onBackPressedDispatcher
  val scope = androidx.compose.runtime.rememberCoroutineScope()
  val (plState, _) = rememberLoad { OpenMusicApp.api.playlist(id) }
  val (tracksState, reload) = rememberLoad { OpenMusicApp.api.playlistTracks(id) }
  val bus by PlayerBus.state.collectAsState()
  val context = androidx.compose.ui.platform.LocalContext.current

  val tracks = tracksState.data
  val totalSec = tracks?.sumOf { it.durationSeconds } ?: 0

  LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 20.dp)) {
    item {
      Column(Modifier.statusBarsPadding().padding(top = 6.dp)) {
        Box(Modifier.padding(horizontal = 12.dp)) {
          DetailTopBar("", onBack = { back?.onBackPressed() })
        }
        Row(
          Modifier
            .fillMaxWidth()
            .padding(horizontal = 20.dp, vertical = 8.dp),
          verticalAlignment = Alignment.Bottom,
        ) {
          Box(
            Modifier
              .size(120.dp)
              .shadow(12.dp, RoundedCornerShape(10.dp), spotColor = Color.Black, ambientColor = Color.Black)
              .clip(RoundedCornerShape(10.dp)),
          ) {
            ProgrammaticCover(seed = "pl-$id", name = plState.data?.name ?: "♪", monogram = true, modifier = Modifier.size(120.dp))
          }
          Spacer(Modifier.width(16.dp))
          Column(Modifier.weight(1f)) {
            Text("播放列表", style = OmType.Meta, color = Om.Faint)
            Text(
              plState.data?.name ?: "…",
              style = OmType.Display,
              color = Om.Paper,
              maxLines = 2,
              overflow = TextOverflow.Ellipsis,
            )
            Text("${tracks?.size ?: 0} 首 · ${formatDuration(totalSec)}", style = OmType.Readout, color = Om.Faint)
          }
        }
        Row(
          Modifier
            .fillMaxWidth()
            .padding(horizontal = 20.dp, vertical = 10.dp),
          horizontalArrangement = Arrangement.spacedBy(10.dp),
          verticalAlignment = Alignment.CenterVertically,
        ) {
          PlayAllButton({
            val t = tracksState.data
            if (!t.isNullOrEmpty()) actions.playNow(t, 0)
          })
        }
      }
    }

    when {
      tracks == null && tracksState.error == null -> item { LoadingView() }
      tracks != null && tracks.isEmpty() -> item { EmptyView("播放列表是空的，去曲目长按添加") }
      tracks != null -> itemsIndexed(tracks, key = { i, t -> "$i-${t.id}" }) { i, track ->
        val isCurrent = bus.current?.id == track.id
        TrackRow(
          track = track,
          isCurrent = isCurrent,
          isPlaying = bus.isPlaying,
          index = i + 1,
          onClick = { actions.playNow(tracks, i) },
          onLongClick = { actions.trackActions(track, tracks, i) },
          onVersions = { actions.pickVersion(track, tracks, i) },
          trailing = {
            androidx.compose.foundation.layout.Box(
              modifier = Modifier
                .size(32.dp)
                .clickable {
                  scope.launch {
                    val ok = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                      runCatching { OpenMusicApp.api.removeFromPlaylist(id, i) }.isSuccess
                    }
                    if (ok) reload()
                    else android.widget.Toast.makeText(context, "移除失败", android.widget.Toast.LENGTH_SHORT).show()
                  }
                },
              contentAlignment = Alignment.Center,
            ) {
              Icon(OmIcons.X, contentDescription = "移除", tint = Om.Faint, modifier = Modifier.size(15.dp))
            }
          },
        )
      }
    }
  }
}
