import { useQuery } from "@tanstack/react-query"
import { accountsApi, initialsOf } from "@/lib/accounts-api"
import { useAuthOptional } from "@/routes/auth-provider"

export interface PersonChoice {
  id: string
  displayName: string
  initials: string
}

/**
 * The people who can be named as the person responsible for a Todo on a board. The operator reads the People list and
 * keeps those with a grant on the board (or who own the instance); a member reads the people on their own boards, and
 * the gateway refuses anyone who has no access to this one. Asked only where accounts exist: an instance without
 * them has the operator to choose and nothing else, and makes no request.
 */
export function usePersonChoices(board: string | null | undefined): { people: PersonChoice[]; ready: boolean } {
  const auth = useAuthOptional()
  const member = auth?.principal?.kind === "member"
  const enabled = member || auth?.authState?.accountsEnabled === true
  const query = useQuery({
    queryKey: ["person-choices", member ? "member" : "operator", board ?? ""],
    enabled,
    staleTime: 30_000,
    queryFn: async (): Promise<PersonChoice[]> => {
      if (member) return (await accountsApi.getMemberPeople()).people
      const people = await accountsApi.listPeople()
      return people
        .filter((person) => person.status === "active" && (person.instanceRole === "owner" || person.boards.some((grant) => grant.department === board)))
        .map((person) => ({ id: person.id, displayName: person.displayName, initials: person.initials || initialsOf(person.displayName) }))
    },
  })
  return { people: query.data ?? [], ready: !enabled || query.isSuccess }
}
