import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { ChevronRight, FolderOpen } from "lucide-react"
import { api } from "@/api/client"
import { subdirectoryProblem } from "@/imports/view-model"
import { inputClass } from "@/components/page"

export interface ImportDestinationValue {
  folderId: string
  subdirectory: string
}

/** 导入目标：曲库根目录（含可写状态）+ 已存在子目录的浏览/手输。
 *  手输仍允许（可输入任何“已存在”的相对子目录），服务端校验为权威。 */
export function ImportDestination({
  value,
  onChange,
  disabled = false,
}: {
  value: ImportDestinationValue
  onChange: (next: ImportDestinationValue) => void
  disabled?: boolean
}) {
  const { data: folders } = useQuery({ queryKey: ["netease-folders"], queryFn: api.neteaseFolders })
  const [browsing, setBrowsing] = useState(false)
  // 浏览路径独立于手输框：只在显式动作（打开浏览/点选子目录/按输入路径浏览）时变化，
  // 打字绝不触发请求——请求次数与用户显式动作一一对应。
  const [browsePath, setBrowsePath] = useState("")
  const children = useQuery({
    queryKey: ["netease-subdirectories", value.folderId, browsePath],
    queryFn: () => api.neteaseSubdirectories(value.folderId, browsePath),
    enabled: browsing && !disabled && value.folderId !== "",
  })
  const problem = subdirectoryProblem(value.subdirectory)
  const writableFolders = (folders ?? []).filter((folder) => folder.writable)
  const selected = (folders ?? []).find((folder) => folder.id === value.folderId)

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="目标曲库目录"
          className={`${inputClass} min-w-48 flex-1`}
          value={value.folderId}
          disabled={disabled}
          onChange={(event) => {
            onChange({ ...value, folderId: event.target.value, subdirectory: "" })
            setBrowsePath("")
          }}
        >
          <option value="">选择曲库目录…</option>
          {(folders ?? []).map((folder) => (
            <option key={folder.id} value={folder.id} disabled={!folder.writable}>
              {folder.name}（{folder.path}）{folder.writable ? "" : " · 不可写"}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="inline-flex min-h-10 items-center gap-2 border border-line bg-shell px-3 text-sm text-paper transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
          disabled={disabled || value.folderId === "" || problem !== null}
          aria-expanded={browsing}
          onClick={() => {
            if (!browsing) setBrowsePath(value.subdirectory)
            setBrowsing((open) => !open)
          }}
        >
          <FolderOpen className="h-4 w-4" />
          浏览子目录
        </button>
      </div>
      {selected && <p className="break-all font-readout text-xs text-faint">{selected.path}</p>}
      {folders !== undefined && folders.length > 0 && writableFolders.length === 0 && (
        <p className="text-xs text-danger">注册的曲库目录当前都不可写；请联系管理员检查目录权限。</p>
      )}
      {folders !== undefined && folders.length === 0 && (
        <p className="text-xs text-dim">管理员尚未注册任何曲库目录，无法导入。</p>
      )}
      <div>
        <input
          className={`${inputClass} w-full font-readout`}
          value={value.subdirectory}
          maxLength={360}
          disabled={disabled}
          aria-label="相对子目录（可选）"
          placeholder="相对子目录（可选，必须是已存在的目录，不跟随符号链接）"
          onChange={(event) => onChange({ ...value, subdirectory: event.target.value })}
        />
        {problem && <p role="alert" className="mt-1 text-xs text-danger">{problem}</p>}
      </div>
      {browsing && value.folderId !== "" && (
        <div className="rounded-md border border-line/60 bg-shell p-2">
          <div className="flex items-center gap-2 px-1 pb-1">
            <p className="min-w-0 flex-1 truncate font-readout text-[11px] text-faint">
              正在浏览：{browsePath === "" ? "根目录" : browsePath}
            </p>
            {browsePath !== value.subdirectory && (
              <button
                type="button"
                className="shrink-0 text-[11px] text-accent hover:underline disabled:cursor-not-allowed disabled:opacity-40"
                disabled={problem !== null}
                onClick={() => setBrowsePath(value.subdirectory)}
              >
                按输入路径浏览
              </button>
            )}
          </div>
          {children.isFetching ? (
            <p className="px-1 py-1.5 text-xs text-dim">正在读取子目录…</p>
          ) : children.error ? (
            <p role="alert" className="px-1 py-1.5 text-xs text-danger">
              {children.error instanceof Error ? children.error.message : "无法查看该子目录。"}
            </p>
          ) : (children.data?.directories.length ?? 0) === 0 ? (
            <p className="px-1 py-1.5 text-xs text-faint">这一层没有可选的子目录。</p>
          ) : (
            <ul className="max-h-40 space-y-0.5 overflow-y-auto">
              {(children.data?.directories ?? []).map((directory) => (
                <li key={directory}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-1.5 rounded px-1.5 py-1.5 text-left text-xs transition-colors hover:bg-raised/70"
                    onClick={() => {
                      onChange({ ...value, subdirectory: directory })
                      // 点选即显式钻入下一层：浏览路径与手输框同步推进
                      setBrowsePath(directory)
                    }}
                  >
                    <ChevronRight className="h-3.5 w-3.5 shrink-0 text-faint" />
                    <span className="truncate font-readout">{directory}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {children.data?.truncated && (
            <p className="px-1.5 pb-1 pt-1.5 text-[11px] text-faint">子目录较多，只显示前 80 个。</p>
          )}
          {value.subdirectory !== "" && (
            <button
              type="button"
              className="px-1.5 pt-1 text-xs text-accent hover:underline"
              onClick={() => {
                onChange({ ...value, subdirectory: "" })
                setBrowsePath("")
              }}
            >
              回到根目录
            </button>
          )}
        </div>
      )}
    </div>
  )
}
