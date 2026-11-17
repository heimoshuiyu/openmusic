/** Read the dial clockwise from twelve o'clock. Each sector is one independent frequency band. */
export const SPECTRUM_BANDS = 80
export const SPECTRUM_FFT = 4096

/** Nearly linear in the sub-bass, logarithmic above it. Use the context's actual sample rate;
 * never double-count DC or reuse the same FFT bin for several neighbouring bars. */
export function bandEdges(sampleRate: number) {
  const binHz = sampleRate / SPECTRUM_FFT
  const low = 32, high = Math.min(16_000, sampleRate / 2), knee = 180
  const edges = new Uint16Array(SPECTRUM_BANDS + 1)
  const end = Math.floor(high / binHz)
  for (let i = 0; i <= SPECTRUM_BANDS; i++) {
    const hz = (low + knee) * ((high + knee) / (low + knee)) ** (i / SPECTRUM_BANDS) - knee
    edges[i] = Math.min(end - (SPECTRUM_BANDS - i), Math.max(i ? edges[i - 1]! + 1 : 1, Math.round(hz / binHz)))
  }
  return edges
}

/** Absolute dB scale: silence stays dark, a sound in one band cannot move an unrelated sector. */
export function spectrumLevels(db: Float32Array, edges: Uint16Array, out: Float32Array) {
  for (let i = 0; i < SPECTRUM_BANDS; i++) {
    let peak = -Infinity
    for (let k = edges[i]!; k < edges[i + 1]!; k++) peak = Math.max(peak, db[k]!)
    // Small high-frequency lift to keep hats/overtones legible beside the bass, without normalising each frame.
    out[i] = Math.min(1, Math.max(0, (peak + 72 + 9 * i / (SPECTRUM_BANDS - 1)) / 59))
  }
}
