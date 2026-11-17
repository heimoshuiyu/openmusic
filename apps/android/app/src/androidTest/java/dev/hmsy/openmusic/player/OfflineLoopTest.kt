@file:androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)

package dev.hmsy.openmusic.player

import android.net.Uri
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.database.StandaloneDatabaseProvider
import androidx.media3.datasource.ByteArrayDataSource
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.cache.CacheDataSource
import androidx.media3.datasource.cache.NoOpCacheEvictor
import androidx.media3.datasource.cache.SimpleCache
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.*
import org.junit.Test

class OfflineLoopTest {
  @Test fun unknownLengthTrackIsCachedThenLoopsWithUpstreamUnavailable() {
    val inst = InstrumentationRegistry.getInstrumentation()
    val ctx = inst.targetContext
    val dir = File(ctx.cacheDir, "offline-test-${System.nanoTime()}")
    val db = StandaloneDatabaseProvider(ctx)
    val cache = SimpleCache(dir, NoOpCacheEvictor(), db)
    // 1 second of silent, valid mono PCM. No network, production credentials or real music files.
    val wav = ByteBuffer.allocate(44+16000).order(ByteOrder.LITTLE_ENDIAN).apply {
      put("RIFF".toByteArray()); putInt(capacity()-8); put("WAVEfmt ".toByteArray()); putInt(16)
      putShort(1); putShort(1); putInt(8000); putInt(16000); putShort(2); putShort(16)
      put("data".toByteArray()); putInt(16000)
    }.array()
    val url = Uri.parse("https://music.example/api/v1/tracks/42/stream")
    val spec = DataSpec.Builder().setUri(url).setFlags(DataSpec.FLAG_DONT_CACHE_IF_LENGTH_UNKNOWN or DataSpec.FLAG_ALLOW_CACHE_FRAGMENTATION).build()
    val key = AudioCache.cacheKeyFactory.buildCacheKey(spec)
    val online = DataSource.Factory {
      val bytes = ByteArrayDataSource(wav)
      object : DataSource by bytes {
        override fun open(dataSpec: DataSpec): Long { bytes.open(dataSpec); return C.LENGTH_UNSET.toLong() }
      }
    }
    val attempts = AtomicInteger()
    val offline = DataSource.Factory {
      object : DataSource by ByteArrayDataSource(wav) {
        override fun open(dataSpec: DataSpec): Long { attempts.incrementAndGet(); throw IOException("upstream disconnected") }
      }
    }
    fun readAll(factory:DataSource.Factory, request:DataSpec=spec) {
      val source=factory.createDataSource(); val buf=ByteArray(4096); var n=0
      try { source.open(request); while(true){val r=source.read(buf,0,buf.size);if(r<0)break;n+=r} } finally {source.close()}
      assertEquals(wav.size,n)
    }
    var player: ExoPlayer? = null
    try {
      // Old factory: a successful complete read could store the length, but zero payload bytes.
      val oldSpec=spec.buildUpon().setUri("https://music.example/api/v1/tracks/41/stream").build()
      readAll(CacheDataSource.Factory().setCache(cache).setCacheKeyFactory(AudioCache.cacheKeyFactory).setUpstreamDataSourceFactory(online),oldSpec)
      assertEquals(0L,cache.getCachedBytes(AudioCache.cacheKeyFactory.buildCacheKey(oldSpec),0,wav.size.toLong()))
      // Fresh unknown-length download with the production factory, followed by a new player:
      // playback must be from disk, not a warm decoder queue or an existing connection.
      readAll(AudioCache.playbackFactory(cache,online))
      assertTrue(cache.isCached(key,0,wav.size.toLong()))
      val repeats=CountDownLatch(3); val error=AtomicReference<PlaybackException>()
      inst.runOnMainSync {
        player=ExoPlayer.Builder(ctx).setMediaSourceFactory(DefaultMediaSourceFactory(AudioCache.playbackFactory(cache,offline))).build().apply {
          volume=0f; repeatMode=Player.REPEAT_MODE_ONE
          addListener(object : Player.Listener {
            override fun onMediaItemTransition(item: MediaItem?, reason: Int) { if(reason==Player.MEDIA_ITEM_TRANSITION_REASON_REPEAT)repeats.countDown() }
            override fun onPlayerError(e: PlaybackException) { error.set(e); while(repeats.count>0)repeats.countDown() }
          })
          setMediaItem(MediaItem.fromUri(url)); prepare(); play()
        }
      }
      assertTrue("three offline loops",repeats.await(20,TimeUnit.SECONDS))
      assertNull(error.get()); assertEquals(0,attempts.get())
    } finally { inst.runOnMainSync { player?.release() }; cache.release(); SimpleCache.delete(dir,db); db.close() }
  }
}
