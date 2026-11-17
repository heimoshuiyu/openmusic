/** 订阅 Player 的版本号——任何状态变化（tick/动作）触发重渲染 */
import { useSyncExternalStore } from "react"
import type { Player } from "./player.js"

export function usePlayerTick(player: Player): void {
  useSyncExternalStore(player.subscribe, player.getVersion, player.getVersion)
}
