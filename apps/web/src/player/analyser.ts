/**
 * 播放条电平表的信号源：Web Audio AnalyserNode 接在 <audio> 上取真实输出。
 * 首次播放（用户手势链内）惰性创建；同源流无 CORS 限制。
 * 注意：createMediaElementSource 之后音频必须经 analyser 回接 destination，
 * 否则静音 —— 这里 connect 链已处理。
 */

import { bandEdges, spectrumLevels, SPECTRUM_FFT } from "./spectrum"

let ctx: AudioContext | null = null
let analyser: AnalyserNode | null = null
const buf = new Uint8Array(512)
const frequencyDb = new Float32Array(SPECTRUM_FFT / 2)
let edges: Uint16Array | null = null

export function initAnalyser(audio: HTMLAudioElement): void {
  if (ctx !== null) {
    if (ctx.state === "suspended") void ctx.resume()
    return
  }
  try {
    const AudioCtor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AudioCtor) return
    ctx = new AudioCtor()
    const source = ctx.createMediaElementSource(audio)
    analyser = ctx.createAnalyser()
    analyser.fftSize = SPECTRUM_FFT
    analyser.smoothingTimeConstant = .35
    edges = bandEdges(ctx.sampleRate)
    source.connect(analyser)
    analyser.connect(ctx.destination)
  } catch {
    // 建不起来就让播放条安静降级（不接电平表而已）
    ctx = null
    analyser = null
  }
}

export function readSpectrum(out: Float32Array): void {
  if (!analyser || !edges || ctx?.state !== "running") { out.fill(0); return }
  analyser.getFloatFrequencyData(frequencyDb)
  spectrumLevels(frequencyDb, edges, out)
}

/** RMS 电平 0..1（未就绪/暂停返回 0） */
export function readLevel(): number {
  if (analyser === null) return 0
  analyser.getByteTimeDomainData(buf)
  let sum = 0
  for (const raw of buf) {
    const v = (raw - 128) / 128
    sum += v * v
  }
  const rms = Math.sqrt(sum / buf.length)
  return Math.min(1, rms * 2.6)
}
