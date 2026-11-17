import { useEffect } from "react"
import { create } from "zustand"

/**
 * 全局环境晕染（对齐安卓 AmbientBackdrop 架构）：屏幕侧声明封面 URL，
 * 根布局统一画在最底层——晕染延伸到侧栏区/移动顶栏/播放条后面，
 * 屏内自画会在滚动容器上缘截断（安卓踩过同款坑）。
 */
interface AmbientState {
  coverUrl: string | null
  set: (url: string | null) => void
}

export const useAmbient = create<AmbientState>((set) => ({
  coverUrl: null,
  set: (coverUrl) => set({ coverUrl }),
}))

/** 屏幕侧声明：加载到封面时设置，离开自动清除（安卓 SetAmbientCover 的
 *  DisposableEffect 语义——只在值仍归自己时清，防 A→B 导航的卸载竞态） */
export function useSetAmbientCover(coverUrl: string | null | undefined): void {
  useEffect(() => {
    const url = coverUrl ?? null
    useAmbient.getState().set(url)
    return () => {
      if (useAmbient.getState().coverUrl === url) useAmbient.getState().set(null)
    }
  }, [coverUrl])
}

/** 封面全屏铺底 + 渐变压暗至近实色——安卓 AmbientBackdrop 逐参数同款：
 *  1.4× Crop alpha 0.35 不重糊（放大自身柔化已足够）；渐变从不全不透明，
 *  页面底部仍留一丝色，底栏区域才不会像另一块底 */
export function AmbientBackdrop() {
  const coverUrl = useAmbient((s) => s.coverUrl)
  if (coverUrl === null) return null
  return (
    <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden" aria-hidden>
      <img
        src={coverUrl}
        alt=""
        className="absolute inset-0 h-full w-full scale-[1.4] object-cover opacity-35"
      />
      <div
        className="absolute inset-0"
        style={{
          background:
            "linear-gradient(180deg, rgba(14,14,17,0.55) 0%, rgba(14,14,17,0.82) 60%, rgba(14,14,17,0.96) 100%)",
        }}
      />
    </div>
  )
}
