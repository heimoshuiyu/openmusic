import { useId, useState } from 'react'
import type { PendingQuestion } from '@openmusic/shared/agent-parts'
import { useAgentStore } from './store'

/** Plain text by design: neither model options nor typed answers are clickable commands. */
export function QuestionCard({session,question}:{session:string;question:PendingQuestion}) {
  const prefix = useId()
  const [choices,setChoices] = useState<string[][]>(()=>question.fields.map(()=>[]))
  const [custom,setCustom] = useState<string[]>(()=>question.fields.map(()=>''))
  const [saving,setSaving] = useState(false)
  const answers=choices.map((selected,i)=>[...new Set([...selected,...(custom[i]?.trim()?[custom[i]!.trim()]:[])])])
  async function send(value:string[][]|null) {
    if(saving)return
    setSaving(true)
    try {await useAgentStore.getState().settleQuestion(session,question.id,value)} finally {setSaving(false)}
  }
  return <form className="studio-question" aria-label="助手提问" onSubmit={e=>{e.preventDefault(); if(answers.every(a=>a.length))void send(answers)}}>
    {question.fields.map((field,i)=><fieldset disabled={saving} key={i}>
      <legend>{field.prompt || field.title}</legend>
      <p className="text-xs text-dim">{field.multiple?'可多选，也可以补充自己的答案。':'选一项，或填写自己的答案。'}</p>
      {field.options.map((o,j)=><label className="studio-question-option" key={j}>
        <input type={field.multiple?'checkbox':'radio'} name={`${prefix}-${i}`} checked={choices[i]!.includes(o.label)} onChange={e=>{
          const checked=e.currentTarget.checked
          setChoices(all=>all.map((v,n)=>n!==i?v:field.multiple?(checked?[...v,o.label]:v.filter(x=>x!==o.label)):[o.label]))
          if(!field.multiple)setCustom(all=>all.map((v,n)=>n===i?'':v))
        }}/><span>{o.label}{o.description && <small>{o.description}</small>}</span>
      </label>)}
      <input className="studio-question-custom" aria-label={`${field.title || field.prompt}：自己的答案`} placeholder="填写自己的答案…" maxLength={4000} value={custom[i]} onChange={e=>{
        const text=e.currentTarget.value
        setCustom(all=>all.map((v,n)=>n===i?text:v)); if(!field.multiple && text.trim())setChoices(all=>all.map((v,n)=>n===i?[]:v))
      }}/>
    </fieldset>)}
    <div className="flex flex-wrap items-center gap-3"><button className="studio-primary px-3 py-2 disabled:opacity-40" disabled={saving || answers.some(a=>!a.length)} type="submit">提交回答</button>
      <button className="px-2 py-2 text-sm text-dim" type="button" disabled={saving} onClick={()=>void send(null)}>取消提问</button></div>
  </form>
}
