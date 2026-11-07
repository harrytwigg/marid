import { memo } from "react"
import type { Employee } from "@/lib/api"
import { EmployeeAvatar, OPERATOR_DEFAULT_EMOJI } from "@/components/ui/employee-avatar"
import { MemberAvatar, MemberName, useViewer } from "./attribution"
import { OPERATOR_ASSIGNEE } from "./util"

/* A Todo's two assignees as two small circles, the person left and the agent right, on the board card and the
 * list row. They answer different questions and are set apart: the person is who is responsible, the agent is
 * who does the work. An empty slot is a dashed outline so the pair never changes width or reads as missing data,
 * and both are drawn on every card, an instance with no accounts included. */

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

/** The agent slot: an employee's avatar, or a dashed circle when no agent holds the Todo. `name` is the employee's display name, when the roster has one. */
export function AgentCircle({ assignee, name, size = 20 }: { assignee: string | null | undefined; name?: string; size?: number }) {
  const agent = agentOf(assignee)
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
      <AgentCircle assignee={assignee} name={agentName} size={size} />
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
