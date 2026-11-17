package dev.hmsy.openmusic.player

import android.content.Context
import androidx.media3.common.util.UnstableApi
import androidx.media3.database.StandaloneDatabaseProvider
import androidx.media3.datasource.cache.CacheDataSource
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.ResolvingDataSource
import androidx.media3.datasource.cache.Cache
import androidx.media3.datasource.cache.CacheKeyFactory
import androidx.media3.datasource.cache.NoOpCacheEvictor
import androidx.media3.datasource.cache.SimpleCache
import java.io.File

/**
 * 音频流磁盘缓存（进程单例）：播放过的曲目边下边存，重复播放零流量。
 *
 * - SimpleCache 同一目录全进程只允许一个实例，服务销毁重建**不得 release**——
 *   故挂 object 常驻进程；cacheDir 在存储紧张时可被系统整体回收（缓存可再生）
 * - 容量不设上限（NoOpCacheEvictor，用户决策 2026-10-08）：缓存写失败由
 *   FLAG_IGNORE_CACHE_ON_ERROR 兜底静默回源网络
 * - 缓存键 = origin + trackId（转码回退独立成键，见 [streamCacheKey]）：
 *   服务器地址/查询参数变化不失效，换服务器实例不串缓存
 */
@UnstableApi
object AudioCache {

  @Volatile
  private var cache: SimpleCache? = null

  fun get(context: Context): SimpleCache =
    cache ?: synchronized(this) {
      cache ?: SimpleCache(
        File(context.applicationContext.cacheDir, "audio"),
        NoOpCacheEvictor(),
        StandaloneDatabaseProvider(context.applicationContext),
      ).also { cache = it }
    }

  /** DataSpec → 稳定缓存键；非 stream URI 回退 URI 原文（封面等不经过此数据源，仅兜底） */
  val cacheKeyFactory = CacheKeyFactory { spec ->
    val uri = spec.uri
    streamCacheKey(
      scheme = uri.scheme ?: "http",
      host = uri.host,
      port = uri.port,
      path = uri.path,
      transcode = uri.getQueryParameter("format") != null,
    ) ?: uri.toString()
  }

  internal fun playbackFactory(cache: Cache, upstream: DataSource.Factory): DataSource.Factory {
    val cached = CacheDataSource.Factory().setCache(cache).setUpstreamDataSourceFactory(upstream)
      .setCacheKeyFactory(cacheKeyFactory).setFlags(CacheDataSource.FLAG_IGNORE_CACHE_ON_ERROR)
    return ResolvingDataSource.Factory(cached) { spec ->
      // ProgressiveMediaPeriod sets this flag for potential live streams. Our library endpoint
      // always serves a finite track, including first-pass transcodes whose length is not yet known.
      // Preserve ranges, all other flags and existing cache keys. Never guess the size from the source file.
      if (spec.isFlagSet(DataSpec.FLAG_DONT_CACHE_IF_LENGTH_UNKNOWN) &&
        spec.uri.scheme in listOf("http", "https") && finiteStreamPath.matches(spec.uri.path.orEmpty())) {
        spec.buildUpon().setFlags(spec.flags and DataSpec.FLAG_DONT_CACHE_IF_LENGTH_UNKNOWN.inv()).build()
      } else spec
    }
  }
}

private val finiteStreamPath = Regex("(?:/[^/]+)*/api/v1/tracks/[0-9]+/stream")

/** stream 路径前缀（与 Api.streamUrl 的形状对应） */
private val streamPath = Regex("/api/v1/tracks/([^/?#]+)/stream")

/**
 * 纯函数：stream 请求 → 归一化缓存键 `<scheme>://<host>[:<port>]/track/<id>`。
 * 转码回退（?format=mp3…）与原始流是两份不同字节流，加 `-t` 后缀分开存，
 * 避免回退后读到解码失败的原始缓存。非 stream 路径返回 null。
 */
internal fun streamCacheKey(
  scheme: String,
  host: String?,
  port: Int,
  path: String?,
  transcode: Boolean,
): String? {
  val id = streamPath.find(path ?: "")?.groupValues?.getOrNull(1) ?: return null
  val portPart = if (port > 0) ":$port" else ""
  return "${scheme}://${host ?: ""}$portPart/track/$id${if (transcode) "-t" else ""}"
}
