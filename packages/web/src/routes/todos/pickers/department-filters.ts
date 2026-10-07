import type { DepartmentSummaryWire } from "@/lib/api"

/* JIN-1 — department rows under a configured `gateway.todoDepartments`, where
 * the gateway marks every other registered department `selectable: false`; an
 * archived department is unselectable the same way, policy or not.
 * Callers hand the SAME list to DepartmentPickerContent and to their row-index
 * math, so the current row always superimposes on the anchor. */

/** The rows a department picker offers: an unselectable department only when
 *  the Todo already sits in it, so the current value still reads. */
export function offeredDepartments(departments: DepartmentSummaryWire[], current: string | null): DepartmentSummaryWire[] {
  return departments.filter((dept) => dept.selectable !== false || dept.slug === current)
}

/** The department a new Todo may start in. A legacy board — or any board URL
 *  segment, registered or not — still opens the create dialog with its slug;
 *  one the gateway would refuse becomes none, so the server's configured
 *  default applies instead of a 400. A policy is visible as any unselectable row
 *  that is not merely archived; with open departments every unregistered slug stays. */
export function creatableDepartment(departments: DepartmentSummaryWire[], slug: string | undefined): string | null {
  if (!slug) return null
  const row = departments.find((dept) => dept.slug === slug)
  const closed = departments.some((dept) => dept.selectable === false && dept.archived !== true)
  return row?.selectable === false || (closed && !row) ? null : slug
}
