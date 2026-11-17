package dev.hmsy.openmusic.player

import android.app.PendingIntent
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSourceBitmapLoader
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.session.CacheBitmapLoader
import androidx.media3.session.CommandButton
import androidx.media3.session.DefaultMediaNotificationProvider
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionCommands
import androidx.media3.session.SessionResult
import com.google.common.collect.ImmutableList
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.MoreExecutors
import com.google.common.util.concurrent.SettableFuture
import dev.hmsy.openmusic.OpenMusicApp
import dev.hmsy.openmusic.R
import dev.hmsy.openmusic.data.TrackSummary
import dev.hmsy.openmusic.ui.StarOverlay
import java.util.concurrent.Executors
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.Request

/**
 * 媒体播放服务：Media3 MediaSession + ExoPlayer。
 * - OkHttp DataSource 共享 cookie 会话（流/封面同源鉴权）
 * - 音频流缓存：CacheDataSource + AudioCache（SimpleCache 不设上限），重播零流量
 * - 通知栏/锁屏控制由 MediaSessionService 自动提供
 * - 通知栏封面：BitmapLoader 走 OkHttp（带 cookie）；Android 13+ 系统媒体卡片不加载
 *   http(s) 封面 URI，故异步抓取字节注入 artworkData（同 URI 元数据替换，无缝播放）
 * - 通知栏收藏 + 播放模式：自定义 SessionCommand + mediaButtonPreferences（13+ 卡片
 *   五槽位：模式/上一首/播放/下一首/收藏），与 App 内 StarOverlay、PlayerBus 同源
 * - 播放恢复（Android 11+）：队列/进度落 ResumeStore（DataStore），onPlaybackResumption
 *   供系统"继续播放"胶囊复活队列
 * - 通知小图标：品牌胶片盘（ic_notification），替换 media3 默认图标
 * - 打点：>50% 或 >240s 一次（对齐 web/TUI 判定），播完兜底
 * - 解码失败回退：?format=mp3&maxBitRate=320 服务器转码（每曲一次）
 */
@UnstableApi
class PlaybackService : MediaSessionService() {

  private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
  private var mediaSession: MediaSession? = null
  private var player: ExoPlayer? = null

  /** 已打点的 mediaId */
  private val scrobbled = HashSet<String>()
  /** 已尝试转码回退的 mediaId（防循环） */
  private val transcoded = HashSet<String>()
  /** 已尝试注入 artworkData 的 mediaId（含失败，防重复抓取） */
  private val artworkInjected = HashSet<String>()
  /** 通知栏按钮上次的 (trackId, starred, playMode)，去重刷新 */
  private var lastButtonKey: Triple<String, Boolean, PlayMode>? = null

  override fun onCreate() {
    super.onCreate()
    attach(this)

    // 通知 Provider：沿用默认布局（MediaStyle + 自动按钮），仅换掉状态栏小图标
    // （默认是 media3 通用图标）——须在首个通知展示前设置
    setMediaNotificationProvider(
      DefaultMediaNotificationProvider.Builder(this).build().apply {
        setSmallIcon(R.drawable.ic_notification)
      },
    )

    val httpFactory = OkHttpDataSource.Factory(OpenMusicApp.httpClient)
    // 播放过的曲目落盘缓存（键按 trackId 归一，见 AudioCache）；缓存异常静默回源网络
    val dataSourceFactory = AudioCache.playbackFactory(AudioCache.get(this), DefaultDataSource.Factory(baseContext, httpFactory))

    val p = ExoPlayer.Builder(this, MeteredRenderers(this))
      .setMediaSourceFactory(DefaultMediaSourceFactory(dataSourceFactory))
      .setAudioAttributes(
        AudioAttributes.Builder()
          .setUsage(C.USAGE_MEDIA)
          .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
          .build(),
        /* handleAudioFocus = */ true,
      )
      .setHandleAudioBecomingNoisy(true)
      .setWakeMode(C.WAKE_MODE_NETWORK)
      .build()

    p.addListener(listener)
    player = p

    mediaSession = MediaSession.Builder(this, p)
      .setSessionActivity(
        PendingIntent.getActivity(
          this,
          0,
          packageManager.getLaunchIntentForPackage(packageName),
          PendingIntent.FLAG_IMMUTABLE,
        ),
      )
      // 通知大图（Android 12-）与锁屏封面：默认 DataSourceBitmapLoader 用无 cookie 的
      // DefaultHttpDataSource，同源鉴权的封面会 401——换成共享会话的 OkHttp
      .setBitmapLoader(
        CacheBitmapLoader(
          DataSourceBitmapLoader(
            MoreExecutors.listeningDecorator(Executors.newSingleThreadExecutor()),
            OkHttpDataSource.Factory(OpenMusicApp.httpClient),
          ),
        ),
      )
      .setCallback(sessionCallback)
      .build()

    startTicker()
    watchMediaButtons()
  }

