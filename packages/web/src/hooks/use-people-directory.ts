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
/** Whether this session can ask for people at all, and as whom: a member always can, the operator only where accounts exist. */
function useDirectoryAccess(): { member: boolean; accounts: boolean } {
  const auth = useAuthOptional()
  const member = auth?.principal?.kind === "member"
  const state = auth?.authState
  return { member, accounts: member || (state?.accountsEnabled === true && state.hasAccounts === true) }
}

async function loadDirectory(member: boolean): Promise<DirectoryData> {
  if (member) return accountsApi.getMemberPeople()
  const people = await accountsApi.listPeople()
  return { people: people.map((p) => ({ id: p.id, displayName: p.displayName, initials: p.initials })), employees: [] }
}

/** `settled` means no answer is coming (the directory is off, or its read failed): an id not in it is then a former member, not a name still on its way. */
function resolveIdentity(people: DirectoryData["people"] | undefined, identity: string | null | undefined, settled: boolean): ResolvedIdentity | null {
  const id = memberIdOf(identity)
  if (id === null) return null
  if (!people) return settled ? { kind: "former" } : { kind: "pending" }
  const person = people.find((p) => p.id === id)
  if (!person) return { kind: "former" }
  return { kind: "member", id, displayName: person.displayName, initials: person.initials || initialsOf(person.displayName) }
}

export function usePeopleDirectory(): PeopleDirectory {
  const { member, accounts } = useDirectoryAccess()
  const query = useQuery<DirectoryData>({
    queryKey: [...PEOPLE_DIRECTORY_KEY, member ? "member" : "operator"],
    enabled: accounts,
    staleTime: 60_000,
    queryFn: () => loadDirectory(member),
  })
  const people = query.data?.people
  const settled = !accounts || query.isError
  const resolve = useCallback((identity: string | null | undefined) => resolveIdentity(people, identity, settled), [people, settled])
  return { resolve, employees: query.data?.employees ?? [], ready: !accounts || query.isSuccess }
}
