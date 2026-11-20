package dev.hmsy.openmusic.data

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** DTO 形状对齐服务端序列化（docs/04 网易云组 + 管理端点）；Json 配置镜像 OmApi */
class NeteaseModelsTest {
  private val json = Json { ignoreUnknownKeys = true }

  @Test
  fun decodesCandidateWithUnknownFieldsTolerated() {
    val c = json.decodeFromString<NeteaseCandidate>(
      """{"title":"晴天","artist":"周杰伦","album":"叶惠美","songId":"5264842","url":"https://music.163.com/song?id=5264842","vip":false,"extra":"ignored"}""",
    )
    assertEquals("晴天", c.title)
    assertEquals("5264842", c.songId)
    assertFalse(c.vip)
  }

  @Test
  fun decodesImportResultFixtureFromApiDocs() {
    val r = json.decodeFromString<NeteaseImportResult>(
      """
      { "url": "https://music.163.com/song?id=5264842", "kind": "song", "state": "done",
        "total": 1, "imported": 1, "skipped": 0, "failed": 0, "destination": "/music/网易云",
        "trackIds": [42], "files": [{ "trackId": 42, "name": "Netease-5264842.mp3" }],
        "failures": [{ "songId": "2606227455", "reason": "VIP/付费歌曲需要会员账号，未导入。" }],
        "warnings": [{ "songId": "5264842", "message": "未取得歌词。" }] }
      """.trimIndent(),
    )
    assertEquals("done", r.state)
    assertEquals("song", r.kind)
    assertEquals(1, r.imported)
    assertEquals(42L, r.trackIds.single())
    assertEquals("Netease-5264842.mp3", r.files.single().name)
    assertEquals("VIP/付费歌曲需要会员账号，未导入。", r.failures.single().reason)
    assertEquals("未取得歌词。", r.warnings.single().message)
    assertEquals("共 1 · 导入 1 · 跳过 0 · 失败 0", neteaseCountSummary(r))
  }

  @Test
  fun importResultToleratesSparsePayload() {
    val r = json.decodeFromString<NeteaseImportResult>(
      """{"url":"u","kind":"playlist","state":"partial","total":3,"imported":1,"skipped":1,"failed":1,"destination":"/d"}""",
    )
    assertTrue(r.trackIds.isEmpty())
    assertTrue(r.files.isEmpty())
    assertTrue(r.failures.isEmpty())
    assertTrue(r.warnings.isEmpty())
    assertEquals("部分成功 · 歌单导入", "${neteaseStateLabel(r.state)} · ${neteaseKindLabel(r.kind)}导入")
  }

  @Test
  fun decodesFoldersAndChildren() {
    val folders = json.decodeFromString<List<NeteaseFolder>>(
      """[{"id":"1","name":"音乐","path":"/music","writable":true},{"id":"2","name":"只读","path":"/-ro","writable":false}]""",
    )
    assertTrue(folders[0].writable)
    assertFalse(folders[1].writable)
    val children = json.decodeFromString<NeteaseChildren>(
      """{"directories":["网易云","网易云/新歌"],"truncated":true}""",
    )
    assertEquals(2, children.directories.size)
    assertTrue(children.truncated)
  }

  @Test
  fun decodesInfoWithNullOptionalTags() {
    val i = json.decodeFromString<NeteaseInfo>(
      """
      { "trackId": "42", "songId": "5264842", "quality": "exhigh", "format": "mp3",
        "filename": "Netease-5264842.mp3", "title": "晴天", "artist": "周杰伦", "album": "叶惠美",
        "albumArtist": null, "genre": null, "trackNumber": 3, "discNumber": 1,
        "hasCover": true, "warnings": ["歌词未取得"] }
      """.trimIndent(),
    )
    assertEquals("exhigh", i.quality)
    assertNull(i.albumArtist)
    assertNull(i.genre)
    assertEquals(3, i.trackNumber)
    assertTrue(i.hasCover)
    assertEquals(listOf("歌词未取得"), i.warnings)
  }

  @Test
  fun decodesDeletionTicketAndReviewAsEpochMillis() {
    val req = json.decodeFromString<NeteaseDeletionRequest>(
      """{"requestId":"0e6d6f0a-1c2b-4c3d-8e9f-000000000000","reviewPath":"/review-deletion/0e6d6f0a","expiresAt":1763654400000}""",
    )
    assertEquals("0e6d6f0a-1c2b-4c3d-8e9f-000000000000", req.requestId)
    assertEquals(1763654400000L, req.expiresAt)
    val review = json.decodeFromString<NeteaseDeletionReview>(
      """
      { "trackId": "42", "title": "晴天", "artist": "周杰伦", "filename": "Netease-5264842.mp3",
        "format": "mp3", "path": "/music/网易云/Netease-5264842.mp3", "sizeBytes": 10485760,
        "expiresAt": 1763654400000, "token": "t0k" }
      """.trimIndent(),
    )
    assertEquals("Netease-5264842.mp3", review.filename)
    assertEquals(10485760L, review.sizeBytes)
    assertEquals("t0k", review.token)
  }

  @Test
  fun coverSourceWhitelistMatchesServerSemantics() {
    assertTrue(neteaseCoverUrlOk("https://p1.music.126.net/abc.jpg"))
    assertTrue(neteaseCoverUrlOk("https://p2.music.126.net/x.png"))
    assertFalse(neteaseCoverUrlOk("http://p1.music.126.net/abc.jpg"))
    assertFalse(neteaseCoverUrlOk("https://img.example.com/x.jpg"))
    assertFalse(neteaseCoverUrlOk("https://music.126.net.evil.com/x.jpg"))
    assertFalse(neteaseCoverUrlOk("not a url"))
  }

  @Test
  fun labelValidationMirrorsServerMetadataFields() {
    assertTrue(neteaseLabelOk("晴天"))
    assertTrue(neteaseLabelOk("Jay Chou 2026"))
    assertFalse(neteaseLabelOk(""))
    assertFalse(neteaseLabelOk("   "))
    assertFalse(neteaseLabelOk("a\u0007b"))
    assertFalse(neteaseLabelOk("d".repeat(301)))
  }

  @Test
  fun positionTextValidationMirrorsServerRange() {
    assertTrue(neteasePositionTextOk(""))
    assertTrue(neteasePositionTextOk("1"))
    assertTrue(neteasePositionTextOk("9999"))
    assertFalse(neteasePositionTextOk("0"))
    assertFalse(neteasePositionTextOk("10000"))
    assertFalse(neteasePositionTextOk("x"))
    assertFalse(neteasePositionTextOk("-1"))
  }

  @Test
  fun displayHelpersFormatForHumans() {
    assertEquals("512 B", formatSizeBytes(512))
    assertTrue(Regex("\\d+\\.\\d KB").matches(formatSizeBytes(2048)))
    assertTrue(formatSizeBytes(10L * 1024 * 1024).endsWith("MB"))
    assertTrue(Regex("\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}").matches(formatEpochMs(1763654400000L)))
    assertTrue(Regex("\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}").matches(formatEpochMs(0L)))
  }
}
