import { useOperatorSelf } from "@/hooks/use-operator-self"
import { agentOf, OperatorSelfAvatar } from "../assignee-circles"
import { OPERATOR_ASSIGNEE } from "../util"
import { PickerRow } from "./picker-shell"

/**
 * The operator's row ("You (operator)", or the owner account / "Operator (shared)" once one exists, see `useOperatorSelf`) in an assign picker that has no person slot beside it (a sub-task row, the search workbench's Owner):
 * there it is the only way to assign a Todo to yourself, so it stays, through the assign route as it always was. Where a
 * person slot sits beside the agent (the Todo page, the create dialog) the operator is chosen there instead.
 */
export function OperatorAssignRow({ offered, query, assignee, sheet, onSelect }: {
  offered: boolean
  query: string
  assignee: string | null
  sheet?: boolean
  onSelect: () => void
}) {
  const self = useOperatorSelf()
  if (!offered || !self.label.toLowerCase().includes(query.trim().toLowerCase())) return null
  return (
    <PickerRow
      sheet={sheet}
      glyph={<OperatorSelfAvatar self={self} size={22} fontSize={12} />}
      label={self.label}
      checked={assignee === OPERATOR_ASSIGNEE}
      onSelect={onSelect}
      testId={`assignee-option-${OPERATOR_ASSIGNEE}`}
    />
  )
}

/** What an assign picker shows as held: the assignee itself where the operator is offered, else only an agent. */
export function heldInPicker(assignee: string | null | undefined, offerOperator: boolean): string | null {
  return offerOperator ? assignee ?? null : agentOf(assignee ?? null)
}
