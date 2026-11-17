/**
 * 通用列表组件：ListBody（Select + 鼠标 + 分页 + 空/载入/错误态）与
 * ListPane（ListBody + 边框标题壳）。SearchView 等自定义壳的视图直接用 ListBody。
 *
 * 焦点着色：focused → 边框 accent（红只给交互与激活）。
 * 鼠标换算沿用已验证的私有字段 cast（scrollOffset / linesPerItem，见 AGENTS）。
 *
 * register：把 {select, activate, itemAt} 暴露给 MainScreen——全局键
 * s（收藏）/ →（钻入）/ g/G（首尾行）经由它作用于「当前可见列表」。
 */
import { useEffect, useRef } from "react"
import type { MouseEvent, SelectOption, SelectRenderable } from "@opentui/core"
import { C } from "../theme.js"
import type { RowItem } from "../rows.js"


export interface ListHandle {
  select: SelectRenderable | null
  count: number
  activate: (index: number) => void
  itemAt: (index: number) => RowItem | null
}

export interface ListBodyProps {
  options: SelectOption[]
  focused: boolean
  interactive: boolean
  onActivate: (item: RowItem, index: number) => void
  onSelectionChange?: (index: number) => void
  initialSel?: number
  loading?: boolean
  error?: string
  empty?: string
  total?: number
  onNearEnd?: () => void
  register?: (handle: ListHandle | null) => void
}

export function ListBody(props: ListBodyProps) {
  const {
    options,
    focused,
    interactive,
    onActivate,
    onSelectionChange,
    initialSel,
    loading,
    error,
    empty,
    total,
    onNearEnd,
    register,
  } = props
  const selectRef = useRef<SelectRenderable | null>(null)

  // 每次渲染刷新句柄（闭包取最新 options）；挂载/卸载时注册/注销
  useEffect(() => {
    const handle: ListHandle = {
      get select() {
        return selectRef.current
      },
      get count() {
        return options.length
      },
      activate: (index: number) => {
        const item = options[index]?.value as RowItem | undefined
        if (item !== undefined) onActivate(item, index)
      },
      itemAt: (index: number): RowItem | null => {
        const item = options[index]?.value as RowItem | undefined
        return item ?? null
      },
    }
    register?.(handle)
    return () => register?.(null)
  })

  // 首次拿到数据时恢复选中行（列表是异步加载的——挂载时 options 还是空，
  // 直接 setSelectedIndex 会被后续 options 替换冲掉）
  const appliedSel = useRef(false)
  useEffect(() => {
    if (appliedSel.current || options.length === 0) return
    appliedSel.current = true
    if (initialSel !== undefined && initialSel > 0) selectRef.current?.setSelectedIndex(initialSel)
  }, [options.length, initialSel])

  const selectionChanged = (index: number): void => {
    onSelectionChange?.(index)
    if (
      onNearEnd !== undefined &&
      total !== undefined &&
      options.length < total &&
      index >= options.length - 3
    ) {
      onNearEnd()
    }
  }

  const indexAtY = (y: number): number => {
    const select = selectRef.current
    if (select === null || options.length === 0) return -1
    const rel = y - select.y
    if (rel < 0) return -1
    const internals = select as unknown as { scrollOffset: number; linesPerItem: number }
    const index = internals.scrollOffset + Math.floor(rel / internals.linesPerItem)
    return index >= 0 && index < options.length ? index : -1
  }

  return (
    <box
      style={{ flexGrow: 1, flexDirection: "column" }}
      onMouseDown={(event: MouseEvent) => {
        if (!interactive || event.button !== 0) return
        const index = indexAtY(event.y)
        if (index >= 0) {
          selectRef.current?.setSelectedIndex(index)
          selectionChanged(index)
          const item = options[index]?.value as RowItem | undefined
          if (item !== undefined) onActivate(item, index)
        }
      }}
      onMouseScroll={(event: MouseEvent) => {
        if (!interactive || !event.scroll || options.length === 0) return
        const select = selectRef.current
        if (select === null) return
        const step = event.scroll.direction === "up" ? -1 : 1
        const next = Math.min(options.length - 1, Math.max(0, select.getSelectedIndex() + step))
        if (next !== select.getSelectedIndex()) {
          select.setSelectedIndex(next)
          selectionChanged(next)
        }
      }}
    >
      {error !== undefined && error !== "" ? (
        <text fg={C.danger}>{error}</text>
      ) : loading ? (
        <text fg={C.faint}>加载中…</text>
      ) : options.length > 0 ? (
        <select
          ref={(r) => {
            selectRef.current = r
          }}
          focused={focused}
          options={options}
          onChange={(index: number) => selectionChanged(index)}
          onSelect={(index: number) => {
            const item = options[index]?.value as RowItem | undefined
            if (item !== undefined) onActivate(item, index)
          }}
          style={{
            height: "100%",
            selectedBackgroundColor: C.raised,
            selectedTextColor: C.paper,
            descriptionColor: C.faint,
            showSelectionIndicator: false,
          }}
          showScrollIndicator
          wrapSelection
        />
      ) : (
        <text fg={C.faint}>{empty ?? "没有内容"}</text>
      )}
    </box>
  )
}

export interface ListPaneProps extends ListBodyProps {
  title: string
}

/** 带边框标题的完整面板（大多数视图直接用它） */
export function ListPane(props: ListPaneProps) {
  const { title, ...body } = props
  return (
    <box
      title={title}
      style={{
        flexGrow: 1,
        flexDirection: "column",
        border: true,
        borderColor: body.focused ? C.accent : C.line,
      }}
    >
      <ListBody {...body} />
    </box>
  )
}
