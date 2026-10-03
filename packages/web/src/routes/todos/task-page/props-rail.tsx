import { ArrowUpRight, Calendar, LoaderCircle, Send, UserRound } from "lucide-react"
import type { DepartmentSummaryWire, Employee, LinkedSessionWire, WorkItemDetailWire } from "@/lib/api"
import { STATUS_LABEL, priorityLabel } from "@/lib/todos"
import { EmployeeAvatar } from "@/components/ui/employee-avatar"
import { StatusCircle } from "../state-glyph"
import { sessionIdFromActor, type SessionTreeWire } from "@/lib/session-tree-api"
import { SessionRef } from "./session-ref"
import { SessionTreePanel } from "./session-tree"
import { LabelChip, RemoveButton } from "./label-chip"
import { RailKicker, RailRow, RailPriorityBars, formatDueLong } from "./rail-rows"
import { AutoStartRow } from "./auto-start-row"
import { SprintRailRow } from "../sprints/sprint-rail-row"
import { displayNameOf, formatRelativeTime } from "../util"

/* Todos v2 slice 6 — the chrome-free properties rail (design-doc §7.2/§7.3,
 * mock task-detail.html). No inset boxes: quiet rows on the page surface, the
 * whitespace is the design. Rows are flat at rest; interactive rows wash on
 * hover and grow a trailing chevron (120ms) — the whole row is the click
 * target, and while its popover is open the row keeps the wash (anchored
 * state, polish law 1). Rail rhythm: top pad 8, group gap 32 (law 10). */


export interface RailPickers {
  /** Task 6 mounts the picker surfaces here, keyed by row. Absent = read row. */
  status?: React.ReactNode
  rowFor?: (row: "status" | "priority" | "assignee" | "labels" | "department" | "due") => {
    onOpen: () => void
    open: boolean
    picker: React.ReactNode
    /** Assignee only: drops the value without opening the picker at all. */
    onClear?: () => void
  } | undefined
}

/** The states that mean a session is still doing something. Dispatch stays
 *  offered unless one of these holds — a Todo whose only attempt has finished
 *  still needs the action, which keying it to "any linked session" removed. */
const LIVE_RAIL_STATES = new Set(["running", "waiting"])

