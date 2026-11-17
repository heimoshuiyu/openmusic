import { Effect, Schema } from 'effect'
import type { OpenCode } from '@opencode/sdk'
import type { AnsweredQuestion, PendingQuestion } from '@openmusic/shared/agent-parts'
import { BadRequest, notFound } from '../../domain/errors'
import { AgentUnavailable } from './agent-service'

type Forms = OpenCode.Interface['sessions']['form']
type HostForm = Awaited<ReturnType<Forms['list']>>[number]

// Only the native question tool's presentation fields, never permission, auth or MCP forms.
function project(form: HostForm): PendingQuestion | undefined {
  const tool = form.metadata?.tool
  if (form.metadata?.kind !== 'question' || !tool || typeof tool !== 'object' ||
      !('messageID' in tool) || typeof tool.messageID !== 'string' || !('id' in tool) || typeof tool.id !== 'string') return
  const fields = form.fields.flatMap((f, i) => (f.type === 'string' || f.type === 'multiselect') &&
    f.key === `q${i}` && f.custom === true && !f.hidden && !f.when ? [{
      title: f.title ?? '', prompt: f.description ?? '', multiple: f.type === 'multiselect',
      options: (f.options ?? []).map(o => ({label:o.label, description:o.description ?? ''})),
    }] : [])
  if (fields.length !== form.fields.length) return
  return {id:form.id, messageID:tool.messageID, callID:tool.id, fields}
}

export function questionService(forms: Forms) {
  const list = async (sessionID:string) => (await forms.list({sessionID})).flatMap(f => {
    const q = f.sessionID === sessionID && project(f)
    return q ? [q] : []
  })
  const settle = (sessionID:string, id:string, answers:readonly (readonly string[])[] | null) => Effect.gen(function* () {
    const load = yield* Effect.tryPromise({try:()=>list(sessionID),catch:()=>new AgentUnavailable({message:'无法读取待回答的问题'})})
    const q = load.find(form => form.id === id)
    if (!q) return yield* notFound('pending_question',id)
    const answer: Record<string,string | string[]> = {}
    if (answers !== null) {
      if (answers.length !== q.fields.length) return yield* new BadRequest({message:'请逐项回答问题'})
      for (const [i,field] of q.fields.entries()) {
        const values = answers[i]!
        if (!values.length || (!field.multiple && values.length !== 1) || values.some(v=>!v.trim()) || new Set(values).size !== values.length)
          return yield* new BadRequest({message:'请检查所选答案'})
        answer[`q${i}`] = field.multiple ? [...values] : values[0]!
      }
    }
    // A reason makes cancellation ordinary model-facing feedback, not the SDK's no-message
    // dismissal sentinel. It is explicitly not a choice or approval to act.
    yield* Effect.tryPromise({try:()=> answers === null ? forms.cancel({sessionID,formID:id,message:'用户取消了这个问题，未提供答案。不要代选或执行依赖此选择的操作。'}) : forms.reply({sessionID,formID:id,answer}),
      catch:()=>new AgentUnavailable({message:'问题状态可能已变化，请刷新后重试'})})
  })
  return {list, settle}
}

export function answeredQuestion(input: unknown, metadata: Record<string,unknown> | undefined): AnsweredQuestion[] | undefined {
  const decoded = Schema.decodeUnknownOption(Schema.Struct({questions:Schema.Array(Schema.Struct({question:Schema.String})), answers:Schema.Array(Schema.Array(Schema.String))}))({
    questions: (input as {questions?:unknown} | null)?.questions, answers:metadata?.answers,
  })
  if (decoded._tag !== 'Some' || decoded.value.questions.length !== decoded.value.answers.length) return
  return decoded.value.questions.map((q,i)=>({prompt:q.question, answers:decoded.value.answers[i]!}))
}
