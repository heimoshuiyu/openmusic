import { useState } from "react"
import { Link } from "@tanstack/react-router"
import { Bot } from "lucide-react"
import { PageHeader, SortTabs } from "@/components/page"
import { NeteasePane } from "@/imports/netease-pane"

const SOURCES = [
  { key: "netease", label: "网易云" },
  { key: "youtube", label: "YouTube" },
] as const

type Source = (typeof SOURCES)[number]["key"]

/** 导入页：来源切换骨架（网易云首个实现；YouTube 仍走音乐助手，不动其现有行为）。 */
export function ImportsPage() {
  const [source, setSource] = useState<Source>("netease")
  return (
    <div className="catalog-page">
      <PageHeader title="导入">
        <SortTabs sorts={SOURCES} value={source} onChange={(key) => setSource(key as Source)} />
      </PageHeader>
      {source === "netease" ? <NeteasePane /> : <YoutubeHint />}
    </div>
  )
}

/** YouTube 导入的既有入口是音乐助手的工具时间线；这里只做指引，不新增 REST 行为。 */
function YoutubeHint() {
  return (
    <div className="max-w-3xl rounded-md border border-line/60 bg-panel p-5">
      <h2 className="text-base font-medium">YouTube 导入走音乐助手</h2>
      <p className="mt-2 text-sm text-dim">
        助手可以搜索 YouTube 候选、浏览曲库目录，并在对话里等待下载与入库完成；元数据整理、移出曲库和删除申请同样在对话中发起。
      </p>
      <Link
        to="/assistant"
        className="mt-4 inline-flex min-h-10 items-center gap-2 border border-line bg-shell px-3 text-sm text-paper transition-colors hover:border-accent hover:text-accent"
      >
        <Bot className="h-4 w-4" />
        打开音乐助手
      </Link>
    </div>
  )
}
