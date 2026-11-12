import { memo } from "react"
import type { Employee } from "@/lib/api"
import { EmployeeAvatar, OPERATOR_DEFAULT_EMOJI } from "@/components/ui/employee-avatar"
import { HumanAvatar } from "@/components/ui/human-avatar"
import { useOperatorSelf, type OperatorSelf } from "@/hooks/use-operator-self"
import { MemberAvatar, MemberName, useViewer } from "./attribution"
import { OPERATOR_ASSIGNEE } from "./util"

/* A Todo's two assignees as two small circles, the person left and the agent right, on the board card and the
 * list row, on every instance. They answer different questions and are set apart: the person is who is responsible,
 * the agent is who does the work. An empty slot is a dashed outline so the pair never changes width or reads as missing data. */

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

/** The operator's badge: their own emoji, or, where exactly one owner account is the operator, that account's initials. */
export function OperatorSelfAvatar({ self, size, fontSize, className = "bg-[var(--fill-secondary)]" }: { self: OperatorSelf; size: number; fontSize?: number; className?: string }) {
  const owner = self.mode === "single" ? self.owners[0] : undefined
  if (owner) return <HumanAvatar name={owner.displayName} initials={owner.initials} size={size} />
  return <EmployeeAvatar name="operator" fallback={OPERATOR_DEFAULT_EMOJI} size={size} fontSize={fontSize ?? Math.round(size * 0.55)} className={className} />
}

/** The person slot. The operator wears their own avatar (or, with one owner account, that account's), a board member a HumanAvatar, nobody a dashed circle. */
export function PersonCircle({ person, size = 20 }: { person: string | null | undefined; size?: number }) {
  const viewer = useViewer()
  const self = useOperatorSelf(person === OPERATOR_ASSIGNEE)
  if (!person) return <EmptyCircle size={size} label="No person" testId="person-circle-empty" />
  if (person === OPERATOR_ASSIGNEE) {
    return (
      <span title={viewer === "member" ? "Operator" : self.label} data-testid="person-circle" className="flex-none">
        <OperatorSelfAvatar self={self} size={size} />
      </span>
    )
  }
  return <span data-testid="person-circle" className="flex-none"><MemberAvatar identity={person} size={size} /></span>
}

/** The person's name where a row spells it out: the operator reads as themselves to themselves (see `useOperatorSelf`) and "Operator" to a board member. */
export function PersonName({ person, viewer }: { person: string; viewer: "operator" | "member" }) {
  const self = useOperatorSelf(person === OPERATOR_ASSIGNEE)
  if (person === OPERATOR_ASSIGNEE) return <>{viewer === "member" ? "Operator" : self.label}</>
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

/**
 * What a person choice does to the other slot, said before the operator makes it, on a Todo that waits on them: naming
 * someone else hands it on and takes it off their desk. Clearing does too when the operator is the person; beside someone
 * else's name it makes the operator the person instead. No other choice clears a slot it does not name, so nothing to say.
 */
export function personChoiceHints(item: { assignee?: string | null; humanAssignee?: string | null }, viewer: "operator" | "member"): { handsOn?: string; onClear?: string } {
  if (viewer !== "operator" || item.assignee !== OPERATOR_ASSIGNEE) return {}
  const handsOn = "Takes it off your desk"
  return { handsOn, onClear: item.humanAssignee === OPERATOR_ASSIGNEE ? handsOn : "Leaves you as the person" }
}

/** The person row's clear button's name, carrying what clearing does to the other slot when it does anything. */
export function removePersonLabel(item: { assignee?: string | null; humanAssignee?: string | null }, viewer: "operator" | "member"): string {
  const { onClear } = personChoiceHints(item, viewer)
  return onClear ? `Remove person: ${onClear.toLowerCase()}` : "Remove person"
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
