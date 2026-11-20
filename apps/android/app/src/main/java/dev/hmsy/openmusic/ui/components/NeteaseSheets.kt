package dev.hmsy.openmusic.ui.components

import android.widget.Toast
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.hmsy.openmusic.OpenMusicApp
import dev.hmsy.openmusic.core.Om
import dev.hmsy.openmusic.core.OmType
import dev.hmsy.openmusic.data.NeteaseChildren
import dev.hmsy.openmusic.data.NeteaseFile
import dev.hmsy.openmusic.data.NeteaseFolder
import dev.hmsy.openmusic.data.NeteaseImportResult
import dev.hmsy.openmusic.data.NeteaseSubdirectory
import dev.hmsy.openmusic.data.formatEpochMs
import dev.hmsy.openmusic.data.neteaseCountSummary
import dev.hmsy.openmusic.data.neteaseKindLabel
import dev.hmsy.openmusic.data.neteaseStateLabel
import dev.hmsy.openmusic.player.PlaybackService
import dev.hmsy.openmusic.ui.icons.OmIcons
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** 曲目操作 sheet（Sheets.kt 的 ActionRow 是 private；这里同款样式独立实现） */
@Composable
private fun SheetActionRow(label: String, description: String? = null, danger: Boolean = false, onClick: () -> Unit) {
  Row(
    Modifier
      .fillMaxWidth()
      .clickable(onClick = onClick)
      .padding(horizontal = 20.dp, vertical = 13.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Column(Modifier.weight(1f)) {
      Text(label, style = OmType.Body, color = if (danger) Om.Danger else Om.Paper)
      if (description != null) {
        Text(description, style = OmType.Meta, color = Om.Faint, maxLines = 1, overflow = TextOverflow.Ellipsis)
      }
    }
  }
}

@Composable
private fun SheetHeader(title: String, subtitle: String? = null) {
  Column(Modifier.padding(horizontal = 20.dp, vertical = 6.dp)) {
    Text(title, style = OmType.Title, color = Om.Paper)
    if (subtitle != null) {
      Text(subtitle, style = OmType.Meta, color = Om.Faint, maxLines = 2, overflow = TextOverflow.Ellipsis)
    }
  }
}

// ── 导入目标选择：曲库目录 + 子目录（浏览/手输）─────────────────

/**
 * 选定要导入的「url → 目录」组合后弹出：
 * - 目录来自 GET /imports/netease/folders（含 writable，不可写目录前置禁止提交）；
 * - 子目录可单层浏览（GET subdirectories，目录多时截断并提示手输）或手动输入（本地先按服务端规则校验）。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ImportTargetSheet(
  url: String,
  title: String,
  busy: Boolean,
  onStart: (folderId: String, folderName: String, subdirectory: String) -> String?,
  onDismiss: () -> Unit,
) {
  val (foldersState, reloadFolders) = rememberLoad { OpenMusicApp.api.neteaseFolders() }
  var selected by remember { mutableStateOf<NeteaseFolder?>(null) }
  var subdirectory by remember { mutableStateOf("") }
  var browsing by remember { mutableStateOf(false) }
  var manual by remember { mutableStateOf(false) }
  var manualText by remember { mutableStateOf("") }
  var startError by remember { mutableStateOf<String?>(null) }

  ModalBottomSheet(onDismissRequest = onDismiss, containerColor = Om.Panel) {
    Column(
      Modifier
        .fillMaxWidth()
        .verticalScroll(rememberScrollState())
        .padding(bottom = 24.dp),
    ) {
      SheetHeader("导入到…", title)
      if (busy) {
        Text(
          "已有一项导入在等待服务器结果，先等它完成再发起新的。",
          style = OmType.Meta, color = Om.Faint,
          modifier = Modifier.padding(horizontal = 20.dp, vertical = 4.dp),
        )
      }

      if (browsing && selected != null) {
        SubdirectoryBrowsePane(
          folder = selected!!,
          initial = subdirectory,
          onUse = { subdirectory = it; browsing = false },
          onCancel = { browsing = false },
        )
      } else {
        // ── 目录列表 ──
        val folders = foldersState.data
        when {
          folders == null && foldersState.error == null -> Text("加载目录中…", style = OmType.Meta, color = Om.Faint, modifier = Modifier.padding(20.dp))
          foldersState.error != null -> Column(Modifier.padding(horizontal = 20.dp, vertical = 6.dp)) {
            Text("目录读取失败：${foldersState.error}", style = OmType.Meta, color = Om.Danger)
            TextButton(onClick = reloadFolders) { Text("重试", color = Om.Accent) }
          }
          folders != null && folders.isEmpty() -> Text(
            "服务器上还没有已注册的曲库目录——请先在服务器管理里添加。",
            style = OmType.Meta, color = Om.Faint, modifier = Modifier.padding(20.dp),
          )
          else -> folders.orEmpty().forEach { folder ->
            val active = selected?.id == folder.id
            Row(
              Modifier
                .fillMaxWidth()
                .clickable(enabled = !busy) {
                  if (selected?.id != folder.id) subdirectory = ""
                  selected = folder
                }
                .padding(horizontal = 20.dp, vertical = 11.dp),
              verticalAlignment = Alignment.CenterVertically,
            ) {
              Icon(OmIcons.Disc, contentDescription = null, tint = if (active) Om.Accent else Om.Dim, modifier = Modifier.size(18.dp))
              Spacer(Modifier.width(12.dp))
              Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                  Text(folder.name, style = OmType.Row, color = Om.Paper, maxLines = 1, overflow = TextOverflow.Ellipsis)
                  if (!folder.writable) {
                    Spacer(Modifier.width(8.dp))
                    Text("不可写", style = OmType.Meta, color = Om.Danger)
                  }
                }
                Text(folder.path, style = OmType.Meta, color = Om.Faint, maxLines = 1, overflow = TextOverflow.Ellipsis)
              }
              if (active) {
                Spacer(Modifier.width(8.dp))
                Text("已选", style = OmType.Meta, color = Om.Accent)
              }
            }
          }
        }

        // ── 子目录行（选定目录后出现）──
        if (selected != null) {
          Spacer(Modifier.height(6.dp))
          Row(
            Modifier
              .fillMaxWidth()
              .clickable(enabled = !busy) { browsing = true }
              .padding(horizontal = 20.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
          ) {
            Column(Modifier.weight(1f)) {
              Text("子目录", style = OmType.Body, color = Om.Paper)
              Text(
                if (subdirectory.isEmpty()) "（曲库根目录）" else subdirectory,
                style = OmType.Readout, color = if (subdirectory.isEmpty()) Om.Faint else Om.Dim,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
              )
            }
            TextButton(onClick = { browsing = true }, enabled = !busy) { Text("浏览", color = Om.Accent) }
          }
          if (manual) {
            OutlinedTextField(
              value = manualText,
              onValueChange = { manualText = it },
              placeholder = { Text("相对子目录，如 网易云/新歌", style = OmType.Body, color = Om.Faint) },
              singleLine = true,
              isError = manualText.isNotEmpty() && !NeteaseSubdirectory.check(manualText),
              modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 20.dp, vertical = 2.dp),
            )
            if (manualText.isNotEmpty() && !NeteaseSubdirectory.check(manualText)) {
              Text(
                "子目录须 ≤360 字符、≤8 段、每段 1–100 字符，且不含「.」开头的段、反斜杠或冒号。",
                style = OmType.Meta, color = Om.Danger,
                modifier = Modifier.padding(horizontal = 20.dp),
              )
            }
            Row(Modifier.padding(horizontal = 12.dp)) {
              TextButton(
                onClick = {
                  if (NeteaseSubdirectory.check(manualText.trim())) {
                    subdirectory = manualText.trim()
                    manual = false
                    manualText = ""
                  }
                },
              ) { Text("使用该子目录", color = Om.Accent) }
              TextButton(onClick = { manual = false; manualText = "" }) { Text("收起", color = Om.Faint) }
            }
          } else {
            Row(Modifier.padding(horizontal = 12.dp)) {
              TextButton(onClick = { manual = true }, enabled = !busy) { Text("手动输入子目录", color = Om.Dim) }
              if (subdirectory.isNotEmpty()) {
                TextButton(onClick = { subdirectory = "" }) { Text("回到根目录", color = Om.Dim) }
              }
            }
          }
        }

        // ── 提交 ──
        startError?.let { Text(it, style = OmType.Meta, color = Om.Danger, modifier = Modifier.padding(horizontal = 20.dp, vertical = 4.dp)) }
        val sel = selected
        if (sel != null && !sel.writable) {
          Text("该目录当前不可写（或无法创建文件），请换一个目录。", style = OmType.Meta, color = Om.Danger, modifier = Modifier.padding(horizontal = 20.dp))
        }
        Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp)) {
          Button(
            onClick = {
              val folder = sel ?: return@Button
              val error = onStart(folder.id, folder.name, subdirectory)
              if (error == null) onDismiss() else startError = error
            },
            enabled = sel != null && sel.writable && !busy,
            colors = ButtonDefaults.buttonColors(containerColor = Om.Paper, contentColor = Om.Shell),
            shape = RoundedCornerShape(2.dp),
            modifier = Modifier.fillMaxWidth(),
          ) {
            Text(
              if (sel == null) "先选择一个曲库目录"
              else "开始导入 → ${sel.name}${if (subdirectory.isEmpty()) "" else "/$subdirectory"}",
              style = OmType.Row,
              maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
          }
          // 提交即同步等待终态；离开导入页不打断（NeteaseRunner 挂在 MainArea）
          Text(
            "点击后由服务器下载并入库，多曲可能需要几分钟；期间可以离开本页。",
            style = OmType.Meta, color = Om.Faint,
            modifier = Modifier.padding(top = 6.dp),
          )
        }
      }
    }
  }
}

/** 单层子目录浏览：路径逐段下钻，截断时退回手动输入 */
@Composable
private fun SubdirectoryBrowsePane(
  folder: NeteaseFolder,
  initial: String,
  onUse: (String) -> Unit,
  onCancel: () -> Unit,
) {
  var path by remember { mutableStateOf(initial) }
  var children by remember { mutableStateOf<NeteaseChildren?>(null) }
  var error by remember { mutableStateOf<String?>(null) }
  var nonce by remember { mutableIntStateOf(0) }

  LaunchedEffect(folder.id, path, nonce) {
    children = null
    error = null
    runCatching { OpenMusicApp.api.neteaseSubdirectories(folder.id, path) }.fold(
      onSuccess = { children = it },
      onFailure = { error = it.message ?: it.toString() },
    )
  }

  Column(Modifier.fillMaxWidth().padding(bottom = 12.dp)) {
    SheetHeader(
      "选择子目录（${folder.name}）",
      if (path.isEmpty()) "当前：曲库根目录" else "当前：$path",
    )
    Row(Modifier.padding(horizontal = 12.dp)) {
      TextButton(onClick = { onUse(path) }) { Text("使用当前目录", color = Om.Accent) }
      if (path.isNotEmpty()) TextButton(onClick = { path = NeteaseSubdirectory.parent(path) }) { Text("上一级", color = Om.Dim) }
      TextButton(onClick = onCancel) { Text("返回", color = Om.Faint) }
    }
    when {
      error != null -> Column(Modifier.padding(horizontal = 20.dp, vertical = 4.dp)) {
        Text("子目录读取失败：$error", style = OmType.Meta, color = Om.Danger)
        TextButton(onClick = { nonce++ }) { Text("重试", color = Om.Accent) }
      }
      children == null -> Text("读取中…", style = OmType.Meta, color = Om.Faint, modifier = Modifier.padding(horizontal = 20.dp, vertical = 6.dp))
      children?.directories?.isEmpty() == true -> Text(
        "该目录下没有子目录；可直接「使用当前目录」。",
        style = OmType.Meta, color = Om.Faint, modifier = Modifier.padding(horizontal = 20.dp, vertical = 6.dp),
      )
      else -> {
        children?.directories?.forEach { dir ->
          val segment = dir.substringAfterLast('/')
          SheetActionRow(
            label = segment,
            description = dir,
            onClick = { path = dir },
          )
        }
        if (children?.truncated == true) {
          Text(
            "子目录过多已截断显示——可用「手动输入子目录」直接填相对路径。",
            style = OmType.Meta, color = Om.Faint,
            modifier = Modifier.padding(horizontal = 20.dp, vertical = 6.dp),
          )
        }
      }
    }
  }
}

// ── 导入结果：计数 / 文件 / 失败 / 警告 + 播放入队 ───────────────

/** 终态结果面板（来源无关的形状：与 YouTube ImportResult 同形，将来可直接复用） */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ImportResultSheet(
  result: NeteaseImportResult,
  onDismiss: () -> Unit,
  openTrack: (String) -> Unit,
) {
  val scope = rememberCoroutineScope()
  val context = LocalContext.current
  var loadingTracks by remember { mutableStateOf(false) }

  fun playTracks(enqueue: Boolean) {
    if (loadingTracks) return
    loadingTracks = true
    scope.launch {
      // 与 AssistantBridge 的 play 卡片同语义：按 id 逐个拉全量 TrackSummary 后交给队列
      val outcome = withContext(Dispatchers.IO) {
        runCatching { result.trackIds.map { id -> OpenMusicApp.api.track(id.toString()) } }
      }
      loadingTracks = false
      outcome.fold(
        onSuccess = { tracks ->
          if (enqueue) PlaybackService.enqueue(tracks) else PlaybackService.setQueue(tracks, 0)
          Toast.makeText(
            context,
            if (enqueue) "已加入队列（${tracks.size} 首）" else "开始播放导入的 ${tracks.size} 首",
            Toast.LENGTH_SHORT,
          ).show()
        },
        onFailure = { e ->
          Toast.makeText(context, "曲目读取失败：${e.message ?: e.toString()}", Toast.LENGTH_SHORT).show()
        },
      )
    }
  }

  ModalBottomSheet(onDismissRequest = onDismiss, containerColor = Om.Panel) {
    Column(
      Modifier
        .fillMaxWidth()
        .verticalScroll(rememberScrollState())
        .padding(bottom = 24.dp),
    ) {
      val stateColor = when (result.state) {
        "done" -> Om.Accent
        "failed" -> Om.Danger
        else -> Om.Paper
      }
      SheetHeader("${neteaseStateLabel(result.state)} · ${neteaseKindLabel(result.kind)}导入", neteaseCountSummary(result))
      Text(
        "已保存到 ${result.destination}",
        style = OmType.Readout, color = Om.Dim,
        maxLines = 2, overflow = TextOverflow.Ellipsis,
        modifier = Modifier.padding(horizontal = 20.dp, vertical = 2.dp),
      )
      Spacer(Modifier.height(8.dp))

      if (result.files.isNotEmpty()) {
        Text("已入库 ${result.files.size}", style = OmType.Meta, color = Om.Faint, modifier = Modifier.padding(horizontal = 20.dp))
        result.files.forEach { file -> FileRow(file) { openTrack(file.trackId.toString()) } }
      }
      if (result.failures.isNotEmpty()) {
        Text("未导入 ${result.failures.size}", style = OmType.Meta, color = Om.Danger, modifier = Modifier.padding(horizontal = 20.dp, vertical = 4.dp))
        result.failures.forEach { failure ->
          MessageRow(songId = failure.songId, message = failure.reason.ifBlank { "未导入" }, danger = true)
        }
      }
      if (result.warnings.isNotEmpty()) {
        Text("提示 ${result.warnings.size}", style = OmType.Meta, color = Om.Faint, modifier = Modifier.padding(horizontal = 20.dp, vertical = 4.dp))
        result.warnings.forEach { warning ->
          MessageRow(songId = warning.songId, message = warning.message.ifBlank { "提示" }, danger = false)
        }
      }
      if (result.failures.isEmpty() && result.warnings.isEmpty() && result.files.isEmpty()) {
        Text("没有可入库的曲目。", style = OmType.Meta, color = Om.Faint, modifier = Modifier.padding(horizontal = 20.dp, vertical = 6.dp))
      }

      Row(Modifier.padding(horizontal = 12.dp, vertical = 10.dp)) {
        Button(
          onClick = { playTracks(false) },
          enabled = result.trackIds.isNotEmpty() && !loadingTracks,
          colors = ButtonDefaults.buttonColors(containerColor = Om.Paper, contentColor = Om.Shell),
          shape = RoundedCornerShape(2.dp),
        ) { Text(if (loadingTracks) "读取曲目中…" else "立即播放", style = OmType.Row) }
        Spacer(Modifier.width(10.dp))
        Button(
          onClick = { playTracks(true) },
          enabled = result.trackIds.isNotEmpty() && !loadingTracks,
          colors = ButtonDefaults.buttonColors(containerColor = Om.Raised, contentColor = Om.Paper),
          shape = RoundedCornerShape(2.dp),
        ) { Text("加入队列", style = OmType.Row) }
        Spacer(Modifier.width(10.dp))
        TextButton(onClick = onDismiss) { Text("关闭", color = Om.Faint) }
      }
      Text(
        "点「已入库」中的文件可打开网易云来源管理（元数据 / 移出 / 删除申请）。",
        style = OmType.Meta, color = Om.Faint,
        modifier = Modifier.padding(horizontal = 20.dp),
      )
    }
  }
}

@Composable
private fun FileRow(file: NeteaseFile, onClick: () -> Unit) {
  Row(
    Modifier
      .fillMaxWidth()
      .clickable(onClick = onClick)
      .padding(horizontal = 20.dp, vertical = 9.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Icon(OmIcons.Disc, contentDescription = null, tint = Om.Dim, modifier = Modifier.size(16.dp))
    Spacer(Modifier.width(10.dp))
    Column(Modifier.weight(1f)) {
      Text(file.name, style = OmType.Readout, color = Om.Paper, maxLines = 1, overflow = TextOverflow.Ellipsis)
      Text("点按管理来源", style = OmType.Meta, color = Om.Faint)
    }
  }
}

@Composable
private fun MessageRow(songId: String, message: String, danger: Boolean) {
  Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 4.dp)) {
    Column {
      Text(message, style = OmType.Meta, color = if (danger) Om.Danger else Om.Dim)
      Text(songId, style = OmType.Readout, color = Om.Faint)
    }
  }
}

/** 删除票据过期时间等统一展示 */
@Composable
internal fun NeteaseExpiryText(expiresAtMs: Long, modifier: Modifier = Modifier) {
  Text("有效期至 ${formatEpochMs(expiresAtMs)}（本地时区）", style = OmType.Meta, color = Om.Faint, modifier = modifier)
}
