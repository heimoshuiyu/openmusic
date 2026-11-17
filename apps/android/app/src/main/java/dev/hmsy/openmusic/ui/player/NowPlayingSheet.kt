@file:androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)

package dev.hmsy.openmusic.ui.player

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.spring
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.MotionDurationScale
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.currentStateAsState
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import coil3.compose.AsyncImage
import dev.hmsy.openmusic.OpenMusicApp
import dev.hmsy.openmusic.core.Om
import dev.hmsy.openmusic.core.OmType
import dev.hmsy.openmusic.data.formatDuration
import dev.hmsy.openmusic.player.PlayerUiState
import dev.hmsy.openmusic.player.GrooveLevel
import dev.hmsy.openmusic.player.GrooveSpectrum
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.snapshotFlow
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.withContext
import androidx.compose.runtime.withFrameNanos
import dev.hmsy.openmusic.player.RepeatMode
import dev.hmsy.openmusic.ui.StarOverlay
import dev.hmsy.openmusic.ui.components.CoverArt
import dev.hmsy.openmusic.ui.icons.OmIcons
import kotlinx.coroutines.launch
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.coroutineScope
import kotlin.math.roundToInt

/**
 * 正在播放：圆标与真实频谱点阵同转，随封面着色的背景保持静止。
 * 手势：整体下滑收起；黑胶左右滑切歌。
 */
