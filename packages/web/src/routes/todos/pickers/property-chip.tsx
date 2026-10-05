import { ChevronDown } from "lucide-react"

/* The create dialog's property chips: a pill that names the current value and
 * opens that property's picker. */

export function PropertyChip({
  icon,
  label,
  testId,
  active,
  onClick,
  children,
}: {
  icon: React.ReactNode
  label: string
  testId: string
  active?: boolean
  onClick: () => void
  children?: React.ReactNode
}) {
  return (
    <span className="relative">
      <button
        type="button"
        data-testid={testId}
        aria-expanded={active || undefined}
        onClick={onClick}
        className={`focus-ring inline-flex min-h-9 items-center gap-1.5 rounded-full px-2.5 text-[12px] font-medium outline-none transition-colors ${
          active
            ? "bg-[var(--accent-fill)] text-[var(--accent)]"
            : "bg-[var(--fill-tertiary)] text-[var(--text-secondary)] hover:bg-[var(--fill-secondary)]"
        }`}
      >
        {icon}
        <span>{label}</span>
        <ChevronDown size={11} aria-hidden className="opacity-60" />
      </button>
      {children}
    </span>
  )
}
