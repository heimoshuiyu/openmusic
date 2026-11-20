import { Play, Plus, X } from "lucide-react"
import { importStateLabel, type ImportOutcome } from "@/imports/view-model"

/** 泛化导入终态面板：youtube（videoId 维）与 netease（songId 维）共用。
 *  只读展示 + 回调按钮，不直接触碰 player/client，保持可静态渲染测试。 */
export function ImportResultPanel({
  outcome,
  onPlay,
  onEnqueue,
  onDismiss,
  manage,
  busy = false,
}: {
  outcome: ImportOutcome
  onPlay?: () => void
  onEnqueue?: () => void
  onDismiss?: () => void
  /** 结果行上的管理入口（如网易云元数据/移出库/删除申请） */
  manage?: React.ComponentType<{ trackId: string; label: string }>
  /** 播放/入队曲目详情还在解析时置灰按钮 */
  busy?: boolean
}) {
  const state = outcome.state
  const playable = outcome.trackIds.length > 0
  return (
    <section aria-label="导入结果" className="space-y-4 rounded-md border border-line/60 bg-panel p-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className={`text-sm font-medium ${state === "failed" ? "text-danger" : state === "done" ? "text-accent" : "text-dim"}`}>
          {importStateLabel[state]}
        </span>
        <span className="text-xs text-faint">{outcome.kind}</span>
        <span className="tnum text-xs text-dim">
          共 {outcome.total} · 导入 {outcome.imported} · 跳过 {outcome.skipped} · 失败 {outcome.failed}
        </span>
        {onDismiss && (
          <button type="button" aria-label="关闭导入结果" className="ml-auto p-1 text-faint hover:text-paper" onClick={onDismiss}>
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
      <p className="break-all font-readout text-xs text-faint">{outcome.destination}</p>
      {outcome.files.length > 0 && (
        <ul className="space-y-1 text-sm">
          {outcome.files.map((file) => (
            <li key={file.trackId} className="flex items-center gap-2">
              <span className="truncate font-readout text-xs text-dim">{file.name}</span>
              {manage && <ManageRef manage={manage} trackId={String(file.trackId)} label={file.name} />}
            </li>
          ))}
        </ul>
      )}
      {outcome.failures.length > 0 && (
        <div>
          <h3 className="mb-1 text-xs font-medium text-danger">未导入（{outcome.failures.length}）</h3>
          <ul className="space-y-0.5 text-xs text-danger">
            {outcome.failures.map((failure) => (
              <li key={failure.id} className="break-words">
                <span className="tnum">{failure.id}</span> · {failure.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
      {outcome.warnings.length > 0 && (
        <div>
          <h3 className="mb-1 text-xs font-medium text-dim">提示（{outcome.warnings.length}）</h3>
          <ul className="space-y-0.5 text-xs text-dim">
            {outcome.warnings.map((warning) => (
              <li key={warning.id + warning.message} className="break-words">
                <span className="tnum">{warning.id}</span> · {warning.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      {playable && (onPlay || onEnqueue) && (
        <div className="flex flex-wrap gap-2">
          {onPlay && (
            <button type="button" className="inline-flex min-h-10 items-center justify-center gap-2 bg-paper px-4 text-sm font-medium text-shell hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-45" disabled={busy} onClick={onPlay}>
              <Play className="h-4 w-4 fill-current" />
              立即播放
            </button>
          )}
          {onEnqueue && (
            <button type="button" className="inline-flex min-h-10 items-center gap-2 border border-line bg-shell px-3 text-sm text-paper transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40" disabled={busy} onClick={onEnqueue}>
              <Plus className="h-4 w-4" />
              加入队列
            </button>
          )}
        </div>
      )}
    </section>
  )
}

/** React 19 里组件类型的 ref 传法保持一致：这里只是把泛型组件具象化 */
function ManageRef({ manage: Manage, trackId, label }: { manage: React.ComponentType<{ trackId: string; label: string }>; trackId: string; label: string }) {
  return <Manage trackId={trackId} label={label} />
}
