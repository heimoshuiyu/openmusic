import { expect, test } from 'bun:test'
import { voiceFailureMessage } from './voice'

test('dictation distinguishes workspace, credential, codec and unclassified provider errors without echoing details', () => {
  for (const [detail, hint] of [
    ['Workspace selection is required', '指定工作区'],
    ['This API key has expired', '已过期'],
    ['ffmpeg conversion failed', '解码'],
    ['LALM transcription request failed: other error', '模型服务调用失败'],
  ]) {
    const message = voiceFailureMessage(new Error(`${detail} (private upstream detail)`))
    expect(message).toContain(hint!)
    expect(message).not.toContain('private')
  }
})
