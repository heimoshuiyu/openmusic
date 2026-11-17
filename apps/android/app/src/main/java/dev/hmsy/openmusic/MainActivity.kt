package dev.hmsy.openmusic

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import androidx.navigation.compose.rememberNavController
import dev.hmsy.openmusic.core.OmTheme
import dev.hmsy.openmusic.core.Om
import dev.hmsy.openmusic.data.TrackSummary
import dev.hmsy.openmusic.player.PlaybackService
import dev.hmsy.openmusic.player.PlayerBus
import dev.hmsy.openmusic.player.PlayerController
import dev.hmsy.openmusic.ui.MainScaffold
import dev.hmsy.openmusic.ui.StarOverlay
import dev.hmsy.openmusic.ui.UiActions
import dev.hmsy.openmusic.ui.components.PlaylistPickerSheet
import dev.hmsy.openmusic.ui.components.TrackActionsSheet
import dev.hmsy.openmusic.ui.player.MiniPlayer
import dev.hmsy.openmusic.ui.player.NowPlayingSheet
import dev.hmsy.openmusic.ui.player.QueueSheet
import dev.hmsy.openmusic.ui.screens.LoginScreen
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class MainActivity : ComponentActivity() {

  private val notifPermission =
    registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    enableEdgeToEdge()

    // Android 13+：媒体通知权限（拒绝也不影响播放）
    if (Build.VERSION.SDK_INT >= 33 &&
      ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
    ) {
      notifPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
    }

    setContent {
      OmTheme {
        AppRoot()
      }
    }
  }
}

/** 会话门 → 登录 / 主界面 */
@Composable
private fun AppRoot() {
  val context = LocalContext.current
  var sessionKey by remember { mutableStateOf(0) }
  var sessionReady by remember { mutableStateOf<Boolean?>(null) }

  LaunchedEffect(sessionKey) {
    sessionReady = null
    combine(OpenMusicApp.settings.serverUrl, OpenMusicApp.settings.sessionCookie) { url, cookie ->
      url.isNotBlank() && cookie != null
    }.collect { ready -> sessionReady = ready }
  }

  // 播放控制器（认证后连接，登出释放）
  var controller by remember { mutableStateOf<PlayerController?>(null) }
  LaunchedEffect(sessionReady) {
    controller?.release()
    controller = null
    if (sessionReady == true) controller = PlayerController.connect(context)
  }
  DisposableEffect(Unit) {
    onDispose { controller?.release() }
  }

  when (sessionReady) {
    null -> Box(Modifier.fillMaxSize().background(Om.Shell))
    false -> LoginScreen(onSuccess = { sessionKey++ })
    true -> MainArea(controller, onLogout = { sessionKey++ })
  }
}

/** 主界面编排：导航 + 播放面板 + 队列 + 曲目操作 */
@Composable
private fun MainArea(controller: PlayerController?, onLogout: () -> Unit) {
  val context = LocalContext.current
  val scope = rememberCoroutineScope()
  val nav = rememberNavController()

  var showNowPlaying by remember { mutableStateOf(false) }
  var showQueue by remember { mutableStateOf(false) }
  var showPicker by remember { mutableStateOf(false) }
  var actionTrack by remember { mutableStateOf<Triple<TrackSummary, List<TrackSummary>, Int>?>(null) }
  var versionPick by remember { mutableStateOf<Triple<TrackSummary, List<TrackSummary>, Int>?>(null) }
  val bus by PlayerBus.state.collectAsState()

  val actions = remember(controller) {
    UiActions(
      openAlbum = { id -> nav.navigate("album/$id") },
      openArtist = { id -> nav.navigate("artist/$id") },
      openPlaylist = { id -> nav.navigate("playlist/$id") },
      openSettings = { nav.navigate("settings") },
      playNow = { tracks, index -> PlaybackService.setQueue(tracks, index) },
      enqueue = { tracks -> PlaybackService.enqueue(tracks) },
      enqueueNext = { track -> PlaybackService.enqueueNext(track) },
      trackActions = { track, list, index -> actionTrack = Triple(track, list, index) },
      pickVersion = { track, list, index -> versionPick = Triple(track, list, index) },
      logout = {
        scope.launch {
          withContext(Dispatchers.IO) {
            runCatching { OpenMusicApp.api.logout() }
            OpenMusicApp.api.clearSession()
            OpenMusicApp.settings.clearSession()
          }
          PlaybackService.clearQueue()
          withContext(Dispatchers.Main) { onLogout() }
        }
      },
    )
  }

  MainScaffold(
    nav = nav,
    actions = actions,
    expired = { scope.launch { OpenMusicApp.api.clearSession(); OpenMusicApp.settings.clearSession(); onLogout() } },
    miniPlayer = {
      if (bus.current != null) {
        MiniPlayer(
          state = bus,
          onOpen = { showNowPlaying = true },
          onToggle = { controller?.playPause() },
          onNext = { controller?.next() },
        )
      }
    },
    nowPlaying = {
      NowPlayingSheet(
        visible = showNowPlaying,
        state = bus,
        onDismiss = { showNowPlaying = false },
        onToggle = { controller?.playPause() },
        onNext = { controller?.next() },
        onPrevious = { controller?.previous() },
        onSeek = { controller?.seekTo(it) },
        onToggleShuffle = { controller?.toggleShuffle() },
        onCycleRepeat = { controller?.cycleRepeat() },
        onOpenQueue = { showQueue = true },  // 队列是模态窗，盖在正在播放上——保留上下文
        onToggleStar = {
          bus.current?.let { track ->
            StarOverlay.toggle(
              track.id, StarOverlay.isStarred(track.id, track.starred),
              onError = { android.widget.Toast.makeText(context, "收藏操作失败", android.widget.Toast.LENGTH_SHORT).show() },
            )
          }
        },
      )

      QueueSheet(
        visible = showQueue,
        state = bus,
        onDismiss = { showQueue = false },
        onJump = { PlaybackService.jumpTo(it) },
        onRemove = { PlaybackService.removeAt(it) },
        onClear = { PlaybackService.clearQueue() },
      )

      actionTrack?.let { (track, list, index) ->
        TrackActionsSheet(
          track = track,
          onDismiss = { actionTrack = null; showPicker = false },
          onPlayNow = { PlaybackService.setQueue(list, index) },
          onPlayNext = { PlaybackService.enqueueNext(track) },
          onEnqueue = { PlaybackService.enqueue(listOf(track)) },
          onAddToPlaylist = { showPicker = true },
          onToggleStar = {
            StarOverlay.toggle(
              track.id, StarOverlay.isStarred(track.id, track.starred),
              onError = { android.widget.Toast.makeText(context, "收藏操作失败", android.widget.Toast.LENGTH_SHORT).show() },
            )
          },
          onVersions = { versionPick = Triple(track, list, index) },
        )
      }

      // 版本选择器：选中副本顶替原曲起播（web 同语义：队列里这首就是用户挑的那份）
      versionPick?.let { (track, list, index) ->
        dev.hmsy.openmusic.ui.components.VersionPickerSheet(
          track = track,
          onDismiss = { versionPick = null },
          onPick = { version ->
            val swapped = list.mapIndexed { i, t -> if (i == index) version else t }
            PlaybackService.setQueue(swapped, index)
          },
        )
      }

      if (showPicker && actionTrack != null) {
        PlaylistPickerSheet(
          trackId = actionTrack!!.first.id,
          onDismiss = { showPicker = false; actionTrack = null },
        )
      }
    },
  )
}
