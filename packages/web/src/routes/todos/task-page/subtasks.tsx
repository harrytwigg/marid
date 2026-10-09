import { useState } from "react"
import { ChevronDown, Plus } from "lucide-react"
import type { Employee, WorkItemStatusWire, WorkItemTreeNodeWire } from "@/lib/api"
import { PendingSubTaskRow, SubTaskRow } from "./subtask-row"
import { PENDING_SUBTASK_PREFIX } from "./use-subtask-mutations"
import type { OpenTodoFromClick } from "./task-frame"

/* Todos v2 slice 6 — the task page's sub-tasks section (design-doc §7.2.8,
 * mock task-detail.html). ICI-1437 gives the group Linear's shape: the header
 * is a disclosure carrying the subtree count and the `+`, and the `+` opens an
 * inline field at the BOTTOM of the list rather than a dialog. The header
 * survives an empty list, so `+` stays reachable on a Todo with no children.
 * Depth cap: no `+` and no field at depth 3 — the caption explains instead. */

const DEPTH_CAP = 3

/** Closed/total over ALL descendants (self excluded) — the roll-up numbers. */
function subtreeCounts(node: WorkItemTreeNodeWire | undefined): { total: number; done: number } {
  let total = 0
  let done = 0
  const walk = (children: WorkItemTreeNodeWire[]) => {
    for (const child of children) {
      total += 1
      if (child.status === "done" || child.status === "cancelled") done += 1
      walk(child.children ?? [])
    }
  }
  walk(node?.children ?? [])
  return { total, done }
}

export function SubTasksSection({
  node,
  parentDepth,
  employees,
  mobile,
  onOpenChild,
  onChildStatus,
  onChildAssign,
  onAddSubTask,
}: {
  node: WorkItemTreeNodeWire | undefined
  parentDepth: number
  employees: Employee[]
  byName: Map<string, Employee>
  mobile: boolean
  onOpenChild: OpenTodoFromClick
  onChildStatus: (childId: string, status: WorkItemStatusWire, cascade?: boolean) => void
  onChildAssign: (childId: string, assignee: string) => void
  onAddSubTask: (title: string) => void
}) {
  const children = node?.children ?? []
  // Counts cover the whole SUBTREE (the board's 2/5 roll-up counts descendants
  // too); the rows list direct children — deeper levels wear "N sub" badges.
  const { total, done } = subtreeCounts(node)
  const atCap = parentDepth >= DEPTH_CAP
  const [expanded, setExpanded] = useState(true)
  const [adding, setAdding] = useState(false)
  const [title, setTitle] = useState("")
  const [openFor, setOpenFor] = useState<{ id: string; kind: "status" | "assign" } | null>(null)

  // At the cap an empty group can offer nothing at all, so it stays out of the
  // document entirely rather than heading a list nobody can add to.
  if (children.length === 0 && atCap) return null

  const closeField = () => {
    setTitle("")
    setAdding(false)
  }
  /** Creates when there is something to create, and says whether it did — the
   *  field stays open after Enter so the next sub-task can follow straight on. */
  const create = () => {
    const text = title.trim()
    if (!text) return false
    setTitle("")
    onAddSubTask(text)
    return true
  }

  return (
    <section data-testid="task-subtasks">
      <div className="mb-3 mt-8 flex min-h-[34px] items-center gap-1">
        <button
          type="button"
          aria-expanded={expanded}
          data-testid="subtasks-toggle"
          onClick={() => {
            if (expanded) closeField()
            setExpanded(!expanded)
          }}
          className="focus-ring -ml-1.5 flex min-h-[34px] min-w-0 items-center gap-2 rounded-[var(--radius-sm)] px-1.5 text-left text-[11px] font-semibold uppercase tracking-[.15em] text-[var(--text-secondary)] outline-none"
          style={{ fontFamily: "var(--font-code)" }}
        >
          <ChevronDown
            size={13}
            aria-hidden
            className={`flex-none text-[var(--text-quaternary)] transition-transform duration-150 ${expanded ? "" : "-rotate-90"}`}
          />
          Sub-tasks
          <span
            data-testid="subtasks-count"
            className="font-normal tabular-nums tracking-[.02em] text-[var(--text-tertiary)]"
          >
            {total}
          </span>
          {done > 0 && (
            <span
              data-testid="subtasks-done"
              className="ml-1 font-normal normal-case tracking-[.02em] text-[var(--text-quaternary)]"
            >
              {done} of {total} done
            </span>
          )}
        </button>
        {!atCap && (
          <button
            type="button"
            aria-label="Add sub-task"
            data-testid="subtask-add"
            onClick={() => {
              setExpanded(true)
              setAdding(true)
            }}
            className="focus-ring grid size-9 flex-none place-items-center rounded-full text-[var(--text-quaternary)] outline-none transition-[background-color,color,scale] duration-150 hover:bg-[var(--fill-secondary)] hover:text-[var(--text-secondary)] active:scale-[0.96]"
          >
            <Plus size={15} strokeWidth={2.2} aria-hidden />
          </button>
        )}
      </div>

      {expanded && (
        <>
          {total > 0 && (
            <div className="mb-2 flex items-center gap-2.5">
              <span className="h-[3px] w-full max-w-[220px] overflow-hidden rounded-[2px] bg-[var(--fill-secondary)]" aria-hidden>
                <span
                  className="block h-full rounded-[2px] bg-[var(--system-green)] transition-[width] duration-300"
                  style={{ width: `${Math.round((done / total) * 100)}%` }}
                  data-testid="subtasks-progress"
                />
              </span>
            </div>
          )}
          <div data-testid="subtask-list">
            {children.map((child) =>
              child.id.startsWith(PENDING_SUBTASK_PREFIX) ? (
                <PendingSubTaskRow key={child.id} title={child.title} />
              ) : (
                <SubTaskRow
                  key={child.id}
                  child={child}
                  employees={employees}
                  mobile={mobile}
                  picking={openFor?.id === child.id ? openFor.kind : null}
                  onPick={(kind) => setOpenFor(kind ? { id: child.id, kind } : null)}
                  onOpenChild={onOpenChild}
                  onChildStatus={onChildStatus}
                  onChildAssign={onChildAssign}
                />
              ),
            )}
            {adding && (
              <div
                data-testid="subtask-add-row"
                className="-mx-2.5 flex min-h-9 items-center px-2.5 py-[5px] motion-safe:animate-capture-step-in"
              >
                <Plus size={12} strokeWidth={2.2} aria-hidden className="mr-4 flex-none text-[var(--text-quaternary)]" />
                <input
                  autoFocus
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !create()) closeField()
                    if (e.key === "Escape") closeField()
                  }}
                  onBlur={() => {
                    create()
                    closeField()
                  }}
                  placeholder="Sub-task title"
                  aria-label="New sub-task title"
                  data-testid="subtask-add-input"
                  className="min-w-0 flex-1 bg-transparent text-[14px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-quaternary)]"
                />
              </div>
            )}
          </div>
          {atCap && (
            <p className="py-1 text-[12px] text-[var(--text-quaternary)]" data-testid="subtask-depth-cap">
              Deepest level — sub-tasks nest three levels.
            </p>
          )}
        </>
      )}
    </section>
  )
}
