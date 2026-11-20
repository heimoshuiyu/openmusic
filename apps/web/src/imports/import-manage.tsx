import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { useNavigate } from "@tanstack/react-router"
import { useQueryClient } from "@tanstack/react-query"
import { Pencil } from "lucide-react"
import { api, ApiError, type NeteaseInfo, type NeteaseTags, type TrackSummary } from "@/api/client"
import { btnQuiet, inputClass } from "@/components/page"
import { neteaseFormTags } from "@/imports/view-model"

/** 网易云导入曲目的行级管理：用户点开才懒加载来源信息（不逐行探测）。
 *  404 = 这首不是网易云导入或当前账号不可管理；其余错误原样展示。 */
export function ImportManageMenu({ trackId, label }: { trackId: string; label: string }) {
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState({ x: 0, y: 0 })
  const [info, setInfo] = useState<NeteaseInfo | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [phase, setPhase] = useState<"loading" | "failed" | "view" | "edit">("loading")
  const [busy, setBusy] = useState(false)
  const toggle = useRef<HTMLButtonElement | null>(null)
  const popover = useRef<HTMLDivElement | null>(null)
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  useEffect(() => {
    if (!open || info !== null) return
    let mounted = true
    setError(null); setPhase("loading")
    void api.neteaseInfo(trackId).then(
      (value) => { if (mounted) { setInfo(value); setPhase("view") } },
      (cause) => {
        if (!mounted) return
        // 失败进入明确 failed 相位：loading 文案与错误信息不再同显
        setPhase("failed")
        setError(cause instanceof ApiError && cause.status === 404
          ? "这首曲目不是网易云导入，或你不具有权限管理它。"
          : cause instanceof Error && cause.message ? cause.message : "导入信息读取失败，请稍后重试。")
      },
    )
    return () => { mounted = false }
  }, [open, info, trackId])

  // 外点/Esc 只豁免本实例的 toggle 与弹层：点开另一行时旧弹层随之关闭（portal 后仍按 ref 判定）
  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => {
      const target = event.target as Node
      if (popover.current?.contains(target) || toggle.current?.contains(target)) return
      setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false)
    }
    window.addEventListener("mousedown", close)
    window.addEventListener("keydown", onKey)
    return () => {
      window.removeEventListener("mousedown", close)
      window.removeEventListener("keydown", onKey)
    }
  }, [open])

  // 弹层锚定在打开瞬间的行位置：祖先（虚拟列表滚动容器）一滚就关闭，绝不悬浮错位。
  // 弹层自身滚动除外（capture 阶段按 target 判定）。
  useEffect(() => {
    if (!open) return
    const onScroll = (event: Event) => {
      if (event.target instanceof Element && event.target.closest(".import-manage-popover")) return
      setOpen(false)
    }
    window.addEventListener("scroll", onScroll, { capture: true, passive: true })
    return () => window.removeEventListener("scroll", onScroll, { capture: true })
  }, [open])

  // portal 把弹层挂在 body 末尾，Tab 会先穿完整页才到达：打开即把焦点收进弹层
  // （容器 tabIndex=-1），任何关闭路径（Esc/外点/滚动/再点 toggle/整行卸载）都还给
  // 本实例 toggle；ref 已被 React 摘除时 optional chaining 静默跳过，不抛错。
  // preventScroll：聚焦本身绝不触发祖先滚动，不会被上面的滚动关闭误伤。
  useEffect(() => {
    if (!open) return
    popover.current?.focus({ preventScroll: true })
    return () => {
      toggle.current?.focus({ preventScroll: true })
    }
  }, [open])

  async function unindex() {
    if (busy || !info) return
    if (!window.confirm(`把「${info.title}」移出共享曲库和歌单？\n原文件保留在服务器磁盘上；之后的扫描不会自动捡回。`)) return
    setBusy(true); setNote(null)
    try {
      await api.neteaseUnindex(trackId)
      await queryClient.invalidateQueries()
      setOpen(false)
    } catch (cause) {
      setNote(cause instanceof Error && cause.message ? cause.message : "移出失败，请稍后重试。")
    } finally {
      setBusy(false)
    }
  }

  async function requestDeletion() {
    if (busy || !info) return
    setBusy(true); setNote(null)
    try {
      // 只创建 5 分钟人工核对票据，不删任何文件；永久删除必须走 /review-deletion 输入完整文件名
      const request = await api.neteaseRequestDeletion(trackId)
      setOpen(false)
      await navigate({ to: "/review-deletion/$requestId", params: { requestId: request.requestId } })
    } catch (cause) {
      setNote(cause instanceof Error && cause.message ? cause.message : "申请创建失败，请稍后重试。")
    } finally {
      setBusy(false)
    }
  }

  async function saveTags(tags: NeteaseTags) {
    if (busy || !info) return
    if (Object.keys(tags).length === 0) {
      setPhase("view"); setNote("没有改动需要保存。")
      return
    }
    setBusy(true); setNote(null)
    try {
      const updated = await api.neteaseEdit(trackId, tags)
      setInfo(updated); setPhase("view")
      setNote(updated.warnings && updated.warnings.length ? `已保存。${updated.warnings.join(" ")}` : "已保存。")
    } catch (cause) {
      setNote(cause instanceof Error && cause.message ? cause.message : "保存失败，请稍后重试。")
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button
        ref={toggle}
        type="button"
        className="import-manage-toggle p-1 text-faint transition-opacity hoverable:hover:text-paper hoverable:opacity-0 hoverable:group-hover:opacity-100 focus-visible:opacity-100"
        aria-label={`管理 ${label} 的导入信息`}
        title="网易云导入管理"
        onClick={(event) => {
          event.stopPropagation()
          const rect = toggle.current!.getBoundingClientRect()
          setAnchor({ x: rect.left, y: rect.bottom + 6 })
          setOpen((value) => !value)
        }}
      >
        <Pencil className="h-4 w-4" />
      </button>
      {open && createPortal(
        <div
          ref={popover}
          role="dialog"
          aria-label="导入管理"
          tabIndex={-1}
          className="import-manage-popover fixed z-50 w-80 max-h-96 overflow-y-auto rounded-md border border-line bg-panel p-3 shadow-xl"
          style={{ left: Math.min(anchor.x, Math.max(8, window.innerWidth - 328)), top: anchor.y }}
        >
          {phase === "loading" && <p className="text-xs text-dim">正在读取导入信息…</p>}
          {phase === "failed" && error && <p role="alert" className="text-xs text-danger">{error}</p>}
          {note && <p role="status" className="mb-2 text-xs text-accent">{note}</p>}
          {info && phase === "view" && (
            <NeteaseInfoBody
              info={info}
              busy={busy}
              onEdit={() => setPhase("edit")}
              onUnindex={() => void unindex()}
              onRequestDeletion={() => void requestDeletion()}
            />
          )}
          {info && phase === "edit" && (
            <NeteaseEditForm info={info} busy={busy} onCancel={() => setPhase("view")} onSubmit={(tags) => void saveTags(tags)} />
          )}
        </div>,
        // 行内 transform 会让 fixed 以该行为 containing block：portal 到 body 后视口坐标才成立
        document.body,
      )}
    </>
  )
}

