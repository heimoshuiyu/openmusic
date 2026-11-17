/**
 * 收藏状态乐观覆盖层。
 *
 * 各视图各自 fetch 的 TrackSummary 是独立副本，全局 `s` 键改不了别人家的数组；
 * 用会话级 Map<id, bool> 覆盖在 track.starred 之上，所有行渲染统一走 is()。
 * 服务端失败回滚。会话内不过期（收藏是低频操作，覆盖层无冲突风险）。
 */
import type { OmApi } from "./api.js"

export class StarOverlay {
  private map = new Map<string, boolean>()
  constructor(private readonly api: OmApi) {}

  is(track: { id: string; starred: boolean }): boolean {
    return this.map.get(track.id) ?? track.starred
  }

  /** 切换并落库；返回 {next, ok}（ok=false = 服务端拒绝已回滚） */
  async toggle(track: { id: string; starred: boolean }): Promise<{ next: boolean; ok: boolean }> {
    const next = !this.is(track)
    this.map.set(track.id, next)
    try {
      if (next) await this.api.favorite(track.id)
      else await this.api.unfavorite(track.id)
      return { next, ok: true }
    } catch {
      this.map.set(track.id, !next)
      return { next: !next, ok: false }
    }
  }
}
