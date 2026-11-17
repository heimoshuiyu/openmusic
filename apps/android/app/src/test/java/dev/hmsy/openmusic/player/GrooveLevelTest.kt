package dev.hmsy.openmusic.player

import androidx.media3.common.C
import androidx.media3.common.util.UnstableApi
import java.nio.ByteBuffer
import java.nio.ByteOrder
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import dev.hmsy.openmusic.ui.player.GrooveGrid
import kotlin.math.*
import org.junit.Test

@UnstableApi
class GrooveLevelTest {
  @After fun reset() { GrooveLevel.enabled = false; GrooveLevel.flush(48000, 2, C.ENCODING_INVALID) }

  @Test fun `PCM windows preserve buffer position and resolve tones in the same bands as Web Audio`() {
    val fft = GrooveSpectrum(); val frame = GrooveLevel.Snapshot(); val levels = FloatArray(80)
    for (rate in listOf(44100,48000,96000)) {
      var last = -1
      for (hz in listOf(90,1200,9000)) {
        GrooveLevel.flush(rate,2,C.ENCODING_PCM_16BIT); GrooveLevel.enabled=true
        for (chunk in 0..3) {
          val pcm=ByteBuffer.allocate(4+1024*4).order(ByteOrder.nativeOrder()); pcm.position(4)
          repeat(1024) { val value=(16000*sin(2*PI*hz*(chunk*1024+it)/rate)).toInt().toShort(); pcm.putShort(value); pcm.putShort(value) }
          pcm.flip(); pcm.position(4); GrooveLevel.handleBuffer(pcm); assertEquals(4,pcm.position())
        }
        assertTrue(GrooveLevel.read(frame)); assertEquals(rate,frame.rate)
        fft.measure(frame.samples,frame.rate,levels)
        val peak = levels.indices.maxBy { levels[it] }; assertTrue(peak > last); last=peak
        assertTrue(levels[peak]>.7f); assertTrue(levels.count { it>.15f } < 8)
      }
    }
  }

  @Test fun `hidden stage and unsupported encoding stay dark`() {
    val pcm = ByteBuffer.wrap(ByteArray(32768) { 42 }); val frame=GrooveLevel.Snapshot()
    GrooveLevel.flush(44100, 2, C.ENCODING_PCM_16BIT); GrooveLevel.enabled = false
    GrooveLevel.handleBuffer(pcm); GrooveLevel.read(frame); assertEquals(0, frame.rate)
    GrooveLevel.flush(44100, 2, C.ENCODING_INVALID); GrooveLevel.enabled = true
    GrooveLevel.handleBuffer(pcm); GrooveLevel.read(frame); assertEquals(0, frame.rate)
    GrooveLevel.flush(48000,2,C.ENCODING_PCM_FLOAT); GrooveLevel.handleBuffer(ByteBuffer.allocate(32768))
    GrooveLevel.read(frame); assertEquals(48000,frame.rate)
    val levels=FloatArray(80); GrooveSpectrum().measure(frame.samples,frame.rate,levels); assertTrue(levels.all { it==0f })
  }

  @Test fun `seam covers 15 columns and lands gently on bass without changing the centers`() {
    val centers=(0 until GrooveGrid.COLUMNS).filter { GrooveGrid.mix(it)==0f }.map { GrooveGrid.band(it) }
    assertEquals((0 until 80).toList(),centers)
    val seam=(0 until GrooveGrid.COLUMNS).filter { GrooveGrid.band(it)==79 }
    assertEquals(15,seam.size); assertTrue(seam.all { GrooveGrid.next(it)==0 })
    val values=seam.map { GrooveGrid.mix(it) }+1f
    val steps=values.zipWithNext { a,b -> b-a }; assertTrue(steps.all { it in 0f..0.11f }); assertTrue(steps.last()<.02f)
  }
}
