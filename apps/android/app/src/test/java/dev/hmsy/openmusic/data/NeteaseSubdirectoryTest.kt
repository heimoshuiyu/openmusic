package dev.hmsy.openmusic.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** 与服务端 checkSubdirectory（youtube/source.ts）语义逐条对齐 */
class NeteaseSubdirectoryTest {

  @Test
  fun acceptsRootAndSimplePaths() {
    assertTrue(NeteaseSubdirectory.check(""))
    assertTrue(NeteaseSubdirectory.check("网易云"))
    assertTrue(NeteaseSubdirectory.check("a/b/c"))
    assertTrue(NeteaseSubdirectory.check("2026/新歌"))
    // 允许的最大形状：8 段、每段 100 字符、总长 ≤360
    assertTrue(NeteaseSubdirectory.check((0 until 8).joinToString("/") { "d".repeat(30) }))
  }

  @Test
  fun rejectsShapeViolations() {
    assertFalse(NeteaseSubdirectory.check("a//b"))                    // 空段
    assertFalse(NeteaseSubdirectory.check("a/"))                      // 尾部空段
    assertFalse(NeteaseSubdirectory.check("/a"))                     // 首段为空（服务端 split 同样失败）
    assertFalse(NeteaseSubdirectory.check(".hidden"))                 // . 开头
    assertFalse(NeteaseSubdirectory.check("a/.b"))
    assertFalse(NeteaseSubdirectory.check("a\\b"))                     // 反斜杠
    assertFalse(NeteaseSubdirectory.check("a:b"))                      // 冒号
    assertFalse(NeteaseSubdirectory.check("a\u0000b"))                 // 控制字符
    assertFalse(NeteaseSubdirectory.check((0 until 9).joinToString("/") { "d" })) // 超过 8 段
    assertFalse(NeteaseSubdirectory.check("d".repeat(361)))           // 超长
    assertFalse(NeteaseSubdirectory.check("d".repeat(101)))            // 单段超长
  }

  @Test
  fun appendAndParentComposeCorrectly() {
    assertEquals("网易云", NeteaseSubdirectory.append("", "网易云"))
    assertEquals("网易云/新歌", NeteaseSubdirectory.append("网易云", "新歌"))
    // 越界拼接返回 null（长度/段数/非法字符）
    assertNull(NeteaseSubdirectory.append("a/b/c/d/e/f/g/h", "i"))
    assertNull(NeteaseSubdirectory.append("a", ".b"))
    assertEquals("a/b", NeteaseSubdirectory.parent("a/b/c"))
    assertEquals("a", NeteaseSubdirectory.parent("a/b"))
    assertEquals("", NeteaseSubdirectory.parent("a"))
    assertEquals("", NeteaseSubdirectory.parent(""))
  }
}
