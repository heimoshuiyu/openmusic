package dev.hmsy.openmusic.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.itemsIndexed as gridItemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import dev.hmsy.openmusic.OpenMusicApp
import dev.hmsy.openmusic.core.Om
import dev.hmsy.openmusic.core.OmType
import dev.hmsy.openmusic.player.PlayerBus
import dev.hmsy.openmusic.ui.UiActions
import dev.hmsy.openmusic.ui.components.AlbumCard
import dev.hmsy.openmusic.ui.components.ArtistRow
import dev.hmsy.openmusic.ui.components.EmptyView
import dev.hmsy.openmusic.ui.components.ErrorView
import dev.hmsy.openmusic.ui.components.LoadingView
import dev.hmsy.openmusic.ui.components.StarTrailing
import dev.hmsy.openmusic.ui.components.TrackRow
import dev.hmsy.openmusic.ui.components.LoadMoreEffect
import dev.hmsy.openmusic.ui.components.rememberPagedLoad
import dev.hmsy.openmusic.ui.icons.OmIcons

/** 收藏：单曲 / 专辑 / 艺人 */
@Composable
fun FavoritesScreen(actions: UiActions) {
  var tab by remember { mutableIntStateOf(0) }

  Column(Modifier.fillMaxSize().statusBarsPadding()) {
    Text(
      "收藏",
      style = OmType.Headline,
      color = Om.Paper,
      modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
    )
    SegmentedTabs(
      tabs = listOf("单曲", "专辑", "艺人"),
      selected = tab,
      onSelect = { tab = it },
      modifier = Modifier.padding(horizontal = 16.dp),
    )
    when (tab) {
      0 -> FavoriteTracks(actions)
      1 -> FavoriteAlbums(actions)
      else -> FavoriteArtists(actions)
    }
  }
}

@Composable
private fun FavoriteTracks(actions: UiActions) {
  val paged = rememberPagedLoad { offset -> OpenMusicApp.api.favoriteTracks(offset = offset) }
  val state = paged.state
  val listState = androidx.compose.foundation.lazy.rememberLazyListState()
  LoadMoreEffect(listState, paged)
  val bus by PlayerBus.state.collectAsState()
  when {
    state.error != null -> ErrorView(state.error ?: "", paged.reload, Modifier.fillMaxSize())
    state.total === null -> LoadingView(Modifier.fillMaxSize())
    state.items.isEmpty() -> EmptyView("长按曲目或点心形收藏喜欢的音乐")
    else -> LazyColumn(state = listState, contentPadding = PaddingValues(top = 12.dp, bottom = 20.dp)) {
      itemsIndexed(state.items, key = { _, t -> t.id }) { i, track ->
        val isCurrent = bus.current?.id == track.id
        TrackRow(
          track = track,
          isCurrent = isCurrent,
          isPlaying = bus.isPlaying,
          index = i + 1,
          onClick = { actions.playNow(state.items, i) },
          onLongClick = { actions.trackActions(track, state.items, i) },
          onVersions = { actions.pickVersion(track, state.items, i) },
          trailing = { StarTrailing(track, onChanged = paged.reload) },
        )
      }
    }
  }
}

@Composable
private fun FavoriteAlbums(actions: UiActions) {
  val paged = rememberPagedLoad { offset -> OpenMusicApp.api.favoriteAlbums(offset = offset) }
  val state = paged.state
  val gridState = androidx.compose.foundation.lazy.grid.rememberLazyGridState()
  LoadMoreEffect(gridState, paged)
  when {
    state.error != null -> ErrorView(state.error ?: "", paged.reload, Modifier.fillMaxSize())
    state.total === null -> LoadingView(Modifier.fillMaxSize())
    state.items.isEmpty() -> EmptyView("还没有收藏的专辑")
    else -> LazyVerticalGrid(
      columns = GridCells.Fixed(3),
      state = gridState,
      contentPadding = PaddingValues(horizontal = 16.dp, vertical = 14.dp),
      horizontalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(12.dp),
      verticalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(14.dp),
      modifier = Modifier.fillMaxSize(),
    ) {
      gridItemsIndexed(state.items, key = { _, a -> a.id }) { _, album ->
        AlbumCard(album = album, onClick = { actions.openAlbum(album.id) }, modifier = Modifier.fillMaxWidth())
      }
    }
  }
}

@Composable
private fun FavoriteArtists(actions: UiActions) {
  val paged = rememberPagedLoad { offset -> OpenMusicApp.api.favoriteArtists(offset = offset) }
  val state = paged.state
  val listState = androidx.compose.foundation.lazy.rememberLazyListState()
  LoadMoreEffect(listState, paged)
  when {
    state.error != null -> ErrorView(state.error ?: "", paged.reload, Modifier.fillMaxSize())
    state.total === null -> LoadingView(Modifier.fillMaxSize())
    state.items.isEmpty() -> EmptyView("还没有收藏的艺人")
    else -> LazyColumn(state = listState, contentPadding = PaddingValues(top = 12.dp, bottom = 20.dp)) {
      itemsIndexed(state.items, key = { _, a -> a.id }) { _, artist ->
        ArtistRow(artist = artist, onClick = { actions.openArtist(artist.id) })
      }
    }
  }
}
