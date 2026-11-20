package dev.hmsy.openmusic.ui.components

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 详情页错误文案裁决：404 → 友好「已不在曲库」（保留可见返回）；
 * 非 404（网络失败/500 等）必须原样透传服务器文案，不得伪装成「已被移出」。
 */
class DetailEntityGoneTest {

  @Test
  fun notFoundStatusYieldsFriendlyGoneCopy() {
    val message = detailEntityGone("张专辑", 404, "404")
    assertEquals("这张专辑已不在曲库中（可能其曲目都已被移出）。", message)
    assertEquals("这位艺人已不在曲库中（可能其曲目都已被移出）。", detailEntityGone("位艺人", 404, "404"))
  }

  @Test
  fun bare404MessageFallsBackToGoneCopyWithoutStatus() {
    // LoadState 未携带 status（历史调用方/非 ApiError 路径）时以裸 "404" 文案兜底
    assertEquals("这张专辑已不在曲库中（可能其曲目都已被移出）。", detailEntityGone("张专辑", null, "404"))
    assertEquals("这位艺人已不在曲库中（可能其曲目都已被移出）。", detailEntityGone("位艺人", null, " 404 "))
  }

  @Test
  fun server500KeepsOriginalMessage() {
    val message = detailEntityGone("张专辑", 500, "服务器内部错误")
    assertEquals("服务器内部错误", message)
    assertFalse(message.contains("已不在曲库"))
  }

  @Test
  fun networkFailureKeepsOriginalMessage() {
    val message = detailEntityGone("位艺人", null, "Failed to connect to /127.0.0.1:3989")
    assertEquals("Failed to connect to /127.0.0.1:3989", message)
    assertFalse(message.contains("已不在曲库"))
  }

  @Test
  fun goneCopyNeverSwallowsServerErrorTextEvenIf404ish() {
    // 400/409/503 等一律透传；只有确凿的 404 才允许换成「已不在曲库」
    assertEquals("请求参数不正确", detailEntityGone("张专辑", 400, "请求参数不正确"))
    assertEquals("服务器正忙（503）", detailEntityGone("位艺人", 503, "服务器正忙（503）"))
    assertTrue(detailEntityGone("张专辑", 404, "任意正文").contains("已不在曲库中"))
  }
}
