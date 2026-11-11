import { useQuery } from "@tanstack/react-query"
import { accountsApi, initialsOf } from "@/lib/accounts-api"
import { useAuthOptional } from "@/routes/auth-provider"

export interface PersonChoice {
  id: string
  displayName: string
  initials: string
}

async function fetchPersonChoices(member: boolean, board: string | null | undefined, everyone: boolean | undefined): Promise<PersonChoice[]> {
  if (member) return (await accountsApi.getMemberPeople(board ?? undefined)).people
  const people = await accountsApi.listPeople()
  // An instance owner can be named on any Todo; a board's members only on that board, so a Todo with no board offers owners alone.
  const onBoard = (person: (typeof people)[number]) => person.instanceRole === "owner" || (!!board && person.boards.some((grant) => grant.department === board))
  return people
    .filter((person) => person.status === "active" && (everyone || onBoard(person)))
    .map((person) => ({ id: person.id, displayName: person.displayName, initials: person.initials || initialsOf(person.displayName) }))
}

/**
 * The people who can be named as the person responsible for a Todo on a board (the Todo's root board, not a sub-task's own
 * department). The operator reads the People list and keeps those with a grant on the board (or who own the instance); a member reads the people on that one board. Asked only where accounts exist: an instance without
 * them has the operator to choose and nothing else, and makes no request (`asked` is false).
 *
 * `everyone` offers every active person, not only the board's: a view across boards (the Everything board's Person filter)
 * holds Todos from all of them.
 */
export function usePersonChoices(board: string | null | undefined, everyone?: boolean): { people: PersonChoice[]; ready: boolean; asked: boolean } {
  const auth = useAuthOptional()
  const member = auth?.principal?.kind === "member"
  const enabled = member || auth?.authState?.hasAccounts === true
  const query = useQuery({
    queryKey: ["person-choices", member ? "member" : "operator", board ?? "", !!everyone],
    enabled,
    staleTime: 30_000,
    queryFn: () => fetchPersonChoices(member, board, everyone),
  })
  return { people: query.data ?? [], ready: !enabled || query.isSuccess, asked: enabled }
}
