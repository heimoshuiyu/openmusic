import { Effect } from "effect"
import type { OpenCode } from "@opencode/sdk"
import { AgentUnavailable } from "./agent-service"

export const maxVoiceBytes = 2 * 1024 * 1024
export const voiceTypes = ["audio/webm", "audio/mp4", "audio/ogg"]

/** Match known failure modes, never forward or log raw provider errors (they can contain request data). */
export function voiceFailureMessage(error: unknown) {
  const message = error instanceof Error ? error.message : ''
  if (/ffmpeg conversion failed|ffmpeg conversion produced no audio/i.test(message)) return '服务器无法解码这段录音，请重新录制。'
  if (/failed to start ffmpeg|ffmpeg is not installed/i.test(message)) return '服务器无法启动音频转换程序 ffmpeg。'
  if (/workspace selection is required|authenticated workspace is required|workspace must be selected/i.test(message)) return '听写服务需要指定工作区；请选择当前 Console 工作区提供的听写模型。'
  if (/api key has expired/i.test(message)) return '听写服务拒绝了已过期的 API Key；请检查所选模型的供应商和连接。'
  if (/invalid credential|invalid api key|missing api key|credentials are unavailable|unauthorized/i.test(message)) return '听写模型的身份验证失败，请检查该供应商的连接。'
  if (/insufficient funds|insufficient balance|credit limit|usage limit|quota exceeded/i.test(message)) return '听写服务提示额度或余额不足。'
  if (/model not found|unknown model|does not have access to (?:this|the) model|model.{0,60}(?:not available|not enabled|not supported|is disabled)|model_not_found/i.test(message)) return '当前供应商未提供这个听写模型，或账号没有该模型的权限。'
  if (/does not support audio input|unsupported.*audio|audio.*(?:is not supported|not supported)/i.test(message)) return '当前模型接口不支持提交的音频格式。'
  if (/timed?\s*out|timeout/i.test(message)) return '听写请求超时，请稍后重试。'
  if (/LALM transcription request failed|Whisper request failed/i.test(message)) return '录音已送入听写请求，但模型服务调用失败。'
  return '听写失败，请检查录音，或请管理员确认语音模型与凭据。'
}

export function transcriber(host: OpenCode.Interface, directory: string) {
  return (input: { mime: string; bytes: Uint8Array; sessionID?: string }) => Effect.tryPromise({
    try: async (signal) => {
      // Only an owner-checked session enters here. Never guess a session for legacy clients.
      const result = await host.experimental.transcription.transcribeWithOverrides({
        location: { directory }, audio: Buffer.from(input.bytes).toString("base64"), mime: input.mime,
        ...(input.sessionID !== undefined ? { contextSessionID: input.sessionID, overrides: { context_pairs: 3 } }
          : { overrides: { context_pairs: 0 } }),
      }, { signal: AbortSignal.any([signal, AbortSignal.timeout(65_000)]) })
      return result.data.text.trim()
    },
    catch: error => new AgentUnavailable({ message: voiceFailureMessage(error) }),
  })
}
