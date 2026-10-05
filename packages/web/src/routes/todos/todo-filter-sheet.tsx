import { useCallback, useState } from "react"
import { ArrowLeft, Check, ChevronRight, X } from "lucide-react"
import type { Employee } from "@/lib/api"
import { activeFilterCount, type TodoFilters } from "@/lib/todos"
import { EmployeeAvatar } from "@/components/ui/employee-avatar"
import { TodoDialog } from "./todo-dialog"
import { DATE_OPTIONS, DUE_OPTIONS, SOURCE_OPTIONS, STATUS_OPTIONS } from "./filter-options"
import { useLabelRegistry } from "./use-todos"
import { sprintChoices, sprintFilterLabel, useSprints } from "./sprints/use-sprints"
import { projectFilterLabel, useProjects } from "@/hooks/use-projects"
import { splitProjectChoices } from "./projects/project-choices"
import { assigneeFilterLabel, OPERATOR_ASSIGNEE, UNASSIGNED_FILTER } from "./util"

type FilterPanel = "root" | "status" | "person" | "department" | "source" | "date" | "label" | "sprint" | "project" | "due"

const ROW_CLASS =
  "flex min-h-11 w-full min-w-0 items-center gap-3 rounded-[12px] px-3 text-left text-[length:var(--text-subheadline)] text-[var(--text-primary)] transition-[background-color,transform] active:scale-[0.96] hover:bg-[var(--fill-tertiary)]"

function Selection({ selected }: { selected: boolean }) {
  return <Check size={15} strokeWidth={2.5} className={`ml-auto flex-none text-[var(--accent)] ${selected ? "opacity-100" : "opacity-0"}`} aria-hidden />
}

