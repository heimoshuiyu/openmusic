package dev.hmsy.openmusic.ui.screens

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
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.hmsy.openmusic.OpenMusicApp
import dev.hmsy.openmusic.core.Om
import dev.hmsy.openmusic.core.OmType
import dev.hmsy.openmusic.data.NeteaseCandidate
import dev.hmsy.openmusic.data.formatEpochMs
import dev.hmsy.openmusic.data.parseNeteaseLink
import dev.hmsy.openmusic.ui.icons.OmIcons
import dev.hmsy.openmusic.ui.NeteaseRunner
import dev.hmsy.openmusic.ui.components.DetailTopBar
import dev.hmsy.openmusic.ui.components.EmptyView
import dev.hmsy.openmusic.ui.components.ErrorView
import dev.hmsy.openmusic.ui.components.ImportResultSheet
import dev.hmsy.openmusic.ui.components.ImportTargetSheet
import dev.hmsy.openmusic.ui.components.LoadingView
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** 待导入项：url 为规范化链接；label 用于目标/结果面板的人读描述 */
data class NeteaseImportRequest(val url: String, val label: String)

/**
 * 网易云导入屏（设置 → 曲库 → 从网易云导入）。
 *
 * - 搜索/链接双模式，均为「显式提交」：服务端搜索全站并发 4、每用户 1（422 限流文案直达展示），
 *   绝不做防抖即时搜——那会把限流当 bug 展示给用户；
 * - 目录选择含 writable 前置校验；导入经 NeteaseRunner（MainArea 级）同步等终态，
 *   切 tab / 离开本屏不丢状态；
 * - 结果面板展示计数/failures/warnings，可播放/入队，点文件进「网易云来源管理」；
 * - 曲库页签回到前台时由 NavHost 重组自然重载（rememberPagedLoad 挂载即拉取），无需手动刷库。
 */
