import { Check, ChevronDown, X } from "lucide-react"
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"

/* The filter row's chips, split out of filter-bar.tsx: the list view's removable
 * active chip, and the board row's value chip (a dimension that opens its own
 * menu) and removable active chip. */

/** The accent tick a menu row wears when it is the current choice. */
export function MenuCheck({ on }: { on: boolean }) {
  return <Check size={14} strokeWidth={2.6} className={`ml-auto ${on ? "text-[var(--accent)]" : "opacity-0"}`} aria-hidden />
}

export const SUBMENU_CLASS =
  "max-h-[min(420px,70vh)] min-w-[220px] overflow-y-auto rounded-[var(--radius-lg)] border-0 bg-[var(--material-thick)] p-1.5 shadow-[var(--shadow-overlay)] backdrop-blur-xl"

export function ActiveChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <button
      type="button"
      aria-label={`Remove ${label}`}
      onClick={onRemove}
      className="inline-flex min-h-11 items-center gap-1.5 rounded-full bg-[var(--accent-fill)] px-3 text-[length:var(--text-footnote)] font-medium text-[var(--accent)] transition-colors hover:bg-[var(--fill-secondary)]"
    >
      {label}
      <X size={12} strokeWidth={2.4} aria-hidden />
    </button>
  )
}

/* ── Board filter row (mock board.html .filters — stage-A review F1) ────────
 * Quiet value-carrying chips left (Assignee · Label · Sprint · Due), a ⋯ menu for the
 * remaining grammar (Source, Date, Department where scoped in), compact
 * right-aligned search. A SET chip turns accent (the mock's .chip.set) — the
 * chip itself is the active state for its dimension. */

export function ValueChip({
  label,
  display,
  set,
  testId,
  children,
}: {
  label: string
  /** What the chip reads when set; falls back to the dimension name. */
  display?: React.ReactNode
  set: boolean
  testId: string
  children: React.ReactNode
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={label}
          data-testid={testId}
          className={`focus-ring flex h-[30px] flex-none items-center gap-1.5 rounded-[15px] px-3 text-[13px] font-medium outline-none transition-colors ${
            set
              ? "bg-[var(--accent-fill)] text-[var(--accent)]"
              : "bg-[var(--fill-tertiary)] text-[var(--text-secondary)] hover:bg-[var(--fill-secondary)]"
          }`}
        >
          {set && display != null ? display : label}
          <ChevronDown
            size={10}
            strokeWidth={2.4}
            className={set ? "opacity-70" : "text-[var(--text-quaternary)]"}
            aria-hidden
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className={SUBMENU_CLASS}>
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function BoardActiveChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <button
      type="button"
      aria-label={`Remove ${label}`}
      onClick={onRemove}
      className="focus-ring flex h-[30px] flex-none items-center gap-1.5 rounded-[15px] bg-[var(--accent-fill)] px-3 text-[13px] font-medium text-[var(--accent)] outline-none transition-colors hover:bg-[var(--fill-secondary)]"
    >
      {label}
      <X size={11} strokeWidth={2.4} aria-hidden />
    </button>
  )
}
