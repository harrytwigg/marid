import { useCallback } from "react"
import { useQuery } from "@tanstack/react-query"
import { accountsApi, initialsOf, memberIdOf, type MemberEmployeeRefWire, type PersonRefWire } from "@/lib/accounts-api"
import { useAuthOptional } from "@/routes/auth-provider"

export const PEOPLE_DIRECTORY_KEY = ["people-directory"] as const

export type ResolvedIdentity =
  | { kind: "member"; id: string; displayName: string; initials: string }
  | { kind: "former" }
  /** The directory has not answered yet: show nothing rather than a wrong name. */
  | { kind: "pending" }

export const FORMER_MEMBER = "Former member"

export function identityLabel(resolved: ResolvedIdentity): string {
  return resolved.kind === "member" ? resolved.displayName : resolved.kind === "former" ? FORMER_MEMBER : ""
}

export interface PeopleDirectory {
  /** Resolves `user:<id>`; null for any other identity (an employee, the operator, a session). */
  resolve: (identity: string | null | undefined) => ResolvedIdentity | null
  employees: MemberEmployeeRefWire[]
  ready: boolean
}

interface DirectoryData {
  people: PersonRefWire[]
  employees: MemberEmployeeRefWire[]
}

/** Who a `user:<id>` is. Read only where accounts exist, so an instance without any asks nothing new. */
export function usePeopleDirectory(): PeopleDirectory {
  const auth = useAuthOptional()
  const member = auth?.principal?.kind === "member"
  const accounts = member || (auth?.authState?.accountsEnabled === true && auth.authState.hasAccounts === true)
  const query = useQuery<DirectoryData>({
    queryKey: [...PEOPLE_DIRECTORY_KEY, member ? "member" : "operator"],
    enabled: accounts,
    staleTime: 60_000,
    queryFn: async () => {
      if (member) return accountsApi.getMemberPeople()
      const people = await accountsApi.listPeople()
      return { people: people.map((p) => ({ id: p.id, displayName: p.displayName, initials: p.initials })), employees: [] }
    },
  })
  const people = query.data?.people
  const resolve = useCallback((identity: string | null | undefined): ResolvedIdentity | null => {
    const id = memberIdOf(identity)
    if (id === null) return null
    if (!people) return { kind: "pending" }
    const person = people.find((p) => p.id === id)
    if (!person) return { kind: "former" }
    return { kind: "member", id, displayName: person.displayName, initials: person.initials || initialsOf(person.displayName) }
  }, [people])
  return { resolve, employees: query.data?.employees ?? [], ready: !accounts || query.isSuccess }
}
