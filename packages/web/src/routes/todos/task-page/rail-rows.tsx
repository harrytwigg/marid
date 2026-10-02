import { forwardRef } from "react"
import { ChevronDown } from "lucide-react"

/* The rail's shared row vocabulary, lifted out of props-rail.tsx when that file
 * reached the 300-line limit. Rows are flat at rest; interactive rows wash on
 * hover and grow a trailing chevron (design-doc §7.3), and keep the wash while
 * their picker is open. */

export function RailKicker({ children, later }: { children: React.ReactNode; later?: boolean }) {
  return <div className={`mb-1 text-[13px] font-semibold text-[var(--text-tertiary)] ${later ? "mt-8" : ""}`}>{children}</div>
}

/** One rail row. Interactive rows are buttons (tabbable, Enter/Space opens);
 *  read-only rows render without the hover affordance (§7.3). The open state
 *  keeps the wash + chevron while a picker superimposes the row. */
export const RailRow = forwardRef<HTMLButtonElement, {
  children: React.ReactNode
  quiet?: boolean
  onOpen?: () => void
  open?: boolean
  testId?: string
  label?: string
}>(function RailRow({ children, quiet, onOpen, open, testId, label }, ref) {
  const base = "relative -mx-2.5 flex min-h-[34px] items-center gap-[9px] rounded-[9px] px-2.5 text-[13.5px] font-medium"
  const ink = quiet ? "text-[var(--text-secondary)]" : "text-[var(--text-primary)]"
  if (!onOpen) {
    return (
      <div data-testid={testId} className={`${base} ${ink} cursor-default`}>
        {children}
      </div>
    )
  }
  return (
    <button
      ref={ref}
      type="button"
      data-testid={testId}
      aria-label={label}
      aria-haspopup="menu"
      aria-expanded={open || false}
      onClick={onOpen}
      className={`${base} ${ink} focus-ring group/rail w-[calc(100%+20px)] text-left outline-none hover:bg-[var(--fill-quaternary)] ${
        open ? "bg-[var(--fill-quaternary)]" : ""
      }`}
    >
      {children}
      <ChevronDown
        size={11}
        strokeWidth={2.2}
        aria-hidden
        className={`ml-auto flex-none text-[var(--text-quaternary)] transition-opacity duration-120 ${
          open ? "opacity-100" : "opacity-0 group-hover/rail:opacity-100"
        }`}
      />
    </button>
  )
})

/** Rail priority bars: always rendered (unlike cards), emphasis by level. */
export function RailPriorityBars({ priority }: { priority: number }) {
  const strong = priority >= 3
  const low = priority <= 1
  const color = strong ? "var(--text-secondary)" : "var(--text-tertiary)"
  return (
    <span aria-hidden className="relative top-[-0.5px] flex w-4 flex-none items-end gap-[1.5px]" style={{ height: 10 }}>
      {[4, 7, 10].map((h, i) => (
        <i key={h} className="block w-[2.5px] rounded-[1px]" style={{ height: h, background: color, opacity: low && i > 0 ? 0.35 : 1 }} />
      ))}
    </span>
  )
}

export function formatDueLong(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" })
}
