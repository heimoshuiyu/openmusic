package dev.hmsy.openmusic.agent

import android.content.Intent
import android.net.Uri
import android.util.Base64
import android.webkit.WebMessage
import android.webkit.WebMessagePort
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import dev.hmsy.openmusic.OpenMusicApp
import dev.hmsy.openmusic.data.TrackSummary
import dev.hmsy.openmusic.player.PlaybackService
import kotlinx.coroutines.*
import kotlinx.serialization.json.Json
import okhttp3.*
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

internal const val ASSET_ORIGIN = "https://appassets.androidplatform.net"
internal enum class EmbeddedPage(val origin: String, val document: String, val channel: String) {
  Assistant(ASSET_ORIGIN,"android-assistant.html","openmusic-assistant"),
  Admin("https://settings.openmusic.invalid","android-admin.html","openmusic-admin");
  val entry get() = "$origin/assistant/$document"
}
private val assetName = Regex("assets/[A-Za-z0-9_.-]+\\.(?:js|css|woff2)")

internal fun allowsAssistantRequest(method: String, path: String): Boolean {
  val sessions = "/api/v1/agent/sessions"
  val id = "[A-Za-z0-9_-]{1,128}"
  return when (method) {
    "GET" -> path == sessions || Regex("$sessions/$id/(messages|inbox)").matches(path)
    "POST" -> path == sessions || path == "/api/v1/agent/transcribe" || Regex("$sessions/$id/(prompt|interrupt|transcribe|questions/frm_$id)").matches(path)
    "PATCH" -> Regex("$sessions/$id/inbox/$id").matches(path)
    "DELETE" -> Regex("$sessions/$id/(inbox/$id|questions/frm_$id)").matches(path)
    else -> false
  }
}

/** Disjoint capabilities. Chat cannot modify server settings; the admin page cannot play
 * music, subscribe to chats or capture audio. Server-side admin checks remain authoritative. */
internal fun allowsAdminRequest(method: String, path: String): Boolean {
  val base = "/api/v1"
  val settings = "$base/admin/agent/settings"; val console = "$base/admin/agent/console"
  val attempt = Regex("$console/[A-Za-z0-9_-]{1,128}")
  val folders = "$base/music-folders"; val folder = Regex("$folders/[0-9]+")
  val users = "$base/users"; val scan = "$base/library/scan"
  return when(method) {
    "GET" -> path in setOf("$base/auth/me", "$scan-status", folders, "$users?limit=100", settings) || attempt.matches(path)
    "POST" -> path in setOf(scan,"$scan?force=true",folders,users,settings,console)
    "PATCH" -> folder.matches(path)
    "DELETE" -> path == scan || folder.matches(path) || Regex("$users/[0-9]+").matches(path) || attempt.matches(path)
    else -> false
  }
}

/** Only packaged assets execute. The WebView never receives a session cookie, remote page,
 * arbitrary-URL proxy or JavascriptInterface. One message port belongs to one authenticated host. */
