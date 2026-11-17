import { useEffect, useRef } from "react"
import { readLevel } from "@/player/analyser"

const BARS = 14

/**
 * 面板电平表：14 段 LED，真实信号驱动（Web Audio RMS）。
 * 琥珀 = 有声音；顶部三段热区点亮呈红铜色。rAF 直接写 DOM，不触发 React 渨染。
 * 灯条以 3px 为基、可 grow——容器给 flex-1 时整行拉满（播放页），不给则保持原宽。
 */
export function VuMeter({ playing, className = "" }: { playing: boolean; className?: string }) {
  const barsRef = useRef<Array<HTMLSpanElement | null>>([])

  useEffect(() => {
    let raf = 0
    let peak = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const level = playing ? readLevel() : 0
      peak = Math.max(level, peak * 0.88)
      const lit = Math.round((playing ? Math.max(level, peak * 0.6) : 0) * BARS)
      for (let i = 0; i < BARS; i++) {
        const bar = barsRef.current[i]
        if (bar == null) continue
        const hot = i >= BARS - 3
        const on = i < lit
        bar.style.backgroundColor = on
          ? hot
            ? "var(--color-accent)"
            : "var(--color-paper)"
          : "var(--color-line)"
        bar.style.opacity = on ? "1" : "0.55"
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing])

  return (
    <div
      aria-hidden
      className={`hidden items-center gap-[3px] lg:flex ${className}`}
      title="输出电平"
    >
      {Array.from({ length: BARS }, (_, i) => (
        <span
          key={i}
          ref={(el) => {
            barsRef.current[i] = el
          }}
          className="h-4 w-[3px] grow rounded-[1px]"
          style={{ backgroundColor: "var(--color-line)" }}
        />
      ))}
    </div>
  )
}
