import type { ReactNode } from "react"

/** 主操作用反色实底；蓝色保留给链接、焦点与选中态。 */
export const btnPlay =
  "inline-flex min-h-10 items-center justify-center gap-2 bg-paper px-4 text-sm font-medium text-shell hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-45"

export const btnQuiet =
  "inline-flex min-h-10 items-center gap-2 border border-line bg-shell px-3 text-sm text-paper transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"

export const btnDangerGhost =
  "text-xs text-faint transition-colors hover:text-danger disabled:opacity-40"

export const inputClass =
  "h-10 rounded-md border border-line bg-shell px-3 text-sm text-paper placeholder:text-faint outline-none transition-colors focus:border-accent/60"

export function PageHeader({
  title,
  level = 1,
  count,
  children,
}: {
  title: string
  level?: 1 | 2
  count?: number | undefined
  children?: ReactNode
}) {
  const Heading = level === 1 ? "h1" : "h2"
  return (
    <header className="catalog-heading">
      <Heading>
        {title}
      </Heading>
      {count !== undefined && (
        <span className="tnum text-xs text-faint">{count}</span>
      )}
      {children !== undefined && (
        <div className="heading-tools">{children}</div>
      )}
    </header>
  )
}

export function SortTabs({
  sorts,
  value,
  onChange,
}: {
  sorts: ReadonlyArray<{ key: string; label: string }>
  value: string
  onChange: (key: string) => void
}) {
  return (
    <div
      role="tablist"
      className="catalog-tabs"
    >
      {sorts.map((sort) => (
        <button
          key={sort.key}
          type="button"
          role="tab"
          aria-selected={value === sort.key}
          onClick={() => onChange(sort.key)}
        >
          {sort.label}
        </button>
      ))}
    </div>
  )
}
