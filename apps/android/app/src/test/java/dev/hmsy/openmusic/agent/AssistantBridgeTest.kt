package dev.hmsy.openmusic.agent

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AssistantBridgeTest {
  @Test fun assistantContractsOnly() {
    val sessions="/api/v1/agent/sessions"
    for ((m,p) in listOf("GET" to sessions,"POST" to sessions,"POST" to "/api/v1/agent/transcribe",
      "GET" to "$sessions/ses_one/messages","GET" to "$sessions/ses_one/inbox","POST" to "$sessions/ses_one/prompt","POST" to "$sessions/ses_one/transcribe",
      "POST" to "$sessions/ses_one/questions/frm_1","DELETE" to "$sessions/ses_one/questions/frm_1",
      "POST" to "$sessions/ses_one/interrupt","PATCH" to "$sessions/ses_one/inbox/p_1","DELETE" to "$sessions/ses_one/inbox/p_1")) {
      assertTrue("$m $p",allowsAssistantRequest(m,p))
    }
  }
  @Test fun rejectOtherOriginsRoutesAndMethods() {
    for(p in listOf("https://example.org/api/v1/agent/sessions","/api/v1/admin/agent/settings","/api/v1/library/scan",
      "/api/v1/agent/sessions/../messages","/api/v1/agent/sessions/%2F/messages","/api/v1/auth/login")) {
      assertFalse(allowsAssistantRequest("GET",p)); assertFalse(allowsAssistantRequest("POST",p))
    }
    assertFalse(allowsAssistantRequest("DELETE","/api/v1/agent/sessions/ses_a"))
    assertFalse(allowsAssistantRequest("GET","/api/v1/agent/transcribe"))
    assertFalse(allowsAssistantRequest("POST","/api/v1/agent/sessions/ses_one/questions"))
    assertFalse(allowsAssistantRequest("PATCH","/api/v1/agent/sessions/ses_one/questions/frm_1"))
  }
  @Test fun adminContractsAreSeparateFromChat() {
    val base = "/api/v1"
    for ((m,p) in listOf("GET" to "/auth/me", "GET" to "/music-folders", "POST" to "/music-folders",
      "PATCH" to "/music-folders/12","DELETE" to "/music-folders/12","GET" to "/library/scan-status",
      "POST" to "/library/scan","POST" to "/library/scan?force=true","DELETE" to "/library/scan",
      "GET" to "/users?limit=100","POST" to "/users","DELETE" to "/users/21",
      "GET" to "/admin/agent/settings","POST" to "/admin/agent/settings","POST" to "/admin/agent/console",
      "GET" to "/admin/agent/console/attempt_a","DELETE" to "/admin/agent/console/attempt_a")) {
      assertTrue("$m $p",allowsAdminRequest(m,base+p));assertFalse(allowsAssistantRequest(m,base+p))
    }
    for((m,p) in listOf("POST" to "/agent/sessions","POST" to "/agent/transcribe","GET" to "/agent/events",
      "POST" to "/imports/youtube/file-deletion-requests/confirm","DELETE" to "/music-folders/../1",
      "POST" to "/library/scan?force=maybe","PATCH" to "/users/42")) assertFalse(allowsAdminRequest(m,base+p))
    assertFalse(EmbeddedPage.Admin.origin == EmbeddedPage.Assistant.origin)
  }
}
