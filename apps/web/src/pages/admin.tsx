import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { FolderPlus, Pencil, RefreshCw, Trash2, Users } from "lucide-react"
import { api, type ScanStatus, type UserPublic } from "@/api/client"
import { PageHeader, btnPlay, btnQuiet, btnDangerGhost, inputClass } from "@/components/page"
import { AssistantSettingsPanel } from "@/agent/settings-panel"

export function AdminPage() {
  const queryClient = useQueryClient()
  const meQuery = useQuery({ queryKey: ["me"], queryFn: api.me })
  const me = meQuery.data
  const isAdmin = me?.isAdmin ?? false
  const { data: scan } = useQuery({
    queryKey: ["scanStatus"],
    queryFn: api.scanStatus,
    enabled: isAdmin,
    refetchInterval: q => q.state.data?.state === "scanning" ? 1000 : 15000,
  })
  const { data: folders } = useQuery({
    queryKey: ["folders"],
    queryFn: api.folders,
    enabled: isAdmin,
  })
  const { data: users } = useQuery({
    queryKey: ["users"],
    queryFn: api.users,
    enabled: isAdmin,
  })

  const [folderName, setFolderName] = useState("")
  const [folderPath, setFolderPath] = useState("")
  const [newUser, setNewUser] = useState({ username: "", password: "" })
  const [message, setMessage] = useState<string | null>(null)

  const scanMutation = useMutation({
    mutationFn: (force: boolean) => api.scan(force),
    onSuccess: (_data, force) => {
      setMessage(force ? "强制全量重扫已触发（跳过增量基线）" : "扫描已触发")
      queryClient.invalidateQueries({ queryKey: ["scanStatus"] })
    },
    onError: (error) => setMessage(`扫描失败: ${error.message}`),
  })

  const cancelMutation = useMutation({
    mutationFn: api.cancelScan,
    onSuccess: () => setMessage("已取消扫描（已完成的部分保留，重新扫描可续上）"),
    onError: (error) => setMessage(`取消失败: ${error.message}`),
  })

  if (!isAdmin) {
    return <div className="p-6 text-sm text-dim">{meQuery.isPending ? "正在核对账号权限…" : meQuery.isError ? <button onClick={()=>void meQuery.refetch()}>账号读取失败，点击重试</button> : "需要管理员权限"}</div>
  }

  return (
    <div className="catalog-page catalog-admin space-y-10">
      <div><h1 className="detail-title">管理</h1><nav aria-label="管理分区" className="mt-4 flex flex-wrap gap-5 text-sm text-accent">
        <a href="#library-settings">音乐库</a><a href="#assistant-settings">音乐助手</a><a href="#user-settings">用户</a>
      </nav></div>
      {message && (
        <div className="rounded-md border border-line bg-panel px-4 py-2.5 text-sm text-dim">
          {message}
        </div>
      )}

      <section id="library-settings">
        <PageHeader title="音乐库" level={2} />
        <ScanPanel
          scan={scan}
          onScan={() => scanMutation.mutate(false)}
          onForceScan={() => scanMutation.mutate(true)}
          onCancel={() => cancelMutation.mutate()}
        />
        <div className="mt-3 space-y-1.5">
          {(folders ?? []).map(folder => <FolderRow key={folder.id} folder={folder}/>)}
        </div>
        <form
          className="mt-3 flex flex-wrap gap-2"
          onSubmit={async (event) => {
            event.preventDefault()
            try {
              await api.createFolder(folderName, folderPath)
              setFolderName("")
              setFolderPath("")
              setMessage("音乐文件夹已添加")
              queryClient.invalidateQueries({ queryKey: ["folders"] })
            } catch (error) {
              setMessage(`添加失败: ${error instanceof Error ? error.message : ""}`)
            }
          }}
        >
          <input
            value={folderName}
            onChange={(event) => setFolderName(event.target.value)}
            required aria-label="音乐目录名称" placeholder="名称"
            className={`${inputClass} w-36`}
          />
          <input
            value={folderPath}
            onChange={(event) => setFolderPath(event.target.value)}
            required aria-label="服务器目录绝对路径" placeholder="服务器绝对路径，如 /mnt/music"
            className={`${inputClass} min-w-0 flex-1`}
          />
          <button type="submit" className={btnQuiet}>
            <FolderPlus className="h-4 w-4" />
            添加文件夹
          </button>
        </form>
      </section>

      <AssistantSettingsPanel />

      <section id="user-settings">
        <PageHeader title="用户" level={2} count={users?.total}>
          <form
            className="flex flex-wrap gap-2"
            onSubmit={async (event) => {
              event.preventDefault()
              try {
                await api.createUser(newUser.username, newUser.password)
                setNewUser({ username: "", password: "" })
                setMessage("用户已创建")
                queryClient.invalidateQueries({ queryKey: ["users"] })
              } catch (error) {
                setMessage(`创建失败: ${error instanceof Error ? error.message : ""}`)
              }
            }}
          >
            <input
              value={newUser.username}
              onChange={(event) => setNewUser({ ...newUser, username: event.target.value })}
              placeholder="用户名"
              className={`${inputClass} w-36`}
            />
            <input
              value={newUser.password}
              onChange={(event) => setNewUser({ ...newUser, password: event.target.value })}
              placeholder="密码（≥6 位）"
              type="password"
              className={`${inputClass} w-44`}
            />
            <button type="submit" className={btnQuiet}>
              <Users className="h-4 w-4" />
              创建用户
            </button>
          </form>
        </PageHeader>
        <div className="space-y-1.5">
          {(users?.items ?? []).map((user) => (
            <UserRow key={user.id} user={user} self={user.id === me?.id} />
          ))}
        </div>
      </section>
    </div>
  )
}

