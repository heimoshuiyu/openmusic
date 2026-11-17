package dev.hmsy.openmusic.agent

import android.Manifest
import android.content.pm.PackageManager
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.view.ViewGroup.LayoutParams
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import dev.hmsy.openmusic.core.Om
import dev.hmsy.openmusic.core.OmType

@Composable
internal fun rememberAssistantSession(onExpired: () -> Unit): Lazy<AssistantBridge> {
  // Owned by the authenticated scaffold, not by a back-stack entry. Switching tabs detaches
  // the page without losing its selected session, in-memory drafts, or event subscription.
  val context = LocalContext.current
  val latestExpired by rememberUpdatedState(onExpired)
  val session = remember(context) {
    lazy(LazyThreadSafetyMode.NONE) {
      val web = WebView(context).apply {
        // WRAP_CONTENT makes Chromium lay out long chat history at near-zero CSS height.
        layoutParams = LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT)
      }
      AssistantBridge(web) { latestExpired() }
    }
  }
  DisposableEffect(session) {
    onDispose {
      if (session.isInitialized()) session.value.run { close(); web.stopLoading(); web.destroy() }
    }
  }
  return session
}

@Composable
internal fun AssistantSurface(session: Lazy<AssistantBridge>) {
  val context = LocalContext.current
  val bridge = session.value
  val view = bridge.web
  var pending by remember { mutableStateOf<PermissionRequest?>(null) }
  fun answer(request:PermissionRequest, granted:Boolean) {
    if(granted && bridge.shown && request.origin.toString().trimEnd('/')==ASSET_ORIGIN && request.resources.contentEquals(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))) {
      request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
    } else request.deny()
  }
  val permission=rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()){ ok -> pending?.let { answer(it,ok) };pending=null }
  var foreground by remember { mutableStateOf(true) }
  val lifecycle=LocalLifecycleOwner.current.lifecycle
  DisposableEffect(view,lifecycle) {
    val observer=LifecycleEventObserver { _,e ->
      if(e==Lifecycle.Event.ON_STOP){foreground=false;bridge.shown=false;pending?.deny();pending=null;view.onPause()}
      if(e==Lifecycle.Event.ON_START){foreground=true;view.onResume()}
    };lifecycle.addObserver(observer)
    view.webChromeClient=object:WebChromeClient(){
      override fun onPermissionRequest(request:PermissionRequest){
        if(!bridge.shown || request.origin.toString().trimEnd('/')!=ASSET_ORIGIN || !request.resources.contentEquals(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) || pending!=null){request.deny();return}
        if(ContextCompat.checkSelfPermission(context,Manifest.permission.RECORD_AUDIO)==PackageManager.PERMISSION_GRANTED)answer(request,true)
        else {pending=request;permission.launch(Manifest.permission.RECORD_AUDIO)}
      }
      override fun onPermissionRequestCanceled(request:PermissionRequest){if(pending===request)pending=null}
    }
    onDispose {
      lifecycle.removeObserver(observer)
      bridge.shown = false
      pending?.deny(); pending = null
      view.webChromeClient = null
      view.onPause()
    }
  }
  // Read lifecycle state in composition, not inside SideEffect: ON_START alone must revive
  // the detached editor after an external link or a background/foreground cycle.
  val showWeb = foreground
  SideEffect { bridge.shown = showWeb }
  Column(Modifier.fillMaxSize().background(Om.Shell).statusBarsPadding().imePadding()) {
    Text("音乐助手", style = OmType.Headline, color = Om.Paper, modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp))
    AndroidView(factory = { view }, modifier = Modifier.fillMaxWidth().weight(1f))
  }
}
