import type { Employee, WorkItemDetailWire } from "@/lib/api"
import { STATUS_LABEL, priorityLabel } from "@/lib/todos"
import { EmployeeAvatar } from "@/components/ui/employee-avatar"
import { StatusCircle } from "../state-glyph"
import { displayNameOf } from "../util"
import { type RailPickers } from "./props-rail"
import { RailPriorityBars } from "./rail-rows"
import { RemoveButton } from "./label-chip"

/* Variant A — the task's working identity lives directly under its title.
 * Desktop uses the approved 28px chips; mobile keeps every interactive target
 * at 34px. Less-frequent properties remain in the folded Details document. */

function Chip({
  onOpen,
  children,
  testId,
  label,
  mobile,
  clearSlot,
}: {
  onOpen: () => void
  children: React.ReactNode
  testId?: string
  label: string
  mobile: boolean
  /** Reserves trailing room for a clear control laid over the pill's end. */
  clearSlot?: boolean
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={label}
      onClick={onOpen}
      className={`focus-ring flex flex-none items-center gap-[7px] bg-[var(--fill-tertiary)] font-medium text-[var(--text-secondary)] outline-none hover:bg-[var(--fill-secondary)] ${
        mobile
          ? `h-[34px] rounded-[17px] text-[13.5px] ${clearSlot ? "pl-3 pr-[34px]" : "px-3"}`
          : `h-7 rounded-[14px] text-[12.5px] ${clearSlot ? "pl-[11px] pr-7" : "px-[11px]"}`
      }`}
    >
      {children}
    </button>
  )
}

export function ChipCluster({
  detail,
  byName,
  rowFor,
  mobile,
  working,
}: {
  detail: WorkItemDetailWire
  byName: Map<string, Employee>
  /** The same accessor the rail reads: what this property's row can do. */
  rowFor: NonNullable<RailPickers["rowFor"]>
  mobile: boolean
  working?: string | null
}) {
  const item = detail.workItem
  const labels = detail.labels ?? []
  const onClearAssignee = rowFor("assignee")?.onClear
  return (
    <div
      data-testid="task-chip-cluster"
      className="mt-3 flex min-h-7 flex-wrap gap-2 max-[700px]:min-h-[34px] max-[700px]:flex-nowrap max-[700px]:overflow-x-auto"
    >
      <Chip mobile={mobile} label="Status" testId="chip-status" onOpen={() => rowFor("status")?.onOpen()}>
        <StatusCircle status={item.status} size={16} />
        {STATUS_LABEL[item.status]}
        {working && (
          <span className="flex items-center gap-1.5 text-[var(--system-blue)]" data-testid="chip-working">
            <span
              className="size-1.5 rounded-full bg-[var(--system-blue)] motion-safe:animate-[jinn-pulse_1.4s_ease-in-out_infinite]"
              aria-hidden
            />
            Working · {working}
          </span>
        )}
      </Chip>
      <div className="relative flex-none">
        <Chip mobile={mobile} label="Assignee" testId="chip-assignee" clearSlot={!!onClearAssignee} onOpen={() => rowFor("assignee")?.onOpen()}>
          {item.assignee ? (
            <>
              <EmployeeAvatar name={item.assignee} size={20} fontSize={11} className="bg-[var(--fill-secondary)]" />
              {displayNameOf(item.assignee, byName)}
            </>
          ) : (
            <span className="text-[var(--text-tertiary)]">Unassigned</span>
          )}
        </Chip>
        {onClearAssignee && (
          // Sibling of the pill, laid over the room `clearSlot` reserved — the
          // chip itself is a button, so the × cannot live inside it.
          <RemoveButton
            label="Remove assignee"
            testId="chip-assignee-clear"
            onClick={onClearAssignee}
            className={`absolute right-0 top-0 ${mobile ? "size-[34px]" : "size-7"}`}
          />
        )}
      </div>
      <Chip mobile={mobile} label="Priority" testId="chip-priority" onOpen={() => rowFor("priority")?.onOpen()}>
        <RailPriorityBars priority={item.priority} />
        {priorityLabel(item.priority)}
      </Chip>
      {labels.length > 0 && (
        <Chip mobile={mobile} label="Labels" testId="chip-labels" onOpen={() => rowFor("labels")?.onOpen()}>
          {labels.map((label) => (
            <span key={label.id} className="flex items-center gap-1">
              <span className="size-[5px] rounded-full" style={{ background: label.color ?? "var(--text-quaternary)" }} />
              {label.name}
            </span>
          ))}
        </Chip>
      )}
    </div>
  )
}
