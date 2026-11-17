import { useCallback, useRef } from "react"

/**
 * 垂直拖拽手势（播放栏 ⇄ 正在播放 的 sheet 物理感三件套：跟手/速度判定/snap）。
 * 只做采集与速度估计，开合语义由调用方判定。
 *
 * - dy 向下为正（PointerEvent 坐标系）；vEnd 为松手前最后一段的竖直速度 px/s
 * - 主 pointer only；交互子元素（button/a/input/slider）不劫持——拖的是容器，
 *   点击与滑块行为原样保留
 * - 速度采样取松手前 ~80ms 窗口（首尾差分），避免单帧抖动误判轻扫
 */
export interface VerticalDragHandlers {
  /** 拖动中（每 move）；返回 false 表示此刻不接受（如方向锁定未过阈值） */
  onMove?: (dy: number) => void
  /** 松手/取消：dy 累计位移，vEnd 向下为正 */
  onEnd: (dy: number, vEnd: number) => void
}

const INTERACTIVE = "button, a, input, textarea, select, [role='slider'], [role='button']"

export function useVerticalDrag(handlers: VerticalDragHandlers) {
  const state = useRef<{ id: number; startY: number; lastY: number; lastT: number; v: number } | null>(null)

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (!event.isPrimary || state.current !== null) return
      if (event.pointerType === "mouse" && event.button !== 0) return
      const target = event.target as HTMLElement
      if (target.closest(INTERACTIVE) !== null) return
      state.current = { id: event.pointerId, startY: event.clientY, lastY: event.clientY, lastT: performance.now(), v: 0 }
      event.currentTarget.setPointerCapture(event.pointerId)
    },
    [],
  )

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      const s = state.current
      if (s === null || event.pointerId !== s.id) return
      const now = performance.now()
      const dt = (now - s.lastT) / 1000
      if (dt > 0) s.v = (event.clientY - s.lastY) / dt
      s.lastY = event.clientY
      s.lastT = now
      handlers.onMove?.(event.clientY - s.startY)
    },
    [handlers],
  )

  const finish = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      const s = state.current
      if (s === null || event.pointerId !== s.id) return
      state.current = null
      handlers.onEnd(event.clientY - s.startY, s.v)
    },
    [handlers],
  )

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: finish,
    onPointerCancel: finish,
  }
}

/** sheet 开合判定（位移比例 + 轻扫速度双通道）；flickPxPerS 向目标方向为正 */
export const shouldSnap = (traveled: number, velocity: number) => traveled >= 0.3 || velocity >= 500
