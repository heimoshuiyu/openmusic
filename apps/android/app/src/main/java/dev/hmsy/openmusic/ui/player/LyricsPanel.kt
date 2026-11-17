package dev.hmsy.openmusic.ui.player

import androidx.compose.runtime.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.layout.*
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.font.FontWeight
import dev.hmsy.openmusic.OpenMusicApp
import dev.hmsy.openmusic.core.Om
import dev.hmsy.openmusic.data.TrackLyrics
import kotlinx.coroutines.CancellationException

@Composable internal fun LyricsPanel(trackId:String,positionMs:Long) = key(trackId) {
  var attempt by remember { mutableIntStateOf(0) }
  var data by remember { mutableStateOf<TrackLyrics?>(null) }
  var failed by remember { mutableStateOf(false) }
  LaunchedEffect(attempt) {
    failed=false
    try { data=OpenMusicApp.api.lyrics(trackId) } catch(e:CancellationException) { throw e } catch(_:Exception) { failed=true }
  }
  val d=data
  when {
    failed -> TextButton(onClick={attempt++}) { Text("歌词读取失败，重试") }
    d==null -> Text("正在读取歌词…",color=Om.Dim)
    d.lines.isEmpty() -> Text("此版本暂无歌词",color=Om.Dim)
    else -> {
      val scroll=rememberLazyListState()
      val active=if(d.synced)d.lines.indexOfLast { (it.startMs?:Long.MAX_VALUE)<=positionMs } else -1
      LaunchedEffect(active) { if(active>=0)scroll.scrollToItem((active-1).coerceAtLeast(0)) }
      LazyColumn(Modifier.fillMaxSize().padding(horizontal=24.dp),state=scroll,horizontalAlignment=Alignment.CenterHorizontally,
        contentPadding=PaddingValues(vertical=20.dp)) {
        items(d.lines.size){i->Text(d.lines[i].text,Modifier.fillMaxWidth().padding(vertical=6.dp),textAlign=TextAlign.Center,
          color=if(!d.synced||active==i)Om.Paper else Om.Dim,fontWeight=if(i==active)FontWeight.Bold else FontWeight.Normal)}
      }
    }
  }
}
