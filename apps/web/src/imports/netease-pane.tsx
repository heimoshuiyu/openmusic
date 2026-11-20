import { useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Download, Search as SearchIcon } from "lucide-react"
import { api, type TrackSummary } from "@/api/client"
import { usePlayer } from "@/player/store"
import { btnPlay, btnQuiet, inputClass } from "@/components/page"
import { ImportDestination, type ImportDestinationValue } from "@/imports/import-destination"
import { ImportResultPanel } from "@/imports/import-result"
import { ImportManageMenu } from "@/imports/import-manage"
import {
  neteaseKindHint, neteaseKindLabel, neteaseLink, neteaseOutcome, partitionTracks, subdirectoryProblem,
  type ImportOutcome,
} from "@/imports/view-model"

const sectionTitle = "mb-3 flex items-baseline gap-2.5 font-display text-[16px] font-semibold tracking-tight"

/** 网易云导入：搜索候选（≤5）/粘贴链接 → 目标目录 → 同步等终态 → 结果明细。
 *  匿名音源 MP3 ≤320k、VIP 预检跳过、歌单/专辑 ≤25、歌手热门前 25——文案如实。 */
export function NeteasePane() {
  const [query, setQuery] = useState("")
  const [submitted, setSubmitted] = useState("")
  const search = useQuery({
    queryKey: ["netease-search", submitted],
    queryFn: () => api.neteaseSearch(submitted),
    enabled: submitted !== "",
  })

  const [urlInput, setUrlInput] = useState("")
  const [destination, setDestination] = useState<ImportDestinationValue>({ folderId: "", subdirectory: "" })
  const [busy, setBusy] = useState(false)
  const [resolving, setResolving] = useState(false)
  const [result, setResult] = useState<ImportOutcome | null>(null)
  const [error, setError] = useState<string | null>(null)
  const queryClient = useQueryClient()

  const link = neteaseLink(urlInput)
  const subdirectoryBad = subdirectoryProblem(destination.subdirectory) !== null
  const canSubmit = !busy && link !== null && destination.folderId !== "" && !subdirectoryBad

  async function submitImport() {
    if (!canSubmit || !link) return
    setBusy(true); setError(null); setResult(null)
    try {
      const imported = await api.neteaseImport({
        url: link.url,
        folderId: destination.folderId,
        ...(destination.subdirectory === "" ? {} : { subdirectory: destination.subdirectory }),
      })
      setResult(neteaseOutcome(imported))
      // 导入走 scanner upsert，与一次增量扫描等价：全量失效让活跃页面自动刷新（同扫描结束处理）
      if (imported.state !== "failed") await queryClient.invalidateQueries()
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : "导入失败，请稍后重试。")
    } finally {
      setBusy(false)
    }
  }

  async function playImported(kind: "play-now" | "enqueue") {
    if (resolving || !result || result.trackIds.length === 0) return
    setResolving(true); setError(null)
    try {
      // 逐首独立解析：一首失败不拖垮其余，失败数如实展示
      const settled = await Promise.allSettled(result.trackIds.map((id) => api.track(String(id))))
      const { tracks, failed } = partitionTracks<TrackSummary>(settled)
      if (tracks.length === 0) {
        setError("未能取得曲目信息，无法播放。")
        return
      }
      const player = usePlayer.getState()
      if (kind === "play-now") player.playNow(tracks)
      else player.enqueue(tracks)
      if (failed > 0) setError(`${failed} 首的曲目信息读取失败，已跳过；其余照常${kind === "play-now" ? "播放" : "入队"}。`)
    } catch {
      setError("未能把曲目交给播放器。")
    } finally {
      setResolving(false)
    }
  }

  return (
    <div className="max-w-3xl space-y-10">
      <p className="text-xs text-faint">
        匿名音源为 MP3（至多 320k），海外直连对部分曲库有地区差异；VIP/付费歌曲有完整元数据但导入时会被明确跳过；
        歌单/专辑最多 25 首，歌手热门只取前 25；同一目录同一首歌不会重复下载（计为跳过）。
      </p>

      <section>
        <h3 className={sectionTitle}>搜索网易云</h3>
        <form
          className="mb-4"
          onSubmit={(event) => {
            event.preventDefault()
            setSubmitted(query)
          }}
        >
          <div className="relative flex max-w-3xl items-center border border-paper bg-panel focus-within:border-accent">
            <SearchIcon className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" />
            <input
              value={query}
              aria-label="搜索网易云歌曲"
              onChange={(event) => setQuery(event.target.value)}
              maxLength={160}
              placeholder="歌名 / 歌手 / 专辑…"
              className="h-12 min-w-0 flex-1 bg-transparent pl-10 pr-2 text-base placeholder:text-faint"
            />
            <button type="submit" className={btnQuiet} disabled={query.trim() === "" || search.isFetching}>搜索</button>
          </div>
        </form>
        {submitted !== "" && search.isFetching && <p className="text-sm text-dim">搜索中…</p>}
        {search.error && (
          <p role="alert" className="text-sm text-danger">
            {search.error instanceof Error ? search.error.message : "搜索失败，请检查服务器到网易云的网络连接。"}
          </p>
        )}
        {search.data && search.data.length === 0 && <p className="text-sm text-dim">没有匹配「{submitted}」的结果</p>}
        {search.data && search.data.length > 0 && (
          <ul className="space-y-1.5">
            {search.data.map((candidate) => (
              <li key={candidate.songId} className="flex items-center gap-3 rounded-md border border-line/50 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{candidate.title}</span>
                    {candidate.vip && (
                      <span
                        className="shrink-0 rounded-sm border border-line px-1 text-[10px] leading-4 text-dim"
                        title="VIP/付费歌曲会被明确跳过，导入时计入失败明细"
                      >
                        VIP/付费
                      </span>
                    )}
                  </div>
                  <p className="truncate text-xs text-dim">{candidate.artist} · {candidate.album}</p>
                </div>
                <button
                  type="button"
                  className={`${btnQuiet} shrink-0`}
                  onClick={() => setUrlInput(candidate.url)}
                  title="把这首的规范化链接填入下面的导入框"
                >
                  用这首歌
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <form
        onSubmit={(event) => {
          event.preventDefault()
          void submitImport()
        }}
      >
        <section>
          <h3 className={sectionTitle}>或粘贴链接</h3>
          <input
            className={`${inputClass} w-full`}
            value={urlInput}
            maxLength={2048}
            disabled={busy}
            aria-label="网易云歌曲、歌单、专辑或歌手链接"
            placeholder="https://music.163.com/song?id=…（也接受 #/song、y. 前缀、m/song/ID 变体）"
            onChange={(event) => setUrlInput(event.target.value)}
          />
          {urlInput.trim() !== "" && !link && (
            <p role="alert" className="mt-1.5 text-xs text-danger">
              仅接受 music.163.com 的单曲 / 歌单 / 专辑 / 歌手链接。
            </p>
          )}
          {link && (
            <p className="mt-1.5 text-xs text-dim">
              <span className="rounded-sm border border-line px-1 leading-4 text-faint">{neteaseKindLabel[link.kind]}</span>
              <span className="tnum ml-2">ID {link.id}</span>
              {neteaseKindHint(link.kind) && <span className="ml-2">{neteaseKindHint(link.kind)}</span>}
            </p>
          )}
        </section>

        <section className="mt-10">
          <h3 className={sectionTitle}>导入目标</h3>
          <ImportDestination value={destination} onChange={setDestination} disabled={busy} />
        </section>

        <section className="mt-10">
          <div className="flex flex-wrap items-center gap-4">
            <button type="submit" className={btnPlay} disabled={!canSubmit}>
              <Download className="h-4 w-4" />
              {busy ? "导入中…" : "开始导入"}
            </button>
            <span className="text-xs text-faint">下载与入库在同一请求内完成，可能需要几分钟。</span>
          </div>
          {busy && (
            <div className="mt-3 h-1 w-full max-w-md overflow-hidden rounded-full bg-line/60">
              <div className="scan-indeterminate h-full w-1/3 rounded-full bg-accent/70" />
            </div>
          )}
          {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
        </section>
      </form>

      {result && (
        <section className="mt-10">
          <h3 className={sectionTitle}>导入结果</h3>
          <ImportResultPanel
            outcome={result}
            manage={ImportManageMenu}
            busy={resolving}
            onPlay={() => void playImported("play-now")}
            onEnqueue={() => void playImported("enqueue")}
            onDismiss={() => setResult(null)}
          />
        </section>
      )}
    </div>
  )
}
