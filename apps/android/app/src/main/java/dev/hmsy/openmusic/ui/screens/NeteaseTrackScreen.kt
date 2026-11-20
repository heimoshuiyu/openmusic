package dev.hmsy.openmusic.ui.screens

import android.widget.Toast
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.hmsy.openmusic.OpenMusicApp
import dev.hmsy.openmusic.core.Om
import dev.hmsy.openmusic.core.OmType
import dev.hmsy.openmusic.data.ApiError
import dev.hmsy.openmusic.data.NETEASE_REMOVED_GUIDANCE
import dev.hmsy.openmusic.data.NeteaseDeletionRequest
import dev.hmsy.openmusic.data.NeteaseDeletionReview
import dev.hmsy.openmusic.data.NeteaseInfo
import dev.hmsy.openmusic.data.NeteaseTrackState
import dev.hmsy.openmusic.data.formatSizeBytes
import dev.hmsy.openmusic.data.neteaseCoverUrlOk
import dev.hmsy.openmusic.data.neteaseLabelOk
import dev.hmsy.openmusic.data.neteasePositionTextOk
import dev.hmsy.openmusic.data.neteaseRemovedFileLine
import dev.hmsy.openmusic.data.neteaseTagsFormOk
import dev.hmsy.openmusic.data.neteaseTagsPatch
import dev.hmsy.openmusic.data.neteaseTrackState
import dev.hmsy.openmusic.data.neteaseTrackUnreachableMessage
import dev.hmsy.openmusic.data.neteaseUnindexDialogBody
import dev.hmsy.openmusic.ui.icons.OmIcons
import dev.hmsy.openmusic.ui.components.DetailTopBar
import dev.hmsy.openmusic.ui.components.ErrorView
import dev.hmsy.openmusic.ui.components.LoadingView
import dev.hmsy.openmusic.ui.components.NeteaseExpiryText
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * 网易云来源管理屏（路由 netease-track/{id}）。
 *
 * 入口：导入结果面板的文件行 / 任意曲目的长按操作 sheet「网易云来源…」。
 * info 由用户触发后才懒加载——非网易云曲目得到 404 时给出明确说明，
 * 绝不做全列表无界探测。
 *
 * 能力：
 * - 查看来源信息（songId / 音质 / 格式 / 文件名 / 警告）；
 * - 编辑固定元数据（只提交显式变更过的字段；服务端标签非空、位置 1..9999，本地同规则校验）；
 *   封面支持「恢复网易云封面」与 https 的 *.music.126.net 图片 URL；
 * - 移出曲库（二次确认，索引删除、磁盘文件原样保留）；
 * - 申请删除原文件 → 本人人工核对（必须逐字输入完整文件名 + token 兑现，可取消）。
 *   删除绝不做成一键操作；token 只在内存中保存。
 */
@Composable
fun NeteaseTrackScreen(trackId: String, onBack: () -> Unit) {
  var info by remember { mutableStateOf<NeteaseInfo?>(null) }
  var failure by remember { mutableStateOf<Pair<Int, String>?>(null) }
  var reload by remember { mutableIntStateOf(0) }
  // 移出成功终态：只记录展示值，不再发任何已知会 404 的 info 请求，也不把成功当失败
  var removed by remember { mutableStateOf<String?>(null) }

  LaunchedEffect(trackId, reload) {
    info = null
    failure = null
    runCatching { OpenMusicApp.api.neteaseInfo(trackId) }.fold(
      onSuccess = { info = it },
      onFailure = { e ->
        val status = (e as? ApiError)?.status ?: 0
        failure = status to (e.message ?: e.toString())
      },
    )
  }

  Column(
    Modifier
      .fillMaxSize()
      .verticalScroll(rememberScrollState()),
  ) {
    Box(Modifier.padding(horizontal = 12.dp)) { DetailTopBar("网易云来源 · 管理", onBack) }
    when (val state = neteaseTrackState(info, failure, removed)) {
      is NeteaseTrackState.Loading -> LoadingView(Modifier.fillMaxWidth())
      is NeteaseTrackState.Unreachable -> ErrorView(
        message = neteaseTrackUnreachableMessage(state.status, state.message),
        // 404 是终态（非网易云曲目/已移出）：重试只会再发一次已知会 404 的请求
        retry = if (state.status == 404) null else ({ reload++ }),
        modifier = Modifier.fillMaxWidth(),
      )
      is NeteaseTrackState.Ready -> {
        NeteaseSourceSection(state.info)
        NeteaseTagsSection(state.info, onSaved = { info = it })
        Spacer(Modifier.height(8.dp))
        NeteaseDangerSection(state.info, onRemoved = { removed = state.info.filename })
      }
      is NeteaseTrackState.Removed -> NeteaseRemovedCard(state.filename, onBack)
    }
  }
}