export function TodoFilterSheet({
  filters,
  onChange,
  employees,
  departments,
  byName,
  onClose,
  hideStatus,
  hideDepartment,
  showLabelDue,
  onManageSprints,
}: {
  filters: TodoFilters
  onChange: (next: TodoFilters) => void
  employees: Employee[]
  departments: string[]
  byName: Map<string, Employee>
  onClose: () => void
  /** Board scopes own these dimensions (columns/segments = status, a
   *  department board = its department) — same scoping as FilterBar. */
  hideStatus?: boolean
  hideDepartment?: boolean
  /** Board contexts add the Label + Due dimensions (stage-A review F1/F5). */
  showLabelDue?: boolean
  /** Opens the sprint planner from the Sprint panel. */
  onManageSprints?: () => void
}) {
  const [panel, setPanel] = useState<FilterPanel>("root")
  // Every way out runs through the sheet's own exit first; the board is told to
  // drop it once the animation is over.
  const [leaving, setLeaving] = useState(false)
  const leave = useCallback(() => setLeaving(true), [])
  const labelRegistry = useLabelRegistry(!!showLabelDue)
  const sprints = useSprints(!!showLabelDue)
  const projects = useProjects(!!showLabelDue)
  const projectChoices = splitProjectChoices(projects.data)
  const title = panel === "root" ? "Filter" : panel.charAt(0).toUpperCase() + panel.slice(1)
  const choose = (next: TodoFilters) => {
    onChange(next)
    setPanel("root")
  }

  return (
    <TodoDialog
      label="Filter todos"
      open={!leaving}
      onRequestClose={leave}
      onClosed={onClose}
      testId="todo-filter-sheet"
      className="inset-x-0 bottom-0 flex max-h-[82vh] min-w-0 flex-col overflow-hidden rounded-t-[var(--radius-2xl)] bg-[var(--bg-secondary)] p-2 pb-[max(8px,env(safe-area-inset-bottom))] shadow-[var(--shadow-overlay)] motion-safe:data-[state=closed]:animate-sheet-out motion-safe:data-[state=open]:animate-sheet-in"
    >
      <div className="flex justify-center py-1.5">
        <span className="h-[5px] w-9 rounded-full bg-[var(--fill-primary)]" aria-hidden />
      </div>
      <div className="flex min-h-11 items-center gap-1 px-1">
        {panel !== "root" ? (
          <button type="button" aria-label="Back to filters" onClick={() => setPanel("root")} className="grid min-h-11 min-w-11 place-items-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--fill-tertiary)]">
            <ArrowLeft size={18} strokeWidth={1.9} aria-hidden />
          </button>
        ) : <span className="min-w-11" aria-hidden />}
        <h2 className="min-w-0 flex-1 text-center text-[length:var(--text-headline)] font-semibold text-[var(--text-primary)]">{title}</h2>
        <button type="button" aria-label="Close filters" onClick={leave} className="grid min-h-11 min-w-11 place-items-center rounded-full bg-[var(--fill-tertiary)] text-[var(--text-secondary)] hover:bg-[var(--fill-secondary)]">
          <X size={14} strokeWidth={2.2} aria-hidden />
        </button>
      </div>

      <div className="min-h-0 overflow-y-auto px-1 pb-2" data-scrollable>
        {panel === "root" && (
          <div className="flex flex-col gap-1">
            {([
              ["status", "Status", STATUS_OPTIONS.find((option) => option.value === filters.status)?.label ?? "Open"],
              ["person", "Person", assigneeFilterLabel(filters.assignee, byName) ?? "Anyone"],
              ["label", "Label", filters.label ?? "Any"],
              ["sprint", "Sprint", sprintFilterLabel(filters.sprint, sprints.data) ?? "Any"],
              ["project", "Project", (projects.data || filters.project === "none" ? projectFilterLabel(filters.project, projects.data) : undefined) ?? "Any"],
              ["due", "Due", DUE_OPTIONS.find((option) => option.value === filters.due)?.label ?? "Any"],
              ["department", "Department", filters.department ? filters.department.charAt(0).toUpperCase() + filters.department.slice(1) : "Any"],
              ["source", "Source", SOURCE_OPTIONS.find((option) => option.value === filters.source)?.label ?? "Any"],
              ["date", "Date", DATE_OPTIONS.find((option) => option.value === filters.date)?.label ?? "Any time"],
            ] as const).filter(([value]) =>
              !(hideStatus && value === "status")
              && !(hideDepartment && value === "department")
              && !(!showLabelDue && (value === "label" || value === "sprint" || value === "project" || value === "due")),
            ).map(([value, label, current]) => (
              <button key={value} type="button" aria-label={label} onClick={() => setPanel(value)} className={ROW_CLASS}>
                <span>{label}</span>
                <span className="ml-auto min-w-0 truncate text-[var(--text-tertiary)]">{current}</span>
                <ChevronRight size={15} className="flex-none text-[var(--text-quaternary)]" aria-hidden />
              </button>
            ))}
            {activeFilterCount(filters) > 0 && (
              <button type="button" onClick={() => choose({ status: "open" })} className={`${ROW_CLASS} mt-1 justify-center text-[var(--text-secondary)]`}>
                Clear all filters
              </button>
            )}
          </div>
        )}

        {panel === "status" && STATUS_OPTIONS.map((option) => (
          <button key={option.value} type="button" onClick={() => choose({ ...filters, status: option.value })} className={ROW_CLASS}>
            {option.label}<Selection selected={filters.status === option.value} />
          </button>
        ))}
        {panel === "person" && (
          <>
            <button type="button" onClick={() => choose({ ...filters, assignee: undefined })} className={ROW_CLASS}>
              Anyone<Selection selected={!filters.assignee} />
            </button>
            <button type="button" onClick={() => choose({ ...filters, assignee: OPERATOR_ASSIGNEE })} className={ROW_CLASS}>
              Assigned to me<Selection selected={filters.assignee === OPERATOR_ASSIGNEE} />
            </button>
            <button type="button" onClick={() => choose({ ...filters, assignee: UNASSIGNED_FILTER })} className={ROW_CLASS}>
              Unassigned<Selection selected={filters.assignee === UNASSIGNED_FILTER} />
            </button>
            {employees.map((employee) => (
              <button key={employee.name} type="button" onClick={() => choose({ ...filters, assignee: employee.name })} className={ROW_CLASS}>
                <EmployeeAvatar name={employee.name} size={22} fontSize={11} className="bg-[var(--fill-secondary)]" />
                {employee.displayName}<Selection selected={filters.assignee === employee.name} />
              </button>
            ))}
          </>
        )}
        {panel === "department" && (
          <>
            <button type="button" onClick={() => choose({ ...filters, department: undefined })} className={ROW_CLASS}>
              Any department<Selection selected={!filters.department} />
            </button>
            {departments.map((department) => (
              <button key={department} type="button" onClick={() => choose({ ...filters, department })} className={ROW_CLASS}>
                {department.charAt(0).toUpperCase() + department.slice(1)}<Selection selected={filters.department === department} />
              </button>
            ))}
          </>
        )}
        {panel === "source" && (
          <>
            <button type="button" onClick={() => choose({ ...filters, source: undefined })} className={ROW_CLASS}>
              Any source<Selection selected={!filters.source} />
            </button>
            {SOURCE_OPTIONS.map((option) => (
              <button key={option.value} type="button" onClick={() => choose({ ...filters, source: option.value })} className={ROW_CLASS}>
                {option.label}<Selection selected={filters.source === option.value} />
              </button>
            ))}
          </>
        )}
        {panel === "date" && DATE_OPTIONS.map((option) => (
          <button key={option.label} type="button" onClick={() => choose({ ...filters, date: option.value })} className={ROW_CLASS}>
            {option.label}<Selection selected={filters.date === option.value} />
          </button>
        ))}
        {panel === "label" && (
          <>
            <button type="button" onClick={() => choose({ ...filters, label: undefined })} className={ROW_CLASS}>
              Any label<Selection selected={!filters.label} />
            </button>
            {(labelRegistry.data ?? []).map((label) => (
              <button key={label.id} type="button" onClick={() => choose({ ...filters, label: label.name })} className={ROW_CLASS}>
                <span className="size-[5px] flex-none rounded-full" style={{ background: label.color ?? "var(--text-quaternary)" }} />
                {label.name}<Selection selected={filters.label === label.name || filters.label === label.id} />
              </button>
            ))}
          </>
        )}
        {panel === "sprint" && (
          <>
            <button type="button" onClick={() => choose({ ...filters, sprint: undefined })} className={ROW_CLASS}>
              Any sprint<Selection selected={!filters.sprint} />
            </button>
            <button type="button" onClick={() => choose({ ...filters, sprint: "active" })} className={ROW_CLASS}>
              Active sprint<Selection selected={filters.sprint === "active"} />
            </button>
            <button type="button" onClick={() => choose({ ...filters, sprint: "none" })} className={ROW_CLASS}>
              Not in a sprint<Selection selected={filters.sprint === "none"} />
            </button>
            {/* Open sprints, then the last five closed, as the desktop chip lists them. */}
            {sprintChoices(sprints.data).map((sprint) => (
              <button key={sprint.id} type="button" onClick={() => choose({ ...filters, sprint: sprint.id })} className={ROW_CLASS}>
                <span className="min-w-0 truncate">{sprint.name}</span>
                <span className="flex-none text-[12px] text-[var(--text-quaternary)]">{sprint.status}</span>
                <Selection selected={filters.sprint === sprint.id} />
              </button>
            ))}
            {onManageSprints && (
              <button type="button" onClick={() => { leave(); onManageSprints() }} className={`${ROW_CLASS} text-[var(--accent)]`}>
                Manage sprints…
              </button>
            )}
          </>
        )}
        {panel === "project" && (
          <>
            <button type="button" onClick={() => choose({ ...filters, project: undefined })} className={ROW_CLASS}>
              Any project<Selection selected={!filters.project} />
            </button>
            <button type="button" onClick={() => choose({ ...filters, project: "none" })} className={ROW_CLASS}>
              No project<Selection selected={filters.project === "none"} />
            </button>
            {/* Live projects by name, then the archived ones dimmed, as the desktop chip lists them. */}
            {[...projectChoices.live, ...projectChoices.archived].map((project) => (
              <button key={project.id} type="button" onClick={() => choose({ ...filters, project: project.id })} className={ROW_CLASS}>
                <span className={`min-w-0 truncate ${project.archived ? "text-[var(--text-quaternary)]" : ""}`}>{project.name}</span>
                {project.archived && <span className="flex-none text-[12px] text-[var(--text-quaternary)]">archived</span>}
                <Selection selected={filters.project === project.id} />
              </button>
            ))}
          </>
        )}
        {panel === "due" && DUE_OPTIONS.map((option) => (
          <button key={option.label} type="button" onClick={() => choose({ ...filters, due: option.value })} className={ROW_CLASS}>
            {option.label}<Selection selected={filters.due === option.value} />
          </button>
        ))}
      </div>
    </TodoDialog>
  )
}
