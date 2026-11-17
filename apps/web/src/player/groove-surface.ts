import { SPECTRUM_BANDS } from "./spectrum"

// A rounded annular screen, in disc coordinates (diameter 200). Three printed columns per
// frequency band keep the grain fine without inventing additional frequency measurements.
const ROWS = 10, SUB = 3, TAU = 2 * Math.PI
const smooth = (x: number) => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t) }

// Closing a linear spectrum into a circle puts two unrelated endpoints side by side.
// Give *only* that join a 21° feather; leave the actual peaks and all interior samples intact.
const LAST = SPECTRUM_BANDS - 1, SEAM = 15
export const grooveBandMap = Array.from({ length: LAST * SUB + SEAM }, (_, i) => {
  const band = Math.floor(i / SUB)
  return band < LAST
    ? { band, next: band + 1, mix: (i % SUB) / SUB }
    : { band: LAST, next: 0, mix: smooth((i - LAST * SUB) / SEAM) }
})

const SCREEN = grooveBandMap.map((sample, i) => {
  const theta = TAU * i / grooveBandMap.length
  const face = .5 + .5 * Math.cos(theta + .63)
  const dots = Array.from({ length: ROWS }, (_, j) => {
    const depth = (j + .5) / ROWS
    const curve = Math.sin(Math.PI * depth)
    const radius = 79.3 + 19.5 * (.72 * depth + .14 * (1 - Math.cos(Math.PI * depth)))
    return {
      x: 100 + radius * Math.sin(theta), y: 100 - radius * Math.cos(theta), depth,
      size: 3.85 * (.77 + .23 * curve),
      rest: .05 + .17 * face ** 2 * curve,
      incidence: (.71 + .29 * face) * (.5 + .5 * curve),
    }
  })
  return { ...sample, dots }
})

/** Light under dark glass: a soft advancing front rather than a row-count threshold. */
export function phosphor(level: number, depth: number) {
  const behind = (level - depth) / .34
  const body = smooth(.52 + behind)
  const crest = Math.exp(-2.2 * behind * behind)
  return Math.sqrt(level) * (.83 * body + .56 * crest)
}

// Bake core, penumbra and tiny halo once. No per-dot gradients, shadows or DOM mutation in the frame loop.
const SHADES = 128, CELL = 32
let atlas: HTMLCanvasElement | undefined
function dotAtlas() {
  if (atlas) return atlas
  const sheet = document.createElement("canvas")
  sheet.width = CELL * SHADES; sheet.height = CELL
  const ctx = sheet.getContext("2d")!
  for (let i = 0; i < SHADES; i++) {
    const value = i / (SHADES - 1), gray = Math.round(44 + 209 * value)
    const core = .21 + .30 * value, x = (i + .5) * CELL, y = CELL / 2
    const light = ctx.createRadialGradient(x, y, 0, x, y, y)
    light.addColorStop(0, `rgb(${gray} ${gray} ${gray})`)
    light.addColorStop(core * .80, `rgb(${gray} ${gray} ${gray})`)
    light.addColorStop(core + .075, `rgb(255 255 255 / ${.13 * value * value})`)
    light.addColorStop(1, "rgb(255 255 255 / 0)")
    ctx.fillStyle = light; ctx.fillRect(i * CELL, 0, CELL, CELL)
  }
  atlas = sheet
  return sheet
}

export function paintSurface(ctx: CanvasRenderingContext2D, levels: Float32Array) {
  const sheet = dotAtlas()
  ctx.clearRect(0, 0, 200, 200)
  for (const col of SCREEN) {
    const energy = levels[col.band]! * (1 - col.mix) + levels[col.next]! * col.mix
    for (const d of col.dots) {
      const ink = Math.min(1, d.rest + d.incidence * phosphor(energy, d.depth))
      const stamp = Math.round(ink * (SHADES - 1))
      ctx.drawImage(sheet, stamp * CELL, 0, CELL, CELL, d.x - d.size / 2, d.y - d.size / 2, d.size, d.size)
    }
  }
}
