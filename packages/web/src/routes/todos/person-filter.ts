import { memberIdentity } from "@/lib/accounts-api"
import { usePersonChoices, type PersonChoice } from "@/hooks/use-person-choices"
import { SHARED_OPERATOR_LABEL, useOperatorSelf } from "@/hooks/use-operator-self"
import { useAuthOptional } from "@/routes/auth-provider"
import { OPERATOR_ASSIGNEE, UNASSIGNED_FILTER } from "./util"

/** What the Person filter can offer: the viewer ("Me", or the operator's shared desk), then everyone else who can hold a Todo here. */
export interface PersonFilterChoices {
  /** The viewer's own identity: the operator, or the signed-in member. */
  me: string
  /** Everyone but the viewer, as the person picker offers them (accounts only). */
  people: PersonChoice[]
  /** A member also reads the operator as a person they may filter on; the operator's own view has "Me" for that. */
  offerOperator: boolean
  /** The operator's one owner account, which "Me" already stands for and so is not listed again (null otherwise). */
  you?: PersonChoice | null
  /** What `me` reads as: "Me", or "Operator (shared)" when several owners share the operator's desk. */
  meLabel?: string
}

/**
 * The people a board's Person filter lists. `me` is the signed-in user, or the operator on an instance with no accounts (and
 * for the operator's own session). The others are the people with access to the board; with no board named (Everything) every
 * active person, since Todos from every board are in view.
 */
export function usePersonFilterChoices(board: string | null | undefined): PersonFilterChoices {
  const auth = useAuthOptional()
  const principal = auth?.principal
  const me = principal?.kind === "member" ? memberIdentity(principal.user.id) : OPERATOR_ASSIGNEE
  const { people } = usePersonChoices(board, !board)
  const operator = me === OPERATOR_ASSIGNEE
  const self = useOperatorSelf(operator)
  // With one owner, that account is "Me" (`@operator`), never a second row filtering on `user:<id>` beside it. With several, the
  // desk is theirs together, so it reads "Operator (shared)" and every owner is listed by name: one owner can name another as a
  // person. Until the People read says which it is, nobody is listed (the person picker's rule).
  const shared = operator && self.mode === "shared"
  const you = operator && self.mode === "single" ? self.you : null
  const others = operator && !self.ready ? [] : people.filter((person) => memberIdentity(person.id) !== me && person.id !== you?.id)
  return { me, people: others, offerOperator: !operator, you, meLabel: shared ? SHARED_OPERATOR_LABEL : "Me" }
}

/** What the Person filter reads when set: "Me" (or the shared desk), "No person", the person's name; null when unset. */
export function personFilterLabel(person: string | undefined, choices: PersonFilterChoices): string | null {
  if (!person) return null
  if (person === choices.me) return choices.meLabel ?? "Me"
  if (person === OPERATOR_ASSIGNEE) return "Operator"
  if (person === UNASSIGNED_FILTER) return "No person"
  const match = [...choices.people, ...(choices.you ? [choices.you] : [])].find((choice) => memberIdentity(choice.id) === person)
  return match?.displayName ?? "Someone else"
}