export function PropsRail({
  detail,
  byName,
  departments,
  rowFor,
  railSession,
  dispatchPending,
  onDispatch,
  onOpenRailSession,
  sessionTree,
}: {
  detail: WorkItemDetailWire
  byName: Map<string, Employee>
  departments: DepartmentSummaryWire[] | undefined
  rowFor?: RailPickers["rowFor"]
  railSession?: LinkedSessionWire
  dispatchPending?: boolean
  onDispatch?: () => void
  onOpenRailSession?: (sessionId: string) => void
  sessionTree?: SessionTreeWire
}) {
  const item = detail.workItem
  const labels = detail.labels ?? []
  const dept = item.department ? departments?.find((d) => d.slug === item.department) : undefined
  const deptTitle = item.department ? item.department.charAt(0).toUpperCase() + item.department.slice(1) : "No department"
  const createdBySession = sessionIdFromActor(item.createdBy)
  const createdByLabel = !item.createdBy || item.createdBy === "operator" ? "You" : displayNameOf(item.createdBy, byName)
  const overdue = !!item.dueAt && Date.parse(item.dueAt) < Date.now()
  const railSessionLive = LIVE_RAIL_STATES.has(railSession?.status ?? "")

  const pick = (row: Parameters<NonNullable<RailPickers["rowFor"]>>[0]) => rowFor?.(row)

  const statusPick = pick("status")
  const prioPick = pick("priority")
  const assigneePick = pick("assignee")
  const labelsPick = pick("labels")
  const deptPick = pick("department")
  const duePick = pick("due")

  return (
    <aside data-testid="task-props-rail" className="relative pt-2">
      <RailKicker>Properties</RailKicker>
      <div className="relative">
        <RailRow testId="rail-status" label="Status" onOpen={statusPick?.onOpen} open={statusPick?.open}>
          <StatusCircle status={item.status} size={18} />
          {STATUS_LABEL[item.status]}
        </RailRow>
        {statusPick?.picker}
      </div>
      <div className="relative">
        <RailRow testId="rail-priority" label="Priority" onOpen={prioPick?.onOpen} open={prioPick?.open}>
          <RailPriorityBars priority={item.priority} />
          {priorityLabel(item.priority)}
        </RailRow>
        {prioPick?.picker}
      </div>
      <div className="relative">
        <RailRow testId="rail-assignee" label="Assignee" onOpen={assigneePick?.onOpen} open={assigneePick?.open}>
          {item.assignee ? (
            <>
              <EmployeeAvatar name={item.assignee} size={20} fontSize={11} className="bg-[var(--fill-secondary)]" />
              {displayNameOf(item.assignee, byName)}
            </>
          ) : (
            <>
              <span className="grid size-5 flex-none place-items-center rounded-full bg-[var(--fill-secondary)] text-[var(--text-quaternary)]">
                <UserRound size={11} aria-hidden />
              </span>
              <span className="text-[var(--text-tertiary)]">Unassigned</span>
            </>
          )}
        </RailRow>
        {item.assignee && assigneePick?.onClear && (
          // Sibling, not a child: the row is a button. `right-5` parks the ×
          // clear of the row's own trailing disclosure chevron.
          <RemoveButton
            label="Remove assignee"
            testId="rail-assignee-clear"
            onClick={assigneePick.onClear}
            className="absolute right-5 top-1/2 size-6 -translate-y-1/2 max-[700px]:size-[34px]"
          />
        )}
        {assigneePick?.picker}
      </div>
      {railSession && (
        <button
          type="button"
          data-testid="rail-dispatch-session"
          data-session-id={railSession.id}
          onClick={() => onOpenRailSession?.(railSession.id)}
          className="focus-ring group/dispatch relative -mx-2.5 flex min-h-[34px] w-[calc(100%+20px)] items-center gap-[9px] rounded-[9px] px-2.5 text-left text-[13.5px] font-medium text-[var(--text-primary)] outline-none hover:bg-[var(--fill-quaternary)]"
        >
          {/* The pulse says "working", so it is spent only on a session that is:
              the rail now offers a finished attempt too, and a finished attempt
              that pretends to be live is worse than no chip at all. */}
          <span
            className={`size-1.5 flex-none rounded-full ${railSessionLive ? "bg-[var(--system-blue)] motion-safe:animate-[jinn-pulse_1.4s_ease-in-out_infinite]" : "bg-[var(--fill-primary)]"}`}
            aria-hidden
          />
          <span className="min-w-0 truncate">
            {railSession.employee ? displayNameOf(railSession.employee, byName) : "A session"}{" "}
            <span className="font-normal text-[var(--text-tertiary)]">{railSessionLive ? "working" : "worked this"}</span>
          </span>
          <ArrowUpRight size={12} aria-hidden className="ml-auto text-[var(--text-quaternary)] opacity-0 transition-opacity group-hover/dispatch:opacity-100" />
        </button>
      )}
      {!railSessionLive && (
        <button
          type="button"
          data-testid="rail-dispatch"
          disabled={dispatchPending}
          onClick={onDispatch}
          className="focus-ring relative -mx-2.5 flex min-h-[34px] w-[calc(100%+20px)] items-center gap-[9px] rounded-[9px] px-2.5 text-left text-[13.5px] font-medium text-[var(--text-primary)] outline-none hover:bg-[var(--fill-quaternary)] disabled:cursor-wait disabled:text-[var(--text-tertiary)]"
        >
          {dispatchPending ? <LoaderCircle size={14} aria-hidden className="animate-spin text-[var(--text-tertiary)]" /> : <Send size={14} aria-hidden className="text-[var(--text-tertiary)]" />}
          {dispatchPending ? "Starting Dispatcher…" : "Dispatch"}
        </button>
      )}

      <AutoStartRow detail={detail} />

      {sessionTree && sessionTree.roots.length > 0 && (
        <div className="mt-2">
          <SessionTreePanel tree={sessionTree} byName={byName} todoId={item.id} />
        </div>
      )}

      <RailKicker later>Labels</RailKicker>
      <div className="relative">
        <div className="flex flex-wrap gap-1.5 pt-1" data-testid="rail-labels">
          {labels.map((label) => (
            <LabelChip key={label.id} label={label} />
          ))}
          {labelsPick && (
            <button
              type="button"
              data-testid="rail-labels-add"
              aria-label="Edit labels"
              onClick={labelsPick.onOpen}
              className="focus-ring flex h-[22px] items-center rounded-[11px] bg-[var(--fill-tertiary)] px-[9px] text-[11.5px] font-medium text-[var(--text-quaternary)] outline-none hover:text-[var(--text-secondary)]"
            >
              +
            </button>
          )}
        </div>
        {labelsPick?.picker}
      </div>

      <RailKicker later>Details</RailKicker>
      <div className="relative">
        <RailRow quiet testId="rail-department" label="Department" onOpen={deptPick?.onOpen} open={deptPick?.open}>
          <span
            className="w-4 text-center text-[11px] font-normal text-[var(--text-quaternary)]"
            style={{ fontFamily: "var(--font-code)", letterSpacing: ".04em" }}
          >
            {dept?.prefix ?? "—"}
          </span>
          {deptTitle}
        </RailRow>
        {deptPick?.picker}
      </div>
      <SprintRailRow detail={detail} editable={!!rowFor} />
      <div className="relative">
        <RailRow quiet testId="rail-due" label="Due date" onOpen={duePick?.onOpen} open={duePick?.open}>
          <Calendar size={14} strokeWidth={2} aria-hidden className="flex-none text-[var(--text-quaternary)]" />
          {item.dueAt ? (
            <span className={overdue ? "text-[var(--system-red)]" : undefined}>Due {formatDueLong(item.dueAt)}</span>
          ) : (
            <span className="text-[var(--text-tertiary)]">No due date</span>
          )}
        </RailRow>
        {duePick?.picker}
      </div>
      <RailRow quiet testId="rail-created-by">
        <UserRound size={14} strokeWidth={2} aria-hidden className="flex-none text-[var(--text-quaternary)]" />
        {createdBySession ? <SessionRef sessionId={createdBySession} byName={byName} /> : createdByLabel}
        <span className="text-[12px] font-normal text-[var(--text-quaternary)]">· created {formatRelativeTime(item.createdAt)}</span>
      </RailRow>
      <RailRow quiet testId="rail-spend">
        <span className="text-[11px] font-normal text-[var(--text-quaternary)]" style={{ fontFamily: "var(--font-code)" }}>
          ${detail.spendUsd.toFixed(2)}
        </span>
        {item.budgetUsd != null && item.budgetUsd > 0 && (
          <>
            <span className="h-[3px] w-14 overflow-hidden rounded-[2px] bg-[var(--fill-secondary)]" aria-hidden>
              <span
                className="block h-full rounded-[2px] bg-[var(--accent)]"
                style={{ width: `${Math.min(100, Math.round((detail.spendUsd / item.budgetUsd) * 100))}%` }}
              />
            </span>
            <span className="text-[11px] font-normal text-[var(--text-quaternary)]" style={{ fontFamily: "var(--font-code)" }}>
              ${item.budgetUsd % 1 === 0 ? item.budgetUsd.toFixed(0) : item.budgetUsd.toFixed(2)}
            </span>
          </>
        )}
      </RailRow>
    </aside>
  )
}
