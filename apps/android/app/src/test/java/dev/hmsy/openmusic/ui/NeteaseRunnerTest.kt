package dev.hmsy.openmusic.ui

import java.net.SocketTimeoutException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import dev.hmsy.openmusic.data.NeteaseImportResult
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** MainArea 级运行器状态机：成功/失败/超时文案/单飞拒绝（注入 import，照 StarStateTest 姿势） */
@OptIn(ExperimentalCoroutinesApi::class)
class NeteaseRunnerTest {

  private fun result() = NeteaseImportResult(url = "u", kind = "song", state = "done", imported = 1, total = 1)

  @Test
  fun successSetsOutcomeAndClearsBusy() = runTest {
    val runner = NeteaseRunner(this) { _, _, _ -> result() }
    assertNull(runner.start("u", "1", null, "音乐"))
    runCurrent()
    assertNull(runner.busy)
    assertEquals("done", runner.outcome?.state)
    assertNull(runner.error)
  }

  @Test
  fun failureSetsReadableError() = runTest {
    val runner = NeteaseRunner(this) { _, _, _ -> throw IllegalStateException("服务器到网易云的网络连接失败") }
    assertNull(runner.start("u", "1", null, "音乐"))
    runCurrent()
    assertNull(runner.busy)
    assertNull(runner.outcome)
    assertEquals("服务器到网易云的网络连接失败", runner.error)
  }

  @Test
  fun readTimeoutGetsHonestRetryGuidance() = runTest {
    val runner = NeteaseRunner(this) { _, _, _ -> throw SocketTimeoutException("timeout") }
    assertNull(runner.start("u", "1", null, "音乐"))
    runCurrent()
    val error = runner.error
    assertNotNull(error)
    assertTrue(error!!, error.contains("不会取消") && error.contains("重新提交") && error.contains("不会重复下载"))
  }

  @Test
  fun singleFlightRefusesSecondStartWhileBusy() = runTest {
    val gate = CompletableDeferred<Unit>()
    var calls = 0
    val runner = NeteaseRunner(this) { _, _, _ ->
      calls++
      gate.await()
      result()
    }
    assertNull(runner.start("u", "1", null, "音乐"))
    // 让首个任务真正进入执行（挂在 gate 上，保持 busy 状态）
    runCurrent()
    assertEquals(1, calls)
    val refusal = runner.start("https://music.163.com/song?id=5264842", "1", null, "音乐")
    assertNotNull("进行中必须拒绝第二次提交", refusal)
    assertTrue(refusal!!, refusal.contains("只允许一个导入任务"))
    assertEquals("拒绝的提交不得发起第二次调用", 1, calls)
    gate.complete(Unit)
    runCurrent()
    assertEquals("done", runner.outcome?.state)
  }

  @Test
  fun clearOutcomeResetsBothOutcomeAndError() = runTest {
    val runner = NeteaseRunner(this) { _, _, _ -> result() }
    runner.start("u", "1", null, "音乐")
    runCurrent()
    assertNotNull(runner.outcome)
    runner.clearOutcome()
    assertNull(runner.outcome)
    assertNull(runner.error)
  }
}
