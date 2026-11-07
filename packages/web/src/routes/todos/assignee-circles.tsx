import { memo } from "react"
import type { Employee } from "@/lib/api"
import { EmployeeAvatar, OPERATOR_DEFAULT_EMOJI } from "@/components/ui/employee-avatar"
import { emojiForName } from "@/lib/emoji-pool"
import { useTwoSlotAssignees } from "@/hooks/use-two-slot-assignees"
import { MemberAvatar, MemberName, useViewer } from "./attribution"
import { OPERATOR_ASSIGNEE } from "./util"

/* A Todo's two assignees as two small circles, the person left and the agent right, on the board card and the
 * list row once the instance has an account (before that, a card keeps its one assignee circle: `AssigneeSlots`).
 * They answer different questions and are set apart: the person is who is responsible, the agent is who does the
 * work. An empty slot is a dashed outline so the pair never changes width or reads as missing data. */

function EmptyCircle({ size, label, testId }: { size: number; label: string; testId: string }) {
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-testid={testId}
      className="inline-block flex-none rounded-full border border-dashed border-[var(--text-quaternary)]"
      style={{ width: size, height: size }}
    />
  )
}

/** The person slot. The operator wears their own avatar, a board member a HumanAvatar, nobody a dashed circle. */
export function PersonCircle({ person, size = 20 }: { person: string | null | undefined; size?: number }) {
  const viewer = useViewer()
  if (!person) return <EmptyCircle size={size} label="No person" testId="person-circle-empty" />
  if (person === OPERATOR_ASSIGNEE) {
    return (
      <span title={viewer === "member" ? "Operator" : "You (operator)"} data-testid="person-circle" className="flex-none">
        <EmployeeAvatar name="operator" fallback={OPERATOR_DEFAULT_EMOJI} size={size} fontSize={Math.round(size * 0.55)} className="bg-[var(--fill-secondary)]" />
      </span>
    )
  }
  return <span data-testid="person-circle" className="flex-none"><MemberAvatar identity={person} size={size} /></span>
}

/** The person's name where a row spells it out: the operator reads "You (operator)" to themselves and "Operator" to a board member. */
export function PersonName({ person, viewer }: { person: string; viewer: "operator" | "member" }) {
  if (person === OPERATOR_ASSIGNEE) return <>{viewer === "member" ? "Operator" : "You (operator)"}</>
  return <MemberName identity={person} />
}

/** Whether the agent slot holds an agent: `@operator` in it is the legacy "needs the operator" marker, shown in the person slot. */
export function agentOf(assignee: string | null | undefined): string | null {
  return assignee && assignee !== OPERATOR_ASSIGNEE ? assignee : null
}

/** A Todo that waits on the operator while the person responsible is someone else: `@operator` holds the agent slot beside
 *  a user's row (an agent handed it over). When the operator is the person, the person slot already says so. */
export function waitsOnOperator(item: { assignee: string | null | undefined; humanAssignee?: string | null }): boolean {
  return item.assignee === OPERATOR_ASSIGNEE && item.humanAssignee !== OPERATOR_ASSIGNEE
}

/** The agent slot: an employee's avatar, the operator's when the Todo waits on them, or a dashed circle when nobody holds it. `name` is the employee's display name, when the roster has one. */
export function AgentCircle({ assignee, name, size = 20, waitsOnYou = false }: { assignee: string | null | undefined; name?: string; size?: number; waitsOnYou?: boolean }) {
  const agent = agentOf(assignee)
  if (!agent && waitsOnYou) {
    return (
      <span title="Needs the operator" data-testid="agent-circle-operator" className="flex-none">
        <EmployeeAvatar name="operator" fallback={OPERATOR_DEFAULT_EMOJI} size={size} fontSize={Math.round(size * 0.55)} className="bg-[var(--fill-secondary)]" />
      </span>
    )
  }
  if (!agent) return <EmptyCircle size={size} label="No agent" testId="agent-circle-empty" />
  return (
    <span title={name ?? agent} data-testid="agent-circle" className="flex-none">
      <EmployeeAvatar name={agent} size={size} fontSize={Math.round(size * 0.55)} className="bg-[var(--fill-secondary)]" />
    </span>
  )
}

/** Memoised on the strings it draws, never the roster map: a card re-renders for a title or a label, and a pair that was
 *  handed the same people has nothing new to draw. */
const CirclePair = memo(function CirclePair({ assignee, humanAssignee, agentName, size }: {
  assignee: string | null
  humanAssignee: string | null | undefined
  agentName: string | undefined
  size: number
}) {
  return (
    <span data-testid="assignee-circles" className="flex flex-none items-center gap-1">
      <PersonCircle person={humanAssignee} size={size} />
      <AgentCircle assignee={assignee} name={agentName} size={size} waitsOnYou={waitsOnOperator({ assignee, humanAssignee })} />
    </span>
  )
})

export function AssigneeCircles({
  assignee,
  humanAssignee,
  byName,
  size = 20,
}: {
  assignee: string | null
  humanAssignee?: string | null
  byName: Map<string, Employee>
  size?: number
}) {
  const agent = agentOf(assignee)
  return <CirclePair assignee={assignee} humanAssignee={humanAssignee} agentName={agent ? byName.get(agent)?.displayName : undefined} size={size} />
}

/** The one assignee circle an instance with no accounts has always shown, on the board card and on the list row. */
function SingleAssignee({ assignee, byName, variant }: { assignee: string | null; byName: Map<string, Employee>; variant: "card" | "row" }) {
  if (!assignee) return null
  const title = byName.get(assignee)?.displayName ?? assignee
  if (variant === "card") {
    return (
      <span title={title} className="flex-none">
        <EmployeeAvatar name={assignee} size={20} fontSize={11} className="bg-[var(--fill-secondary)]" />
      </span>
    )
  }
  return (
    <span title={title} className="grid size-5 place-items-center rounded-full bg-[var(--fill-secondary)] text-[11px]">
      {emojiForName(assignee)}
    </span>
  )
}

/** What a card or a row shows for who holds a Todo: the person and the agent once an account exists, the one assignee before. */
export function AssigneeSlots({ item, byName, variant }: {
  item: { assignee: string | null; humanAssignee?: string | null }
  byName: Map<string, Employee>
  variant: "card" | "row"
}) {
  const twoSlots = useTwoSlotAssignees()
  if (!twoSlots) return <SingleAssignee assignee={item.assignee} byName={byName} variant={variant} />
  return <AssigneeCircles assignee={item.assignee} humanAssignee={item.humanAssignee} byName={byName} />
}

/**
 * The person row's picker, offering exactly what the gateway allows: a board member never changes a Todo whose person is
 * the operator, nor one that waits on the operator (`@operator` in the agent slot): renaming would hand it on and clearing
 * would name the operator, both the operator's to do (the gateway answers 403). A viewer's role has no picker at all.
 */
export function personRowFor<R>(
  rowFor: (row: "person") => R | undefined,
  item: { assignee?: string | null; humanAssignee?: string | null },
  viewer: "operator" | "member",
): R | undefined {
  const operatorsToChange = item.humanAssignee === OPERATOR_ASSIGNEE || item.assignee === OPERATOR_ASSIGNEE
  return viewer === "member" && operatorsToChange ? undefined : rowFor("person")
}
