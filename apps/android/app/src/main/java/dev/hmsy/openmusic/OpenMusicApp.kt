package dev.hmsy.openmusic

import android.app.Application
import coil3.ImageLoader
import coil3.SingletonImageLoader
import coil3.network.okhttp.OkHttpNetworkFetcherFactory
import coil3.request.crossfade
import dev.hmsy.openmusic.data.OmApi
import dev.hmsy.openmusic.data.PersistentCookieJar
import dev.hmsy.openmusic.data.SettingsStore
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

/** coil3 单例工厂：封面加载共享 OkHttp（cookie 会话随行） */
class OpenMusicApp : Application(), SingletonImageLoader.Factory {

  override fun newImageLoader(context: android.content.Context): ImageLoader =
    ImageLoader.Builder(context)
      .components { add(OkHttpNetworkFetcherFactory(callFactory = httpClient)) }
      .crossfade(true)
      .build()

  override fun onCreate() {
    super.onCreate()
    settings = SettingsStore(this)
    cookieJar = PersistentCookieJar(settings)
    httpClient = OkHttpClient.Builder()
      .cookieJar(cookieJar)
      .connectTimeout(10, TimeUnit.SECONDS)
      .readTimeout(20, TimeUnit.SECONDS)
      .build()
    api = OmApi(httpClient, cookieJar)

    // 恢复会话态：DataStore 里的服务器地址注入 api（cookie 由 jar 惰性装载）
    kotlinx.coroutines.runBlocking {
      api.baseUrl = settings.serverUrlOnce()
    }
  }

  companion object {
    lateinit var settings: SettingsStore
      private set
    lateinit var cookieJar: PersistentCookieJar
      private set
    lateinit var httpClient: OkHttpClient
      private set
    lateinit var api: OmApi
      private set
  }
}
