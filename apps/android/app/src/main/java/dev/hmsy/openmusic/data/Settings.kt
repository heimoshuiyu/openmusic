package dev.hmsy.openmusic.data

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

private val Context.dataStore by preferencesDataStore(name = "openmusic_settings")

/** 应用设置（DataStore）：服务器地址 + 会话 cookie + 用户名 */
class SettingsStore(private val context: Context) {

  data class SessionCookie(val name: String, val value: String, val domain: String)

  private val keyServer = stringPreferencesKey("server_url")
  private val keyUsername = stringPreferencesKey("username")
  private val keyCookieName = stringPreferencesKey("cookie_name")
  private val keyCookieValue = stringPreferencesKey("cookie_value")
  private val keyCookieDomain = stringPreferencesKey("cookie_domain")

  val serverUrl: Flow<String> = context.dataStore.data.map { it[keyServer] ?: "" }
  val username: Flow<String> = context.dataStore.data.map { it[keyUsername] ?: "" }

  val sessionCookie: Flow<SessionCookie?> = context.dataStore.data.map { prefs ->
    val value = prefs[keyCookieValue]
    if (value.isNullOrBlank()) null
    else SessionCookie(
      name = prefs[keyCookieName] ?: "om_session",
      value = value,
      domain = prefs[keyCookieDomain] ?: "",
    )
  }

  suspend fun serverUrlOnce(): String = serverUrl.first()

  suspend fun saveServerUrl(url: String) {
    context.dataStore.edit { it[keyServer] = url.trim().trimEnd('/') }
  }

  suspend fun saveUsername(name: String) {
    context.dataStore.edit { it[keyUsername] = name }
  }

  suspend fun saveSessionCookie(cookie: SessionCookie) {
    context.dataStore.edit {
      it[keyCookieName] = cookie.name
      it[keyCookieValue] = cookie.value
      it[keyCookieDomain] = cookie.domain
    }
  }

  suspend fun clearSession() {
    context.dataStore.edit {
      it.remove(keyCookieValue)
      it.remove(keyCookieName)
      it.remove(keyCookieDomain)
      it.remove(keyUsername)
    }
  }
}
