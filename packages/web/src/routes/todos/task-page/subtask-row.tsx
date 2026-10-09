import { ArrowUpRight, UserRound } from "lucide-react"
import type { Employee, WorkItemStatusWire, WorkItemTreeNodeWire } from "@/lib/api"
import { STATUS_LABEL, stateKeyOf } from "@/lib/todos"
import { closeGateCounts, legalTargets } from "@/lib/legal-targets"
import { EmployeeAvatar } from "@/components/ui/employee-avatar"
import { StateCircle, StatusCircle } from "../state-glyph"
import { PickerPopover, PickerRow } from "../pickers/picker-shell"
import { AssigneePickerContent } from "../pickers/picker-contents"
import type { OpenTodoFromClick } from "./task-frame"

/* One row of the task page's sub-tasks list (design-doc §7.2.8, mock
 * task-detail.html): clean at rest, GROWING its quick actions on hover — the
 * disc gains a 3px halo and opens the legal-states popover FOR THAT CHILD, and
 * two 26px icon buttons fade in (assign, open). Touch: actions always visible. */

const ROW =
  "group/sub relative -mx-2.5 flex min-h-[38px] items-center gap-[9px] rounded-[10px] px-2.5 py-[5px] text-[14.5px]"

const ICON_BUTTON =
  "focus-ring grid size-[26px] place-items-center rounded-lg text-[var(--text-tertiary)] outline-none hover:bg-[var(--fill-tertiary)] hover:text-[var(--text-secondary)]"

type PickerKind = "status" | "assign"

type PickerProps = {
  child: WorkItemTreeNodeWire
  employees: Employee[]
  onClose: () => void
  onChildStatus: (childId: string, status: WorkItemStatusWire, cascade?: boolean) => void
  onChildAssign: (childId: string, assignee: string) => void
}

type SubTaskRowProps = Omit<PickerProps, "onClose"> & {
  mobile: boolean
  picking: PickerKind | null
  onPick: (kind: PickerKind | null) => void
  onOpenChild: OpenTodoFromClick
}

export function SubTaskRow({ child, employees, mobile, picking, onPick, onOpenChild, ...write }: SubTaskRowProps) {
  const closed = child.status === "done" || child.status === "cancelled"
  const kids = (child.children ?? []).length
  const picker = { child, onClose: () => onPick(null), ...write }

  return (
    <div data-testid={`subtask-row-${child.id}`} className={`${ROW} hover:bg-[var(--fill-quaternary)]`}>
      {/* The disc IS a control: halo on hover, opens that child's
          legal-states popover. */}
      <button
        type="button"
        aria-label={`Change status of ${child.id} (${STATUS_LABEL[child.status]})`}
        data-testid={`subtask-status-${child.id}`}
        onClick={() => onPick(picking === "status" ? null : "status")}
        className="focus-ring mr-[5px] flex-none rounded-full outline-none transition-shadow duration-120 group-hover/sub:shadow-[0_0_0_3px_var(--fill-secondary)]"
      >
        <StateCircle keyOf={stateKeyOf(child.status)} size={16} />
      </button>
      <span
        className="flex-none text-[11px] text-[var(--text-quaternary)]"
        style={{ fontFamily: "var(--font-code)", letterSpacing: ".04em" }}
      >
        {child.id}
      </span>
      <button
        type="button"
        onClick={(event) => onOpenChild(child.id, event)}
        className={`focus-ring min-w-0 flex-1 truncate text-left outline-none ${
          closed ? "font-normal text-[var(--text-tertiary)]" : "font-medium text-[var(--text-primary)]"
        }`}
      >
        {child.title}
      </button>
      {kids > 0 && (
        <span className="flex-none text-[11px] tabular-nums text-[var(--text-quaternary)]">
          {kids} sub{kids === 1 ? "" : "s"}
        </span>
      )}
      {child.assignee && (
        <EmployeeAvatar name={child.assignee} size={18} fontSize={10} className="flex-none bg-[var(--fill-secondary)]" />
      )}
      <QuickActions id={child.id} mobile={mobile} onAssign={() => onPick(picking === "assign" ? null : "assign")} onOpen={onOpenChild} />
      {picking === "status" && <StatusPicker {...picker} employees={employees} />}
      {picking === "assign" && <AssignPicker {...picker} employees={employees} />}
    </div>
  )
}

/** Hidden at rest, fading in on hover; always visible on touch, which has none. */
function QuickActions({
  id,
  mobile,
  onAssign,
  onOpen,
}: {
  id: string
  mobile: boolean
  onAssign: () => void
  onOpen: OpenTodoFromClick
}) {
  return (
    <span
      className={`flex flex-none gap-0.5 transition-opacity duration-120 ${
        mobile ? "opacity-100" : "opacity-0 focus-within:opacity-100 group-hover/sub:opacity-100"
      }`}
    >
      <button type="button" aria-label={`Assign ${id}`} data-testid={`subtask-assign-${id}`} onClick={onAssign} className={ICON_BUTTON}>
        <UserRound size={14} strokeWidth={2} aria-hidden />
      </button>
      <button type="button" aria-label={`Open ${id}`} data-testid={`subtask-open-${id}`} onClick={(event) => onOpen(id, event)} className={ICON_BUTTON}>
        <ArrowUpRight size={14} strokeWidth={2} aria-hidden />
      </button>
    </span>
  )
}

/** That child's own legal states — one picker is open at a time, which is why
 *  the section above owns which row is picking. */
function StatusPicker({ child, onClose, onChildStatus }: PickerProps) {
  return (
    <PickerPopover label={`Status of ${child.id}`} onClose={onClose} testId={`subtask-status-picker-${child.id}`}>
      <PickerRow
        glyph={<StatusCircle status={child.status} size={18} />}
        label={STATUS_LABEL[child.status]}
        checked
        onSelect={onClose}
      />
      {legalTargets(child.status, closeGateCounts(child))
        .filter((target) => target.status !== child.status)
        .map((target) => (
          <PickerRow
            key={target.status}
            glyph={<StatusCircle status={target.status} size={18} />}
            label={STATUS_LABEL[target.status]}
            disabled={target.gated}
            reason={target.reason}
            sub={target.gated ? undefined : target.reason}
            onSelect={() => {
              onChildStatus(child.id, target.status, target.cascade)
              onClose()
            }}
            testId={`subtask-status-option-${target.status}`}
          />
        ))}
    </PickerPopover>
  )
}

function AssignPicker({ child, employees, onClose, onChildAssign }: PickerProps) {
  return (
    <PickerPopover
      label={`Assign ${child.id}`}
      onClose={onClose}
      autoFocusFirst={false}
      testId={`subtask-assign-picker-${child.id}`}
    >
      <AssigneePickerContent
        detail={{ workItem: child, spendUsd: 0, events: [] }}
        employees={employees}
        onDone={onClose}
        commit={(assignee) => {
          if (assignee) onChildAssign(child.id, assignee)
        }}
      />
    </PickerPopover>
  )
}

/** The row a child wears between Enter and the gateway minting it: its title,
 *  and nothing it has no id to act on yet. */
export function PendingSubTaskRow({ title }: { title: string }) {
  return (
    <div data-testid="subtask-pending-row" className={`${ROW} opacity-60 motion-safe:animate-capture-step-in`}>
      <span className="mr-[5px] flex-none">
        <StateCircle keyOf={stateKeyOf("backlog")} size={16} />
      </span>
      <span className="min-w-0 flex-1 truncate font-medium text-[var(--text-primary)]">{title}</span>
    </div>
  )
}
