import { useEffect, useRef } from "react"
import { signalFrames } from "@/components/signal-frames"

const size = 44
// Project a fixed hemisphere. The apparent wave is light, not moving particles.
const dots = Array.from({length: 17}, (_, row) => {
  const lat = (row - 8) * Math.PI / 18
  const count = Math.max(3, Math.round(20 * Math.cos(lat)))
  return Array.from({length:count}, (_, col) => {
    const lon = ((col + .5) / count - .5) * Math.PI
    const x = Math.cos(lat) * Math.sin(lon), y = Math.sin(lat), z = Math.cos(lat) * Math.cos(lon)
    return { x:size/2 + 20*x, y:size/2 + 20*y, face:z, bend:x+.32*y+.35*(1-z),
      glint: Math.exp(-9*((x+.34)**2+(y+.44)**2)) }
  })
}).flat()

/** Quiet lens → microphone-driven ripple → one-way transcription sweep. No capture of its own. */
export function VoiceScope({ stream, processing }: { stream: MediaStream | undefined; processing: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const el = canvas.current, pen = el?.getContext("2d")
    if (!el || !pen) return
    const ratio = Math.min(devicePixelRatio || 1, 3)
    el.width = el.height = Math.round(size * ratio)
    pen.scale(ratio, ratio)
    pen.fillStyle = processing ? "#b9d0ff" : "#f1f5ff"
    let context: AudioContext | undefined, meter: AnalyserNode | undefined
    if (stream && typeof AudioContext !== "undefined") {
      try {
        context = new AudioContext(); meter = context.createAnalyser(); meter.fftSize = 512
        context.createMediaStreamSource(stream).connect(meter)
        void context.resume().catch(() => {})
      } catch { meter = undefined } // A missing meter must never stop the recorder.
    }
    const samples = new Float32Array(512)
    let level = 0, peak = -35, phase = 0
    const stop = signalFrames(!!meter || processing, dt => {
      if (dt === null) { level = 0; phase = 0 }
      else if (meter) {
        meter.getFloatTimeDomainData(samples)
        let energy = 0
        for (const n of samples) energy += n*n
        const db = 10*Math.log10(energy/samples.length + 1e-10)
        peak = Math.max(-35, peak - 5.4*dt, db)
        const floor = Math.max(-55, peak - 24)
        const target = Math.min(1, Math.max(0, (db-floor)/(peak-floor)))
        level += (target-level) * (1 - Math.exp(-dt/(target > level ? .034 : .14)))
        phase += dt * level * 3.2
      } else if (processing) {
        phase = (phase + dt/2) % 1
      }
      const center = processing ? phase*3.2 - 1.55 : .78*Math.sin(phase)
      const energy = processing && dt !== null ? .72 : level
      pen.clearRect(0, 0, size, size)
      for (const d of dots) {
        const light = energy * Math.exp(-9 * (d.bend - center)**2)
        pen.globalAlpha = Math.min(1, .07 + d.face * (.14 + .21*d.glint + light))
        pen.beginPath(); pen.arc(d.x, d.y, .35 + d.face*.45 + light*.25, 0, 2*Math.PI); pen.fill()
      }
    })
    return () => { stop(); void context?.close().catch(() => {}) }
  }, [stream, processing])
  return <canvas ref={canvas} width={size} height={size} className="voice-orb" aria-hidden="true" />
}