/** 元数据展示 + 管理动作（纯展示，回调驱动，可静态渲染测试） */
export function NeteaseInfoBody({
  info,
  onEdit,
  onUnindex,
  onRequestDeletion,
  busy = false,
}: {
  info: NeteaseInfo
  onEdit?: () => void
  onUnindex?: () => void
  onRequestDeletion?: () => void
  busy?: boolean
}) {
  return (
    <div className="space-y-2.5 text-sm">
      <h3 className="truncate font-medium" title={info.title}>{info.title}</h3>
      <dl className="space-y-0.5 text-xs text-dim">
        <div className="flex gap-2"><dt className="shrink-0 text-faint">歌手</dt><dd className="truncate">{info.artist}</dd></div>
        <div className="flex gap-2"><dt className="shrink-0 text-faint">专辑</dt><dd className="truncate">{info.album}{info.albumArtist ? ` · ${info.albumArtist}` : ""}</dd></div>
        <div className="flex gap-2"><dt className="shrink-0 text-faint">歌曲 ID</dt><dd className="tnum">{info.songId}</dd></div>
        <div className="flex gap-2"><dt className="shrink-0 text-faint">音质</dt>
          <dd className="tnum">{info.quality ?? "未知"} · {info.format.toUpperCase()}</dd></div>
        {info.genre && <div className="flex gap-2"><dt className="shrink-0 text-faint">流派</dt><dd className="truncate">{info.genre}</dd></div>}
        <div className="flex gap-2"><dt className="shrink-0 text-faint">曲序</dt>
          <dd className="tnum">{info.trackNumber ?? "—"} / 碟 {info.discNumber}{info.hasCover ? " · 有封面" : " · 无封面"}</dd></div>
        <div className="flex gap-2"><dt className="shrink-0 text-faint">文件</dt><dd className="break-all font-readout">{info.filename}</dd></div>
      </dl>
      {info.warnings && info.warnings.length > 0 && (
        <ul className="space-y-0.5 border-l-2 border-line pl-2 text-xs text-dim">
          {info.warnings.map((warning, index) => <li key={`${index}:${warning}`}>{warning}</li>)}
        </ul>
      )}
      <div className="flex flex-col gap-2 pt-1">
        {onEdit && <button type="button" className={btnQuiet} disabled={busy} onClick={onEdit}>编辑元数据</button>}
        {onUnindex && (
          <button type="button" className={btnQuiet} disabled={busy} onClick={onUnindex}>
            移出曲库（保留文件）
          </button>
        )}
        {onRequestDeletion && (
          <button type="button" className="text-xs text-faint transition-colors hover:text-danger disabled:opacity-40" disabled={busy} onClick={onRequestDeletion}>
            申请永久删除原文件…
          </button>
        )}
      </div>
    </div>
  )
}

