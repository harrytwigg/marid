import { useCallback } from "react"
import { useQuery } from "@tanstack/react-query"
import { accountsApi, initialsOf, type PersonWire } from "@/lib/accounts-api"
import { useAuthOptional } from "@/routes/auth-provider"
import { PEOPLE_KEY } from "@/routes/settings/people/use-people"

export interface PersonChoice {
  id: string
  displayName: string
  initials: string
}

/**
 * The people who can be named as the person responsible for a Todo on a board (the Todo's root board, not a sub-task's own
 * department). The operator reads the People list and keeps those with a grant on the board (or who own the instance); a member reads the people on that one board. Asked only where accounts exist: an instance without
 * them has the operator to choose and nothing else, and makes no request (`asked` is false).
 *
 * The operator's choices are a view of the People query itself (the one `useOperatorSelf` reads the owners from), never a read
 * of their own, so the people offered and who the operator is are always answered by the same data.
 */
export function usePersonChoices(board: string | null | undefined): { people: PersonChoice[]; ready: boolean; asked: boolean } {
  const { member, operatorAsked } = useChoicesAccess()
  const memberQuery = useQuery({
    queryKey: ["person-choices", "member", board ?? ""],
    enabled: member,
    staleTime: 30_000,
    queryFn: async (): Promise<PersonChoice[]> => (await accountsApi.getMemberPeople(board ?? undefined)).people,
  })
  const operatorQuery = useOperatorChoices(board, operatorAsked)
  const query = member ? memberQuery : operatorQuery
  const asked = member || operatorAsked
  return { people: query.data ?? [], ready: !asked || query.isSuccess, asked }
}

function useChoicesAccess(): { member: boolean; operatorAsked: boolean } {
  const auth = useAuthOptional()
  const member = auth?.principal?.kind === "member"
  return { member, operatorAsked: !member && auth?.authState?.hasAccounts === true }
}

function useOperatorChoices(board: string | null | undefined, enabled: boolean) {
  // An instance owner can be named on any Todo; a board's members only on that board, so a Todo with no board offers owners alone.
  const choose = useCallback((people: PersonWire[]): PersonChoice[] => people
    .filter((person) => person.status === "active" && (person.instanceRole === "owner" || (!!board && person.boards.some((grant) => grant.department === board))))
    .map((person) => ({ id: person.id, displayName: person.displayName, initials: person.initials || initialsOf(person.displayName) })), [board])
  return useQuery({ queryKey: PEOPLE_KEY, enabled, staleTime: 30_000, queryFn: accountsApi.listPeople, select: choose })
}
