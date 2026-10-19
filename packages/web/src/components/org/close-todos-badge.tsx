import type { Employee } from "@/lib/api"

/** Shown on an employee the operator has granted `closeTodos` in their YAML. The
 *  grant is YAML-only, so this is read-only: there is nothing here to toggle. */
export function CloseTodosBadge({ closeTodos }: { closeTodos: Employee["closeTodos"] }) {
  if (closeTodos !== true) return null
  return (
    <span
      data-testid="close-todos-badge"
      title="Granted closeTodos in its YAML: may move a Todo to done, with a reason"
      className="whitespace-nowrap text-[length:var(--text-caption2)] font-[var(--weight-semibold)] px-[10px] py-[2px] rounded-[10px]"
      style={{ color: "var(--system-orange)", background: "color-mix(in srgb, var(--system-orange) 15%, transparent)" }}
    >
      Can close Todos
    </span>
  )
}