@Composable
fun NowPlayingSheet(
  visible: Boolean,
  state: PlayerUiState,
  onDismiss: () -> Unit,
  onToggle: () -> Unit,
  onNext: () -> Unit,
  onPrevious: () -> Unit,
  onSeek: (Long) -> Unit,
  onToggleShuffle: () -> Unit,
  onCycleRepeat: () -> Unit,
  onOpenQueue: () -> Unit,
  onToggleStar: () -> Unit,
) {
  val track = state.current ?: return
  // 0 = expanded, 1 = off screen. Drag, rebound and dismissal all continue from this position.
  val slide = remember { Animatable(1f, visibilityThreshold = .0005f) }
  LaunchedEffect(visible) { slide.animateTo(if (visible) 0f else 1f) }
  val offscreen by remember { derivedStateOf { slide.value >= 1f } }
  if (visible || !offscreen) {
    var lyricsOpen by remember { mutableStateOf(false) }
    val dismiss by rememberUpdatedState(onDismiss)

    // 系统返回键 = 收起（与下滑手势一致）；不挂的话 back 会直接退出应用
    androidx.activity.compose.BackHandler(enabled = visible) { onDismiss() }

    Box(
      Modifier
        .fillMaxSize()
        .graphicsLayer {
          translationY = size.height * slide.value
          clip = true // The enlarged cover must not bleed onto the page revealed above the sheet.
        }
        .pointerInput(visible, lyricsOpen) {
          if (!visible || lyricsOpen) return@pointerInput
          coroutineScope {
            fun rebound() { launch { slide.animateTo(0f) } }
            detectVerticalDragGestures(
              onVerticalDrag = { change, amount ->
                change.consume()
                val next = (slide.value + amount / size.height).coerceIn(0f, 1f)
                launch(start = CoroutineStart.UNDISPATCHED) { slide.snapTo(next) }
              },
              onDragEnd = { if (slide.value * size.height > 420f) dismiss() else rebound() },
              onDragCancel = { rebound() },
            )
          }
        }
        .background(Om.Shell),
    ) {
      // ── 环境色晕染：封面铺底 + 渐变压暗（Apple Music 招牌）──
      dev.hmsy.openmusic.ui.components.TrackCover(albumId = track.album.id, albumName = track.album.name, trackId = track.id,
        monogram = false, modifier = Modifier.fillMaxSize().graphicsLayer { scaleX = 1.25f; scaleY = 1.25f; alpha = .32f })
      Box(
        Modifier
          .fillMaxSize()
          .background(
            Brush.verticalGradient(
              0f to Om.Shell.copy(alpha = 0.12f),
              0.6f to Om.Shell.copy(alpha = 0.64f),
              1f to Om.Shell.copy(alpha = 0.96f),
            ),
          ),
      )

      // ── 内容（与背景共用外层位移）──
      Column(
        Modifier
          .fillMaxSize()
          .statusBarsPadding()
          .padding(bottom = 28.dp),
      ) {
        // 顶栏
        Row(
          Modifier
            .fillMaxWidth()
            .padding(horizontal = 8.dp, vertical = 4.dp),
          verticalAlignment = Alignment.CenterVertically,
        ) {
          IconButton(onClick = onDismiss) {
            Icon(OmIcons.ChevronDown, contentDescription = "收起", tint = Om.Dim, modifier = Modifier.size(22.dp))
          }
          Text("正在播放", style = OmType.Meta, color = Om.Faint, modifier = Modifier.weight(1f), textAlign = androidx.compose.ui.text.style.TextAlign.Center)
          androidx.compose.material3.TextButton(onClick={lyricsOpen=!lyricsOpen}) { Text("歌词",color=if(lyricsOpen)Om.Accent else Om.Dim) }
          IconButton(onClick = onOpenQueue) {
            Icon(OmIcons.ListMusic, contentDescription = "播放队列", tint = Om.Dim, modifier = Modifier.size(20.dp))
          }
        }

        // ── 黑胶 + 唱臂（垂直居中于弹性空间，避免高屏死区）──
        Box(Modifier.fillMaxWidth().weight(1f), contentAlignment = Alignment.Center) {
          if(lyricsOpen) LyricsPanel(track.id,state.positionMs) else VinylStage(
            albumId = track.album.id,
            albumName = track.album.name,
            hasCover = track.hasCoverArt,
            trackId = track.id,
            isPlaying = state.isPlaying && visible,
            onSwipeNext = onNext,
            onSwipePrevious = onPrevious,
          )
        }

        // 曲目信息 + 收藏
        Row(
          Modifier
            .fillMaxWidth()
            .padding(horizontal = 28.dp),
          verticalAlignment = Alignment.CenterVertically,
        ) {
          Column(Modifier.weight(1f)) {
            Text(
              track.title,
              style = OmType.Display,
              color = Om.Paper,
              maxLines = 1,
              overflow = TextOverflow.Ellipsis,
            )
            Spacer(Modifier.height(4.dp))
            Text(
              "${track.artist.name} · ${track.album.name}",
              style = OmType.Body,
              color = Om.Dim,
              maxLines = 1,
              overflow = TextOverflow.Ellipsis,
            )
          }
          Spacer(Modifier.width(12.dp))
          IconButton(onClick = onToggleStar) {
            val starred = StarOverlay.rememberStarred(track.id, track.starred)
            Icon(
              imageVector = if (starred) OmIcons.HeartFilled else OmIcons.Heart,
              contentDescription = if (starred) "取消收藏" else "收藏",
              tint = if (starred) Om.Accent else Om.Dim,
              modifier = Modifier.size(22.dp),
            )
          }
        }

        Spacer(Modifier.height(18.dp))

        // 进度
        ProgressBar(
          positionMs = state.positionMs,
          durationMs = state.durationMs,
          onSeek = onSeek,
          modifier = Modifier.padding(horizontal = 28.dp),
        )

        Spacer(Modifier.height(10.dp))

        // 传送
        Row(
          Modifier
            .fillMaxWidth()
            .padding(horizontal = 20.dp),
          horizontalArrangement = Arrangement.SpaceEvenly,
          verticalAlignment = Alignment.CenterVertically,
        ) {
          IconButton(onClick = onToggleShuffle) {
            Icon(OmIcons.Shuffle, contentDescription = "随机播放", tint = if (state.shuffle) Om.Accent else Om.Dim, modifier = Modifier.size(20.dp))
          }
          IconButton(onClick = onPrevious) {
            Icon(OmIcons.SkipBack, contentDescription = "上一首", tint = Om.Paper, modifier = Modifier.size(30.dp))
          }
          // 大播放键：白圆 + shell 图标（Apple Music 式）
          Box(
            Modifier
              .size(68.dp)
              .shadow(12.dp, CircleShape, ambientColor = Color.Black, spotColor = Color.Black)
              .clip(CircleShape)
              .background(Om.Paper)
              .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, onClick = onToggle),
            contentAlignment = Alignment.Center,
          ) {
            Icon(
              imageVector = if (state.isPlaying) OmIcons.Pause else OmIcons.Play,
              contentDescription = if (state.isPlaying) "暂停" else "播放",
              tint = Om.Shell,
              modifier = Modifier.size(if (state.isPlaying) 28.dp else 26.dp),
            )
          }
          IconButton(onClick = onNext) {
            Icon(OmIcons.SkipForward, contentDescription = "下一首", tint = Om.Paper, modifier = Modifier.size(30.dp))
          }
          IconButton(onClick = onCycleRepeat) {
            val icon = if (state.repeat == RepeatMode.ONE) OmIcons.RepeatOne else OmIcons.Repeat
            Icon(icon, contentDescription = "循环", tint = if (state.repeat != RepeatMode.OFF) Om.Accent else Om.Dim, modifier = Modifier.size(20.dp))
          }
        }
      }
    }
  }
}

