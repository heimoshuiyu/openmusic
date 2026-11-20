package dev.hmsy.openmusic.ui

import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.foundation.background
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import dev.hmsy.openmusic.core.Om
import dev.hmsy.openmusic.core.OmType
import dev.hmsy.openmusic.data.TrackSummary
import dev.hmsy.openmusic.agent.AssistantSurface
import dev.hmsy.openmusic.agent.rememberAssistantSession
import dev.hmsy.openmusic.ui.screens.AlbumScreen
import dev.hmsy.openmusic.ui.screens.ArtistScreen
import dev.hmsy.openmusic.ui.screens.FavoritesScreen
import dev.hmsy.openmusic.ui.screens.HomeScreen
import dev.hmsy.openmusic.ui.screens.LibraryScreen
import dev.hmsy.openmusic.ui.screens.NeteaseImportScreen
import dev.hmsy.openmusic.ui.screens.NeteaseTrackScreen
import dev.hmsy.openmusic.ui.screens.PlaylistScreen
import dev.hmsy.openmusic.ui.screens.SearchScreen
import dev.hmsy.openmusic.ui.screens.SettingsScreen
import dev.hmsy.openmusic.ui.screens.ServerAdminScreen

/** 屏幕间动作协议（避免 lambda 汤） */
class UiActions(
  val openAlbum: (String) -> Unit,
  val openArtist: (String) -> Unit,
  val openPlaylist: (String) -> Unit,
  val openSettings: () -> Unit,
  val playNow: (List<TrackSummary>, Int) -> Unit,
  val enqueue: (List<TrackSummary>) -> Unit,
  val enqueueNext: (TrackSummary) -> Unit,
  val trackActions: (track: TrackSummary, context: List<TrackSummary>, index: Int) -> Unit,
  /** 版本徽标/长按「选择版本」：弹版本选择器（swap 起播语义） */
  val pickVersion: (track: TrackSummary, context: List<TrackSummary>, index: Int) -> Unit,
  val logout: () -> Unit,
  /** 网易云导入屏（设置 → 曲库入口） */
  val openNeteaseImport: () -> Unit,
  /** 网易云来源管理屏（按曲目 id；非网易云曲目由屏内懒加载 404 明确提示） */
  val openNeteaseTrack: (String) -> Unit,
)

private const val ASSISTANT_ROUTE = "assistant"
private val mainTabs = listOf("home" to "主页", "library" to "资料库", ASSISTANT_ROUTE to "音乐助手", "search" to "搜索", "favorites" to "收藏")

/** The middle tab is a destination, not an action or a floating button. */
@Composable
fun BottomBar(
  selected: String,
  onSelect: (String) -> Unit,
  modifier: Modifier = Modifier,
) {
  // 半透面板与 MiniPlayer 一致——晕染页上底部 chrome 才不会和页面脱节
  Column(modifier.fillMaxWidth().background(Om.Shell)) {
    Box(Modifier.fillMaxWidth().height(0.5.dp).background(Om.Line.copy(alpha = 0.6f)))
    Row(Modifier.fillMaxWidth().selectableGroup().navigationBarsPadding().height(58.dp)) {
      mainTabs.forEachIndexed { index, (route, label) ->
        val active = selected == route
        Column(
          Modifier
            .weight(1f)
            .fillMaxWidth()
            .selectable(selected = active, role = Role.Tab, onClick = { if (!active) onSelect(route) })
            .height(58.dp),
          horizontalAlignment = Alignment.CenterHorizontally,
          verticalArrangement = androidx.compose.foundation.layout.Arrangement.Center,
        ) {
          Text("[0${index+1}]", style = OmType.Readout, color = if (active) Om.Accent else Om.Faint)
          Spacer(Modifier.height(3.dp))
          Text(label, style = OmType.Meta, color = if (active) Om.Accent else Om.Dim, maxLines = 1)
        }
      }
    }
  }
}

/** 已认证区域：导航 + 迷你播放器 + 正在播放的布局骨架（面板由外部插槽提供） */
@Composable
fun MainScaffold(
  nav: NavHostController,
  actions: UiActions,
  netease: NeteaseRunner,
  expired: ()->Unit,
  miniPlayer: @Composable () -> Unit,
  nowPlaying: @Composable () -> Unit,
) {
  val backStack by nav.currentBackStackEntryAsState()
  val currentRoute = backStack?.destination?.route ?: "home"
  val assistantSession = rememberAssistantSession(expired)

  Box(Modifier.fillMaxSize().background(Om.Shell)) {
    Column(Modifier.fillMaxSize()) {
      Box(Modifier.weight(1f)) {
        NavHost(
          navController = nav,
          startDestination = "home",
          modifier = Modifier.fillMaxSize(),
          enterTransition = { EnterTransition.None },
          exitTransition = { ExitTransition.None },
          popEnterTransition = { EnterTransition.None },
          popExitTransition = { ExitTransition.None },
        ) {
          composable("home") { HomeScreen(actions) }
          composable("library") { LibraryScreen(actions) }
          composable(ASSISTANT_ROUTE) { AssistantSurface(assistantSession) }
          composable("search") { SearchScreen(actions) }
          composable("favorites") { FavoritesScreen(actions) }
          composable("album/{id}") { entry ->
            AlbumScreen(entry.arguments?.getString("id") ?: "", actions)
          }
          composable("artist/{id}") { entry ->
            ArtistScreen(entry.arguments?.getString("id") ?: "", actions)
          }
          composable("playlist/{id}") { entry ->
            PlaylistScreen(entry.arguments?.getString("id") ?: "", actions)
          }
          composable("settings") { SettingsScreen(actions, onManage = { nav.navigate("server-admin") { launchSingleTop = true } }) }
          composable("server-admin") { ServerAdminScreen(onBack = { nav.popBackStack() }, onExpired = expired) }
          composable("netease-import") {
            NeteaseImportScreen(
              runner = netease,
              openTrack = actions.openNeteaseTrack,
              onBack = { nav.popBackStack() },
            )
          }
          composable("netease-track/{id}") { entry ->
            NeteaseTrackScreen(
              trackId = entry.arguments?.getString("id") ?: "",
              onBack = { nav.popBackStack() },
            )
          }
        }
      }
      miniPlayer()
      BottomBar(
        selected = currentRoute,
        onSelect = { route ->
          nav.navigate(route) {
            popUpTo(nav.graph.startDestinationId) { saveState = true }
            launchSingleTop = true
            restoreState = true
          }
        },
      )
    }
    nowPlaying()
  }
}
