import type { Employee } from "@/lib/api"
import { displayNameOf } from "./util"

/** "for <employee>": a Todo in review that waits on the employee who owns its
 *  parent, not on the operator. */
export function ReviewForChip({ employee, byName }: { employee: string; byName: Map<string, Employee> }) {
  return (
    <span
      data-testid="review-for-chip"
      className="flex-none rounded-full bg-[var(--fill-tertiary)] px-2 text-[10.5px] font-medium leading-[18px] text-[var(--text-secondary)]"
    >
      for {displayNameOf(employee, byName)}
    </span>
  )
}
