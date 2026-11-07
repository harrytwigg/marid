import { EmployeeAvatar, OPERATOR_DEFAULT_EMOJI } from "@/components/ui/employee-avatar"
import { HumanAvatar } from "@/components/ui/human-avatar"
import { memberIdentity } from "@/lib/accounts-api"
import { usePersonChoices } from "@/hooks/use-person-choices"
import { useViewer } from "../attribution"
import { OPERATOR_ASSIGNEE } from "../util"
import { PickerNote, PickerRow } from "./picker-shell"
import type { PickerContentProps } from "./picker-contents"

/**
 * What a choice does, said before the operator makes it, on a Todo that waits on them: naming someone else hands it on and
 * takes it off their desk. Clearing does too when the operator is the person; beside someone else's name it makes the
 * operator the person instead. Nothing to say anywhere else.
 */
function choiceHints(item: { assignee: string | null; humanAssignee?: string | null }, viewer: "operator" | "member"): { handsOn?: string; onClear?: string } {
  if (viewer !== "operator" || item.assignee !== OPERATOR_ASSIGNEE) return {}
  const handsOn = "Takes it off your desk"
  return { handsOn, onClear: item.humanAssignee === OPERATOR_ASSIGNEE ? handsOn : "Leaves you as the person" }
}

/** The person picker: the operator (the operator's own picker only: a board member never names the operator), then the people on
 *  this Todo's board, and a row to clear. It names a person responsible and nothing else: it never starts or notifies an agent,
 *  so it carries no creator-access note. */
export function PersonPickerContent({ detail, commit, sheet, onDone, board }: Omit<PickerContentProps, "memberCreator"> & { commit: (person: string | null) => void; board: string | null }) {
  const viewer = useViewer()
  const current = detail.workItem.humanAssignee ?? null
  const { people } = usePersonChoices(board)
  const pick = (person: string | null) => { if (person !== current) commit(person); onDone() }
  const { handsOn, onClear } = choiceHints(detail.workItem, viewer)
  return (
    <>
      {current !== null && (
        <PickerRow
          sheet={sheet}
          label={<span className="text-[var(--text-tertiary)]">No person</span>}
          sub={onClear}
          onSelect={() => pick(null)}
          testId="person-option-clear"
        />
      )}
      <div className={sheet ? "" : "max-h-[288px] overflow-y-auto"}>
        {viewer === "operator" && (
          <PickerRow
            sheet={sheet}
            glyph={<EmployeeAvatar name="operator" fallback={OPERATOR_DEFAULT_EMOJI} size={22} fontSize={12} className="bg-[var(--fill-secondary)]" />}
            label="You (operator)"
            checked={current === OPERATOR_ASSIGNEE}
            onSelect={() => pick(OPERATOR_ASSIGNEE)}
            testId="person-option-operator"
          />
        )}
        {people.map((person) => (
          <PickerRow
            key={person.id}
            sheet={sheet}
            glyph={<HumanAvatar name={person.displayName} initials={person.initials} size={22} />}
            label={person.displayName}
            sub={current === memberIdentity(person.id) ? undefined : handsOn}
            checked={current === memberIdentity(person.id)}
            onSelect={() => pick(memberIdentity(person.id))}
            testId={`person-option-${person.id}`}
          />
        ))}
        {people.length === 0 && <PickerNote>No one else has access to this board.</PickerNote>}
      </div>
    </>
  )
}