/** 移出成功终态卡：明确的成功展示 + 返回出口（替代先前直接 pop 回到可能已失效的上级页） */
@Composable
private fun NeteaseRemovedCard(filename: String, onBack: () -> Unit) {
  Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 40.dp), horizontalAlignment = Alignment.CenterHorizontally) {
    Icon(OmIcons.Check, contentDescription = null, tint = Om.Accent, modifier = Modifier.size(30.dp))
    Spacer(Modifier.height(10.dp))
    Text("已移出曲库", style = OmType.Title, color = Om.Paper)
    Spacer(Modifier.height(6.dp))
    Text(neteaseRemovedFileLine(filename), style = OmType.Readout, color = Om.Dim, maxLines = 1, overflow = TextOverflow.Ellipsis)
    Spacer(Modifier.height(6.dp))
    Text(
      NETEASE_REMOVED_GUIDANCE,
      style = OmType.Meta, color = Om.Faint,
      modifier = Modifier.padding(horizontal = 8.dp),
    )
    Spacer(Modifier.height(18.dp))
    Button(
      onClick = onBack,
      colors = ButtonDefaults.buttonColors(containerColor = Om.Paper, contentColor = Om.Shell),
      shape = RoundedCornerShape(2.dp),
    ) { Text("返回", style = OmType.Row) }
  }
}

// ── 来源信息（只读）─────────────────────────────────────

@Composable
private fun SectionLabel(text: String, modifier: Modifier = Modifier) {
  Text(text, style = OmType.Meta, color = Om.Faint, modifier = modifier.padding(start = 20.dp, top = 22.dp, bottom = 6.dp))
}

