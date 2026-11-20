package dev.hmsy.openmusic.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 网易云来源管理屏的状态机与移出文案（纯函数层）：
 * 移出成功是显式终态——不得重发已知会 404 的 info 请求，不得把成功当失败；
 * 对话框/终态卡文案须与 library_exclusions 的真实语义一致（扫描不捡回、恢复需先删文件）。
 */
class NeteaseTrackStateTest {

  private val info = NeteaseInfo(
    trackId = "3", songId = "5264842", quality = "exhigh", format = "mp3",
    filename = "Netease-5264842.mp3", title = "渡口", artist = "蔡琴", album = "惠威T200A试音碟",
  )

  @Test
  fun loadingAndReadyStates() {
    assertEquals(NeteaseTrackState.Loading, neteaseTrackState(null, null, null))
    val ready = neteaseTrackState(info, null, null)
    assertTrue(ready is NeteaseTrackState.Ready)
    assertEquals("3", (ready as NeteaseTrackState.Ready).info.trackId)
  }

  @Test
  fun removedTakesPrecedenceOverEverything() {
    // 成功终态压倒任何残留失败/旧数据：不把成功当失败
    val state = neteaseTrackState(info, 404 to "404", "Netease-5264842.mp3")
    assertTrue(state is NeteaseTrackState.Removed)
    assertEquals("Netease-5264842.mp3", (state as NeteaseTrackState.Removed).filename)
    // 即使 info 未加载（null）也照样进成功终态
    assertTrue(neteaseTrackState(null, null, "f.mp3") is NeteaseTrackState.Removed)
  }

  @Test
  fun unreachable404KeepsFriendlyCopy() {
    val message = neteaseTrackUnreachableMessage(404, "404")
    assertEquals("这首歌不是网易云导入的曲目（或已不在库中）。「网易云来源」只对网易云导入的曲目开放。", message)
    // 其他错误原样透传服务器文案
    assertEquals("服务器内部错误", neteaseTrackUnreachableMessage(500, "服务器内部错误"))
    assertEquals("网络中断", neteaseTrackUnreachableMessage(0, "网络中断"))
  }

  @Test
  fun unindexDialogBodyMatchesExclusionSemantics() {
    val body = neteaseUnindexDialogBody("Netease-5264842.mp3")
    // 不再承诺「重新扫描即可恢复」——排除记录正是为了扫描不捡回
    assertFalse(body.contains("重新扫描目录"))
    assertTrue(body, body.contains("扫描不会自动"))
    assertTrue(body, body.contains("排除记录"))
    // 保留文件 / 播放记录语义不变
    assertTrue(body, body.contains("磁盘文件保留不动（Netease-5264842.mp3）"))
    assertTrue(body, body.contains("播放记录保留"))
    // 恢复路径如实：先删/移走文件再导入（文件仍在时重导入不会入库）
    assertTrue(body, body.contains("删除或移走该文件"))
    assertTrue(body, body.contains("再次导入"))
  }

  @Test
  fun removedCardCopyIsSelfContained() {
    assertEquals("原文件保留：Netease-5264842.mp3", neteaseRemovedFileLine("Netease-5264842.mp3"))
    assertTrue(NETEASE_REMOVED_GUIDANCE.contains("扫描不会自动"))
    assertTrue(NETEASE_REMOVED_GUIDANCE.contains("删除或移走"))
  }
}