function ScanPanel({
  scan,
  onScan,
  onForceScan,
  onCancel,
}: {
  scan: ScanStatus | undefined
  onScan: () => void
  onForceScan: () => void
  onCancel: () => void
}) {
  const scanning = scan?.state === "scanning"
  const walking = scanning && scan?.phase === "walking"
  const total = scan?.total ?? 0
  const processed = scan?.processed ?? 0
  const progress = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0
  // indexing 已数完但仍未 idle：物化计数/封面解析等收尾工作（远程库可达数分钟）
  const finishing = scanning && !walking && total > 0 && processed >= total
  const statusText = !scanning
    ? scan?.lastScanAt
      ? `上次扫描 ${new Date(scan.lastScanAt).toLocaleString()}`
      : "从未扫描"
    : walking
      ? `遍历磁盘 · 已发现 ${total.toLocaleString()} 个文件`
      : finishing
        ? `收尾中… ${processed} / ${total}`
        : `${processed} / ${total} · ${progress}%`

  return (
    <div className="rounded-md border border-line/60 bg-panel p-4">
      <div className="flex flex-wrap items-center gap-4">
        <button type="button" onClick={onScan} disabled={scanning} className={btnPlay}>
          <RefreshCw className={`h-4 w-4 ${scanning ? "animate-spin" : ""}`} />
          {scanning ? "扫描中…" : "立即扫描"}
        </button>
        {/* 管理操作一律 quiet：跳过增量基线全量重解析（归组规则升级后修存量），
            大库耗时数分钟，误点代价高——二次确认 */}
        <button
          type="button"
          onClick={() => {
            if (window.confirm("强制重扫会重新解析全部文件（大库需数分钟），继续？")) onForceScan()
          }}
          disabled={scanning}
          className={btnQuiet}
          title="跳过增量基线，重解析全部文件"
        >
          强制重扫
        </button>
        {scanning && (
          <button type="button" onClick={onCancel} className={btnQuiet}>
            取消
          </button>
        )}
        <span className="tnum text-xs text-dim">{statusText}</span>
      </div>
      {scanning && (
        <div className="mt-3 h-1 w-full overflow-hidden rounded-full bg-line/60">
          {walking ? (
            /* walking 阶段总量未知（total 随发现增长）：不确定态动画，百分比无意义 */
            <div className="scan-indeterminate h-full w-1/3 rounded-full bg-accent/70" />
          ) : (
            <div
              className="h-full rounded-full bg-accent transition-all"
              style={{ width: `${progress}%` }}
            />
          )}
        </div>
      )}
      {scan?.errors && scan.errors.length > 0 && (
        <div className="mt-3 max-h-24 overflow-y-auto tnum text-[11px] text-danger">
          {scan.errors.slice(0, 5).map((error, i) => (
            <div key={i} className="truncate">
              {error}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function FolderRow({folder}: {folder:Awaited<ReturnType<typeof api.folders>>[number]}) {
  const queries = useQueryClient()
  const [name,setName] = useState<string|null>(null)
  const change = useMutation({mutationFn: async (value:string|null) => {
    if(value===null)await api.deleteFolder(folder.id);else await api.renameFolder(folder.id,value)
  },
    onSuccess: async () => {setName(null);await queries.invalidateQueries({queryKey:["folders"]})}})
  return <div className="border-b border-line py-2 text-sm">
    <div className="flex items-center gap-1"><div className="min-w-0 flex-1">
      <div className="font-medium">{folder.name}</div><div className="break-all font-readout text-xs text-dim">{folder.path}</div>
    </div><span className="hidden tnum text-xs text-faint lg:block">{folder.lastScanAt ? `扫描于 ${new Date(folder.lastScanAt).toLocaleString()}` : "未扫描"}</span>
      <button type="button" aria-label={`重命名目录 ${folder.name}`} className="p-3 text-dim" disabled={change.isPending} onClick={()=>setName(folder.name)}><Pencil size={15}/></button>
      <button type="button" aria-label={`移除目录 ${folder.name}`} className={`${btnDangerGhost} p-3`} disabled={change.isPending} onClick={()=>{
        if(window.confirm(`从曲库移除「${folder.name}」？\n${folder.path}\n该目录下的曲目将移出曲库，不会删除磁盘上的文件。`))change.mutate(null)
      }}><Trash2 size={16}/></button>
    </div>
    {name!==null && <form className="mt-2 flex flex-wrap items-center gap-2" onSubmit={e=>{e.preventDefault();if(name.trim())change.mutate(name.trim())}}>
      <input autoFocus required aria-label="新目录名称" className={`${inputClass} min-w-0 flex-1`} value={name} onChange={e=>setName(e.target.value)}/>
      <button className={btnQuiet} disabled={change.isPending || !name.trim()}>保存</button><button type="button" onClick={()=>setName(null)}>取消</button>
    </form>}
    {change.error && <p role="alert" className="text-danger">{change.error.message}</p>}
  </div>
}

function UserRow({ user, self }: { user: UserPublic; self:boolean }) {
  const queryClient = useQueryClient()
  const [deleted, setDeleted] = useState(false)
  const [error,setError] = useState("")
  useEffect(() => setDeleted(false), [user.id])
  if (deleted) return null
  return (
    <div className="group flex items-center gap-3 rounded-md border border-line/50 p-3 text-sm transition-colors hover:border-accent/40">
      <div className="flex-1">
        {user.username}
        {user.isAdmin && <span className="ml-2 text-xs text-accent">管理员</span>}
      </div>
      <span className="tnum text-[11px] text-faint">
        {user.lastSeenAt ? `活跃 ${new Date(user.lastSeenAt).toLocaleDateString()}` : "从未登录"}
      </span>
      <button
        type="button"
        disabled={self} aria-label={`删除用户 ${user.username}`}
        className={`${btnDangerGhost} p-3 hoverable:opacity-0 hoverable:group-hover:opacity-100 focus-visible:opacity-100`}
        onClick={async () => {
          if(!window.confirm(`删除用户「${user.username}」？此操作不可撤销。`))return
          try {await api.deleteUser(user.id);setDeleted(true);await queryClient.invalidateQueries({queryKey:["users"]})}
          catch(e){setError(e instanceof Error ? e.message : "删除失败")}
        }}
        title="删除"
      >
        <Trash2 className="h-4 w-4" />
      </button>
      {error && <span role="alert" className="text-danger">{error}</span>}
    </div>
  )
}
