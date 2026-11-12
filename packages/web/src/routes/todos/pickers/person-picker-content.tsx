import { HumanAvatar } from "@/components/ui/human-avatar"
import { memberIdentity } from "@/lib/accounts-api"
import { usePersonChoices, type PersonChoice } from "@/hooks/use-person-choices"
import { SHARED_OPERATOR_LABEL, useOperatorSelf, type OperatorSelf } from "@/hooks/use-operator-self"
import { useViewer } from "../attribution"
import { OperatorSelfAvatar, personChoiceHints } from "../assignee-circles"
import { OPERATOR_ASSIGNEE } from "../util"
import { PickerNote, PickerRow } from "./picker-shell"
import type { PickerContentProps } from "./picker-contents"

/** The person picker: the operator (the operator's own picker only: a board member never names the operator), then the people on
 *  this Todo's board, and a row to clear. Where an owner account exists the operator is that account: its row reads "<name> (you)"
 *  and still stores `@operator` (with several owners, or none of them this browser's, "Operator (shared)" does), and the account
 *  is not listed again as a person of its own. It names a person responsible and nothing else: it never starts or notifies an agent,
 *  so it carries no creator-access note. */
export function PersonPickerContent({ detail, commit, sheet, onDone, board }: Omit<PickerContentProps, "memberCreator"> & { commit: (person: string | null) => void; board: string | null }) {
  const viewer = useViewer()
  const current = detail.workItem.humanAssignee ?? null
  const { people: choices, asked, ready } = usePersonChoices(board)
  const self = useOperatorSelf()
  // The "you" account is the `@operator` row, never also a `user:` row: a Todo naming it by account reads as it and is not checked.
  const people = withoutAccount(choices, viewer === "operator" ? self.you : null)
  // Who the operator is comes from the same People read as the rows below, so until it lands neither is offered: a "You (operator)"
  // beside the operator's own account, each choosing something different, must never show.
  const waiting = viewer === "operator" && !self.ready
  const pick = (person: string | null) => { if (person !== current) commit(person); onDone() }
  const { handsOn, onClear } = personChoiceHints(detail.workItem, viewer)
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
        {viewer === "operator" && !waiting && <OperatorPersonRow self={self} sheet={sheet} checked={current === OPERATOR_ASSIGNEE} onSelect={() => pick(OPERATOR_ASSIGNEE)} />}
        {!waiting && <PersonRows people={people} current={current} handsOn={handsOn} sheet={sheet} asked={asked && ready} board={board} pick={pick} />}
      </div>
    </>
  )
}

function withoutAccount(choices: PersonChoice[], account: PersonChoice | null): PersonChoice[] {
  return account ? choices.filter((person) => person.id !== account.id) : choices
}

/** `@operator`. With no owner account, "You (operator)". Where one exists it is the account this browser is, "<name> (you)" (marked
 *  shared when there are several owners), or with no such account "Operator (shared)". Always stores `@operator`. */
function OperatorPersonRow({ self, sheet, checked, onSelect }: { self: OperatorSelf; sheet: boolean | undefined; checked: boolean; onSelect: () => void }) {
  const you = self.you
  const shared = self.mode === "shared"
  const glyph = you && self.mode !== "legacy"
    ? <HumanAvatar name={you.displayName} initials={you.initials} size={22} />
    : <OperatorSelfAvatar self={self} size={22} fontSize={12} />
  return (
    <PickerRow
      sheet={sheet}
      glyph={glyph}
      label={self.mode === "legacy" ? self.label : you ? `${you.displayName} (you)` : SHARED_OPERATOR_LABEL}
      sub={you && shared ? SHARED_OPERATOR_LABEL : undefined}
      checked={checked}
      onSelect={onSelect}
      testId="person-option-operator"
    />
  )
}

function PersonRows({ people, current, handsOn, sheet, asked, board, pick }: {
  people: PersonChoice[]
  current: string | null
  handsOn: string | undefined
  sheet: boolean | undefined
  /** The people list has answered, so an empty one is a fact worth saying. */
  asked: boolean
  board: string | null
  pick: (person: string | null) => void
}) {
  return (
    <>
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
      {asked && people.length === 0 && (
        <PickerNote>{board ? "No one else has access to this board." : "Choose a board to name someone else."}</PickerNote>
      )}
    </>
  )
}
