import { memo, useEffect, useRef } from "react"
import { signalFrames } from "@/components/signal-frames"
import { readSpectrum } from "./analyser"
import { paintSurface } from "./groove-surface"
import { SPECTRUM_BANDS } from "./spectrum"

export const GrooveMeter = memo(function GrooveMeter({ active }: { active: boolean }) {
  const surface = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = surface.current, ctx = canvas?.getContext("2d")
    if (!canvas || !ctx) return
    const target = new Float32Array(SPECTRUM_BANDS), levels = new Float32Array(SPECTRUM_BANDS)
    function resize() {
      if (!canvas || !ctx) return
      // Layout width, not the axis-aligned bounds of a rotating square.
      const px = Math.max(1, Math.round(canvas.clientWidth * Math.min(devicePixelRatio, 2)))
      if (canvas.width === px && canvas.height === px) return
      canvas.width = canvas.height = px
      ctx.setTransform(px / 200, 0, 0, px / 200, 0, 0)
      paintSurface(ctx, levels)
    }
    resize()
    const observer = new ResizeObserver(resize); observer.observe(canvas)
    const stop = signalFrames(active, dt => {
      if (dt === null) levels.fill(0)
      else {
        readSpectrum(target)
        const attack = 1 - Math.exp(-dt / .037), release = 1 - Math.exp(-dt / .19)
        for (let i = 0; i < levels.length; i++) {
          const diff = target[i]! - levels[i]!
          levels[i] = levels[i]! + diff * (diff > 0 ? attack : release)
        }
      }
      paintSurface(ctx, levels)
    })
    return () => { stop(); observer.disconnect() }
  }, [active])
  return <canvas ref={surface} aria-hidden="true" className="pointer-events-none absolute inset-0 size-full"/>
})
