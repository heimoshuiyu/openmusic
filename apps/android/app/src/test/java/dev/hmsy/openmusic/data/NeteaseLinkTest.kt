package dev.hmsy.openmusic.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

/** 与服务端 service/netease/source.test.ts 同一组用例：客户端解析语义与服务器一致 */
class NeteaseLinkTest {

  private fun parsed(raw: String): NeteaseLink? = parseNeteaseLink(raw)

  @Test
  fun rebuildsTrustedLinksCanonicalUrl() {
    val cases = listOf(
      "https://music.163.com/song?id=5264842" to ("song" to "5264842"),
      "http://music.163.com/song?id=5264842&userid=1" to ("song" to "5264842"),
      "https://music.163.com/#/song?id=5264842" to ("song" to "5264842"),
      "https://y.music.163.com/m/song?id=5264842" to ("song" to "5264842"),
      "https://music.163.com/m/song/5264842" to ("song" to "5264842"),
      "https://www.music.163.com/song/?id=5264842" to ("song" to "5264842"),
      "https://music.163.com/playlist?id=718606" to ("playlist" to "718606"),
      "https://music.163.com/#/playlist?id=718606" to ("playlist" to "718606"),
      "https://music.163.com/album?id=35135711" to ("album" to "35135711"),
      "https://music.163.com/#/album?id=35135711" to ("album" to "35135711"),
      "https://y.music.163.com/m/album?id=35135711" to ("album" to "35135711"),
      "https://music.163.com/artist?id=6454" to ("artist" to "6454"),
      " https://music.163.com/song?id=6454 " to ("song" to "6454"),
    )
    for ((raw, expected) in cases) {
      val link = parsed(raw)
      assertNotNull("应能解析 $raw", link)
      assertEquals(expected.first, link!!.kind.name.lowercase())
      assertEquals(expected.second, link.id)
      assertEquals("https://music.163.com/${expected.first}?id=${expected.second}", link.canonicalUrl)
    }
  }

  @Test
  fun rejectsOtherHostsPathsIdsAndInjection() {
    for (url in listOf(
      "file:///etc/passwd",
      "--exec=echo",
      "netease:song:5264842",
      "https://music.163.com.evil.com/song?id=5264842",
      "https://evil.com/?u=https://music.163.com/song?id=5264842",
      "https://user@music.163.com/song?id=5264842",
      "http://music.163.com:555/song?id=5264842",
      "https://music.163.com/discover/playlist?id=5264842",
      "https://music.163.com/dj?id=5264842",
      "https://music.163.com/song?id=abc",
      "https://music.163.com/song?id=",
      "https://music.163.com/song?id=123456789012345678901",
      "https://v6.music.163.com/song?id=5264842",
      "https://music.163.com/song/5264842/extra",
      "https://music.163.com/#/mv?id=5264842",
      "https://music.163.com/",
      "",
      "   ",
    )) {
      assertNull("应拒绝 $url", parsed(url))
    }
  }

  @Test
  fun trimsAndToleratesUnencodedShareText() {
    // 分享文案常夹带未转义 CJK：编码重试后仍应解析成功
    val link = parsed("https://music.163.com/song?id=5264842&text=晴天 周杰伦")
    assertNotNull(link)
    assertEquals("5264842", link!!.id)
    assertEquals(NeteaseKind.SONG, link.kind)
  }

  @Test
  fun kindLabelsAreHumanReadable() {
    assertEquals("单曲", NeteaseKind.SONG.label)
    assertEquals("歌单", NeteaseKind.PLAYLIST.label)
    assertEquals("专辑", NeteaseKind.ALBUM.label)
    assertEquals("歌手热门", NeteaseKind.ARTIST.label)
  }
}
