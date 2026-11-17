package dev.hmsy.openmusic.data

import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class ApiRequestTest {
  private val url = "http://localhost/api/v1/favorites/tracks/42".toHttpUrl()

  @Test
  fun favoritePutHasEmptyBodyAndReachesClient() {
    val request = buildApiRequest("PUT", url)
    assertNotNull(request.body)
    assertEquals(0L, request.body!!.contentLength())
    var received = false
    val client = OkHttpClient.Builder().addInterceptor { chain ->
      assertEquals("PUT", chain.request().method)
      assertEquals("/api/v1/favorites/tracks/42", chain.request().url.encodedPath)
      received = true
      Response.Builder()
        .request(chain.request())
        .protocol(Protocol.HTTP_1_1)
        .code(204)
        .message("No Content")
        .body("".toResponseBody())
        .build()
    }.build()
    client.newCall(request).execute().use { response -> assertEquals(204, response.code) }
    assertEquals(true, received)
  }

  @Test
  fun bodylessPostAndPatchHaveEmptyBodies() {
    for (method in listOf("POST", "PATCH")) {
      val request = buildApiRequest(method, url)
      assertNotNull(request.body)
      assertEquals(0L, request.body!!.contentLength())
    }
  }

  @Test
  fun unfavoriteDeleteAndReadsRemainBodyless() {
    for (method in listOf("DELETE", "GET", "HEAD")) {
      val request = buildApiRequest(method, url)
      assertEquals(method, request.method)
      assertNull(request.body)
    }
  }

  @Test
  fun explicitJsonBodyIsPreserved() {
    val json = "{\"trackIds\":[\"42\"]}"
    val request = buildApiRequest("POST", url, json)
    val buffer = Buffer()
    request.body!!.writeTo(buffer)
    assertEquals(json, buffer.readUtf8())
    assertEquals("application/json; charset=utf-8", request.body!!.contentType().toString())
  }
}