internal class AssistantBridge(val web: WebView, private val page: EmbeddedPage = EmbeddedPage.Assistant, private val expired: () -> Unit) {
  private val base = OpenMusicApp.api.baseUrl.trimEnd('/')
  private val url = "$base/api/v1/agent/events".toHttpUrl()
  private val cookie = OpenMusicApp.cookieJar.loadForRequest(url).firstOrNull { it.name == "om_session" }?.toString()?.substringBefore(';')
  private val client = OpenMusicApp.httpClient.newBuilder().cookieJar(CookieJar.NO_COOKIES)
    .followRedirects(false).followSslRedirects(false).readTimeout(90,TimeUnit.SECONDS).build()
  private val eventsClient = client.newBuilder().readTimeout(0,TimeUnit.SECONDS).build()
  private val scope = CoroutineScope(SupervisorJob()+Dispatchers.IO)
  private val calls = ConcurrentHashMap<Int, Call>()
  private val requests = ConcurrentHashMap<Int, Job>()
  private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }
  @Volatile private var dead = false
  @Volatile private var stream: Call? = null
  private var streamJob: Job? = null
  private var port: WebMessagePort? = null
  private var ready = false
  @Volatile var shown = false
    set(value) { if(field != value) { field=value; if(ready) visibility() } }

  init {
    with(web.settings) {
      javaScriptEnabled = true; allowFileAccess = false; allowContentAccess = false
      mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW; blockNetworkLoads = true
    }
    web.webViewClient = object : WebViewClient() {
      override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = true
      override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse {
        val uri = request.url
        val file = uri.encodedPath.orEmpty().removePrefix("/assistant/")
        if(request.method == "GET" && "${uri.scheme}://${uri.encodedAuthority}" == page.origin &&
          uri.encodedPath == "/assistant/$file" && (file == page.document || assetName.matches(file))) {
          val mime = when(file.substringAfterLast('.')) { "html" -> "text/html"; "css" -> "text/css"; "woff2" -> "font/woff2"; else -> "text/javascript" }
          runCatching { return WebResourceResponse(mime, if(mime=="font/woff2") null else "UTF-8", web.context.assets.open("assistant/$file")) }
        }
        return WebResourceResponse("text/plain","UTF-8",404,"Not found",emptyMap(),ByteArrayInputStream(byteArrayOf()))
      }
      override fun onPageFinished(view: WebView, url: String) {
        if(dead || url != page.entry || port != null)return
        val pair = view.createWebMessageChannel(); port = pair[0]
        pair[0].setWebMessageCallback(object : WebMessagePort.WebMessageCallback() {
          override fun onMessage(p: WebMessagePort, message: WebMessage) {
            if(dead || message.data.orEmpty().length > 3_000_000)return
            runCatching { handle(JSONObject(message.data ?: "{}")) }
          }
        })
        view.postWebMessage(WebMessage(page.channel, arrayOf(pair[1])),Uri.parse(page.origin))
      }
    }
    web.loadUrl(page.entry)
  }
  private fun post(data: JSONObject) { if(matchesLogin()) port?.postMessage(WebMessage(data.toString())) }
  private fun visibility() = post(JSONObject().put("type","visibility").put("data",shown))
  private fun builder(path:String) = Request.Builder().url(base+path).apply { cookie?.let { header("Cookie",it) } }
  private fun matchesLogin() = !dead && OpenMusicApp.api.baseUrl.trimEnd('/') == base && cookie != null &&
    OpenMusicApp.cookieJar.loadForRequest(url).any { "${it.name}=${it.value}" == cookie }
  private fun invalidate() {
    if(dead)return
    val same = matchesLogin(); close(); if(same) expired()
  }
  private fun handle(m: JSONObject) {
    if(!matchesLogin()) { close(); return }
    val id = m.optInt("id")
    when(m.getString("op")) {
      "ready" -> {ready=true;visibility()}
      "subscribe" -> if(page == EmbeddedPage.Assistant) subscribe()
      "unsubscribe" -> {streamJob?.cancel();stream?.cancel();streamJob=null}
      "cancel" -> { requests.remove(id)?.cancel();calls.remove(id)?.cancel() }
      "link" -> if(shown) openLink(m.optString("href"))
      "request", "play" -> { val job=scope.launch(start=CoroutineStart.LAZY) {
        val result = runCatching {
          if(m.getString("op")=="play") {
            require(shown && page == EmbeddedPage.Assistant); val kind=m.getString("kind"); require(kind=="play-now" || kind=="enqueue")
            val ids=m.getJSONArray("ids"); require(ids.length() in 1..512)
            val tracks=(0 until ids.length()).map { index ->
              val tid=ids.getString(index);require(tid.matches(Regex("[0-9]+")))
              call(id,builder("/api/v1/tracks/$tid").build()).use { r -> require(r.isSuccessful);json.decodeFromString<TrackSummary>(r.body!!.string()) }
            }
            withContext(Dispatchers.Main) { if(matchesLogin()) { if(kind=="play-now") PlaybackService.setQueue(tracks,0) else PlaybackService.enqueue(tracks) } }
            204 to ""
          } else {
            val path=m.getString("path"); val method=m.getString("method")
            require(when(page) { EmbeddedPage.Assistant -> allowsAssistantRequest(method,path); EmbeddedPage.Admin -> allowsAdminRequest(method,path) })
            val raw=m.optString("body")
            val body=when {
              path.endsWith("/transcribe") -> {
                val mime=m.getString("mime");require(mime.substringBefore(';') in setOf("audio/webm","audio/ogg","audio/mp4"))
                val bytes=Base64.decode(raw,Base64.DEFAULT);require(bytes.size in 1..2*1024*1024);bytes.toRequestBody(mime.toMediaType())
              }
              method == "GET" || method == "DELETE" -> null
              else -> { require(raw.length<=128_000);raw.toRequestBody("application/json".toMediaType()) }
            }
            call(id,builder(path).method(method,body).build()).use { it.code to it.body?.string().orEmpty() }
          }
        }.getOrElse { 503 to "{\"message\":\"请求未完成，请检查服务器连接后重试\"}" }
        withContext(Dispatchers.Main) {
          if(result.first==401) invalidate() else post(JSONObject().put("id",id).put("status",result.first).put("body",result.second))
        }
      };requests[id]=job;job.invokeOnCompletion { requests.remove(id,job);calls.remove(id) };job.start() }
    }
  }
  private suspend fun call(id:Int, request: Request): Response {
    val c=client.newCall(request); calls[id]=c
    if(dead || !currentCoroutineContext().isActive)c.cancel()
    return c.execute()
  }
  private fun subscribe() {
    if(streamJob?.isActive==true)return
    streamJob=scope.launch {
      var wait=1_000L
      while(isActive) {
        val c=eventsClient.newCall(builder("/api/v1/agent/events").build());stream=c
        if(!isActive){c.cancel();break}
        try { c.execute().use { r ->
          if(r.code==401){withContext(Dispatchers.Main){invalidate()};return@launch}
          if(r.isSuccessful){
            withContext(Dispatchers.Main){post(JSONObject().put("type","open"))}; wait=1_000
            val reader=r.body!!.charStream().buffered();val data=StringBuilder()
            while(isActive){val line=reader.readLine() ?: break
              if(line.startsWith("data:"))data.append(line.substring(5).trimStart()).append('\n')
              if(line.isEmpty() && data.isNotEmpty()){
                val payload=data.toString().trimEnd('\n');data.clear()
                withContext(Dispatchers.Main){post(JSONObject().put("type","event").put("data",payload))}
              }
            }
          }
        } } catch (_: java.io.IOException) { /* reconnect, preserving busy until inbox reconciliation */ }
        finally { c.cancel() }
        delay(wait);wait=(wait*2).coerceAtMost(30_000)
      }
    }
  }
  private fun openLink(href:String) {
    val uri=Uri.parse(if(Regex("/review-deletion/[a-fA-F0-9-]{36}").matches(href)) base+href else href)
    if(page == EmbeddedPage.Admin && (uri.scheme != "https" || uri.encodedAuthority != "opencode.ai")) return
    if(uri.scheme in setOf("http","https","mailto")) runCatching { web.context.startActivity(Intent(Intent.ACTION_VIEW,uri)) }
  }
  fun close() { dead=true;scope.cancel();stream?.cancel();calls.values.forEach { it.cancel() };calls.clear();port?.close();port=null }
}