@Composable
fun NeteaseImportScreen(
  runner: NeteaseRunner,
  openTrack: (String) -> Unit,
  onBack: () -> Unit,
) {
  var tab by remember { mutableIntStateOf(0) }
  var pending by remember { mutableStateOf<NeteaseImportRequest?>(null) }

  Column(Modifier.fillMaxSize().statusBarsPadding()) {
    Box(Modifier.padding(horizontal = 12.dp)) { DetailTopBar("从网易云导入", onBack) }
    Text(
      "匿名音源 MP3 ≤320k；VIP/付费歌曲导入时明确跳过；歌单/专辑最多 25 首，歌手热门取前 25 首。",
      style = OmType.Meta,
      color = Om.Faint,
      modifier = Modifier.padding(horizontal = 20.dp, vertical = 2.dp),
    )
    SegmentedTabs(
      tabs = listOf("搜索", "链接"),
      selected = tab,
      onSelect = { tab = it },
      modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
    )

    // 进行中 / 上次失败横幅（runner 挂在 MainArea，离开再回来仍可见）
    runner.busy?.let { busy ->
      Row(
        Modifier
          .fillMaxWidth()
          .padding(horizontal = 20.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        Icon(OmIcons.Refresh, contentDescription = null, tint = Om.Accent, modifier = Modifier.size(14.dp))
        Spacer(Modifier.width(8.dp))
        Column {
          Text("导入进行中 → ${busy.target}", style = OmType.Body, color = Om.Accent, maxLines = 1, overflow = TextOverflow.Ellipsis)
          Text(
            "自 ${formatEpochMs(busy.startedAtMs)} 起等待服务器；多曲可能需要几分钟，可先去别的页面。",
            style = OmType.Meta, color = Om.Faint,
          )
        }
      }
    }
    runner.error?.let { error ->
      Row(
        Modifier
          .fillMaxWidth()
          .padding(horizontal = 20.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        Icon(OmIcons.CircleAlert, contentDescription = null, tint = Om.Danger, modifier = Modifier.size(14.dp))
        Spacer(Modifier.width(8.dp))
        Text(error, style = OmType.Body, color = Om.Danger, modifier = Modifier.weight(1f))
        androidx.compose.material3.TextButton(onClick = { runner.clearOutcome() }) { Text("知道了", color = Om.Faint) }
      }
    }

    Box(Modifier.weight(1f)) {
      when (tab) {
        0 -> NeteaseSearchPane { pending = it }
        else -> NeteaseLinkPane { pending = it }
      }
    }
  }

  pending?.let { request ->
    ImportTargetSheet(
      url = request.url,
      title = request.label,
      busy = runner.busy != null,
      onStart = { folderId, folderName, subdirectory ->
        runner.start(request.url, folderId, subdirectory, folderName + if (subdirectory.isEmpty()) "" else "/$subdirectory")
      },
      onDismiss = { pending = null },
    )
  }

  runner.outcome?.let { result ->
    ImportResultSheet(result = result, onDismiss = { runner.clearOutcome() }, openTrack = openTrack)
  }
}

// ── 搜索模式：显式提交 → ≤5 条候选 ─────────────────────────

@Composable
private fun NeteaseSearchPane(onPick: (NeteaseImportRequest) -> Unit) {
  var query by remember { mutableStateOf("") }
  var searching by remember { mutableStateOf(false) }
  var results by remember { mutableStateOf<List<NeteaseCandidate>?>(null) }
  var error by remember { mutableStateOf<String?>(null) }
  val scope = rememberCoroutineScope()

  fun submit() {
    val q = query.trim()
    if (q.isEmpty() || searching) return
    searching = true
    error = null
    scope.launch {
      val outcome = withContext(Dispatchers.IO) { runCatching { OpenMusicApp.api.neteaseSearch(q) } }
      searching = false
      outcome.fold(
        onSuccess = { results = it },
        onFailure = { results = null; error = it.message ?: it.toString() },
      )
    }
  }

  Column(Modifier.fillMaxSize()) {
    TextField(
      value = query,
      onValueChange = { query = it; error = null },
      placeholder = { Text("歌名 / 歌手 / 专辑关键词", color = Om.Faint) },
      leadingIcon = { Icon(OmIcons.Search, contentDescription = null, tint = Om.Faint, modifier = Modifier.size(18.dp)) },
      trailingIcon = {
        androidx.compose.material3.IconButton(onClick = { submit() }, enabled = !searching) {
          Icon(OmIcons.ChevronRight, contentDescription = "搜索", tint = if (searching) Om.Faint else Om.Dim, modifier = Modifier.size(18.dp))
        }
      },
      singleLine = true,
      keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
      keyboardActions = KeyboardActions(onSearch = { submit() }),
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

    Box(Modifier.weight(1f)) {
      val list = results
      when {
        searching -> LoadingView(Modifier.fillMaxSize())
        error != null -> ErrorView(error ?: "", retry = null, modifier = Modifier.fillMaxSize())
        list == null -> EmptyView("输入关键词后按搜索键——网易云搜索每次最多返回 5 条候选")
        list.isEmpty() -> EmptyView("没有找到「$query」的候选，换个短一点的关键词")
        else -> LazyColumn(contentPadding = PaddingValues(top = 8.dp, bottom = 20.dp)) {
          itemsIndexed(list, key = { _, c -> c.songId }) { _, candidate ->
            CandidateRow(candidate) {
              onPick(
                NeteaseImportRequest(
                  url = candidate.url,
                  label = "${candidate.title} — ${candidate.artist}",
                ),
              )
            }
          }
        }
      }
    }
  }
}

@Composable
private fun CandidateRow(candidate: NeteaseCandidate, onClick: () -> Unit) {
  Row(
    Modifier
      .fillMaxWidth()
      .clickable(onClick = onClick)
      .padding(horizontal = 20.dp, vertical = 11.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Column(Modifier.weight(1f)) {
      Row(verticalAlignment = Alignment.CenterVertically) {
        Text(candidate.title, style = OmType.Row, color = Om.Paper, maxLines = 1, overflow = TextOverflow.Ellipsis)
        if (candidate.vip) {
          Spacer(Modifier.width(8.dp))
          Text("VIP/付费", style = OmType.Meta, color = Om.Danger)
        }
      }
      Text(
        "${candidate.artist} · ${candidate.album}",
        style = OmType.Meta, color = Om.Dim, maxLines = 1, overflow = TextOverflow.Ellipsis,
      )
      if (candidate.vip) {
        Text("VIP/付费歌曲匿名拿不到完整版，导入时会被明确跳过。", style = OmType.Meta, color = Om.Faint)
      }
    }
    Text(candidate.songId, style = OmType.Readout, color = Om.Faint)
  }
}

// ── 链接模式：粘贴 → 本地解析（服务端语义平移）→ 目标选择 ──────────

@Composable
private fun NeteaseLinkPane(onPick: (NeteaseImportRequest) -> Unit) {
  var text by remember { mutableStateOf("") }
  val link = remember(text) { parseNeteaseLink(text) }

  Column(
    Modifier
      .fillMaxSize()
      .verticalScroll(rememberScrollState()),
  ) {
    TextField(
      value = text,
      onValueChange = { text = it },
      placeholder = { Text("https://music.163.com/song?id=5264842", color = Om.Faint) },
      leadingIcon = { Icon(OmIcons.Send, contentDescription = null, tint = Om.Faint, modifier = Modifier.size(18.dp)) },
      singleLine = true,
      keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
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
    Spacer(Modifier.height(12.dp))
    when {
      text.isBlank() -> EmptyView("粘贴单曲 / 歌单 / 专辑 / 歌手热门链接（支持 #/song、m/song/<id>、y. 前缀）")
      link == null -> Text(
        "无法识别该链接：仅接受 music.163.com 的 song / playlist / album / artist 页面地址。",
        style = OmType.Body, color = Om.Danger,
        modifier = Modifier.padding(horizontal = 20.dp),
      )
      else -> {
        Row(
          Modifier.padding(horizontal = 20.dp),
          verticalAlignment = Alignment.CenterVertically,
          horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
          Text("将导入：${link.kind.label}", style = OmType.Body, color = Om.Accent)
          Text("ID ${link.id}", style = OmType.Readout, color = Om.Dim)
        }
        Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp)) {
          Button(
            onClick = {
              onPick(NeteaseImportRequest(url = link.canonicalUrl, label = "${link.kind.label} · ${link.id}"))
            },
            colors = ButtonDefaults.buttonColors(containerColor = Om.Paper, contentColor = Om.Shell),
            shape = RoundedCornerShape(2.dp),
            modifier = Modifier.fillMaxWidth(),
          ) { Text("选择目标目录", style = OmType.Row) }
          Text(
            "歌单/专辑超过 25 首会被整组拒绝（需拆分）；链接规范化重建后才提交，不透传原始输入。",
            style = OmType.Meta, color = Om.Faint,
            modifier = Modifier.padding(top = 6.dp),
          )
        }
      }
    }
  }
}
