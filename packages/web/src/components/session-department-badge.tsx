import { ShieldHalf } from "lucide-react"

/* The department a scoped employee's session is bound to, as a small pill beside
 * the session's title. Sessions that are not bound show nothing, so an instance
 * with no scoped department looks exactly as it did before. It truncates before
 * it pushes the title or the time off a phone-width row. */

export function SessionDepartmentBadge({ department, className = "" }: { department: string | null | undefined; className?: string }) {
  if (!department) return null
  const tone = "var(--system-blue)"
  return (
    <span
      data-testid="session-department-badge"
      title={`Bound to department ${department}: this session works only inside it`}
      className={`inline-flex min-w-0 max-w-[7.5rem] flex-none items-center gap-1 rounded-full px-2 py-px text-[length:var(--text-caption2)] font-[var(--weight-semibold)] tracking-[0.02em] ${className}`}
      style={{ color: tone, background: `color-mix(in srgb, ${tone} 14%, transparent)` }}
    >
      <ShieldHalf size={10} strokeWidth={2.4} aria-hidden className="flex-none" />
      <span className="truncate">{department}</span>
    </span>
  )
}
