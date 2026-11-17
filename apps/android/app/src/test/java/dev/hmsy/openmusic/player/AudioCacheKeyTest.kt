package dev.hmsy.openmusic.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import androidx.media3.common.PlaybackException
import org.junit.Test

/** 缓存键归一化：重复播放命中、转码回退独立、跨服务器不串缓存 */
class AudioCacheKeyTest {

  @Test fun networkAndHttpErrorsNeverSelectAnotherStream() {
    for (code in listOf(PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED,
      PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT,PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS,
      PlaybackException.ERROR_CODE_IO_UNSPECIFIED)) assertEquals(false,needsCodecFallback(code))
    assertEquals(true,needsCodecFallback(PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED))
  }

  @Test
  fun originalStreamKey() {
    assertEquals(
      "http://192.0.2.10:3000/track/42",
      streamCacheKey("http", "192.0.2.10", 3000, "/api/v1/tracks/42/stream", transcode = false),
    )
  }

  @Test
  fun transcodeVariantGetsSeparateKey() {
    assertEquals(
      "http://192.0.2.10:3000/track/42-t",
      streamCacheKey("http", "192.0.2.10", 3000, "/api/v1/tracks/42/stream", transcode = true),
    )
  }

  @Test
  fun defaultPortOmitted() {
    assertEquals(
      "https://example.com/track/7",
      streamCacheKey("https", "example.com", -1, "/api/v1/tracks/7/stream", transcode = false),
    )
  }

  @Test
  fun differentServersDoNotCollide() {
    val a = streamCacheKey("http", "192.0.2.10", 3000, "/api/v1/tracks/7/stream", transcode = false)
    val b = streamCacheKey("http", "198.51.100.10", 3000, "/api/v1/tracks/7/stream", transcode = false)
    assertNotEquals(a, b)
  }

  @Test
  fun nonStreamPathReturnsNull() {
    assertNull(streamCacheKey("http", "x", 1, "/api/v1/covers/al-1", transcode = false))
    assertNull(streamCacheKey("http", "x", 1, null, transcode = false))
  }
}
