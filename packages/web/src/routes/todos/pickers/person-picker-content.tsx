import { EmployeeAvatar, OPERATOR_DEFAULT_EMOJI } from "@/components/ui/employee-avatar"
import { HumanAvatar } from "@/components/ui/human-avatar"
import { memberIdentity } from "@/lib/accounts-api"
import { usePersonChoices } from "@/hooks/use-person-choices"
import { useViewer } from "../attribution"
import { OPERATOR_ASSIGNEE } from "../util"
import { PickerNote, PickerRow } from "./picker-shell"
import type { PickerContentProps } from "./picker-contents"

/** The person picker: the operator (the operator's own picker only: a board member never names the operator), then the people on
 *  this Todo's board, and a row to clear. It names a person responsible and nothing else: it never starts or notifies an agent,
 *  so it carries no creator-access note. */
export function PersonPickerContent({
  detail,
  commit,
  sheet,
  onDone,
}: Omit<PickerContentProps, "memberCreator"> & { commit: (person: string | null) => void }) {
  const viewer = useViewer()
  const current = detail.workItem.humanAssignee ?? null
  const { people } = usePersonChoices(detail.workItem.department)
  const pick = (person: string | null) => {
    if (person !== current) commit(person)
    onDone()
  }
  return (
    <>
      {current !== null && (
        <PickerRow
          sheet={sheet}
          label={<span className="text-[var(--text-tertiary)]">No person</span>}
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
