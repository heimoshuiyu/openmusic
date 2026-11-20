package dev.hmsy.openmusic.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.util.concurrent.TimeUnit

class ApiError(val status: Int, message: String) : Exception(message)

@Serializable data class LyricLine(val startMs: Long? = null, val text: String)
@Serializable data class TrackLyrics(val synced: Boolean, val lines: List<LyricLine>)

/** OkHttp 要求 POST/PUT/PATCH 有 body，即使端点不接收 payload。 */
internal fun buildApiRequest(method: String, url: HttpUrl, body: String? = null): Request {
  val requestBody = body?.toRequestBody("application/json".toMediaType())
    ?: when (method) {
      "POST", "PUT", "PATCH" -> ByteArray(0).toRequestBody()
      else -> null
    }
  return Request.Builder().url(url).method(method, requestBody).build()
}

/** 查询参数编码：空格/加号歧义统一走 %20（URLSearchParams 与字面解码两种解析器下都正确）。 */
internal fun encodeParam(value: String) = java.net.URLEncoder.encode(value, "UTF-8").replace("+", "%20")

/** 路径段编码（id / 票据 key）：输入域只有 ASCII id，无空格歧义。 */
internal fun encodePath(value: String) = java.net.URLEncoder.encode(value, "UTF-8")

/** 会话 cookie（om_session）持久化 CookieJar：内存缓存 + DataStore 落盘 */
class PersistentCookieJar(private val store: SettingsStore) : CookieJar {

  @Volatile
  private var cached: Cookie? = null

  private val initMutex = Mutex()
  private var initialized = false

  private suspend fun ensureLoaded() {
    if (initialized) return
    initMutex.withLock {
      if (initialized) return
      val saved = store.sessionCookie.first()
      if (saved != null && saved.domain.isNotBlank()) {
        cached = Cookie.Builder()
          .name(saved.name)
          .value(saved.value)
          .domain(saved.domain)
          .path("/")
          .build()
      }
      initialized = true
    }
  }

  override fun loadForRequest(url: HttpUrl): List<Cookie> {
    runBlocking { ensureLoaded() }
    val cookie = cached ?: return emptyList()
    return if (cookie.matches(url)) listOf(cookie) else emptyList()
  }

  override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {
    val session = cookies.firstOrNull { it.name == "om_session" && it.value.isNotBlank() } ?: return
    cached = session
    runBlocking {
      store.saveSessionCookie(SettingsStore.SessionCookie(session.name, session.value, session.domain))
    }
  }

  fun clearCache() {
    cached = null
  }
}

/**
 * 第一方 API 客户端 —— OkHttp + kotlinx-serialization。
 * 会话经 PersistentCookieJar 自动随行（API 请求 / 流 / 封面共用同一 OkHttpClient）。
 */
