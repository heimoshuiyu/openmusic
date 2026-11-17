/** A visual meter never owns the recording/player clock. null requests its quiet still frame. */
export function signalFrames(active: boolean, paint: (seconds: number | null) => void) {
  const reduced = matchMedia("(prefers-reduced-motion: reduce)")
  let frame = 0, previous = 0
  function tick(now: number) {
    const elapsed = previous ? now - previous : 1000 / 30
    if (elapsed >= 1000 / 30 - 1) {
      previous = now
      paint(Math.min(elapsed, 100) / 1000)
    }
    frame = requestAnimationFrame(tick)
  }
  function reset() {
    cancelAnimationFrame(frame)
    previous = 0
    paint(null)
    if (active && !document.hidden && !reduced.matches) frame = requestAnimationFrame(tick)
  }
  reset()
  reduced.addEventListener("change", reset)
  document.addEventListener("visibilitychange", reset)
  return () => {
    cancelAnimationFrame(frame)
    reduced.removeEventListener("change", reset)
    document.removeEventListener("visibilitychange", reset)
  }
}
