import { CalendarRange } from "lucide-react"
import type { SprintWire } from "@/lib/sprint-api"
import { operatorSafeTodoError } from "@/lib/todos"
import { resolveSprintFilter, sprintDates, useSprints, useStartSprint } from "./use-sprints"

/* The line under the filter row while the board is scoped to a sprint: which
 * sprint, its dates and goal, how much of it is still open, and the one
 * lifecycle move that fits its state — Start for a planned sprint, Complete for
 * the running one. Scoped to `active` with nothing running, it says so instead
 * of showing an empty board with no explanation. */

const BUTTON_CLASS =
  "focus-ring inline-flex h-[28px] flex-none items-center rounded-full px-3 text-[12px] font-medium outline-none transition-colors"
const ACCENT_CLASS = `${BUTTON_CLASS} bg-[var(--accent-fill)] text-[var(--accent)] hover:bg-[var(--fill-secondary)] disabled:opacity-50`
const QUIET_CLASS = `${BUTTON_CLASS} bg-[var(--fill-tertiary)] text-[var(--text-secondary)] hover:bg-[var(--fill-secondary)]`

export function SprintStrip({ filter, onManage, onComplete }: {
  filter: string
  onManage: () => void
  onComplete: (sprintId: string) => void
}) {
  const sprints = useSprints()
  if (filter === "none" || !sprints.data) return null
  const sprint = resolveSprintFilter(sprints.data, filter)
  const running = sprints.data.find((s) => s.status === "active")

  return (
    <div
      data-testid="sprint-strip"
      className="mt-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 text-[length:var(--text-footnote)] text-[var(--text-secondary)]"
    >
      <CalendarRange size={14} aria-hidden className="flex-none text-[var(--text-tertiary)]" />
      {sprint ? <SprintSummary sprint={sprint} /> : (
        <span>{filter === "active" ? "No sprint is running." : "That sprint no longer exists."}</span>
      )}
      <span className="flex-1" />
      {sprint && <SprintLifecycleButton sprint={sprint} running={running} onComplete={onComplete} />}
      <button type="button" data-testid="sprint-strip-manage" onClick={onManage} className={QUIET_CLASS}>
        Sprints
      </button>
    </div>
  )
}

/** Start for a planned sprint (held while another runs), Complete for the running one. */
function SprintLifecycleButton({ sprint, running, onComplete }: {
  sprint: SprintWire
  running: SprintWire | undefined
  onComplete: (sprintId: string) => void
}) {
  const start = useStartSprint()
  if (sprint.status === "active") {
    return (
      <button type="button" data-testid="sprint-strip-complete" onClick={() => onComplete(sprint.id)} className={ACCENT_CLASS}>
        Complete sprint…
      </button>
    )
  }
  if (sprint.status !== "planned") return null
  return (
    <>
      <button
        type="button"
        data-testid="sprint-strip-start"
        disabled={!!running || start.isPending}
        title={running ? `Complete "${running.name}" first` : undefined}
        onClick={() => start.mutate(sprint.id)}
        className={ACCENT_CLASS}
      >
        Start sprint
      </button>
      {start.isError && (
        <span role="alert" className="basis-full text-[var(--system-red)]">
          {operatorSafeTodoError(start.error, "Couldn't start the sprint")}
        </span>
      )}
    </>
  )
}

const STATE_LABEL: Record<SprintWire["status"], string> = { active: "Active", planned: "Planned", closed: "Closed" }

function SprintSummary({ sprint }: { sprint: SprintWire }) {
  const dates = sprintDates(sprint)
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="truncate font-semibold text-[var(--text-primary)]">{sprint.name}</span>
      <span className="flex-none rounded-full bg-[var(--fill-tertiary)] px-2 py-px text-[11px] font-medium text-[var(--text-secondary)]">
        {STATE_LABEL[sprint.status]}
      </span>
      {dates && <span className="flex-none tabular-nums">{dates}</span>}
      <span className="flex-none tabular-nums text-[var(--text-tertiary)]">
        {sprint.open} open of {sprint.total}
      </span>
      {sprint.goal && <span className="min-w-0 truncate text-[var(--text-tertiary)]" title={sprint.goal}>{sprint.goal}</span>}
    </span>
  )
}