@Composable
private fun InfoRow(label: String, value: String, mono: Boolean = false, danger: Boolean = false) {
  Row(
    Modifier
      .fillMaxWidth()
      .padding(horizontal = 20.dp, vertical = 5.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Text(label, style = OmType.Body, color = Om.Dim, modifier = Modifier.width(88.dp))
    Text(
      value,
      style = if (mono) OmType.Readout else OmType.Body,
      color = if (danger) Om.Danger else Om.Paper,
      maxLines = 2,
      overflow = TextOverflow.Ellipsis,
    )
  }
}

@Composable
private fun NeteaseSourceSection(info: NeteaseInfo) {
  SectionLabel("来源")
  InfoRow("文件", info.filename, mono = true)
  InfoRow("格式", info.format.uppercase())
  InfoRow("网易云 ID", info.songId, mono = true)
  InfoRow("音质", info.quality ?: "—")
  InfoRow("内嵌封面", if (info.hasCover) "有" else "无")
  info.warnings.forEach { warning ->
    Row(
      Modifier
        .fillMaxWidth()
        .padding(horizontal = 20.dp, vertical = 3.dp),
      verticalAlignment = Alignment.Top,
    ) {
      Icon(OmIcons.CircleAlert, contentDescription = null, tint = Om.Faint, modifier = Modifier.size(13.dp))
      Spacer(Modifier.width(8.dp))
      Text(warning, style = OmType.Meta, color = Om.Faint)
    }
  }
}

// ── 元数据编辑（只提交变更过的字段）───────────────────────────

@Composable
private fun NeteaseTagsSection(info: NeteaseInfo, onSaved: (NeteaseInfo) -> Unit) {
  val context = LocalContext.current
  val scope = rememberCoroutineScope()
  var saving by remember { mutableStateOf(false) }
  var saveError by remember { mutableStateOf<String?>(null) }

  // 表单随 info 快照重置：保存成功（服务端返回新 info）后字段回填为已保存值
  var title by remember(info) { mutableStateOf(info.title) }
  var artist by remember(info) { mutableStateOf(info.artist) }
  var album by remember(info) { mutableStateOf(info.album) }
  var albumArtist by remember(info) { mutableStateOf(info.albumArtist.orEmpty()) }
  var genre by remember(info) { mutableStateOf(info.genre.orEmpty()) }
  var trackText by remember(info) { mutableStateOf(info.trackNumber?.toString().orEmpty()) }
  var discText by remember(info) { mutableStateOf(info.discNumber?.toString().orEmpty()) }
  var coverMode by remember(info) { mutableStateOf(0) } // 0=保持 1=恢复网易云封面 2=图片 URL
  var coverUrl by remember { mutableStateOf("") }

  // 提交前置校验（纯函数）：必填非空合法；可选字段留空合法（清除企图由 patch.unsupportedClears 处理），
  // 非空时同样须过 label 校验——301+ 字符/控制字符在本地拦截，不留给服务端 422
  val formOk = neteaseTagsFormOk(title, artist, album, albumArtist, genre, trackText, discText)
  val coverOk = coverMode != 2 || neteaseCoverUrlOk(coverUrl.trim())
  // 载荷 = 唯一裁决点：变更才提交；清除已设值不会发出空串（服务端 NonEmptyString 拒绝）
  val patch = neteaseTagsPatch(
    info = info,
    title = title,
    artist = artist,
    album = album,
    albumArtist = albumArtist,
    genre = genre,
    trackText = trackText,
    discText = discText,
    cover = when (coverMode) {
      1 -> "netease"
      2 -> coverUrl.trim().takeIf(::neteaseCoverUrlOk)
      else -> null
    },
  )

  SectionLabel("元数据")
  TagField("曲名", title, { title = it }, single = true)
  TagField("歌手", artist, { artist = it }, single = true)
  TagField("专辑", album, { album = it }, single = true)
  TagField("专辑作者", albumArtist, { albumArtist = it }, single = true, optional = true)
  TagField("流派", genre, { genre = it }, single = true, optional = true)
  Row(Modifier.padding(horizontal = 20.dp).fillMaxWidth()) {
    Box(Modifier.weight(1f)) {
      TagField("曲目号", trackText, { trackText = it }, single = true, optional = true, number = true)
    }
    Spacer(Modifier.width(12.dp))
    Box(Modifier.weight(1f)) {
      TagField("碟号", discText, { discText = it }, single = true, optional = true, number = true)
    }
  }
  Text(
    "文本标签不能为空（留空 = 保持不变）；曲目号/碟号留空 = 保持不变，填写须为 1–9999。",
    style = OmType.Meta, color = Om.Faint,
    modifier = Modifier.padding(horizontal = 20.dp, vertical = 2.dp),
  )

  SectionLabel("封面")
  CoverModeRow(0, coverMode, "保持当前封面", if (info.hasCover) "文件已有内嵌封面" else "当前无内嵌封面") { coverMode = 0 }
  CoverModeRow(1, coverMode, "恢复网易云封面", "重新内嵌导入时的网易云封面（暂不支持从本地相册选图）") { coverMode = 1 }
  CoverModeRow(2, coverMode, "指定图片 URL", "https 的 *.music.126.net 图片，无参数/锚点，.jpg/.jpeg/.png/.webp") { coverMode = 2 }
  if (coverMode == 2) {
    OutlinedTextField(
      value = coverUrl,
      onValueChange = { coverUrl = it },
      placeholder = { Text("https://p1.music.126.net/….jpg", style = OmType.Body, color = Om.Faint) },
      singleLine = true,
      isError = coverUrl.isNotBlank() && !neteaseCoverUrlOk(coverUrl.trim()),
      modifier = Modifier
        .fillMaxWidth()
        .padding(horizontal = 20.dp, vertical = 4.dp),
    )
    if (coverUrl.isNotBlank() && !neteaseCoverUrlOk(coverUrl.trim())) {
      Text(
        "封面 URL 须为 https、主机名以 .music.126.net 结尾、无参数/锚点，且以 .jpg/.jpeg/.png/.webp 结尾。",
        style = OmType.Meta, color = Om.Danger, modifier = Modifier.padding(horizontal = 20.dp),
      )
    }
  }

  saveError?.let { Text(it, style = OmType.Meta, color = Om.Danger, modifier = Modifier.padding(horizontal = 20.dp, vertical = 4.dp)) }
  if (patch.unsupportedClears.isNotEmpty()) {
    Text(
      "暂不支持清除已设值：${patch.unsupportedClears.joinToString("、")}。留空 = 保持不变；请恢复原值或填入新值。",
      style = OmType.Meta, color = Om.Danger,
      modifier = Modifier.padding(horizontal = 20.dp, vertical = 4.dp),
    )
  }
  Row(Modifier.padding(horizontal = 12.dp, vertical = 8.dp)) {
    Button(
      onClick = {
        if (saving) return@Button
        saving = true
        saveError = null
        scope.launch {
          val outcome = withContext(Dispatchers.IO) {
            runCatching {
              OpenMusicApp.api.neteaseEditTags(
                trackId = info.trackId,
                title = patch.title,
                artist = patch.artist,
                album = patch.album,
                albumArtist = patch.albumArtist,
                genre = patch.genre,
                trackNumber = patch.trackNumber,
                discNumber = patch.discNumber,
                cover = patch.cover,
              )
            }
          }
          saving = false
          outcome.fold(
            onSuccess = { updated ->
              coverMode = 0
              coverUrl = ""
              onSaved(updated)
              Toast.makeText(context, "元数据已保存", Toast.LENGTH_SHORT).show()
            },
            onFailure = { e -> saveError = "保存失败：${e.message ?: e.toString()}" },
          )
        }
      },
      enabled = patch.isDirty && patch.unsupportedClears.isEmpty() && formOk && coverOk && !saving,
      colors = ButtonDefaults.buttonColors(containerColor = Om.Paper, contentColor = Om.Shell),
      shape = RoundedCornerShape(2.dp),
    ) { Text(if (saving) "保存中…" else "保存元数据", style = OmType.Row) }
  }
}

@Composable
private fun TagField(
  label: String,
  value: String,
  onValueChange: (String) -> Unit,
  single: Boolean,
  optional: Boolean = false,
  number: Boolean = false,
) {
  val invalid = when {
    number -> !neteasePositionTextOk(value)
    optional -> value.isNotEmpty() && !neteaseLabelOk(value)
    else -> !neteaseLabelOk(value)
  }
  Column(Modifier.padding(horizontal = 20.dp, vertical = 4.dp)) {
    OutlinedTextField(
      value = value,
      onValueChange = onValueChange,
      placeholder = { Text(if (optional) "$label（留空 = 保持不变）" else label, style = OmType.Body, color = Om.Faint) },
      singleLine = single,
      isError = invalid,
      modifier = Modifier.fillMaxWidth(),
    )
    if (invalid) {
      Text(
        if (number) "须为空或 1–9999 的整数" else "标签须非空、≤300 字符且不含控制字符",
        style = OmType.Meta, color = Om.Danger,
      )
    }
  }
}

@Composable
private fun CoverModeRow(mode: Int, current: Int, label: String, description: String, onSelect: () -> Unit) {
  Row(
    Modifier
      .fillMaxWidth()
      .clickable(onClick = onSelect)
      .padding(horizontal = 20.dp, vertical = 8.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Icon(
      if (current == mode) OmIcons.Check else OmIcons.Square,
      contentDescription = null,
      tint = if (current == mode) Om.Accent else Om.Dim,
      modifier = Modifier.size(15.dp),
    )
    Spacer(Modifier.width(10.dp))
    Column {
      Text(label, style = OmType.Body, color = Om.Paper)
      Text(description, style = OmType.Meta, color = Om.Faint)
    }
  }
}

// ── 危险区：移出曲库 + 删除申请（人工核对）──────────────────────

@Composable
private fun NeteaseDangerSection(info: NeteaseInfo, onRemoved: () -> Unit) {
  val context = LocalContext.current
  val scope = rememberCoroutineScope()

  var showUnindex by remember { mutableStateOf(false) }
  var busy by remember { mutableStateOf<String?>(null) } // 进行中的操作名
  var ticket by remember { mutableStateOf<NeteaseDeletionRequest?>(null) }
  var review by remember { mutableStateOf<NeteaseDeletionReview?>(null) }
  var flowError by remember { mutableStateOf<String?>(null) }

  /** 票据失效（过期/不存在/已被消费）→ 本地状态一并作废，恢复「申请删除原文件」入口 */
  fun ticketInvalid(message: String) {
    ticket = null
    review = null
    flowError = message
  }

  /** onFail 返回 true = 已按票据失效处理（404/400 视为票据不存在或已消费） */
  fun runFlow(
    name: String,
    action: suspend () -> Unit,
    onDone: () -> Unit,
    onFail: ((Throwable) -> Boolean)? = null,
  ) {
    if (busy != null) return
    busy = name
    flowError = null
    scope.launch {
      val outcome = withContext(Dispatchers.IO) { runCatching { action() } }
      busy = null
      outcome.fold(
        onSuccess = { onDone() },
        onFailure = { e ->
          if (onFail?.invoke(e) != true) flowError = "操作失败：${e.message ?: e.toString()}"
        },
      )
    }
  }

  /** 删除流里的 404/400：票据过期、不存在或已被消费——不要只把「404」抛给用户 */
  fun ticketMiss(e: Throwable): Boolean {
    val status = (e as? ApiError)?.status
    return status == 400 || status == 404
  }

  SectionLabel("危险区")
  flowError?.let { Text(it, style = OmType.Meta, color = Om.Danger, modifier = Modifier.padding(horizontal = 20.dp, vertical = 4.dp)) }

  Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp)) {
    Button(
      onClick = { showUnindex = true },
      enabled = busy == null,
      colors = ButtonDefaults.buttonColors(containerColor = Om.Raised, contentColor = Om.Paper),
      shape = RoundedCornerShape(2.dp),
      modifier = Modifier.fillMaxWidth(),
    ) { Text("移出曲库（保留文件）", style = OmType.Row) }
    Text(
      "只删除曲库索引，磁盘上的文件原样保留；播放记录保留（曲目从列表消失）。",
      style = OmType.Meta, color = Om.Faint,
      modifier = Modifier.padding(top = 6.dp),
    )
    Spacer(Modifier.height(12.dp))
    Button(
      onClick = { runFlow("request", { ticket = OpenMusicApp.api.neteaseRequestDeletion(info.trackId) }, {}) },
      enabled = busy == null && ticket == null,
      colors = ButtonDefaults.buttonColors(containerColor = Om.Danger, contentColor = Color.White),
      shape = RoundedCornerShape(2.dp),
      modifier = Modifier.fillMaxWidth(),
    ) { Text(if (busy == "request") "创建申请中…" else "申请删除原文件", style = OmType.Row) }
    Text(
      "进入人工核对流程：申请后由你本人逐字输入完整文件名确认，才会真正删除磁盘文件。",
      style = OmType.Meta, color = Om.Faint,
      modifier = Modifier.padding(top = 6.dp),
    )
  }

  ticket?.let { t ->
    SectionLabel("删除申请（待人工核对）")
    // 本地过期判定：过期票据禁用核对入口，只能取消后重新申请
    val expired = t.expiresAt > 0 && t.expiresAt <= System.currentTimeMillis()
    Column(Modifier.padding(horizontal = 20.dp, vertical = 4.dp)) {
      Text(
        "申请已创建。核对票据只在本机内存中继续，也可稍后在 Web 端核对页处理：",
        style = OmType.Meta, color = Om.Dim,
      )
      Text("票据 ${t.requestId}", style = OmType.Readout, color = Om.Dim)
      Text("Web 核对路径 ${t.reviewPath}", style = OmType.Readout, color = Om.Faint, maxLines = 1, overflow = TextOverflow.Ellipsis)
      NeteaseExpiryText(t.expiresAt)
      if (expired) {
        Text("票据已过期——请「取消申请」后重新发起。", style = OmType.Meta, color = Om.Danger, modifier = Modifier.padding(top = 4.dp))
      }
      Spacer(Modifier.height(6.dp))
      Row {
        Button(
          onClick = { runFlow("review", { review = OpenMusicApp.api.neteaseReviewDeletion(t.requestId) }, {}) { e ->
            if (ticketMiss(e)) {
              ticketInvalid("删除票据已过期或不存在——请重新申请删除。")
              true
            } else false
          } },
          enabled = busy == null && !expired,
          colors = ButtonDefaults.buttonColors(containerColor = Om.Paper, contentColor = Om.Shell),
          shape = RoundedCornerShape(2.dp),
        ) { Text(if (busy == "review") "读取中…" else "打开人工核对", style = OmType.Row) }
        Spacer(Modifier.width(10.dp))
        TextButton(
          onClick = {
            runFlow(
              "cancel",
              { OpenMusicApp.api.neteaseCancelDeletion(t.requestId) },
              { ticket = null; review = null },
            ) { e ->
              if (ticketMiss(e)) {
                ticketInvalid("票据已不存在（可能已过期或已被使用）——流程已重置，可重新申请。")
                true
              } else false
            }
          },
          enabled = busy == null,
        ) { Text(if (expired) "取消过期票据" else "取消申请", color = Om.Faint) }
      }
    }
  }

  review?.let { r ->
    DeletionReviewSheet(
      review = r,
      key = ticket?.requestId ?: "",
      onConfirmed = {
        ticket = null
        review = null
        Toast.makeText(context, "删除已兑现：磁盘文件已移除。", Toast.LENGTH_LONG).show()
        onRemoved()
      },
      // confirm 失败且票据已失效（400/404）：清票恢复重新申请入口，附可操作文案
      onTicketConsumed = { message -> ticketInvalid(message) },
      onCancelTicket = {
        runFlow(
          "cancel",
          { OpenMusicApp.api.neteaseCancelDeletion(ticket?.requestId ?: "") },
          { ticket = null; review = null },
        ) { e ->
          if (ticketMiss(e)) {
            ticketInvalid("票据已不存在（可能已过期或已被使用）——流程已重置，可重新申请。")
            true
          } else false
        }
      },
      onDismiss = { review = null },
    )
  }

  if (showUnindex) {
    AlertDialog(
      onDismissRequest = { showUnindex = false },
      containerColor = Om.Panel,
      title = { Text("移出曲库？", style = OmType.Title, color = Om.Paper) },
      text = {
        Column {
          Text("将把「${info.title}」从曲库索引中移除。", style = OmType.Body, color = Om.Paper)
          Spacer(Modifier.height(8.dp))
          Text(neteaseUnindexDialogBody(info.filename), style = OmType.Meta, color = Om.Dim)
        }
      },
      confirmButton = {
        TextButton(
          onClick = {
            showUnindex = false
            // 成功 = 屏内终态卡（不再 pop 回可能因专辑清空而失效的上级页，也不再重发 info）
            runFlow("unindex", { OpenMusicApp.api.neteaseUnindex(info.trackId) }, { onRemoved() })
          },
        ) { Text("确认移出", color = Om.Danger) }
      },
      dismissButton = { TextButton(onClick = { showUnindex = false }) { Text("取消", color = Om.Faint) } },
    )
  }
}

