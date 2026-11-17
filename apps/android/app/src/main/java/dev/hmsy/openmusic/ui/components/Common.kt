package dev.hmsy.openmusic.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import dev.hmsy.openmusic.core.Om
import dev.hmsy.openmusic.core.OmType
import dev.hmsy.openmusic.data.Page
import dev.hmsy.openmusic.ui.icons.OmIcons
import kotlinx.coroutines.launch
/** 简易异步加载态（null=加载中） */
data class LoadState<T>(val data: T? = null, val error: String? = null)

/** 分页状态：total=null 表示首页还在加载；ended = 已到末页 */
data class PagedState<T>(
  val items: List<T> = emptyList(),
  val total: Int? = null,
  val error: String? = null,
  val loadingMore: Boolean = false,
) {
  val ended: Boolean get() = total != null && items.size >= total
}

data class PagedHandle<T>(val state: PagedState<T>, val loadMore: () -> Unit, val reload: () -> Unit)

/** 挂载加载首页 + 触底增量：大库目录/收藏不再「一次拉满上限、静默截断」 */
@Composable
fun <T> rememberPagedLoad(
  fetch: suspend (offset: Int) -> Page<T>,
): PagedHandle<T> {
  var state by remember { mutableStateOf(PagedState<T>()) }
  var key by remember { mutableIntStateOf(0) }
  var gen by remember { mutableIntStateOf(0) }
  val scope = rememberCoroutineScope()
  val latestFetch by rememberUpdatedState(fetch)

  LaunchedEffect(key) {
    gen += 1
    val myGen = gen
    state = PagedState()
    runCatching { latestFetch(0) }.fold(
      onSuccess = { page -> if (gen == myGen) state = PagedState(items = page.items, total = page.total) },
      onFailure = { e -> if (gen == myGen) state = PagedState(error = e.message ?: e.toString()) },
    )
  }

  fun requestMore() {
    val st = state
    if (st.total === null || st.ended || st.loadingMore || st.error !== null) return
    val myGen = gen
    state = st.copy(loadingMore = true)
    scope.launch {
      runCatching { latestFetch(st.items.size) }.fold(
        onSuccess = { page ->
          if (gen == myGen) {
            state = state.copy(items = state.items + page.items, total = page.total, loadingMore = false)
          }
        },
        onFailure = { e ->
          if (gen == myGen) state = state.copy(loadingMore = false, error = e.message ?: e.toString())
        },
      )
    }
  }

  return PagedHandle(state, ::requestMore, { key++ })
}

/** LazyColumn 触底（可视末行进入倒数 8 行内）自动加载下一页 */
@Composable
fun LoadMoreEffect(listState: androidx.compose.foundation.lazy.LazyListState, handle: PagedHandle<*>) {
  val nearEnd by remember {
    derivedStateOf {
      val info = listState.layoutInfo
      val last = info.visibleItemsInfo.lastOrNull()?.index ?: -1
      info.totalItemsCount > 0 && last >= info.totalItemsCount - 8
    }
  }
  LaunchedEffect(nearEnd, handle.state.items.size) {
    if (nearEnd) handle.loadMore()
  }
}

/** LazyVerticalGrid 触底自动加载下一页 */
@Composable
fun LoadMoreEffect(gridState: androidx.compose.foundation.lazy.grid.LazyGridState, handle: PagedHandle<*>) {
  val nearEnd by remember {
    derivedStateOf {
      val info = gridState.layoutInfo
      val last = info.visibleItemsInfo.lastOrNull()?.index ?: -1
      info.totalItemsCount > 0 && last >= info.totalItemsCount - 9
    }
  }
  LaunchedEffect(nearEnd, handle.state.items.size) {
    if (nearEnd) handle.loadMore()
  }
}

/** 挂载时加载 + 手动 reload（star/增删后刷新用） */
@Composable
fun <T> rememberLoad(loader: suspend () -> T): Pair<LoadState<T>, () -> Unit> {
  var state by remember { mutableStateOf(LoadState<T>()) }
  var key by remember { mutableIntStateOf(0) }
  LaunchedEffect(key) {
    state = LoadState<T>()
    runCatching { loader() }.fold(
      onSuccess = { state = LoadState(data = it) },
      onFailure = { state = LoadState(error = it.message ?: it.toString()) },
    )
  }
  return LoadState(state.data, state.error) to { key++ }
}

@Composable
fun LoadingView(modifier: Modifier = Modifier) {
  Box(modifier.fillMaxWidth().padding(48.dp), contentAlignment = Alignment.Center) {
    androidx.compose.material3.CircularProgressIndicator(
      color = Om.Accent,
      modifier = Modifier.width(28.dp).height(28.dp),
      strokeWidth = 2.5.dp,
    )
  }
}

@Composable
fun ErrorView(message: String, retry: (() -> Unit)? = null, modifier: Modifier = Modifier) {
  Column(modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 40.dp), horizontalAlignment = Alignment.CenterHorizontally) {
    Text("加载失败", style = OmType.Title, color = Om.Paper)
    Spacer(Modifier.height(6.dp))
    Text(message, style = OmType.Meta, color = Om.Faint)
    if (retry != null) {
      Spacer(Modifier.height(14.dp))
      androidx.compose.material3.TextButton(onClick = retry) { Text("重试", color = Om.Accent) }
    }
  }
}

@Composable
fun EmptyView(text: String, modifier: Modifier = Modifier) {
  Box(modifier.fillMaxWidth().padding(vertical = 48.dp), contentAlignment = Alignment.Center) {
    Text(text, style = OmType.Body, color = Om.Faint)
  }
}

/** 详情页顶栏：返回 + 标题 */
@Composable
fun DetailTopBar(title: String, onBack: () -> Unit, modifier: Modifier = Modifier) {
  Row(
    modifier
      .fillMaxWidth()
      .statusBarsPadding()
      .padding(vertical = 2.dp),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(4.dp),
  ) {
    IconButton(onClick = onBack) {
      androidx.compose.material3.Icon(
        OmIcons.ChevronLeft,
        contentDescription = "返回",
        tint = Om.Paper,
        modifier = Modifier.width(22.dp).height(22.dp),
      )
    }
    Text(title, style = OmType.Title, color = Om.Paper)
  }
}
