package dev.hmsy.openmusic.player

import android.content.ComponentName
import android.content.Context
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume

/**
 * UI → 播放服务的命令通道。
 * 状态读取走 PlayerBus（同进程直读）；命令走 MediaController，
 * 这样通知栏/锁屏/蓝牙耳机按键与 UI 完全一致。
 */
@UnstableApi
class PlayerController(private val controller: MediaController) {

  fun playPause() {
    if (!controller.isPlaying) {
      if (controller.playbackState == androidx.media3.common.Player.STATE_ENDED) {
        PlaybackService.replayCurrent()
      } else {
        if (controller.playbackState == androidx.media3.common.Player.STATE_IDLE && controller.mediaItemCount > 0) controller.prepare()
        controller.play()
      }
    } else {
      controller.pause()
    }
  }

  fun next() = controller.seekToNextMediaItem()

  fun previous() {
    if (controller.currentPosition > 3000) {
      controller.seekBack()
      // seekBack 默认 10s；精确对齐 web 语义：>3s 回到曲首
      controller.seekTo(0)
    } else {
      controller.seekToPreviousMediaItem()
    }
  }

  fun seekTo(ms: Long) = controller.seekTo(ms)

  fun toggleShuffle() { controller.shuffleModeEnabled = !controller.shuffleModeEnabled }

  fun cycleRepeat() {
    controller.repeatMode = when (controller.repeatMode) {
      androidx.media3.common.Player.REPEAT_MODE_OFF -> androidx.media3.common.Player.REPEAT_MODE_ALL
      androidx.media3.common.Player.REPEAT_MODE_ALL -> androidx.media3.common.Player.REPEAT_MODE_ONE
      else -> androidx.media3.common.Player.REPEAT_MODE_OFF
    }
  }

  fun release() = controller.release()

  companion object {
    suspend fun connect(context: Context): PlayerController? {
      val token = SessionToken(context, ComponentName(context, PlaybackService::class.java))
      return suspendCancellableCoroutine { cont ->
        val future = MediaController.Builder(context, token).buildAsync()
        future.addListener({
          val controller = try {
            future.get()
          } catch (_: Exception) {
            null
          }
          if (cont.isActive) cont.resume(controller?.let { PlayerController(it) })
        }, androidx.core.content.ContextCompat.getMainExecutor(context))
        cont.invokeOnCancellation { future.cancel(true) }
      }
    }
  }
}