/**
 * 人工核对面板：展示曲目/路径/大小/过期时间；必须逐字输入完整 filename（与展示值完全一致）
 * 才允许确认；确认同时携带 review 发放的 token。绝不提供一键删除。
 *
 * confirm 失败的两种处理：
 * - 400/404（服务端在校验通过后即消费票据，物理删除失败也要求重新申请）→ 通知父级
 *   清空 ticket/review，恢复重新申请入口；
 * - 其他错误（网络超时等，无法确认票据是否已被消费）→ 保留票据重试，文案指明
 *   「取消删除申请后重新申请」的显式出路，不盲清票导致状态不一致。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DeletionReviewSheet(
  review: NeteaseDeletionReview,
  key: String,
  onConfirmed: () -> Unit,
  onTicketConsumed: (String) -> Unit,
  onCancelTicket: () -> Unit,
  onDismiss: () -> Unit,
) {
  var typed by remember(review) { mutableStateOf("") }
  var busy by remember { mutableStateOf(false) }
  var error by remember { mutableStateOf<String?>(null) }
  val scope = rememberCoroutineScope()
  val matches = typed == review.filename
  // 本地过期判定：过期票据禁用确认，只能返回重新申请
  val expired = review.expiresAt > 0 && review.expiresAt <= System.currentTimeMillis()

  ModalBottomSheet(onDismissRequest = onDismiss, containerColor = Om.Panel) {
    Column(
      Modifier
        .fillMaxWidth()
        .verticalScroll(rememberScrollState())
        .padding(bottom = 24.dp),
    ) {
      Row(
        Modifier.padding(horizontal = 20.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        Icon(OmIcons.Trash2, contentDescription = null, tint = Om.Danger, modifier = Modifier.size(18.dp))
        Spacer(Modifier.width(10.dp))
        Column {
          Text("人工核对 · 删除原文件", style = OmType.Title, color = Om.Paper)
          Text("该操作将从磁盘永久删除文件，不可恢复。", style = OmType.Meta, color = Om.Danger)
        }
      }
      Spacer(Modifier.height(6.dp))
      InfoRow("曲名", review.title)
      InfoRow("歌手", review.artist)
      InfoRow("文件名", review.filename, mono = true)
      InfoRow("格式", review.format.uppercase())
      InfoRow("大小", formatSizeBytes(review.sizeBytes))
      InfoRow("路径", review.path, mono = true)
      NeteaseExpiryText(review.expiresAt, Modifier.padding(horizontal = 20.dp, vertical = 5.dp))
      if (expired) {
        Text(
          "核对票据已过期——无法继续确认；请返回「取消删除申请」后重新申请。",
          style = OmType.Meta, color = Om.Danger,
          modifier = Modifier.padding(horizontal = 20.dp, vertical = 4.dp),
        )
      }
      Spacer(Modifier.height(10.dp))
      Text(
        "防误删确认：请逐字输入上方完整文件名（${review.filename}）。",
        style = OmType.Meta, color = Om.Dim,
        modifier = Modifier.padding(horizontal = 20.dp),
      )
      OutlinedTextField(
        value = typed,
        onValueChange = { typed = it },
        placeholder = { Text("输入完整文件名", style = OmType.Body, color = Om.Faint) },
        singleLine = true,
        isError = typed.isNotEmpty() && !matches,
        modifier = Modifier
          .fillMaxWidth()
          .padding(horizontal = 20.dp, vertical = 6.dp),
      )
      if (typed.isNotEmpty() && !matches) {
        Text("输入与文件名不完全一致。", style = OmType.Meta, color = Om.Danger, modifier = Modifier.padding(horizontal = 20.dp))
      }
      error?.let { Text(it, style = OmType.Meta, color = Om.Danger, modifier = Modifier.padding(horizontal = 20.dp, vertical = 2.dp)) }
      Row(Modifier.padding(horizontal = 12.dp, vertical = 8.dp)) {
        Button(
          onClick = {
            if (busy || !matches || expired) return@Button
            busy = true
            error = null
            scope.launch {
              val outcome = withContext(Dispatchers.IO) {
                runCatching { OpenMusicApp.api.neteaseConfirmDeletion(key, review.token, typed) }
              }
              busy = false
              outcome.fold(
                onSuccess = { onConfirmed() },
                onFailure = { e ->
                  val status = (e as? ApiError)?.status
                  if (status == 400 || status == 404) {
                    // 票据已被消费或已失效：服务端校验通过即消费票据，物理删除失败需重新申请
                    onTicketConsumed(
                      "删除未完成：核对票据已被消费或已失效（服务端校验通过后即消费票据）。请重新申请删除后再试。",
                    )
                  } else {
                    // 无法确认票据是否已被消费：不清票，保留重试与显式重置出路
                    error =
                      "删除未完成：${e.message ?: e.toString()}。可再试一次；若持续失败，请「取消删除申请」后重新申请（旧票据随之作废）。"
                  }
                },
              )
            }
          },
          enabled = matches && !busy && !expired,
          colors = ButtonDefaults.buttonColors(containerColor = Om.Danger, contentColor = Color.White),
          shape = RoundedCornerShape(2.dp),
        ) { Text(if (busy) "删除中…" else "确认删除文件", style = OmType.Row) }
        Spacer(Modifier.width(10.dp))
        TextButton(onClick = onCancelTicket, enabled = !busy) { Text("取消删除申请", color = Om.Faint) }
        TextButton(onClick = onDismiss, enabled = !busy) { Text("返回", color = Om.Faint) }
      }
      Text(
        "确认会连同票据 token 一并提交；「取消删除申请」作废本次申请（文件保留）。",
        style = OmType.Meta, color = Om.Faint,
        modifier = Modifier.padding(horizontal = 20.dp),
      )
    }
  }
}
