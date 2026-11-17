package dev.hmsy.openmusic.player

import kotlin.math.*

/** Same 4096-point Blackman FFT, band edges and dB scale as the Web Audio dial.
 * Owned by the visible sheet; never run an FFT on Media3's audio thread. */
internal class GrooveSpectrum {
  companion object { const val N = 4096; const val BANDS = 80 }
  private val window = FloatArray(N) { (.42 - .5*cos(2*PI*it/N) + .08*cos(4*PI*it/N)).toFloat() }
  private val reverse = IntArray(N) { Integer.reverse(it) ushr (32 - Integer.numberOfTrailingZeros(N)) }
  private val cosines = FloatArray(N/2) { cos(2*PI*it/N).toFloat() }
  private val sines = FloatArray(N/2) { -sin(2*PI*it/N).toFloat() }
  private val re = FloatArray(N)
  private val im = FloatArray(N)
  private val edges = IntArray(BANDS+1)
  private var rate = 0

  fun measure(samples: FloatArray, sampleRate: Int, out: FloatArray) {
    if (rate != sampleRate) {
      rate = sampleRate
      val step = rate.toDouble()/N
      val high = min(16000.0, rate*.5)
      val end = (high/step).toInt()
      for (i in edges.indices) {
        val hz = 212.0*((high+180)/212).pow(i.toDouble()/BANDS)-180
        edges[i] = min(end-(BANDS-i), max(if (i==0) 1 else edges[i-1]+1, (hz/step).roundToInt()))
      }
    }
    for (i in 0 until N) { re[reverse[i]] = samples[i]*window[i]; im[reverse[i]] = 0f }
    var span = 2
    while (span <= N) {
      val half = span/2; val stride = N/span
      for (base in 0 until N step span) for (j in 0 until half) {
        val a = base+j; val b = a+half; val k = j*stride
        val x = re[b]*cosines[k]-im[b]*sines[k]; val y = re[b]*sines[k]+im[b]*cosines[k]
        re[b] = re[a]-x; im[b] = im[a]-y; re[a] += x; im[a] += y
      }
      span *= 2
    }
    for (i in 0 until BANDS) {
      var power = 0f
      for (k in edges[i] until edges[i+1]) power = max(power, re[k]*re[k]+im[k]*im[k])
      val db = 10*log10(power/(N.toFloat()*N))
      out[i] = ((db+72f+9f*i/(BANDS-1))/59f).coerceIn(0f,1f)
    }
  }
}
