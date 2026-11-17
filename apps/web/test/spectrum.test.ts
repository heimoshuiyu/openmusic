import { expect, test } from "bun:test"
import { bandEdges, spectrumLevels, SPECTRUM_BANDS, SPECTRUM_FFT } from "../src/player/spectrum"
import { grooveBandMap } from "../src/player/groove-surface"

test("the treble/bass join feathers across the wrap without attenuating the original bands", () => {
  const centers = grooveBandMap.filter(c => c.mix === 0).map(c => c.band)
  expect(centers).toEqual(Array.from({ length: SPECTRUM_BANDS }, (_, i) => i))
  const join = grooveBandMap.filter(c => c.band === SPECTRUM_BANDS - 1)
  expect(join.every(c => c.next === 0)).toBe(true)
  // Worst case: completely dark treble next to full-strength bass (or vice versa).
  for (const bass of [0, 1]) {
    const energy = [...join.map(c => (1 - bass) * (1 - c.mix) + bass * c.mix), bass]
    const steps = energy.slice(1).map((v, i) => Math.abs(v - energy[i]!))
    expect(Math.max(...steps)).toBeLessThan(.11)
    expect(steps[0]!).toBeLessThan(.02)
    expect(steps.at(-1)!).toBeLessThan(.02)
  }
})

test("the dial covers disjoint bass, mid and treble bands at the device sample rate", () => {
  for (const hz of [32_000,44_100,48_000,96_000,192_000]) {
    const edges = bandEdges(hz)
    expect(edges.length).toBe(SPECTRUM_BANDS + 1)
    expect(edges[0]).toBeGreaterThan(0)
    expect(edges[SPECTRUM_BANDS]).toBeLessThanOrEqual(SPECTRUM_FFT / 2)
    expect(edges.slice(1).every((v,i) => v > edges[i]!)).toBe(true)
    const db = new Float32Array(SPECTRUM_FFT / 2), levels = new Float32Array(SPECTRUM_BANDS)
    const locations = [90,1200,9000].map(tone => {
      db.fill(-Infinity)
      db[Math.round(tone * SPECTRUM_FFT / hz)] = -20
      spectrumLevels(db, edges, levels)
      expect(levels.filter(v=>v>0)).toHaveLength(1)
      return levels.findIndex(v=>v>0)
    })
    expect(locations[0]!).toBeLessThan(locations[1]!)
    expect(locations[1]!).toBeLessThan(locations[2]!)
    db.fill(-Infinity); spectrumLevels(db,edges,levels)
    expect(levels.every(v=>v===0)).toBe(true)
  }
})
