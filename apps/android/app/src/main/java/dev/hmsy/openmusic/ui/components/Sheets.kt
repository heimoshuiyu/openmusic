package dev.hmsy.openmusic.ui.components

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import android.widget.Toast
import dev.hmsy.openmusic.OpenMusicApp
import dev.hmsy.openmusic.core.Om
import dev.hmsy.openmusic.core.OmType
import dev.hmsy.openmusic.data.TrackSummary
import dev.hmsy.openmusic.ui.icons.OmIcons
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** 曲目长按操作 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TrackActionsSheet(
  track: TrackSummary,
  onDismiss: () -> Unit,
  onPlayNow: () -> Unit,
  onPlayNext: () -> Unit,
  onEnqueue: () -> Unit,
  onAddToPlaylist: () -> Unit,
  onToggleStar: () -> Unit,
  onVersions: () -> Unit = {},
) {
  val starred = dev.hmsy.openmusic.ui.StarOverlay.rememberStarred(track.id, track.starred)
  ModalBottomSheet(onDismissRequest = onDismiss, containerColor = Om.Panel) {
    Column(Modifier.padding(bottom = 24.dp)) {
      // 曲目信息头
      Row(
        Modifier.padding(horizontal = 20.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        CoverArt(
          albumId = track.album.id,
          name = track.album.name,
          hasCover = track.hasCoverArt,
          trackId = track.id,
          cornerRadiusDp = 4,
          modifier = Modifier.size(44.dp),
        )
        Spacer(Modifier.width(12.dp))
        Column {
          Text(track.title, style = OmType.Row, color = Om.Paper, maxLines = 1, overflow = TextOverflow.Ellipsis)
          Text("${track.artist.name} · ${track.album.name}", style = OmType.Meta, color = Om.Dim, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
      }
      Spacer(Modifier.height(10.dp))

      ActionRow(OmIcons.PlayCircle, "立即播放") { onPlayNow(); onDismiss() }
      ActionRow(OmIcons.SkipForward, "下一首播放") { onPlayNext(); onDismiss() }
      ActionRow(OmIcons.Plus, "加入队列") { onEnqueue(); onDismiss() }
      ActionRow(OmIcons.ListMusic, "添加到播放列表") { onAddToPlaylist() }
      if ((track.versionCount ?: 1) > 1) {
        ActionRow(OmIcons.Layers, "选择版本（${track.versionCount} 份拷贝）") { onVersions() }
      }
      ActionRow(
        if (starred) OmIcons.HeartFilled else OmIcons.Heart,
        if (starred) "取消收藏" else "收藏",
      ) { onToggleStar(); onDismiss() }
    }
  }
}

@Composable
private fun ActionRow(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, onClick: () -> Unit) {
  Row(
    Modifier
      .fillMaxWidth()
      .clickable(onClick = onClick)
      .padding(horizontal = 20.dp, vertical = 14.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Icon(icon, contentDescription = label, tint = Om.Dim, modifier = Modifier.size(20.dp))
    Spacer(Modifier.width(16.dp))
    Text(label, style = OmType.Body, color = Om.Paper)
  }
}

/**
 * 版本选择器：同一首歌的多份物理拷贝（不同来源/音质）。
 * 每份展示 编解码 / 采样率·码率（读数）/ 来源目录末三段；index 0 = 标准版（canonical 最优）。
 * 选中 = 以该副本顶替原曲起播（web 同语义：队列里这首就是用户挑的那份）。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun VersionPickerSheet(
  track: TrackSummary,
  onDismiss: () -> Unit,
  onPick: (TrackSummary) -> Unit,
) {
  val versions = remember { mutableStateOf<List<TrackSummary>?>(null) }
  val failed = remember { mutableStateOf(false) }

  androidx.compose.runtime.LaunchedEffect(track.id) {
    runCatching { OpenMusicApp.api.trackVersions(track.id) }
      .onSuccess { versions.value = it }
      .onFailure { failed.value = true }
  }

  ModalBottomSheet(onDismissRequest = onDismiss, containerColor = Om.Panel) {
    Column(Modifier.padding(bottom = 24.dp)) {
      Row(
        Modifier.padding(horizontal = 20.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        Icon(OmIcons.Layers, contentDescription = null, tint = Om.Dim, modifier = Modifier.size(18.dp))
        Spacer(Modifier.width(10.dp))
        Column {
          Text("选择播放版本", style = OmType.Title, color = Om.Paper)
          Text(track.title, style = OmType.Meta, color = Om.Faint, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
      }
      Spacer(Modifier.height(8.dp))

      val list = versions.value
      when {
        failed.value -> Text("版本读取失败", style = OmType.Meta, color = Om.Faint, modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp))
        list == null -> Text("加载中…", style = OmType.Meta, color = Om.Faint, modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp))
        else -> list.forEachIndexed { index, version ->
          Row(
            Modifier
              .fillMaxWidth()
              .clickable {
                onDismiss()
                onPick(version)
              }
              .padding(horizontal = 20.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
          ) {
            Column(Modifier.weight(1f)) {
              Row(verticalAlignment = Alignment.CenterVertically) {
                Text(version.codec.uppercase(), style = OmType.Row, color = Om.Paper)
                Spacer(Modifier.width(10.dp))
                Text(
                  "${version.sampleRateHz / 1000}kHz · ${version.bitrateKbps}k",
                  style = OmType.Readout,
                  color = Om.Dim,
                )
                if (index == 0) {
                  Spacer(Modifier.width(10.dp))
                  Text("标准版", style = OmType.Meta, color = Om.Accent)
                }
              }
              val dir = version.path
                ?.split("/")
                ?.dropLast(1)
                ?.takeLast(3)
                ?.joinToString("/")
                .orEmpty()
              if (dir.isNotBlank()) {
                Text(dir, style = OmType.Meta, color = Om.Faint, maxLines = 1, overflow = TextOverflow.Ellipsis)
              }
            }
          }
        }
      }
    }
  }
}

/** 播放列表选择器（含新建） */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PlaylistPickerSheet(
  trackId: String,
  onDismiss: () -> Unit,
) {
  val scope = rememberCoroutineScope()
  val playlists = remember { mutableStateOf<List<dev.hmsy.openmusic.data.PlaylistSummary>?>(null) }
  var showCreate by remember { mutableStateOf(false) }
  var newName by remember { mutableStateOf("") }
  val context = androidx.compose.ui.platform.LocalContext.current

  androidx.compose.runtime.LaunchedEffect(Unit) {
    playlists.value = withContext(Dispatchers.IO) { runCatching { OpenMusicApp.api.playlists() }.getOrNull() }
  }

  ModalBottomSheet(onDismissRequest = onDismiss, containerColor = Om.Panel) {
    Column(Modifier.padding(bottom = 24.dp)) {
      Row(
        Modifier.padding(horizontal = 20.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        Text("添加到播放列表", style = OmType.Title, color = Om.Paper)
      }
      ActionRow(OmIcons.Plus, "新建播放列表") { showCreate = true }

      if (showCreate) {
        OutlinedTextField(
          value = newName,
          onValueChange = { newName = it },
          placeholder = { Text("列表名称", style = OmType.Body, color = Om.Faint) },
          singleLine = true,
          modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 20.dp, vertical = 4.dp),
        )
        Row(Modifier.padding(horizontal = 12.dp)) {
          TextButton(
            onClick = {
              val name = newName.trim()
              if (name.isEmpty()) return@TextButton
              scope.launch {
                val ok = withContext(Dispatchers.IO) {
                  runCatching {
                    val pl = OpenMusicApp.api.createPlaylist(name)
                    OpenMusicApp.api.addToPlaylist(pl.id, listOf(trackId))
                  }.isSuccess
                }
                withContext(Dispatchers.Main) {
                  Toast.makeText(context, if (ok) "已添加到「$name」" else "操作失败", Toast.LENGTH_SHORT).show()
                  onDismiss()
                }
              }
            },
          ) { Text("创建并添加", color = Om.Accent) }
        }
      }

      val list = playlists.value
      when {
        list == null -> Text("加载中…", style = OmType.Meta, color = Om.Faint, modifier = Modifier.padding(20.dp))
        list.isEmpty() && !showCreate -> Text("还没有播放列表", style = OmType.Meta, color = Om.Faint, modifier = Modifier.padding(20.dp))
        else -> list.forEach { pl ->
          ActionRow(OmIcons.ListMusic, "${pl.name} · ${pl.songCount} 首") {
            scope.launch {
              val ok = withContext(Dispatchers.IO) {
                runCatching { OpenMusicApp.api.addToPlaylist(pl.id, listOf(trackId)) }.isSuccess
              }
              withContext(Dispatchers.Main) {
                Toast.makeText(context, if (ok) "已添加到「${pl.name}」" else "操作失败", Toast.LENGTH_SHORT).show()
                onDismiss()
              }
            }
          }
        }
      }
    }
  }
}
