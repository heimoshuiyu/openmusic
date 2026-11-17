package dev.hmsy.openmusic.ui.screens

import androidx.compose.foundation.background
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
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.itemsIndexed as gridItemsIndexed
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
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
import dev.hmsy.openmusic.ui.components.PlaylistCoverRow
import dev.hmsy.openmusic.ui.components.TrackRow
import dev.hmsy.openmusic.ui.components.StarTrailing
import dev.hmsy.openmusic.ui.components.LoadMoreEffect
import dev.hmsy.openmusic.ui.components.rememberLoad
import dev.hmsy.openmusic.ui.components.rememberPagedLoad
import dev.hmsy.openmusic.ui.icons.OmIcons
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** 资料库：专辑(网格) / 艺人 / 播放列表 分段页签 */
@Composable
fun LibraryScreen(actions: UiActions) {
  var tab by remember { mutableIntStateOf(0) }

  Column(Modifier.fillMaxSize().statusBarsPadding()) {
    Row(
      Modifier
        .fillMaxWidth()
        .padding(horizontal = 16.dp, vertical = 12.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      Text("资料库", style = OmType.Headline, color = Om.Paper, modifier = Modifier.weight(1f))
    }

    SegmentedTabs(
      tabs = listOf("专辑", "艺人", "播放列表"),
      selected = tab,
      onSelect = { tab = it },
      modifier = Modifier.padding(horizontal = 16.dp),
    )

    when (tab) {
      0 -> AlbumsGrid(actions)
      1 -> ArtistsList(actions)
      else -> PlaylistsList(actions)
    }
  }
}

/** 分段控件：raised 底、选中 panel 白字（资料库/收藏共用） */
@Composable
internal fun SegmentedTabs(tabs: List<String>, selected: Int, onSelect: (Int) -> Unit, modifier: Modifier = Modifier) {
  Row(
    modifier.fillMaxWidth(),
  ) {
    tabs.forEachIndexed { i, label ->
      val active = i == selected
      Box(
        Modifier
          .weight(1f)
          .clickable { onSelect(i) }
          .height(44.dp),
        contentAlignment = Alignment.Center,
      ) {
        Text(label, style = OmType.Row, color = if (active) Om.Accent else Om.Dim)
        Box(Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(if (active) 2.dp else 1.dp).background(if (active) Om.Accent else Om.Line))
      }
    }
  }
}

@Composable
private fun AlbumsGrid(actions: UiActions) {
  val paged = rememberPagedLoad { offset -> OpenMusicApp.api.albums(limit = 60, offset = offset) }
  val state = paged.state
  val gridState = androidx.compose.foundation.lazy.grid.rememberLazyGridState()
  LoadMoreEffect(gridState, paged)
  when {
    state.error != null -> ErrorView(state.error ?: "", paged.reload, Modifier.fillMaxSize())
    state.total === null -> LoadingView(Modifier.fillMaxSize())
    state.items.isEmpty() -> EmptyView("曲库还是空的——先在服务端添加音乐目录")
    else -> LazyVerticalGrid(
      columns = GridCells.Adaptive(145.dp),
      state = gridState,
      contentPadding = PaddingValues(horizontal = 16.dp, vertical = 14.dp),
      horizontalArrangement = Arrangement.spacedBy(12.dp),
      verticalArrangement = Arrangement.spacedBy(14.dp),
      modifier = Modifier.fillMaxSize(),
    ) {
      gridItemsIndexed(state.items, key = { _, a -> a.id }) { _, album ->
        AlbumCard(album = album, onClick = { actions.openAlbum(album.id) }, modifier = Modifier.fillMaxWidth())
      }
    }
  }
}

@Composable
private fun ArtistsList(actions: UiActions) {
  val paged = rememberPagedLoad { offset -> OpenMusicApp.api.artists(limit = 100, offset = offset) }
  val state = paged.state
  val listState = androidx.compose.foundation.lazy.rememberLazyListState()
  LoadMoreEffect(listState, paged)
  val bus by PlayerBus.state.collectAsState()
  when {
    state.error != null -> ErrorView(state.error ?: "", paged.reload, Modifier.fillMaxSize())
    state.total === null -> LoadingView(Modifier.fillMaxSize())
    state.items.isEmpty() -> EmptyView("曲库还是空的——先在服务端添加音乐目录")
    else -> LazyColumn(state = listState, contentPadding = PaddingValues(vertical = 10.dp)) {
      itemsIndexed(state.items, key = { _, a -> a.id }) { _, artist ->
        ArtistRow(artist = artist, onClick = { actions.openArtist(artist.id) })
      }
    }
  }
}

@Composable
private fun PlaylistsList(actions: UiActions) {
  val scope = rememberCoroutineScope()
  val (state, reload) = rememberLoad { OpenMusicApp.api.playlists() }
  var showCreate by remember { mutableStateOf(false) }
  var newName by remember { mutableStateOf("") }
  val context = androidx.compose.ui.platform.LocalContext.current

  Column(Modifier.fillMaxSize()) {
    Row(
      Modifier
        .fillMaxWidth()
        .padding(horizontal = 20.dp, vertical = 4.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      Text("播放列表", style = OmType.Meta, color = Om.Faint, modifier = Modifier.weight(1f))
      TextButton(onClick = { showCreate = true }) {
        Icon(OmIcons.Plus, contentDescription = null, tint = Om.Dim, modifier = Modifier.size(14.dp))
        Spacer(Modifier.width(4.dp))
        Text("新建", color = Om.Dim, style = OmType.Meta)
      }
    }

    when {
      state.data == null && state.error == null -> LoadingView(Modifier.fillMaxSize())
      state.error != null -> ErrorView(state.error ?: "", reload, Modifier.fillMaxSize())
      state.data?.isEmpty() == true -> EmptyView("还没有播放列表，点右上角新建")
      else -> LazyColumn(contentPadding = PaddingValues(top = 6.dp, bottom = 16.dp)) {
        itemsIndexed(state.data ?: emptyList(), key = { _, pl -> pl.id }) { _, pl ->
          PlaylistCoverRow(playlistId = pl.id, name = pl.name, songCount = pl.songCount, onClick = { actions.openPlaylist(pl.id) })
        }
      }
    }
  }

  if (showCreate) {
    AlertDialog(
      onDismissRequest = { showCreate = false },
      containerColor = Om.Panel,
      title = { Text("新建播放列表", style = OmType.Title, color = Om.Paper) },
      text = {
        OutlinedTextField(
          value = newName,
          onValueChange = { newName = it },
          placeholder = { Text("列表名称", color = Om.Faint) },
          singleLine = true,
        )
      },
      confirmButton = {
        TextButton(onClick = {
          val name = newName.trim()
          if (name.isEmpty()) return@TextButton
          scope.launch {
            val ok = withContext(Dispatchers.IO) { runCatching { OpenMusicApp.api.createPlaylist(name) }.isSuccess }
            withContext(Dispatchers.Main) {
              if (ok) reload() else android.widget.Toast.makeText(context, "创建失败", android.widget.Toast.LENGTH_SHORT).show()
              showCreate = false
              newName = ""
            }
          }
        }) { Text("创建", color = Om.Accent) }
      },
      dismissButton = { TextButton(onClick = { showCreate = false }) { Text("取消", color = Om.Faint) } },
    )
  }
}
