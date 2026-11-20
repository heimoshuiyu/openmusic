package dev.hmsy.openmusic.ui.screens

import androidx.activity.compose.LocalOnBackPressedDispatcherOwner
import androidx.compose.foundation.background
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import android.widget.Toast
import dev.hmsy.openmusic.OpenMusicApp
import dev.hmsy.openmusic.core.Om
import dev.hmsy.openmusic.core.OmType
import dev.hmsy.openmusic.data.ScanStatus
import dev.hmsy.openmusic.data.UserPublic
import dev.hmsy.openmusic.ui.UiActions
import dev.hmsy.openmusic.ui.components.DetailTopBar
import dev.hmsy.openmusic.ui.components.rememberLoad
import dev.hmsy.openmusic.ui.icons.OmIcons
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** 设置：账号 / 服务器 / 扫描 / 登出 */
@Composable
fun SettingsScreen(actions: UiActions, onManage: () -> Unit) {
  val back = LocalOnBackPressedDispatcherOwner.current?.onBackPressedDispatcher
  val (meState, retryMe) = rememberLoad { OpenMusicApp.api.me() }
  val (scanState, reloadScan) = rememberLoad { OpenMusicApp.api.scanStatus() }
  val scanning = scanState.data?.state == "scanning"
  LaunchedEffect(scanning) { if (scanning) { delay(2000); reloadScan() } }

  Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
    Box(Modifier.padding(horizontal = 12.dp)) {
      DetailTopBar("设置", onBack = { back?.onBackPressed() })
    }

    SectionLabel("账号")
    val me = meState.data
    SettingsRow(label = "用户", value = me?.username ?: "…")
    SettingsRow(label = "角色", value = if (me == null) "…" else if (me.isAdmin) "管理员" else "成员")
    if (meState.error != null) androidx.compose.material3.TextButton(onClick = retryMe) { Text("重新读取账号") }

    SectionLabel("服务器")
    SettingsRow(label = "地址", value = OpenMusicApp.api.baseUrl)

    SectionLabel("曲库")
    val scan = scanState.data
    val scanText = when {
      scanning && scan?.phase == "walking" -> "扫描中 · 遍历 ${scan?.total ?: 0}"
      scanning && scan != null && scan.total > 0 && scan.processed >= scan.total -> "扫描中 · 收尾中…"
      scanning -> "扫描中 ${scan?.processed ?: 0}/${scan?.total ?: 0}"
      scan?.lastScanAt != null -> "上次扫描 ${scan.total} 首"
      else -> "尚未扫描"
    }
    SettingsRow(label = "状态", value = scanText)

    // 网易云导入入口（登录即可用；不需要管理员）
    Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 12.dp)) {
      androidx.compose.material3.Button(
        onClick = actions.openNeteaseImport,
        colors = androidx.compose.material3.ButtonDefaults.buttonColors(containerColor = Om.Paper, contentColor = Om.Shell),
        shape = RoundedCornerShape(2.dp),
      ) {
        Text("从网易云导入", style = OmType.Row)
      }
      Text("搜索或粘贴链接导入单曲 / 歌单 / 专辑 / 歌手热门（匿名 MP3 ≤320k，VIP 跳过，≤25 首）", style = OmType.Meta, color = Om.Dim)
    }

    if (me?.isAdmin == true) Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 12.dp)) {
      androidx.compose.material3.Button(
        onClick = onManage,
        colors = androidx.compose.material3.ButtonDefaults.buttonColors(containerColor = Om.Paper, contentColor = Om.Shell),
        shape = RoundedCornerShape(2.dp),
      ) {
        Text("服务器管理", style = OmType.Row)
      }
      Text("音乐目录与扫描、助手模型与供应商、用户管理", style = OmType.Meta, color = Om.Dim)
    }

    Spacer(Modifier.height(18.dp))

    // 登出（quiet——管理操作一律中性）
    Row(
      Modifier
        .fillMaxWidth()
        .padding(horizontal = 20.dp, vertical = 12.dp),
    ) {
      androidx.compose.material3.TextButton(onClick = { actions.logout() }) {
        Icon(OmIcons.Logout, contentDescription = null, tint = Om.Dim, modifier = Modifier.size(16.dp))
        Spacer(Modifier.width(6.dp))
        Text("退出登录", style = OmType.Body, color = Om.Dim)
      }
    }
  }
}

@Composable
private fun SectionLabel(text: String) {
  Text(
    text,
    style = OmType.Meta,
    color = Om.Faint,
    modifier = Modifier.padding(start = 20.dp, top = 22.dp, bottom = 6.dp),
  )
}

@Composable
private fun SettingsRow(label: String, value: String) {
  Row(
    Modifier
      .fillMaxWidth()
      .padding(horizontal = 20.dp, vertical = 9.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Text(label, style = OmType.Body, color = Om.Dim, modifier = Modifier.width(88.dp))
    Text(value, style = OmType.Body, color = Om.Paper)
  }
}
