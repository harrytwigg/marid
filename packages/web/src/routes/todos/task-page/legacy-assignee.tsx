import { UserRound } from "@/components/ui/icon"
import type { Employee } from "@/lib/api"
import { EmployeeAvatar } from "@/components/ui/employee-avatar"
import { displayNameOf, type Viewer } from "../util"
import { RemoveButton } from "./label-chip"
import { RailRow } from "./rail-rows"
import { Chip } from "./chip"

/* The one Assignee row and chip an instance with no accounts has always shown. The person and agent pair replaces them
 * once an account exists (see `useTwoSlotAssignees`); until then the Todo page reads exactly as before. */

interface Pick {
  onOpen: () => void
  open: boolean
  picker: React.ReactNode
  onClear?: () => void
}

export function AssigneeRailRow({ assignee, byName, viewer, pick }: { assignee: string | null; byName: Map<string, Employee>; viewer: Viewer; pick?: Pick }) {
  return (
    <div className="relative">
      <RailRow testId="rail-assignee" label="Assignee" onOpen={pick?.onOpen} open={pick?.open}>
        {assignee ? (
          <>
            <EmployeeAvatar name={assignee} size={20} fontSize={11} className="bg-[var(--fill-secondary)]" />
            {displayNameOf(assignee, byName, viewer)}
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
      {assignee && pick?.onClear && (
        // Sibling, not a child: the row is a button. `right-5` parks the × clear of the row's own trailing disclosure chevron.
        <RemoveButton
          label="Remove assignee"
          testId="rail-assignee-clear"
          onClick={pick.onClear}
          className="absolute right-5 top-1/2 size-6 -translate-y-1/2 max-[700px]:size-[34px]"
        />
      )}
      {pick?.picker}
    </div>
  )
}

export function AssigneeChip({ assignee, byName, viewer, onOpen, onClear, mobile }: {
  assignee: string | null
  byName: Map<string, Employee>
  viewer: Viewer
  onOpen?: () => void
  onClear?: () => void
  mobile: boolean
}) {
  return (
    <div className="relative flex-none">
      <Chip mobile={mobile} label="Assignee" testId="chip-assignee" clearSlot={!!onClear} onOpen={onOpen}>
        {assignee ? (
          <>
            <EmployeeAvatar name={assignee} size={20} fontSize={11} className="bg-[var(--fill-secondary)]" />
            {displayNameOf(assignee, byName, viewer)}
          </>
        ) : (
          <span className="text-[var(--text-tertiary)]">Unassigned</span>
        )}
      </Chip>
      {onClear && (
        // Sibling of the pill, laid over the room `clearSlot` reserved — the chip itself is a button, so the × cannot live inside it.
        <RemoveButton
          label="Remove assignee"
          testId="chip-assignee-clear"
          onClick={onClear}
          className={`absolute right-0 top-0 ${mobile ? "size-[34px]" : "size-7"}`}
        />
      )}
    </div>
  )
}
