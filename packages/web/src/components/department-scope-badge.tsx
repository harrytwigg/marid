import { Lock, ShieldHalf } from "lucide-react"
import { isConfined, type DepartmentScopeWire } from "@/lib/department-api"

/* A department's scope, as a small pill. Open departments show nothing, so an
 * instance with no department.yaml looks exactly as it did before. "Scoped" is the
 * department's own members being confined to it; "Dedicated" also keeps everyone
 * else from holding its Todos. */

const LABELS = {
  scoped: { text: "Scoped", hint: "Its employees work only inside this department. Everyone else can still read it and hold its Todos.", Icon: ShieldHalf, tone: "var(--system-blue)" },
  dedicated: { text: "Dedicated", hint: "Its employees work only inside this department, and only they can hold its Todos.", Icon: Lock, tone: "var(--system-orange)" },
} as const

export function DepartmentScopeBadge({ scope, className = "" }: { scope: DepartmentScopeWire | undefined; className?: string }) {
  if (!isConfined(scope)) return null
  const { text, hint, Icon, tone } = LABELS[scope]
  return (
    <span
      data-testid="department-scope-badge"
      data-scope={scope}
      title={hint}
      className={`inline-flex flex-none items-center gap-1 rounded-full px-2 py-px text-[length:var(--text-caption2)] font-[var(--weight-semibold)] uppercase tracking-[0.04em] ${className}`}
      style={{ color: tone, background: `color-mix(in srgb, ${tone} 14%, transparent)` }}
    >
      <Icon size={10} strokeWidth={2.4} aria-hidden />
      {text}
    </span>
  )
}
