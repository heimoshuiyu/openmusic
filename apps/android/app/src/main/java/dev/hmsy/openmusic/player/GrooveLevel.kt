package dev.hmsy.openmusic.player

import android.content.Context
import androidx.media3.common.C
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.audio.DefaultAudioSink
import androidx.media3.exoplayer.audio.TeeAudioProcessor
import java.nio.ByteBuffer
import java.nio.ByteOrder

/** Read only decoded samples while the record is visible. No audio capture permission or second player. */
@UnstableApi
internal object GrooveLevel : TeeAudioProcessor.AudioBufferSink {
  @Volatile var enabled = false
    @Synchronized set(value) { field = value; filled = 0; cursor = 0; sequence++ }
  private val ring = FloatArray(GrooveSpectrum.N)
  private var filled = 0
  private var cursor = 0
  private var sequence = 0L
  private var rate = 0
  private var channels = 0
  private var encoding = C.ENCODING_INVALID

  @Synchronized override fun flush(sampleRateHz: Int, channelCount: Int, encoding: Int) {
    this.encoding = encoding
    rate = sampleRateHz; channels = channelCount; filled = 0; cursor = 0; sequence++
  }
  override fun handleBuffer(buffer: ByteBuffer) {
    if (!enabled) return
    synchronized(this) {
      val bytes = when (encoding) { C.ENCODING_PCM_16BIT -> 2; C.ENCODING_PCM_FLOAT -> 4; else -> return }
      if (!enabled || channels <= 0) return
      val pcm = if (buffer.order() == ByteOrder.nativeOrder()) buffer else buffer.duplicate().order(ByteOrder.nativeOrder())
      val stride = bytes*channels
      val frames = pcm.remaining()/stride
      for (frame in (frames-ring.size).coerceAtLeast(0) until frames) {
        val start = pcm.position()+frame*stride
        var sum = 0f
        for (ch in 0 until channels) sum += if (bytes==2) pcm.getShort(start+ch*2)/32768f else pcm.getFloat(start+ch*4)
        ring[cursor] = if (sum.isFinite()) (sum/channels).coerceIn(-1f,1f) else 0f
        cursor = (cursor+1) and (ring.size-1)
      }
      filled = (filled+frames).coerceAtMost(ring.size); sequence++
    }
  }

  /** Latest full PCM window. Cache its sequence to avoid repeating work between decoder buffers. */
  class Snapshot { val samples = FloatArray(GrooveSpectrum.N); var rate = 0; var seq = -1L }
  @Synchronized fun read(out: Snapshot): Boolean {
    if (out.seq == sequence) return false
    out.seq = sequence
    out.rate = if (enabled && filled == ring.size) rate else 0
    if (out.rate > 0) {
      ring.copyInto(out.samples,0,cursor,ring.size)
      ring.copyInto(out.samples,ring.size-cursor,0,cursor)
    }
    return true
  }
}

@UnstableApi
internal class MeteredRenderers(context: Context) : DefaultRenderersFactory(context) {
  override fun buildAudioSink(context: Context, enableFloatOutput: Boolean, enableAudioTrackPlaybackParams: Boolean) =
    DefaultAudioSink.Builder(context).setEnableFloatOutput(enableFloatOutput)
      .setEnableAudioTrackPlaybackParams(enableAudioTrackPlaybackParams)
      .setAudioProcessors(arrayOf(TeeAudioProcessor(GrooveLevel))).build()
}