/** The artwork and printed spectrum share the same rotation, independent of the stationary wash. */
@Composable
private fun VinylStage(
  albumId: String,
  albumName: String,
  hasCover: Boolean,
  trackId: String? = null,
  isPlaying: Boolean,
  onSwipeNext: () -> Unit,
  onSwipePrevious: () -> Unit,
  modifier: Modifier = Modifier,
) {
  val scope = rememberCoroutineScope()
  // 连续旋转：播放中 18s/圈，暂停保持角度
  var rotation by remember { androidx.compose.runtime.mutableFloatStateOf(0f) }
  val lifecycleState by LocalLifecycleOwner.current.lifecycle.currentStateAsState()
  val moving = isPlaying && lifecycleState.isAtLeast(Lifecycle.State.RESUMED)
  val screen = remember { GrooveScreen() }
  val levels = remember { FloatArray(GrooveSpectrum.BANDS) }
  var revision by remember { mutableIntStateOf(0) }
  LaunchedEffect(moving) {
    if (!moving) return@LaunchedEffect
    val scale = coroutineContext[MotionDurationScale]
    snapshotFlow { scale?.scaleFactor?.let { it > 0f } ?: android.animation.ValueAnimator.areAnimatorsEnabled() }.collectLatest { animate ->
      if (!animate) return@collectLatest
      val fft = GrooveSpectrum(); val pcm = GrooveLevel.Snapshot(); val target = FloatArray(levels.size)
      GrooveLevel.enabled = true
      try {
        var last = withFrameNanos { it }; var measured = last
        while (true) {
          val now = withFrameNanos { it }
          rotation = (rotation + ((now-last)/1e9f).coerceIn(0f,.1f)*20f) % 360f; last = now
          if (now-measured < 32_000_000L) continue
          val dt = ((now-measured)/1e9f).coerceAtMost(.1f); measured = now
          if (GrooveLevel.read(pcm)) {
            if (pcm.rate > 0) withContext(Dispatchers.Default) { fft.measure(pcm.samples,pcm.rate,target) }
            else target.fill(0f)
          }
          val attack = 1-kotlin.math.exp(-dt/.037f); val release = 1-kotlin.math.exp(-dt/.19f)
          for (i in levels.indices) { val diff=target[i]-levels[i]; levels[i]+=diff*(if (diff>0) attack else release) }
          revision++
        }
      } finally { GrooveLevel.enabled=false; levels.fill(0f); revision++ }
    }
  }
  // 左右滑切歌的累计位移（Animatable：松手弹回）
  val swipeX = remember { Animatable(0f) }

  BoxWithConstraints(modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
    val discSize = minOf(350.dp, maxWidth*.76f, maxHeight*.89f)
    val discPx = with(LocalDensity.current) { discSize.toPx() }

    Box(Modifier.size(discSize)) {
      // 黑胶盘体
      Box(
        Modifier
          .align(Alignment.CenterStart)
          .size(discSize)
          .offset { IntOffset(swipeX.value.roundToInt(), 0) }
          .shadow(20.dp, CircleShape, ambientColor = Color.Black, spotColor = Color.Black)
          .pointerInput(Unit) {
            detectHorizontalDragGestures(
              onHorizontalDrag = { change, amount ->
                change.consume()
                scope.launch { swipeX.snapTo((swipeX.value + amount).coerceIn(-discPx * 0.4f, discPx * 0.4f)) }
              },
              onDragEnd = {
                when {
                  swipeX.value < -discPx * 0.22f -> onSwipeNext()
                  swipeX.value > discPx * 0.22f -> onSwipePrevious()
                }
                scope.launch { swipeX.animateTo(0f, spring(stiffness = Spring.StiffnessMedium)) }
              },
            )
          },
      ) {
        Canvas(Modifier.fillMaxSize()) {
          val radius = size.minDimension / 2f
          drawCircle(Brush.radialGradient(listOf(Color(0xff343434),Color(0xff191919),Color(0xff080808)),
            center=Offset(size.width*.24f,size.height*.13f),radius=size.width*.85f), radius = radius)
          drawCircle(Color.White.copy(alpha = 0.08f), radius = radius, style = androidx.compose.ui.graphics.drawscope.Stroke(1.5.dp.toPx()))
        }
        Canvas(Modifier.fillMaxSize().graphicsLayer { rotationZ = rotation }) {
          // State is observed only in draw, not composition. The cached ring can rotate at display refresh.
          revision
          drawIntoCanvas { screen.draw(it.nativeCanvas,size.minDimension,levels) }
        }
        // 圆标封面（72% 内圈，失败回退程序化渐变）+ 中孔
        Box(
          Modifier
            .fillMaxSize(0.78f)
            .align(Alignment.Center)
            .graphicsLayer { rotationZ = rotation }
            .clip(CircleShape),
        ) {
          dev.hmsy.openmusic.ui.components.TrackCover(
            albumId = albumId,
            albumName = albumName,
            trackId = trackId,
            monogram = false,
            modifier = Modifier.fillMaxSize(),
          )
        }
        Box(
          Modifier
            .size(discSize*.035f)
            .align(Alignment.Center)
            .clip(CircleShape)
            .background(Om.Shell),
        )
      }

    }
  }
}

