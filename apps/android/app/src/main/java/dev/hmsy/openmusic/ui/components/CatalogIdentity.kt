package dev.hmsy.openmusic.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.*
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.hmsy.openmusic.core.Om

@Composable
fun CatalogWordmark() {
  val ink = Om.Paper
  Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
    Canvas(Modifier.size(26.dp)) {
      val u = size.width / 26f
      drawCircle(ink, 9*u, Offset(12*u,14*u), style = Stroke(3*u))
      drawCircle(ink, 2.5f*u, Offset(12*u,14*u))
      drawLine(ink, Offset(24*u,2*u), Offset(19*u,2*u), 3*u)
      drawLine(ink, Offset(19*u,2*u), Offset(19*u,9*u), 3*u)
      drawLine(ink, Offset(19*u,9*u), Offset(13*u,15*u), 3*u)
    }
    val muted = Om.Faint
    Text(buildAnnotatedString { withStyle(SpanStyle(color = muted)) { append("open") }; append("music") },
      color = ink, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold, fontSize = 23.sp, letterSpacing = (-1.5).sp)
  }
}