class OmApi(
  val client: OkHttpClient,
  private val cookieJar: PersistentCookieJar,
) {

  private val json = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    encodeDefaults = false
  }

  /** 当前服务器基地址（volatile，登录/设置可改） */
  @Volatile
  var baseUrl: String = ""

  private fun url(path: String): HttpUrl {
    val base = baseUrl.trimEnd('/')
    return "$base$path".toHttpUrl()
  }

  private suspend inline fun <reified T> request(
    method: String,
    path: String,
    body: String? = null,
  ): T = withContext(Dispatchers.IO) {
    client.newCall(buildApiRequest(method, url(path), body)).execute().use { response ->
      if (!response.isSuccessful) throw toError(response)
      parseBody<T>(response)
    }
  }

  private suspend inline fun <reified T> parseBody(response: Response): T {
    val text = response.body?.string().orEmpty()
    @Suppress("UNCHECKED_CAST")
    return if (text.isEmpty()) Unit as T else json.decodeFromString<T>(text)
  }

  private fun toError(response: Response): ApiError {
    val body = try { response.body?.string().orEmpty() } catch (_: Exception) { "" }
    val message = Regex("\"message\"\\s*:\\s*\"([^\"]*)\"").find(body)?.groupValues?.get(1) ?: response.code.toString()
    return ApiError(response.code, message)
  }

  @Serializable
  private data class LoginBody(val username: String, val password: String)
  @Serializable
  private data class LoginResponse(val user: UserPublic)

  @Serializable
  private data class CreatePlaylistBody(val name: String)

  @Serializable
  private data class AddTracksBody(val trackIds: List<String>)

  @Serializable
  private data class RecordPlayBody(val listenedSeconds: Int)

  @Serializable
  private data class NeteaseImportBody(val url: String, val folderId: String, val subdirectory: String? = null)

  @Serializable
  private data class NeteaseTagsBody(
    val title: String? = null,
    val artist: String? = null,
    val album: String? = null,
    val albumArtist: String? = null,
    val genre: String? = null,
    val trackNumber: Int? = null,
    val discNumber: Int? = null,
    val cover: String? = null,
  )

  @Serializable
  private data class NeteaseConfirmBody(val token: String, val filename: String)


  // ── 认证 ──────────────────────────────────────────────
  suspend fun login(username: String, password: String): UserPublic =
    request<LoginResponse>("POST", "/api/v1/auth/login", json.encodeToString(LoginBody.serializer(), LoginBody(username, password))).user

  suspend fun logout() { request<Unit>("POST", "/api/v1/auth/logout") }
  suspend fun me(): UserPublic = request("GET", "/api/v1/auth/me")

  // ── 浏览 ──────────────────────────────────────────────
  suspend fun albums(limit: Int = 30, offset: Int = 0, sort: String = "name"): Page<AlbumSummary> =
    request("GET", "/api/v1/albums?limit=$limit&offset=$offset&sort=${java.net.URLEncoder.encode(sort, "UTF-8")}")

  suspend fun album(id: String): AlbumSummary = request("GET", "/api/v1/albums/$id")

  suspend fun albumTracks(id: String): List<TrackSummary> = request("GET", "/api/v1/albums/$id/tracks")

  suspend fun artists(limit: Int = 50, offset: Int = 0, sort: String = "name"): Page<ArtistSummary> =
    request("GET", "/api/v1/artists?limit=$limit&offset=$offset&sort=${java.net.URLEncoder.encode(sort, "UTF-8")}")

  suspend fun artist(id: String): ArtistSummary = request("GET", "/api/v1/artists/$id")

  suspend fun artistAlbums(id: String): Page<AlbumSummary> = request("GET", "/api/v1/artists/$id/albums?limit=100")

  suspend fun artistTopTracks(id: String): List<TrackSummary> = request("GET", "/api/v1/artists/$id/top-tracks?limit=10")

  suspend fun random(count: Int = 20): List<TrackSummary> = request("GET", "/api/v1/random?count=$count")

  suspend fun track(id: String): TrackSummary = request("GET", "/api/v1/tracks/$id")
  suspend fun lyrics(id: String): TrackLyrics = request("GET", "/api/v1/tracks/$id/lyrics")

  /** 同一首歌的多份拷贝（canonical 口径排序，index 0 = 标准版） */
  suspend fun trackVersions(id: String): List<TrackSummary> = request("GET", "/api/v1/tracks/$id/versions")

  suspend fun search(q: String): SearchResult =
    request("GET", "/api/v1/search?q=${java.net.URLEncoder.encode(q, "UTF-8")}&type=all")

  // ── 收藏 ──────────────────────────────────────────────
  suspend fun favoriteTracks(limit: Int = 100, offset: Int = 0): Page<TrackSummary> =
    request("GET", "/api/v1/favorites?type=track&limit=$limit&offset=$offset")
  suspend fun favoriteAlbums(limit: Int = 100, offset: Int = 0): Page<AlbumSummary> =
    request("GET", "/api/v1/favorites?type=album&limit=$limit&offset=$offset")
  suspend fun favoriteArtists(limit: Int = 100, offset: Int = 0): Page<ArtistSummary> =
    request("GET", "/api/v1/favorites?type=artist&limit=$limit&offset=$offset")

  suspend fun favorite(type: String, id: String) { request<Unit>("PUT", "/api/v1/favorites/$type/$id") }
  suspend fun unfavorite(type: String, id: String) { request<Unit>("DELETE", "/api/v1/favorites/$type/$id") }

  // ── 播放记录 ──────────────────────────────────────────
  suspend fun recordPlay(trackId: String, listenedSeconds: Int) {
    request<Unit>("POST", "/api/v1/plays/$trackId", json.encodeToString(RecordPlayBody.serializer(), RecordPlayBody(listenedSeconds)))
  }

  suspend fun recentTracks(limit: Int = 12): List<PlayEntry> = request("GET", "/api/v1/plays/recent?distinct=track&limit=$limit")

  suspend fun mostPlayedAlbums(limit: Int = 12, period: String = "all"): List<MostPlayedAlbum> =
    request("GET", "/api/v1/plays/most-played?type=album&period=$period&limit=$limit")

  suspend fun mostPlayedTracks(limit: Int = 20, period: String = "all"): List<MostPlayedTrack> =
    request("GET", "/api/v1/plays/most-played?type=track&period=$period&limit=$limit")

  suspend fun playSummary(): ListeningSummary = request("GET", "/api/v1/plays/summary")

  // ── 播放列表 ──────────────────────────────────────────
  suspend fun playlists(): List<PlaylistSummary> = request("GET", "/api/v1/playlists")
  suspend fun playlist(id: String): PlaylistSummary = request("GET", "/api/v1/playlists/$id")
  suspend fun playlistTracks(id: String): List<TrackSummary> = request("GET", "/api/v1/playlists/$id/tracks")
  suspend fun createPlaylist(name: String): PlaylistSummary =
    request("POST", "/api/v1/playlists", json.encodeToString(CreatePlaylistBody.serializer(), CreatePlaylistBody(name)))

  suspend fun addToPlaylist(id: String, trackIds: List<String>) {
    request<Unit>("POST", "/api/v1/playlists/$id/tracks", json.encodeToString(AddTracksBody.serializer(), AddTracksBody(trackIds)))
  }

  suspend fun removeFromPlaylist(id: String, position: Int) { request<Unit>("DELETE", "/api/v1/playlists/$id/tracks/$position") }
  suspend fun deletePlaylist(id: String) { request<Unit>("DELETE", "/api/v1/playlists/$id") }

  // ── 库管理 ────────────────────────────────────────────
  suspend fun scanStatus(): ScanStatus = request("GET", "/api/v1/library/scan-status")
  suspend fun scan() { request<Unit>("POST", "/api/v1/library/scan") }

  // ── 网易云导入（docs/04 导入组）─────────────────────────

  /** 服务端同步等终态（多曲分钟级）：只放宽读超时；连接池与 cookie 随共享 builder 继承。 */
  private val longClient by lazy { client.newBuilder().readTimeout(10, TimeUnit.MINUTES).build() }

  suspend fun neteaseSearch(q: String): List<NeteaseCandidate> =
    request("GET", "/api/v1/imports/netease/search?q=${encodeParam(q)}")

  /** 导入目标目录（含 writable；不可写目录在 UI 层前置禁止提交） */
  suspend fun neteaseFolders(): List<NeteaseFolder> = request("GET", "/api/v1/imports/netease/folders")

  /** 单层子目录浏览：subdirectory 传空 = 曲库根目录 */
  suspend fun neteaseSubdirectories(folderId: String, subdirectory: String): NeteaseChildren =
    request("GET", "/api/v1/imports/netease/subdirectories?folderId=${encodeParam(folderId)}&subdirectory=${encodeParam(subdirectory)}")

  /** 同步等待导入终态；会话失效（401）由调用方照常处理 */
  suspend fun neteaseImport(url: String, folderId: String, subdirectory: String?): NeteaseImportResult =
    withContext(Dispatchers.IO) {
      longClient.newCall(
        buildApiRequest(
          "POST",
          url("/api/v1/imports/netease/requests"),
          json.encodeToString(NeteaseImportBody.serializer(), NeteaseImportBody(url, folderId, subdirectory?.takeIf { it.isNotBlank() })),
        ),
      ).execute().use { response ->
        if (!response.isSuccessful) throw toError(response)
        parseBody(response)
      }
    }

  // ── 网易云导入管理（信息登录可读；修改/移出/删除仅导入者或管理员）──────────

  suspend fun neteaseInfo(trackId: String): NeteaseInfo =
    request("GET", "/api/v1/imports/netease/tracks/${encodePath(trackId)}/metadata")

  /**
   * 只提交显式变更过的字段（服务端标签为非空文本，空串会被 422 拒绝；null = 保持不变）。
   * cover：null=不动，"netease"=恢复网易云封面，或 https 的 *.music.126.net 图片 URL。
   */
  suspend fun neteaseEditTags(
    trackId: String,
    title: String? = null,
    artist: String? = null,
    album: String? = null,
    albumArtist: String? = null,
    genre: String? = null,
    trackNumber: Int? = null,
    discNumber: Int? = null,
    cover: String? = null,
  ): NeteaseInfo =
    request(
      "PATCH",
      "/api/v1/imports/netease/tracks/${encodePath(trackId)}/metadata",
      json.encodeToString(
        NeteaseTagsBody.serializer(),
        NeteaseTagsBody(title, artist, album, albumArtist, genre, trackNumber, discNumber, cover),
      ),
    )

  /** 移出曲库（索引删除，磁盘文件保留） */
  suspend fun neteaseUnindex(trackId: String) {
    request<Unit>("DELETE", "/api/v1/imports/netease/tracks/${encodePath(trackId)}/library-entry")
  }

  /** 申请删除原文件 → 人工核对票据（key = requestId） */
  suspend fun neteaseRequestDeletion(trackId: String): NeteaseDeletionRequest =
    request("POST", "/api/v1/imports/netease/tracks/${encodePath(trackId)}/file-deletion-requests")

  suspend fun neteaseReviewDeletion(key: String): NeteaseDeletionReview =
    request("POST", "/api/v1/imports/netease/file-deletion-requests/${encodePath(key)}/review")

  /** 兑现删除：必须携带 review 发放的 token，且 filename 与人工逐字输入一致 */
  suspend fun neteaseConfirmDeletion(key: String, token: String, filename: String) {
    request<Unit>(
      "POST",
      "/api/v1/imports/netease/file-deletion-requests/${encodePath(key)}/confirm",
      json.encodeToString(NeteaseConfirmBody.serializer(), NeteaseConfirmBody(token, filename)),
    )
  }

  suspend fun neteaseCancelDeletion(key: String) {
    request<Unit>("DELETE", "/api/v1/imports/netease/file-deletion-requests/${encodePath(key)}")
  }


  // ── 媒体地址 ──────────────────────────────────────────
  fun streamUrl(trackId: String, transcode: Boolean = false): String =
    if (transcode) "$baseUrl/api/v1/tracks/$trackId/stream?format=mp3&maxBitRate=320"
    else "$baseUrl/api/v1/tracks/$trackId/stream"

  fun coverUrl(coverId: String): String = "$baseUrl/api/v1/covers/$coverId"
  fun albumCoverUrl(albumId: String): String = coverUrl("al-$albumId")
  fun artistCoverUrl(artistId: String): String = coverUrl("ar-$artistId")

  /** 曲目精确封面链：自身内嵌 → 专辑链（tr- 端点一次解析） */
  fun trackCoverUrl(trackId: String): String = coverUrl("tr-$trackId")

  fun clearSession() = cookieJar.clearCache()
}
