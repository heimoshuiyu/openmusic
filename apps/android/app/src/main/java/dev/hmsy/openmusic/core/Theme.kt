@file:OptIn(androidx.compose.ui.text.ExperimentalTextApi::class)

package dev.hmsy.openmusic.core

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.unit.sp
import dev.hmsy.openmusic.R

/** 唱片目录：与 Web 共用纸面、油墨、链接蓝，封面保留自身颜色。 */
data class CatalogPalette(
  val Shell: Color, val Panel: Color, val Raised: Color, val Line: Color, val Paper: Color,
  val Dim: Color, val Faint: Color, val Accent: Color, val AccentDeep: Color, val Danger: Color,
) {
  val Vinyl = Color(0xFF191919)
}
private val Light = CatalogPalette(Color.White, Color(0xFFF8F8F8), Color(0xFFEDEDED), Color(0xFFD7D7D7), Color(0xFF191919),
  Color(0xFF505050), Color(0xFF676767), Color(0xFF3454DF), Color(0xFF253EA8), Color(0xFFAE2E27))
private val Dark = CatalogPalette(Color(0xFF0C0C0C), Color(0xFF141414), Color(0xFF242424), Color(0xFF383838), Color(0xFFF1F1F1),
  Color(0xFFBBBBBB), Color(0xFFAAAAAA), Color(0xFF80A5FF), Color(0xFFA7C2FF), Color(0xFFFF9089))
private val LocalPalette = staticCompositionLocalOf { Light }
val Om: CatalogPalette @Composable @ReadOnlyComposable get() = LocalPalette.current

// ── 字体：Inter Variable（CJK 回退系统 Noto Sans）────────────
private fun inter(weight: Int): Font =
  Font(R.font.inter_variable, variationSettings = FontVariation.Settings(FontVariation.weight(weight)))

val InterFamily = FontFamily(
  inter(400),
  inter(500),
  inter(600),
  inter(700),
)

object OmType {
  // 大标题（正在播放曲名 / 首页标题）
  val Display = TextStyle(fontFamily = InterFamily, fontWeight = FontWeight.SemiBold, fontSize = 24.sp, letterSpacing = (-0.3).sp, lineHeight = 30.sp)
  // 屏幕标题（大标题布局首项）
  val Headline = TextStyle(fontFamily = InterFamily, fontWeight = FontWeight.SemiBold, fontSize = 32.sp, letterSpacing = (-1.1).sp, lineHeight = 40.sp)
  // 分区标题
  val Title = TextStyle(fontFamily = InterFamily, fontWeight = FontWeight.SemiBold, fontSize = 17.sp, letterSpacing = (-0.2).sp)
  // 卡片/行主文字
  val Row = TextStyle(fontFamily = InterFamily, fontWeight = FontWeight.Medium, fontSize = 14.5.sp, letterSpacing = 0.sp, lineHeight = 20.sp)
  val Body = TextStyle(fontFamily = InterFamily, fontWeight = FontWeight.Normal, fontSize = 14.sp, lineHeight = 20.sp)
  // 次级/元信息
  val Meta = TextStyle(fontFamily = InterFamily, fontWeight = FontWeight.Normal, fontSize = 12.5.sp, lineHeight = 17.sp)
  // 读数（时间码/计数）：tabular
  val Readout = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 12.sp, fontFeatureSettings = "tnum")
  val ReadoutLg = Readout.copy(fontSize = 13.sp)
}

@Composable
fun OmTheme(content: @Composable () -> Unit) {
  val dark = isSystemInDarkTheme()
  val palette = if (dark) Dark else Light
  CompositionLocalProvider(LocalPalette provides palette) {
  val scheme = (if (dark) darkColorScheme() else lightColorScheme()).copy(
  primary = Om.Accent,
  onPrimary = Om.Shell,
  primaryContainer = Om.AccentDeep,
  onPrimaryContainer = Om.Shell,
  secondary = Om.Dim,
  onSecondary = Om.Shell,
  secondaryContainer = Om.Raised,
  onSecondaryContainer = Om.Paper,
  tertiary = Om.Dim,
  background = Om.Shell,
  onBackground = Om.Paper,
  surface = Om.Panel,
  onSurface = Om.Paper,
  surfaceVariant = Om.Raised,
  onSurfaceVariant = Om.Dim,
  outline = Om.Line,
  outlineVariant = Om.Line,
  error = Om.Danger,
  onError = Om.Shell,
  surfaceContainer = Om.Panel, surfaceContainerHigh = Om.Raised, surfaceTint = Om.Panel,
)
  MaterialTheme(
    colorScheme = scheme,
    typography = MaterialTheme.typography.run {
      copy(
        displayLarge = OmType.Display, displayMedium = OmType.Display, displaySmall = OmType.Display,
        headlineLarge = OmType.Headline, headlineMedium = OmType.Headline, headlineSmall = OmType.Title,
        titleLarge = OmType.Title, titleMedium = OmType.Row, titleSmall = OmType.Row,
        bodyLarge = OmType.Body, bodyMedium = OmType.Body, bodySmall = OmType.Meta,
        labelLarge = OmType.Row, labelMedium = OmType.Meta, labelSmall = OmType.Meta,
      )
    },
    content = content,
  )
  }
}
