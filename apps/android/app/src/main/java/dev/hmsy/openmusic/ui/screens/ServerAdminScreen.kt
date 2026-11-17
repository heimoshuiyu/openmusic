package dev.hmsy.openmusic.ui.screens

import android.app.AlertDialog
import android.view.ViewGroup.LayoutParams
import android.webkit.JsResult
import android.webkit.WebChromeClient
import android.webkit.WebView
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import dev.hmsy.openmusic.agent.AssistantBridge
import dev.hmsy.openmusic.agent.EmbeddedPage
import dev.hmsy.openmusic.core.Om
import dev.hmsy.openmusic.ui.components.DetailTopBar

/** A separate document, port and query cache from chat. Leave this destination to discard forms. */
@Composable
fun ServerAdminScreen(onBack: () -> Unit, onExpired: () -> Unit) {
  val context = LocalContext.current
  val latestExpired by rememberUpdatedState(onExpired)
  val view = remember { WebView(context).apply { layoutParams = LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT) } }
  DisposableEffect(view) {
    var confirm: AlertDialog? = null
    view.webChromeClient = object : WebChromeClient() {
      override fun onJsConfirm(web: WebView, url: String, message: String, result: JsResult): Boolean {
        if (url.substringBefore('#') != EmbeddedPage.Admin.entry) { result.cancel(); return true }
        confirm = AlertDialog.Builder(context).setTitle("确认服务器操作").setMessage(message)
          .setNegativeButton("取消") { _,_ -> result.cancel() }.setPositiveButton("确认") { _,_ -> result.confirm() }
          .setOnCancelListener { result.cancel() }.show()
        return true
      }
    }
    val bridge = AssistantBridge(view, EmbeddedPage.Admin) { latestExpired() }.also { it.shown = true }
    onDispose { confirm?.cancel(); bridge.close(); view.stopLoading(); view.destroy() }
  }
  Column(Modifier.fillMaxSize().background(Om.Shell).imePadding()) {
    DetailTopBar("服务器管理", onBack)
    AndroidView(factory = { view }, modifier = Modifier.fillMaxWidth().weight(1f))
  }
}