  override fun onTaskRemoved(rootIntent: Intent?) {
    val p = mediaSession?.player
    if (p == null || !p.playWhenReady || p.mediaItemCount == 0) {
      stopSelf()
    }
  }

  override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = mediaSession

  override fun onDestroy() {
    serviceScope.cancel()
    mediaSession?.run {
      player.release()
      release()
    }
    mediaSession = null
    player = null
    detach(this)
    PlayerBus.reset()
    super.onDestroy()
  }

  // ── Player 监听 → PlayerBus 发布 ─────────────────────
  private val listener = object : Player.Listener {
    override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) = publish()
    override fun onIsPlayingChanged(isPlaying: Boolean) = publish()
    override fun onPlaybackStateChanged(playbackState: Int) = publish()
    override fun onShuffleModeEnabledChanged(shuffleModeEnabled: Boolean) = publish()
    override fun onRepeatModeChanged(repeatMode: Int) = publish()
    override fun onPlayerError(error: PlaybackException) {
      if (needsCodecFallback(error.errorCode)) maybeTranscodeFallback()
    }
  }

  private fun publish() {
    val p = player ?: return
    PlayerBus.update {
      it.copy(
        index = if (p.mediaItemCount == 0) -1 else p.currentMediaItemIndex,
        isPlaying = p.isPlaying,
        isBuffering = p.playbackState == Player.STATE_BUFFERING,
        shuffle = p.shuffleModeEnabled,
        repeat = when (p.repeatMode) {
          Player.REPEAT_MODE_ONE -> RepeatMode.ONE
          Player.REPEAT_MODE_ALL -> RepeatMode.ALL
          else -> RepeatMode.OFF
        },
        durationMs = if (p.duration > 0) p.duration else it.current?.durationSeconds?.times(1000L) ?: 0L,
      )
    }
    ensureArtworkData()
    persistResume()
  }

  /**
   * Android 13+ 媒体卡片只从 content/file URI 取图，http(s) 封面必须以位图形式
   * 进入 MediaMetadata（artworkData）。抓取当前曲目的封面字节后原位替换 MediaItem
   * ——同 URI 仅元数据变化，replaceMediaItem 契约保证播放无缝衔接。
   */
  private fun ensureArtworkData() {
    val p = player ?: return
    val item = p.currentMediaItem ?: return
    if (item.mediaMetadata.artworkData != null) return
    if (item.mediaId in artworkInjected) return
    val track = PlayerBus.state.value.current ?: return
    if (!track.hasCoverArt) return
    artworkInjected.add(item.mediaId)
    val url = OpenMusicApp.api.albumCoverUrl(track.album.id)
    serviceScope.launch(Dispatchers.IO) {
      val bytes = runCatching {
        OpenMusicApp.httpClient.newCall(Request.Builder().url(url).build()).execute().use { resp ->
          if (resp.isSuccessful) resp.body?.bytes() else null
        }
      }.getOrNull() ?: return@launch
      withContext(Dispatchers.Main) {
        val player = player ?: return@withContext
        val index = player.currentMediaItemIndex
        val current = player.currentMediaItem ?: return@withContext
        if (current.mediaId != item.mediaId) return@withContext // 切歌竞态
        player.replaceMediaItem(
          index,
          current.buildUpon()
            .setMediaMetadata(
              current.mediaMetadata.buildUpon()
                .setArtworkData(bytes, MediaMetadata.PICTURE_TYPE_FRONT_COVER)
                .build(),
            )
            .build(),
        )
      }
    }
  }

  /** 500ms 轮询：位置发布 + 打点判定 + ENDED 兜底打点 + 现场存档（10s 粒度） */
  private fun startTicker() {
    serviceScope.launch {
      var tick = 0
      while (true) {
        val p = player
        if (p != null && p.mediaItemCount > 0) {
          PlayerBus.update {
            it.copy(positionMs = if (p.isPlaying) p.currentPosition else it.positionMs)
          }
          maybeScrobble(p)
          if (++tick % 20 == 0) persistResume()
        }
        delay(500)
      }
    }
  }

  /** 播放现场落盘：进程被杀/重启后供 onPlaybackResumption 复活队列 */
  private fun persistResume() {
    val state = PlayerBus.state.value
    if (state.queue.isEmpty() || state.index < 0) return
    val positionMs = player?.currentPosition ?: state.positionMs
    val snapshot = ResumeStore.snapshot(state.queue, state.index, positionMs)
    serviceScope.launch(Dispatchers.IO) {
      ResumeStore.save(this@PlaybackService, snapshot)
    }
  }

  private fun maybeScrobble(p: Player) {
    val id = p.currentMediaItem?.mediaId ?: return
    if (id in scrobbled) return
    val ended = p.playbackState == Player.STATE_ENDED
    val posSec = (if (ended) p.duration else p.currentPosition) / 1000
    val durSec = (if (p.duration > 0) p.duration else 0L) / 1000
    val should = if (ended) {
      true
    } else if (p.isPlaying && durSec > 0) {
      posSec * 2 >= durSec || posSec >= 240
    } else {
      false
    }
    if (!should) return
    scrobbled.add(id)
    val track = PlayerBus.state.value.current ?: return
    val listened = (if (ended) track.durationSeconds * 1000L else p.currentPosition) / 1000
    val capped = listened.coerceIn(0, track.durationSeconds.toLong()).toInt()
    serviceScope.launch(Dispatchers.IO) {
      runCatching { OpenMusicApp.api.recordPlay(id, capped) }
    }
  }

  /** 解码失败（罕见编码）→ 服务器转码 mp3 重试一次 */
  private fun maybeTranscodeFallback() {
    val p = player ?: return
    val item = p.currentMediaItem ?: return
    if (item.mediaId in transcoded) return
    transcoded.add(item.mediaId)
    val fallback = item.buildUpon()
      .setUri(OpenMusicApp.api.streamUrl(item.mediaId, transcode = true))
      .build()
    val index = p.currentMediaItemIndex
    p.replaceMediaItem(index, fallback)
    p.prepare()
    p.play()
  }

  // ── 队列操作实现（companion 转发进来）──────────────────
  /** 队列整体更换/恢复时清空曲目级簿记（打点/转码回退/封面注入） */
  private fun resetPlaybackBookkeeping() {
    scrobbled.clear()
    transcoded.clear()
    // 队列重建后 MediaItem 全新（artworkData 为空），注入记录一并重置
    artworkInjected.clear()
  }

  private fun doSetQueue(tracks: List<TrackSummary>, startIndex: Int) {
    val p = player ?: return
    resetPlaybackBookkeeping()
    PlayerBus.update { PlayerUiState(queue = tracks) }
    val items = tracks.map { toMediaItem(it) }
    p.setMediaItems(items, startIndex.coerceIn(0, (items.size - 1).coerceAtLeast(0)), 0L)
    p.prepare()
    p.play()
  }

  private fun doEnqueue(tracks: List<TrackSummary>) {
    val p = player ?: return
    PlayerBus.update { it.copy(queue = it.queue + tracks) }
    p.addMediaItems(tracks.map { toMediaItem(it) })
  }

  private fun doEnqueueNext(track: TrackSummary) {
    val p = player ?: return
    PlayerBus.update {
      val q = it.queue.toMutableList()
      q.add((it.index + 1).coerceAtMost(q.size), track)
      it.copy(queue = q)
    }
    p.addMediaItem((p.currentMediaItemIndex + 1).coerceAtMost(p.mediaItemCount), toMediaItem(track))
  }

  private fun doRemoveAt(position: Int) {
    val p = player ?: return
    if (position !in 0 until p.mediaItemCount) return
    PlayerBus.update {
      val q = it.queue.toMutableList().apply { removeAt(position) }
      val idx = when {
        position < it.index -> it.index - 1
        position == it.index -> position.coerceAtMost(q.size - 1)
        else -> it.index
      }
      it.copy(queue = q, index = idx)
    }
    p.removeMediaItem(position)
  }

  private fun doJumpTo(position: Int) {
    val p = player ?: return
    if (position !in 0 until p.mediaItemCount) return
    PlayerBus.update { it.copy(index = position, positionMs = 0) }
    p.seekToDefaultPosition(position)
    p.play()
  }

  private fun doClearQueue() {
    val p = player ?: return
    p.stop()
    p.clearMediaItems()
    resetPlaybackBookkeeping()
    // 用户主动清队列：恢复存档一并作废，避免"继续播放"复活已弃队列
    serviceScope.launch(Dispatchers.IO) { ResumeStore.clear(this@PlaybackService) }
    PlayerBus.reset()
  }

  private fun doReplayCurrent() {
    val p = player ?: return
    p.seekToDefaultPosition(p.currentMediaItemIndex)
    p.prepare()
    p.play()
  }

  // ── 通知栏按钮（收藏 + 播放模式）与播放恢复 ────────────
  /** 自定义 SessionCommand：通知栏/锁屏上的心形与播放模式按钮；恢复回调也在这个 Callback 上 */
  private val sessionCallback = object : MediaSession.Callback {
    override fun onConnect(
      session: MediaSession,
      controller: MediaSession.ControllerInfo,
    ): MediaSession.ConnectionResult =
      MediaSession.ConnectionResult.AcceptedResultBuilder(session)
        // 不授予的话系统通知控制器拿不到自定义命令，按钮会被过滤掉
        .setAvailableSessionCommands(
          SessionCommands.Builder()
            .addSessionCommands(listOf(favoriteCommand, playModeCommand))
            .build(),
        )
        .build()

    override fun onPostConnect(session: MediaSession, controller: MediaSession.ControllerInfo) {
      publishMediaButtons()
    }

    override fun onCustomCommand(
      session: MediaSession,
      controller: MediaSession.ControllerInfo,
      customCommand: SessionCommand,
      args: Bundle,
    ): ListenableFuture<SessionResult> {
      when (customCommand.customAction) {
        ACTION_FAVORITE -> {
          val track = PlayerBus.state.value.current
          if (track != null) {
            // 乐观更新走全局 StarOverlay：App 内所有心形按钮同步刷新
            StarOverlay.toggle(track.id, StarOverlay.isStarred(track.id, track.starred))
          }
          return Futures.immediateFuture(SessionResult(SessionResult.RESULT_SUCCESS))
        }
        ACTION_PLAY_MODE -> {
          cyclePlayMode()
          return Futures.immediateFuture(SessionResult(SessionResult.RESULT_SUCCESS))
        }
      }
      return Futures.immediateFuture(SessionResult(SessionResult.RESULT_ERROR_NOT_SUPPORTED))
    }

    /**
     * Android 11+ 系统"继续播放"胶囊：进程被杀/重启后下拉栏点播放即复活队列。
     * 返回存档的队列/起点，media3 会应用 setMediaItems + prepare；PlayerBus 预先
     * 填好队列让 UI 立即可见。
     */
    override fun onPlaybackResumption(
      session: MediaSession,
      controller: MediaSession.ControllerInfo,
    ): ListenableFuture<MediaSession.MediaItemsWithStartPosition> {
      val future = SettableFuture.create<MediaSession.MediaItemsWithStartPosition>()
      serviceScope.launch {
        val saved = ResumeStore.load(this@PlaybackService)
        if (saved == null || saved.queue.isEmpty()) {
          future.setException(IllegalStateException("no resumable playback state"))
          return@launch
        }
        resetPlaybackBookkeeping()
        val startIndex = saved.index.coerceIn(0, saved.queue.size - 1)
        PlayerBus.update { PlayerUiState(queue = saved.queue, index = startIndex, positionMs = saved.positionMs) }
        future.set(
          MediaSession.MediaItemsWithStartPosition(
            ImmutableList.copyOf(saved.queue.map { toMediaItem(it) }),
            startIndex,
            saved.positionMs,
          ),
        )
      }
      return future
    }
  }

  /** 通知栏播放模式按钮：四态循环（顺序/列表循环/单曲循环/随机） */
  private fun cyclePlayMode() {
    val p = player ?: return
    val target = PlayerBus.state.value.playMode().next()
    when (target) {
      PlayMode.SEQUENCE -> { p.shuffleModeEnabled = false; p.repeatMode = Player.REPEAT_MODE_OFF }
      PlayMode.LIST_LOOP -> { p.shuffleModeEnabled = false; p.repeatMode = Player.REPEAT_MODE_ALL }
      PlayMode.ONE_LOOP -> { p.shuffleModeEnabled = false; p.repeatMode = Player.REPEAT_MODE_ONE }
      // 随机配 OFF 会在一轮后停播，ALL 才符合"一直随机播下去"的预期
      PlayMode.SHUFFLE -> { p.shuffleModeEnabled = true; p.repeatMode = Player.REPEAT_MODE_ALL }
    }
    // repeat/shuffle 变化 → listener.publish() → PlayerBus → watchMediaButtons 刷新按钮
  }

  private fun iconFor(mode: PlayMode): Int = when (mode) {
    PlayMode.SEQUENCE -> CommandButton.ICON_REPEAT_OFF
    PlayMode.LIST_LOOP -> CommandButton.ICON_REPEAT_ALL
    PlayMode.ONE_LOOP -> CommandButton.ICON_REPEAT_ONE
    PlayMode.SHUFFLE -> CommandButton.ICON_SHUFFLE_ON
  }

  /** 订阅播放状态与收藏覆盖层，刷新通知栏按钮图标 */
  private fun watchMediaButtons() {
    serviceScope.launch {
      combine(PlayerBus.state, StarOverlay.starStates) { s, _ -> s }
        .collect { publishMediaButtons() }
    }
  }

  /**
   * 13+ 卡片五槽位：[模式][上一首][播放][下一首][收藏]（custom 按按添加顺序填两端）；
   * 12- 展开态全部可见、紧凑态仍是 上一首/播放/下一首。
   *
   * 注意 slots 必须用 SLOT_OVERFLOW：SLOT_BACK/SLOT_FORWARD 会替换上一首/下一首，
   * 而 SLOT_*_SECONDARY 在 1.8.0 的 mediaButtonPreferences→PlaybackState 转换中
   * 不被识别（getCustomLayoutFromMediaButtonPreferences 只认 BACK/FORWARD/OVERFLOW），
   * 按钮会被静默丢弃——实测 Android 16 卡片因此只显示三个标准键。
   */
  private fun publishMediaButtons() {
    val session = mediaSession ?: return
    val state = PlayerBus.state.value
    val track = state.current
    if (track == null) {
      if (lastButtonKey != null) {
        lastButtonKey = null
        session.setMediaButtonPreferences(emptyList())
      }
      return
    }
    val starred = StarOverlay.isStarred(track.id, track.starred)
    val mode = state.playMode()
    val key = Triple(track.id, starred, mode)
    if (key == lastButtonKey) return
    lastButtonKey = key
    session.setMediaButtonPreferences(
      listOf(
        CommandButton.Builder(iconFor(mode))
          .setSessionCommand(playModeCommand)
          .setSlots(CommandButton.SLOT_OVERFLOW)
          .setDisplayName(mode.label)
          .build(),
        CommandButton.Builder(
          if (starred) CommandButton.ICON_HEART_FILLED else CommandButton.ICON_HEART_UNFILLED,
        )
          .setSessionCommand(favoriteCommand)
          .setSlots(CommandButton.SLOT_OVERFLOW)
          .setDisplayName(if (starred) "取消收藏" else "收藏")
          .build(),
      ),
    )
  }

  companion object {
    private const val ACTION_FAVORITE = "dev.hmsy.openmusic.action.FAVORITE"
    private const val ACTION_PLAY_MODE = "dev.hmsy.openmusic.action.PLAY_MODE"
    private val favoriteCommand = SessionCommand(ACTION_FAVORITE, Bundle.EMPTY)
    private val playModeCommand = SessionCommand(ACTION_PLAY_MODE, Bundle.EMPTY)

    @Volatile
    private var instance: PlaybackService? = null

    fun attach(service: PlaybackService) { instance = service }
    fun detach(service: PlaybackService) { if (instance === service) instance = null }

    /** MediaItem：mediaId=track.id，封面走 MediaMetadata（通知栏/锁屏自动取用） */
    fun toMediaItem(track: TrackSummary): MediaItem {
      val api = OpenMusicApp.api
      return MediaItem.Builder()
        .setMediaId(track.id)
        .setUri(api.streamUrl(track.id))
        .setMediaMetadata(
          MediaMetadata.Builder()
            .setTitle(track.title)
            .setArtist(track.artist.name)
            .setAlbumTitle(track.album.name)
            .setAlbumArtist(track.artist.name)
            .setArtworkUri(if (track.hasCoverArt) Uri.parse(api.albumCoverUrl(track.album.id)) else null)
            .setMediaType(MediaMetadata.MEDIA_TYPE_MUSIC)
            .build(),
        )
        .build()
    }

    fun setQueue(tracks: List<TrackSummary>, startIndex: Int = 0) = instance?.doSetQueue(tracks, startIndex)
    fun enqueue(tracks: List<TrackSummary>) = instance?.doEnqueue(tracks)
    fun enqueueNext(track: TrackSummary) = instance?.doEnqueueNext(track)
    fun removeAt(position: Int) = instance?.doRemoveAt(position)
    fun jumpTo(position: Int) = instance?.doJumpTo(position)
    fun clearQueue() = instance?.doClearQueue()
    fun replayCurrent() = instance?.doReplayCurrent()
  }
}
