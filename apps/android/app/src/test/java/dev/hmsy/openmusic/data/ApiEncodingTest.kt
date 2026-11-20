package dev.hmsy.openmusic.data

import org.junit.Assert.assertEquals
import org.junit.Test

/** 查询参数 / 路径段编码：空格与加号必须无歧义（服务端两种解析器下语义一致） */
class ApiEncodingTest {

  @Test
  fun encodeParamUsesPercent20ForSpacesAndEscapesPlus() {
    assertEquals("a%20b", encodeParam("a b"))
    // 字面加号不能留成 "+"（会被 URLSearchParams 解码成空格）
    assertEquals("a%2Bb", encodeParam("a+b"))
    // CJK 百分号编码
    assertEquals("%E6%99%B4%E5%A4%A9", encodeParam("晴天"))
    assertEquals("", encodeParam(""))
    assertEquals("42", encodeParam("42"))
    assertEquals("m%2Fsong", encodeParam("m/song"))
  }

  @Test
  fun encodePathIsSafeForIdDomains() {
    assertEquals("42", encodePath("42"))
    assertEquals("0e6d6f0a-1c2b-4c3d-8e9f-000000000000", encodePath("0e6d6f0a-1c2b-4c3d-8e9f-000000000000"))
    // 输入域只有 ASCII id；空格行为仅作记录（URLEncoder 转加号）
    assertEquals("a+b", encodePath("a b"))
  }
}