/** 细进度条：4dp 轨 + 红填充 + 拖拽/点按 seek + 双读数 */
@Composable
private fun ProgressBar(
  positionMs: Long,
  durationMs: Long,
  onSeek: (Long) -> Unit,
  modifier: Modifier = Modifier,
) {
  var dragging by remember { mutableStateOf(false) }
  var dragFraction by remember { mutableStateOf(0f) }
  val duration = durationMs.coerceAtLeast(1)
  val fraction = if (dragging) dragFraction else (positionMs.toFloat() / duration).coerceIn(0f, 1f)
  val shownPos = (fraction * duration).toLong()

  Column(modifier) {
    Box(
      Modifier
        .fillMaxWidth()
        .height(22.dp)
        .pointerInput(durationMs) {
          detectTapGestures { offset ->
            onSeek(((offset.x / size.width).coerceIn(0f, 1f) * duration).toLong())
          }
        }
        .pointerInput(Unit) {
          detectHorizontalDragGestures(
            onHorizontalDrag = { change, _ ->
              change.consume()
              dragging = true
              dragFraction = (change.position.x / size.width).coerceIn(0f, 1f)
            },
            onDragEnd = {
              onSeek((dragFraction * duration).toLong())
              dragging = false
            },
          )
        },
    ) {
      Box(Modifier.align(Alignment.Center).fillMaxWidth().height(4.dp).background(Om.Line)) {
        Box(Modifier.fillMaxWidth(fraction).height(4.dp).clip(CircleShape).background(Om.Accent))
      }
    }
    Row(Modifier.fillMaxWidth().padding(top = 2.dp)) {
      Text(formatDuration((shownPos / 1000).toInt()), style = OmType.Readout, color = Om.Dim)
      Spacer(Modifier.weight(1f))
      Text("-" + formatDuration(((duration - shownPos) / 1000).toInt().coerceAtLeast(0)), style = OmType.Readout, color = Om.Faint)
    }
  }
}
