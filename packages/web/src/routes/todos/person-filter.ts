import { memberIdentity } from "@/lib/accounts-api"
import { usePersonChoices, type PersonChoice } from "@/hooks/use-person-choices"
import { useAuthOptional } from "@/routes/auth-provider"
import { OPERATOR_ASSIGNEE, UNASSIGNED_FILTER } from "./util"

/** What the Person filter can offer: the viewer as "Me", then everyone else who can hold a Todo here. */
export interface PersonFilterChoices {
  /** The viewer's own identity: the operator, or the signed-in member. */
  me: string
  /** Everyone but the viewer, as the person picker offers them (accounts only). */
  people: PersonChoice[]
  /** A member also reads the operator as a person they may filter on; the operator's own view has "Me" for that. */
  offerOperator: boolean
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
  return { me, people: people.filter((person) => memberIdentity(person.id) !== me), offerOperator: me !== OPERATOR_ASSIGNEE }
}

/** What the Person filter reads when set: "Me", "No person", the person's name; null when unset. */
export function personFilterLabel(person: string | undefined, choices: PersonFilterChoices): string | null {
  if (!person) return null
  if (person === choices.me) return "Me"
  if (person === OPERATOR_ASSIGNEE) return "Operator"
  if (person === UNASSIGNED_FILTER) return "No person"
  const match = choices.people.find((choice) => memberIdentity(choice.id) === person)
  return match?.displayName ?? "Someone else"
}
