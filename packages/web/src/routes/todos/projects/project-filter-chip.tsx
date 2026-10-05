import { DropdownMenuItem, DropdownMenuLabel } from "@/components/ui/dropdown-menu"
import type { ProjectWire } from "@/lib/project-api"
import type { TodoFilters } from "@/lib/todos"
import { useProjects, projectFilterLabel } from "@/hooks/use-projects"
import { MenuCheck, ValueChip } from "../filter-chips"
import { splitProjectChoices } from "./project-choices"

/* The board's Project chip: any project, Todos in no project, each live
 * project by name, then the archived ones, dimmed, so an old project's Todos
 * stay reachable. */

/** What the chip reads once set. An id is not named until the registry has loaded, so it never flashes "Unknown project". */
function chipDisplay(value: string | undefined, projects: ProjectWire[] | undefined): string | undefined {
  return value === "none" || projects ? projectFilterLabel(value, projects) : undefined
}

export function ProjectFilterChip({ filters, onChange, itemClassName }: {
  filters: TodoFilters
  onChange: (next: TodoFilters) => void
  itemClassName: string
}) {
  const projects = useProjects()
  const { live, archived } = splitProjectChoices(projects.data)
  const choose = (project: string | undefined) => onChange({ ...filters, project })
  return (
    <ValueChip
      label="Project"
      set={!!filters.project}
      display={chipDisplay(filters.project, projects.data)}
      testId="filter-chip-project"
    >
      <DropdownMenuItem className={itemClassName} onClick={() => choose(undefined)}>
        Any project<MenuCheck on={!filters.project} />
      </DropdownMenuItem>
      <DropdownMenuItem className={itemClassName} data-testid="filter-project-none" onClick={() => choose("none")}>
        No project<MenuCheck on={filters.project === "none"} />
      </DropdownMenuItem>
      {live.map((project) => (
        <DropdownMenuItem key={project.id} className={itemClassName} data-testid={`filter-project-${project.id}`} onClick={() => choose(project.id)}>
          <span className="truncate">{project.name}</span>
          <MenuCheck on={filters.project === project.id} />
        </DropdownMenuItem>
      ))}
      {archived.length > 0 && (
        <DropdownMenuLabel className="px-3 pb-1 pt-2 text-[length:var(--text-caption1)] font-semibold uppercase tracking-[0.06em] text-[var(--text-tertiary)]">
          Archived
        </DropdownMenuLabel>
      )}
      {archived.map((project) => (
        <DropdownMenuItem key={project.id} className={itemClassName} data-testid={`filter-project-${project.id}`} onClick={() => choose(project.id)}>
          <span className="truncate text-[var(--text-quaternary)]">{project.name}</span>
          <MenuCheck on={filters.project === project.id} />
        </DropdownMenuItem>
      ))}
    </ValueChip>
  )
}