/** 曲目行的管理插槽适配：把 TrackSummary 收窄成菜单需要的 trackId/label */
export function TrackManageSlot({ track }: { track: TrackSummary }) {
  return <ImportManageMenu trackId={track.id} label={track.title} />
}

/** 元数据编辑表单：经 view-model.neteaseFormTags 只提交改过的字段（空位置字段=不改） */
export function NeteaseEditForm({
  info,
  busy = false,
  onSubmit,
  onCancel,
}: {
  info: NeteaseInfo
  busy?: boolean
  onSubmit: (tags: NeteaseTags) => void
  onCancel?: () => void
}) {
  const [form, setForm] = useState({
    title: info.title, artist: info.artist, album: info.album,
    albumArtist: info.albumArtist, genre: info.genre ?? "",
    trackNumber: info.trackNumber === null ? "" : String(info.trackNumber),
    discNumber: String(info.discNumber), cover: "",
  })
  const set = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setForm((current) => ({ ...current, [key]: event.target.value }))
  return (
    <form
      className="space-y-2 text-sm"
      onSubmit={(event) => {
        event.preventDefault()
        // 位置字段以原始字符串走 neteaseFormTags：空串=不改（修复 Number("")=0），越界同样省略
        onSubmit(neteaseFormTags(info, form))
      }}
    >
      <h3 className="text-xs text-faint">编辑元数据（只提交改过的字段）</h3>
      <label className="block space-y-1 text-xs"><span className="text-faint">标题</span>
        <input className={`${inputClass} h-9 w-full`} value={form.title} maxLength={300} onChange={set("title")} /></label>
      <label className="block space-y-1 text-xs"><span className="text-faint">歌手</span>
        <input className={`${inputClass} h-9 w-full`} value={form.artist} maxLength={300} onChange={set("artist")} /></label>
      <label className="block space-y-1 text-xs"><span className="text-faint">专辑</span>
        <input className={`${inputClass} h-9 w-full`} value={form.album} maxLength={300} onChange={set("album")} /></label>
      <label className="block space-y-1 text-xs"><span className="text-faint">专辑艺人</span>
        <input className={`${inputClass} h-9 w-full`} value={form.albumArtist} maxLength={300} onChange={set("albumArtist")} /></label>
      <label className="block space-y-1 text-xs"><span className="text-faint">流派</span>
        <input className={`${inputClass} h-9 w-full`} value={form.genre} maxLength={300} onChange={set("genre")} /></label>
      <div className="flex gap-2">
        <label className="block space-y-1 text-xs"><span className="text-faint">曲序</span>
          <input className={`${inputClass} h-9 w-20 tnum`} type="number" min={1} max={9999} value={form.trackNumber} onChange={set("trackNumber")} /></label>
        <label className="block space-y-1 text-xs"><span className="text-faint">碟号</span>
          <input className={`${inputClass} h-9 w-20 tnum`} type="number" min={1} max={9999} value={form.discNumber} onChange={set("discNumber")} /></label>
      </div>
      <label className="block space-y-1 text-xs">
        <span className="text-faint">封面（netease 恢复网易云封面；或 music.126.net 的 https 链接 / data:image）</span>
        <input className={`${inputClass} h-9 w-full font-readout`} value={form.cover} maxLength={5_600_000} placeholder="留空不修改" onChange={set("cover")} />
      </label>
      <div className="flex gap-2 pt-1">
        <button type="submit" className={btnQuiet} disabled={busy}>保存</button>
        {onCancel && <button type="button" className="p-2 text-xs text-dim hover:text-paper" disabled={busy} onClick={onCancel}>取消</button>}
      </div>
    </form>
  )
}
