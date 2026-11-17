package dev.hmsy.openmusic.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import dev.hmsy.openmusic.OpenMusicApp
import dev.hmsy.openmusic.core.Om
import dev.hmsy.openmusic.core.OmType
import dev.hmsy.openmusic.ui.components.CatalogWordmark
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** 登录：服务器地址 + 账号（自托管场景，预填 tailnet 地址） */
@Composable
fun LoginScreen(onSuccess: () -> Unit) {
  var serverUrl by remember {
    mutableStateOf(OpenMusicApp.api.baseUrl)
  }
  var username by remember { mutableStateOf("admin") }
  var password by remember { mutableStateOf("") }
  var busy by remember { mutableStateOf(false) }
  var error by remember { mutableStateOf<String?>(null) }
  val scope = rememberCoroutineScope()

  Column(
    Modifier
      .fillMaxSize()
      .background(Om.Shell)
      .statusBarsPadding()
      .verticalScroll(rememberScrollState())
      .imePadding()
      .padding(horizontal = 28.dp),
    horizontalAlignment = Alignment.Start,
  ) {
    Spacer(Modifier.height(20.dp))
    CatalogWordmark()
    Spacer(Modifier.height(36.dp))
    Box(Modifier.fillMaxWidth().height(1.dp).background(Om.Paper))
    Spacer(Modifier.height(24.dp))
    Text("登录音乐库", style = OmType.Headline, color = Om.Paper)
    Spacer(Modifier.height(6.dp))
    Text("连接你的音乐服务器", style = OmType.Meta, color = Om.Faint)

    Spacer(Modifier.height(34.dp))

    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
      Field(
        value = serverUrl,
        onValueChange = { serverUrl = it },
        label = "服务器地址",
        placeholder = "https://music.example.org",
        keyboardType = KeyboardType.Uri,
        imeAction = ImeAction.Next,
      )
      Field(
        value = username,
        onValueChange = { username = it },
        label = "用户名",
        placeholder = "admin",
        keyboardType = KeyboardType.Ascii,
        imeAction = ImeAction.Next,
      )
      Field(
        value = password,
        onValueChange = { password = it },
        label = "密码",
        placeholder = "",
        keyboardType = KeyboardType.Password,
        imeAction = ImeAction.Done,
        password = true,
      )
    }

    if (error != null) {
      Spacer(Modifier.height(10.dp))
      Text(error ?: "", style = OmType.Meta, color = Om.Danger)
    }

    Spacer(Modifier.height(22.dp))

    // 登录按钮（红=交互）
    Box(
      Modifier
        .fillMaxWidth()
        .height(48.dp)
        .clip(RoundedCornerShape(2.dp))
        .background(if (busy) Om.Dim else Om.Paper)
        .clickable(enabled = !busy) {
          if (busy) return@clickable
          busy = true
          error = null
          scope.launch {
            val url = serverUrl.trim().trimEnd('/')
            OpenMusicApp.api.baseUrl = url
            val result = withContext(Dispatchers.IO) {
              runCatching {
                OpenMusicApp.settings.saveServerUrl(url)
                OpenMusicApp.api.login(username.trim(), password)
              }
            }
            result.fold(
              onSuccess = {
                OpenMusicApp.settings.saveUsername(it.username)
                withContext(Dispatchers.Main) { onSuccess() }
              },
              onFailure = { e ->
                withContext(Dispatchers.Main) {
                  error = e.message ?: "登录失败"
                  busy = false
                }
              },
            )
          }
        },
      contentAlignment = Alignment.Center,
    ) {
      if (busy) {
        CircularProgressIndicator(color = Om.Shell, modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
      } else {
        Text("登录", style = OmType.Row, color = Om.Shell)
      }
    }

    Spacer(Modifier.height(32.dp))
  }
}

@Composable
private fun Field(
  value: String,
  onValueChange: (String) -> Unit,
  label: String,
  placeholder: String,
  keyboardType: KeyboardType,
  imeAction: ImeAction,
  password: Boolean = false,
) {
  OutlinedTextField(
    value = value,
    onValueChange = onValueChange,
    label = { Text(label, color = Om.Faint) },
    placeholder = if (placeholder.isEmpty()) {
      null
    } else {
      { Text(placeholder, color = Om.Faint) }
    },
    singleLine = true,
    visualTransformation = if (password) PasswordVisualTransformation() else androidx.compose.ui.text.input.VisualTransformation.None,
    keyboardOptions = KeyboardOptions(keyboardType = keyboardType, imeAction = imeAction),
    shape = RoundedCornerShape(2.dp),
    colors = OutlinedTextFieldDefaults.colors(
      focusedTextColor = Om.Paper,
      unfocusedTextColor = Om.Paper,
      focusedBorderColor = Om.Accent,
      unfocusedBorderColor = Om.Line,
      focusedContainerColor = Om.Panel,
      unfocusedContainerColor = Om.Panel,
      cursorColor = Om.Accent,
    ),
    modifier = Modifier.fillMaxWidth(),
  )
}
