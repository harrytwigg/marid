import type { Employee, WorkItemDetailWire } from "@/lib/api"
import { STATUS_LABEL, priorityLabel, reviewAddresseeEmployee } from "@/lib/todos"
import { EmployeeAvatar, OPERATOR_DEFAULT_EMOJI } from "@/components/ui/employee-avatar"
import { StatusCircle } from "../state-glyph"
import { displayNameOf } from "../util"
import { useViewer } from "../attribution"
import { agentOf, PersonCircle, PersonName, personRowFor, removePersonLabel, waitsOnOperator } from "../assignee-circles"
import { ReviewForChip } from "../review-for-chip"
import { type RailPickers } from "./props-rail"
import { SESSION_WAITING_COLOR, SESSION_WAITING_LABEL } from "@/lib/session-waiting"
import { RailPriorityBars } from "./rail-rows"
import { RemoveButton } from "./label-chip"
import { Chip } from "./chip"
import { AssigneeChip } from "./legacy-assignee"
import { useTwoSlotAssignees } from "@/hooks/use-two-slot-assignees"

/* Variant A — the task's working identity lives directly under its title.
 * Desktop uses the approved 28px chips; mobile keeps every interactive target
 * at 34px. Less-frequent properties remain in the folded Details document. */

/** The elapsed time under the status chip: blue and pulsing while anything is
 *  working, amber and still when every live worker is paused. */
function ElapsedChip({ working, waiting }: { working: string; waiting: boolean }) {
  return (
    <span
      className={`flex items-center gap-1.5 ${waiting ? "text-[var(--system-yellow)]" : "text-[var(--system-blue)]"}`}
      data-testid="chip-working"
    >
      <span
        className={
          waiting
            ? "size-1.5 rounded-full"
            : "size-1.5 rounded-full bg-[var(--system-blue)] motion-safe:animate-[jinn-pulse_1.4s_ease-in-out_infinite]"
        }
        style={waiting ? { background: SESSION_WAITING_COLOR } : undefined}
        aria-hidden
      />
      {waiting ? `${SESSION_WAITING_LABEL} · ${working}` : `Working · ${working}`}
    </span>
  )
}

interface OwnerChipProps {
  item: WorkItemDetailWire["workItem"]
  byName: Map<string, Employee>
  rowFor: NonNullable<RailPickers["rowFor"]>
  mobile: boolean
}

/** What the agent chip says: the employee holding the Todo, the operator when it waits on them, or nobody. */
function AgentChipBody({ item, byName, viewer }: { item: WorkItemDetailWire["workItem"]; byName: Map<string, Employee>; viewer: "operator" | "member" }) {
  const agent = agentOf(item.assignee)
  if (agent) {
    return (
      <>
        <EmployeeAvatar name={agent} size={20} fontSize={11} className="bg-[var(--fill-secondary)]" />
        {displayNameOf(agent, byName, viewer)}
      </>
    )
  }
  if (!waitsOnOperator(item)) return <span className="text-[var(--text-tertiary)]">No agent</span>
  return (
    <>
      <EmployeeAvatar name="operator" fallback={OPERATOR_DEFAULT_EMOJI} size={20} fontSize={11} className="bg-[var(--fill-secondary)]" />
      {viewer === "member" ? "Needs the operator" : "Needs you"}
    </>
  )
}

/** The two chips that say who holds a Todo once an account exists: the person responsible, then the agent, each with its own clear control. */
function TwoSlotChips({ item, byName, rowFor, mobile }: OwnerChipProps) {
  const viewer = useViewer()
  const personPick = personRowFor(rowFor, item, viewer)
  const onClearPerson = personPick?.onClear
  const removeLabel = removePersonLabel(item, viewer)
  const onClearAssignee = rowFor("assignee")?.onClear
  const clearClass = `absolute right-0 top-0 ${mobile ? "size-[34px]" : "size-7"}`
  return (
    <>
      <div className="relative flex-none">
        <Chip mobile={mobile} label="Person" testId="chip-person" clearSlot={!!onClearPerson} onOpen={personPick?.onOpen}>
          <PersonCircle person={item.humanAssignee} size={20} />
          {item.humanAssignee ? <PersonName person={item.humanAssignee} viewer={viewer} /> : <span className="text-[var(--text-tertiary)]">No person</span>}
        </Chip>
        {onClearPerson && <RemoveButton label={removeLabel} title={removeLabel} testId="chip-person-clear" onClick={onClearPerson} className={clearClass} />}
      </div>
      <div className="relative flex-none">
        <Chip mobile={mobile} label="Agent" testId="chip-assignee" clearSlot={!!onClearAssignee} onOpen={rowFor("assignee")?.onOpen}>
          <AgentChipBody item={item} byName={byName} viewer={viewer} />
        </Chip>
        {/* Sibling of the pill, laid over the room `clearSlot` reserved: the chip itself is a button, so the × cannot live inside it. */}
        {onClearAssignee && <RemoveButton label="Remove agent" testId="chip-assignee-clear" onClick={onClearAssignee} className={clearClass} />}
      </div>
    </>
  )
}

/** Who holds a Todo, as chips: the person and the agent once an account exists, the one assignee before. */
function OwnerChips(props: OwnerChipProps) {
  const twoSlots = useTwoSlotAssignees()
  const viewer = useViewer()
  const { item, byName, rowFor, mobile } = props
  if (twoSlots) return <TwoSlotChips {...props} />
  return <AssigneeChip assignee={item.assignee} byName={byName} viewer={viewer} onOpen={rowFor("assignee")?.onOpen} onClear={rowFor("assignee")?.onClear} mobile={mobile} />
}

export function ChipCluster({
  detail,
  byName,
  rowFor,
  mobile,
  working,
  waiting = false,
}: {
  detail: WorkItemDetailWire
  byName: Map<string, Employee>
  /** The same accessor the rail reads: what this property's row can do. */
  rowFor: NonNullable<RailPickers["rowFor"]>
  mobile: boolean
  working?: string | null
  /** Every live worker is paused: the elapsed time is time spent waiting, not
   *  working, so the chip says so in amber rather than pulsing blue. */
  waiting?: boolean
}) {
  const item = detail.workItem
  const labels = detail.labels ?? []
  const opener = (row: Parameters<typeof rowFor>[0]) => (rowFor(row) ? () => rowFor(row)?.onOpen() : undefined)
  const reviewFor = reviewAddresseeEmployee({ status: item.status, reviewAddressee: detail.reviewAddressee })
  return (
    <div
      data-testid="task-chip-cluster"
      className="mt-3 flex min-h-7 flex-wrap gap-2 max-[700px]:min-h-[34px] max-[700px]:flex-nowrap max-[700px]:overflow-x-auto"
    >
      <Chip mobile={mobile} label="Status" testId="chip-status" onOpen={opener("status")}>
        <StatusCircle status={item.status} size={16} />
        {STATUS_LABEL[item.status]}
        {reviewFor && <ReviewForChip employee={reviewFor} byName={byName} />}
        {working && <ElapsedChip working={working} waiting={waiting} />}
      </Chip>
      <OwnerChips item={item} byName={byName} rowFor={rowFor} mobile={mobile} />
      <Chip mobile={mobile} label="Priority" testId="chip-priority" onOpen={opener("priority")}>
        <RailPriorityBars priority={item.priority} />
        {priorityLabel(item.priority)}
      </Chip>
      {labels.length > 0 && (
        <Chip mobile={mobile} label="Labels" testId="chip-labels" onOpen={opener("labels")}>
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
