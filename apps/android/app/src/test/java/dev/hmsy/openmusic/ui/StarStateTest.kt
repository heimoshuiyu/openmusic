package dev.hmsy.openmusic.ui

import java.io.IOException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class StarStateTest {
  @Test
  fun fallsBackToServerState() = runTest {
    val state = StarState(this) { _, _, _ -> }
    assertFalse(state.isStarred("42", null))
    assertTrue(state.isStarred("42", "2026-10-02T00:00:00Z"))
  }

  @Test
  fun updatesImmediatelyAndNotifiesOnlyAfterPersistence() = runTest {
    val gate = CompletableDeferred<Unit>()
    val writes = mutableListOf<Boolean>()
    val state = StarState(this) { kind, id, starred ->
      assertEquals("tracks", kind)
      assertEquals("42", id)
      gate.await()
      writes += starred
    }
    var changed = 0
    state.toggle("42", false, onChanged = { changed++ })
    assertTrue(state.isStarred("42", null))
    assertEquals(true, state.stars.value[StarKey("tracks", "42")])
    runCurrent()
    assertEquals(0, changed)
    gate.complete(Unit)
    runCurrent()
    assertEquals(listOf(true), writes)
    assertEquals(1, changed)
  }

  @Test
  fun rollsBackFailedFavoriteWithoutReloading() = runTest {
    val state = StarState(this) { _, _, _ -> throw IOException("offline") }
    var failed = 0
    var changed = 0
    state.toggle("42", false, onError = { failed++ }, onChanged = { changed++ })
    assertTrue(state.isStarred("42", null))
    runCurrent()
    assertFalse(state.isStarred("42", null))
    assertEquals(1, failed)
    assertEquals(0, changed)
    // 失败后可重试，不会一直锁在 pending。
    state.toggle("42", false, onError = { failed++ })
    runCurrent()
    assertEquals(2, failed)
  }

  @Test
  fun rollsBackFailedUnfavorite() = runTest {
    val state = StarState(this) { _, _, _ -> throw IOException("offline") }
    state.toggle("42", true)
    assertFalse(state.isStarred("42", "starred"))
    runCurrent()
    assertTrue(state.isStarred("42", "starred"))
  }

  @Test
  fun tracksAndAlbumsWithSameIdAreIndependent() = runTest {
    val writes = mutableListOf<String>()
    val state = StarState(this) { kind, id, starred -> writes += "$kind/$id=$starred" }
    state.toggle("42", false)
    assertTrue(state.isStarred("42", null))
    assertFalse(state.isStarred("42", null, "albums"))
    state.toggle("42", true, "albums")
    runCurrent()
    assertTrue(state.isStarred("42", null))
    assertFalse(state.isStarred("42", "starred", "albums"))
    assertEquals(listOf("tracks/42=true", "albums/42=false"), writes)
  }

  @Test
  fun secondToggleUsesOverlayInsteadOfStaleServerCopy() = runTest {
    val writes = mutableListOf<Boolean>()
    val state = StarState(this) { _, _, starred -> writes += starred }
    state.toggle("42", false)
    runCurrent()
    state.toggle("42", false)
    assertFalse(state.isStarred("42", null))
    runCurrent()
    assertEquals(listOf(true, false), writes)
  }

  @Test
  fun ignoresRepeatedClickUntilRequestFinishes() = runTest {
    val gate = CompletableDeferred<Unit>()
    var writes = 0
    val state = StarState(this) { _, _, _ -> writes++; gate.await() }
    state.toggle("42", false)
    runCurrent()
    state.toggle("42", true)
    runCurrent()
    assertEquals(1, writes)
    assertTrue(state.isStarred("42", null))
    gate.complete(Unit)
    runCurrent()
    state.toggle("42", true)
    runCurrent()
    assertEquals(2, writes)
    assertFalse(state.isStarred("42", null))
  }
}
