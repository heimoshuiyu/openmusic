import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { ListMusic, Plus, Trash2 } from "lucide-react"
import { api, formatDuration } from "@/api/client"
import { PageHeader, btnPlay, inputClass } from "@/components/page"

export function PlaylistsPage() {
  const queryClient = useQueryClient()
  const [name, setName] = useState("")
  const { data } = useQuery({ queryKey: ["playlists"], queryFn: api.playlists })

  const create = useMutation({
    mutationFn: () => api.createPlaylist(name),
    onSuccess: () => {
      setName("")
      queryClient.invalidateQueries({ queryKey: ["playlists"] })
    },
  })

  const remove = useMutation({
    mutationFn: (id: string) => api.deletePlaylist(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["playlists"] }),
  })

  return (
    <div className="catalog-page">
      <PageHeader title="播放列表" count={data?.length}>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            if (name.trim()) create.mutate()
          }}
            className="flex max-w-full flex-wrap gap-2"
        >
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="新播放列表名称"
            className={`${inputClass} w-56`}
          />
          <button
            type="submit"
            disabled={!name.trim() || create.isPending}
            className={btnPlay}
          >
            <Plus className="h-4 w-4" />
            创建
          </button>
        </form>
      </PageHeader>

      <div className="space-y-1.5">
        {(data ?? []).map((playlist) => (
          <div
            key={playlist.id}
              className="group flex items-center gap-4 border-b border-line py-3 transition-colors hover:bg-panel"
          >
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[3px] bg-raised text-dim">
              <ListMusic className="h-4 w-4" />
            </div>
            <Link to="/playlists/$id" params={{ id: playlist.id }} className="min-w-0 flex-1">
              <div className="truncate font-medium">{playlist.name}</div>
              <div className="tnum text-[11px] text-faint">
                {playlist.songCount} 首 · {formatDuration(playlist.durationSeconds)} ·{" "}
                {playlist.owner}
                {playlist.isPublic ? " · 公开" : ""}
              </div>
            </Link>
            {playlist.isMine && (
              <button
                type="button"
                onClick={() => remove.mutate(playlist.id)}
                className="p-1.5 text-faint opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
                title="删除"
                aria-label={`删除 ${playlist.name}`}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            )}
          </div>
        ))}
        {(data ?? []).length === 0 && (
          <div className="text-sm text-dim">还没有播放列表</div>
        )}
      </div>
    </div>
  )
}
