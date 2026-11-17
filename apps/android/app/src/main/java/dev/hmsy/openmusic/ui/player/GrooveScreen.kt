package dev.hmsy.openmusic.ui.player

import android.graphics.Canvas
import android.graphics.Paint
import dev.hmsy.openmusic.player.GrooveSpectrum
import kotlin.math.*

/** Native counterpart of web/player/groove-surface: the last 15 columns feather back to bass. */
internal object GrooveGrid {
  const val ROWS = 10
  private const val LAST = GrooveSpectrum.BANDS-1
  private const val SUB = 3
  const val SEAM = 15
  const val COLUMNS = LAST*SUB + SEAM
  fun band(i: Int) = min(LAST, i/SUB)
  fun next(i: Int) = (band(i)+1) % GrooveSpectrum.BANDS
  fun mix(i: Int): Float {
    if (i < LAST*SUB) return (i%SUB).toFloat()/SUB
    val t = (i-LAST*SUB).toFloat()/SEAM
    return t*t*(3-2*t)
  }
}

/** Precompute geometry and phosphor transfer; batch all dots of one shade into one drawPoints call. */
internal class GrooveScreen {
  private val rows = GrooveGrid.ROWS
  private val cols = GrooveGrid.COLUMNS
  private val n = cols*rows
  private val x = FloatArray(n); private val y = FloatArray(n)
  private val rest = FloatArray(n); private val incidence = FloatArray(n)
  private val colors = IntArray(n); private val count = IntArray(128); private val cursor = IntArray(128)
  private val points = FloatArray(n*2)
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { strokeCap = Paint.Cap.ROUND }
  private val light = FloatArray(256*rows) { index ->
    val level = (index/rows)/255f; val depth = ((index%rows)+.5f)/rows
    val behind = (level-depth)/.34f; val t = (.52f+behind).coerceIn(0f,1f)
    sqrt(level)*(.83f*t*t*(3-2*t)+.56f*exp(-2.2f*behind*behind))
  }
  init {
    for (i in 0 until cols) {
      val theta = 2*PI*i/cols; val face = (.5+.5*cos(theta+.63)).toFloat()
      for (j in 0 until rows) {
        val k = i*rows+j; val depth = (j+.5)/rows; val curve = sin(PI*depth).toFloat()
        val r = 79.3+19.5*(.72*depth+.14*(1-cos(PI*depth)))
        x[k]=(100+r*sin(theta)).toFloat(); y[k]=(100-r*cos(theta)).toFloat()
        rest[k]=.05f+.17f*face*face*curve; incidence[k]=(.71f+.29f*face)*(.5f+.5f*curve)
      }
    }
  }

  fun draw(canvas: Canvas, side: Float, levels: FloatArray) {
    count.fill(0)
    for (i in 0 until cols) {
      val mix = GrooveGrid.mix(i)
      val energy = levels[GrooveGrid.band(i)]*(1-mix)+levels[GrooveGrid.next(i)]*mix
      val base = (energy*255).roundToInt().coerceIn(0,255)*rows
      for (j in 0 until rows) {
        val k = i*rows+j
        val shade = (127*(rest[k]+incidence[k]*light[base+j])).roundToInt().coerceIn(0,127)
        colors[k]=shade; count[shade]++
      }
    }
    var offset = 0
    for (s in count.indices) { cursor[s]=offset; offset+=2*count[s] }
    for (i in colors.indices) {
      val s=colors[i]; val p=cursor[s]; points[p]=x[i]; points[p+1]=y[i]; cursor[s]=p+2
    }
    canvas.save(); canvas.scale(side/200,side/200)
    for (s in count.indices) {
      if (count[s]==0) continue
      val v=s/127f; val length=count[s]*2; val start=cursor[s]-length
      val gray=(44+209*v).roundToInt()
      if (s>20) {
        paint.color=android.graphics.Color.argb((31*v*v).roundToInt(),255,255,255)
        paint.strokeWidth=2.3f+1.1f*v; canvas.drawPoints(points,start,length,paint)
      }
      paint.color=android.graphics.Color.rgb(gray,gray,gray); paint.strokeWidth=.73f+1.1f*v
      canvas.drawPoints(points,start,length,paint)
    }
    canvas.restore()
  }
}
