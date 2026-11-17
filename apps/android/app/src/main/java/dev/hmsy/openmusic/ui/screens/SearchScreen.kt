package dev.hmsy.openmusic.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.hmsy.openmusic.OpenMusicApp
import dev.hmsy.openmusic.core.Om
import dev.hmsy.openmusic.core.OmType
import dev.hmsy.openmusic.data.SearchResult
import dev.hmsy.openmusic.player.PlayerBus
import dev.hmsy.openmusic.ui.UiActions
import dev.hmsy.openmusic.ui.components.AlbumCard
import dev.hmsy.openmusic.ui.components.ArtistRow
import dev.hmsy.openmusic.ui.components.EmptyView
import dev.hmsy.openmusic.ui.components.SectionHeader
import dev.hmsy.openmusic.ui.components.StarTrailing
import dev.hmsy.openmusic.ui.components.TrackRow
import dev.hmsy.openmusic.ui.icons.OmIcons
import kotlinx.coroutines.delay

/** 搜索：即时（300ms 防抖）分组结果：单曲 / 专辑 / 艺人 */
@Composable
fun SearchScreen(actions: UiActions) {
  var query by remember { mutableStateOf("") }
  var result by remember { mutableStateOf<SearchResult?>(null) }
  var searching by remember { mutableStateOf(false) }
  var searched by remember { mutableStateOf(false) }
  val bus by PlayerBus.state.collectAsState()

  LaunchedEffect(query) {
    if (query.isBlank()) {
      result = null
      searched = false
      return@LaunchedEffect
    }
    delay(300)
    searching = true
    result = runCatching { OpenMusicApp.api.search(query.trim()) }.getOrNull()
    searching = false
    searched = true
  }

  Column(Modifier.fillMaxSize().statusBarsPadding()) {
    Text(
      "搜索",
      style = OmType.Headline,
      color = Om.Paper,
      modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
    )
    TextField(
      value = query,
      onValueChange = { query = it },
      placeholder = { Text("艺人、专辑、曲目", color = Om.Faint) },
      leadingIcon = { Icon(OmIcons.Search, contentDescription = null, tint = Om.Faint, modifier = Modifier.size(18.dp)) },
      singleLine = true,
      keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
      shape = RoundedCornerShape(2.dp),
      colors = TextFieldDefaults.colors(
        focusedContainerColor = Om.Panel,
        unfocusedContainerColor = Om.Panel,
        focusedTextColor = Om.Paper,
        unfocusedTextColor = Om.Paper,
        cursorColor = Om.Accent,
        focusedIndicatorColor = Om.Accent,
        unfocusedIndicatorColor = Om.Line,
      ),
      modifier = Modifier
        .fillMaxWidth()
        .padding(horizontal = 16.dp),
    )

    val r = result
    when {
      query.isBlank() -> EmptyView("输入关键词搜索你的资料库")
      searching && r == null -> EmptyView("搜索中…")
      r != null && r.artistCount + r.albumCount + r.trackCount == 0 -> EmptyView("没有找到「$query」相关内容")
      r != null -> LazyColumn(contentPadding = PaddingValues(top = 14.dp, bottom = 20.dp)) {
        if (r.tracks.isNotEmpty()) {
          item { SectionHeader("单曲", r.trackCount) }
          itemsIndexed(r.tracks, key = { _, t -> "t-${t.id}" }) { i, track ->
            val isCurrent = bus.current?.id == track.id
            TrackRow(
              track = track,
              isCurrent = isCurrent,
              isPlaying = bus.isPlaying,
              index = null,
              onClick = { actions.playNow(r.tracks, i) },
              onLongClick = { actions.trackActions(track, r.tracks, i) },
              onVersions = { actions.pickVersion(track, r.tracks, i) },
              trailing = { StarTrailing(track) },
            )
          }
        }
        if (r.albums.isNotEmpty()) {
          item {
            SectionHeader("专辑", r.albumCount, Modifier.padding(top = 18.dp))
            LazyRow(
              contentPadding = PaddingValues(horizontal = 16.dp),
              horizontalArrangement = Arrangement.spacedBy(14.dp),
            ) {
              items(r.albums, key = { it.id }) { album ->
                AlbumCard(album = album, onClick = { actions.openAlbum(album.id) })
              }
            }
          }
        }
        if (r.artists.isNotEmpty()) {
          item { SectionHeader("艺人", r.artistCount, Modifier.padding(top = 18.dp)) }
          itemsIndexed(r.artists, key = { _, a -> "ar-${a.id}" }) { _, artist ->
            ArtistRow(artist = artist, onClick = { actions.openArtist(artist.id) })
          }
        }
      }
    }
  }
}
