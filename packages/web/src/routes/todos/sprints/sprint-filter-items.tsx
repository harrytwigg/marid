import { Check } from "lucide-react"
import { DropdownMenuItem, DropdownMenuLabel } from "@/components/ui/dropdown-menu"
import type { SprintWire } from "@/lib/sprint-api"

/* The board's Sprint chip menu: any sprint, the running one (which follows
 * the sprint as sprints roll over, so it is the one to bookmark), Todos in no
 * sprint, each open sprint, the last few closed ones, and the way into the
 * planner. */

function MenuCheck({ on }: { on: boolean }) {
  return <Check size={14} strokeWidth={2.6} className={`ml-auto ${on ? "text-[var(--accent)]" : "opacity-0"}`} aria-hidden />
}

export function SprintFilterItems({ value, sprints, onChoose, onManage, itemClassName }: {
  value: string | undefined
  sprints: SprintWire[] | undefined
  onChoose: (sprint: string | undefined) => void
  onManage?: () => void
  itemClassName: string
}) {
  const open = (sprints ?? []).filter((sprint) => sprint.status !== "closed")
  const closed = (sprints ?? []).filter((sprint) => sprint.status === "closed").slice(0, 5)
  return (
    <>
      <DropdownMenuItem className={itemClassName} onClick={() => onChoose(undefined)}>
        Any sprint<MenuCheck on={!value} />
      </DropdownMenuItem>
      <DropdownMenuItem className={itemClassName} data-testid="filter-sprint-active" onClick={() => onChoose("active")}>
        Active sprint<MenuCheck on={value === "active"} />
      </DropdownMenuItem>
      <DropdownMenuItem className={itemClassName} onClick={() => onChoose("none")}>
        Not in a sprint<MenuCheck on={value === "none"} />
      </DropdownMenuItem>
      {open.map((sprint) => (
        <DropdownMenuItem key={sprint.id} className={itemClassName} data-testid={`filter-sprint-${sprint.id}`} onClick={() => onChoose(sprint.id)}>
          <span className="truncate">{sprint.name}</span>
          <span className="text-[11px] text-[var(--text-quaternary)]">{sprint.status}</span>
          <MenuCheck on={value === sprint.id} />
        </DropdownMenuItem>
      ))}
      {closed.length > 0 && (
        <DropdownMenuLabel className="px-3 pb-1 pt-2 text-[length:var(--text-caption1)] font-semibold uppercase tracking-[0.06em] text-[var(--text-tertiary)]">
          Closed
        </DropdownMenuLabel>
      )}
      {closed.map((sprint) => (
        <DropdownMenuItem key={sprint.id} className={itemClassName} onClick={() => onChoose(sprint.id)}>
          <span className="truncate text-[var(--text-secondary)]">{sprint.name}</span>
          <MenuCheck on={value === sprint.id} />
        </DropdownMenuItem>
      ))}
      {onManage && (
        <DropdownMenuItem className={`${itemClassName} mt-1 text-[var(--accent)]`} data-testid="filter-sprint-manage" onClick={onManage}>
          Manage sprints…
        </DropdownMenuItem>
      )}
    </>
  )
}
