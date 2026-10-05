import type { TodoFilters } from "@/lib/todos"
import { ValueChip } from "../filter-chips"
import { SprintFilterItems } from "./sprint-filter-items"
import { sprintFilterLabel, useSprints } from "./use-sprints"

/* The board's Sprint chip: the value chip and its menu, with the sprint
 * registry read here so the filter bar does not carry it. */

export function SprintFilterChip({ filters, onChange, onManage, itemClassName }: {
  filters: TodoFilters
  onChange: (next: TodoFilters) => void
  /** Opens the sprint planner; the menu's last row. */
  onManage?: () => void
  itemClassName: string
}) {
  const sprints = useSprints()
  return (
    <ValueChip label="Sprint" set={!!filters.sprint} display={sprintFilterLabel(filters.sprint, sprints.data)} testId="filter-chip-sprint">
      <SprintFilterItems
        value={filters.sprint}
        sprints={sprints.data}
        onChoose={(sprint) => onChange({ ...filters, sprint })}
        onManage={onManage}
        itemClassName={itemClassName}
      />
    </ValueChip>
  )
}
