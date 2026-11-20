import { ArrowUpLeft } from "lucide-react"

import { Sleeve } from "@/components/identity"

const starters = [
  ["点歌", "放点适合深夜的歌"],
  ["歌单", "把最近听的歌建成一个列表"],
  ["导入", "导入 YouTube 链接"],
  ["网易云", "导入网易云链接"],
] as const

export function StudioWelcome({ onPrompt, onCreate, creating }: {
  onPrompt?: (text:string)=>void; onCreate?: ()=>void; creating?:boolean
}) {
  return <div className="studio-welcome">
    <div className="studio-intro">
      <div><h2>今天想听什么？</h2><p>点一首歌，整理歌单，或把新发现收进曲库。</p></div>
      <Sleeve className="studio-sleeve"/>
    </div>
    {onPrompt && <div className="studio-prompts">{starters.map(([label,prompt])=><button type="button" key={label} onClick={()=>onPrompt(prompt)}>
      <span>{label}</span><strong>{prompt}</strong><ArrowUpLeft aria-hidden="true" size={16}/>
    </button>)}</div>}
    {onCreate && <button type="button" className="studio-primary" disabled={creating} onClick={onCreate}>{creating ? "正在新建…" : "新建对话"}</button>}
  </div>
}
