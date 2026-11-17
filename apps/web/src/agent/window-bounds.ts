export interface Point { x: number; y: number }
export interface Viewport { left: number; top: number; width: number; height: number; playerTop: number }

/** All coordinates are in layout-viewport CSS pixels, including on a zoomed phone.
 * The soft keyboard can hide the player. Don't reserve its height twice in that case. */
export function windowBounds(view: Viewport, position: Point | null) {
  const gap = 8
  const left = view.left + gap, top = view.top + gap
  const right = view.left + view.width - gap
  const bottom = Math.min(view.top + view.height, view.playerTop) - gap
  const width = Math.max(0, Math.min(420, right - left, Math.max(280, Math.round(view.width * 0.88))))
  const height = Math.max(0, Math.min(510, bottom - top, Math.max(300, Math.round(view.height * 0.64))))
  const clamp = (n: number | undefined, min: number, max: number) => Math.max(min, Math.min(n ?? max, max))
  return { left: clamp(position?.x, left, right - width), top: clamp(position?.y, top, bottom - height), width, height }
}
