import { useEffect, useState } from "react"
import { ChevronDown } from "@/components/ui/icon"

/* The New Todo dialog's property chips and the width at which its pickers become sheets. */

const MOBILE_QUERY = "(max-width: 700px)"

export function useIsCreateMobile(): boolean {
  const [mobile, setMobile] = useState(
    () => typeof window !== "undefined" && (window.matchMedia?.(MOBILE_QUERY).matches ?? false),
  )
  useEffect(() => {
    const query = window.matchMedia?.(MOBILE_QUERY)
    if (!query) return
    const onChange = (event: MediaQueryListEvent) => setMobile(event.matches)
    query.addEventListener("change", onChange)
    return () => query.removeEventListener("change", onChange)
  }, [])
  return mobile
}

export function PropertyChip({
  icon,
  label,
  testId,
  active,
  onClick,
  children,
}: {
  icon: React.ReactNode
  label: React.ReactNode
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
        className={`focus-outline inline-flex min-h-9 items-center gap-1.5 rounded-full px-2.5 text-[12px] font-medium outline-none transition-colors ${
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

