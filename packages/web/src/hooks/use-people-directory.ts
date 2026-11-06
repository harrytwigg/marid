import { useCallback, useEffect, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
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
  /** When the directory last answered (data or error), 0 before it has. */
  answeredAt: number
}

interface DirectoryData {
  people: PersonRefWire[]
  employees: MemberEmployeeRefWire[]
}

/** Whether this session can ask for people at all, and as whom: a member always can, the operator wherever accounts are
 *  enabled. Not only where some exist: a page opened before the first account would otherwise never ask, and every
 *  `user:` id that appears after the first invite is accepted would read as a former member until a reload. A surface
 *  only asks when it shows a `user:` id, so an instance without accounts still asks nothing new. */
function useDirectoryAccess(): { member: boolean; accounts: boolean } {
  const auth = useAuthOptional()
  const member = auth?.principal?.kind === "member"
  return { member, accounts: member || auth?.authState?.accountsEnabled === true }
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

function directoryKey(member: boolean) {
  return [...PEOPLE_DIRECTORY_KEY, member ? "member" : "operator"] as const
}

export function usePeopleDirectory(): PeopleDirectory {
  const { member, accounts } = useDirectoryAccess()
  const query = useQuery<DirectoryData>({
    queryKey: directoryKey(member),
    enabled: accounts,
    staleTime: 60_000,
    queryFn: () => loadDirectory(member),
  })
  const people = query.data?.people
  const settled = !accounts || query.isError
  const resolve = useCallback((identity: string | null | undefined) => resolveIdentity(people, identity, settled), [people, settled])
  return {
    resolve,
    employees: query.data?.employees ?? [],
    ready: !accounts || query.isSuccess,
    answeredAt: Math.max(query.dataUpdatedAt, query.errorUpdatedAt),
  }
}

/** Resolve one `user:` id for a surface that shows it. A directory read before this surface appeared may predate the person
 *  (someone accepted an invite since), so an id it lacks is asked about once more before it is called a former member; the
 *  answer is pending meanwhile, and every surface asking at once shares the one read. */
export function useResolvedIdentity(identity: string): ResolvedIdentity {
  const { member, accounts } = useDirectoryAccess()
  const directory = usePeopleDirectory()
  const queryClient = useQueryClient()
  const [shownAt] = useState(() => Date.now())
  const resolved = directory.resolve(identity) ?? { kind: "former" as const }
  // Only a `user:<id>` can be someone the directory has not caught up with; anything else is never worth a re-read.
  const recheck = accounts && memberIdOf(identity) !== null && resolved.kind === "former"
    && directory.answeredAt > 0 && directory.answeredAt < shownAt
  useEffect(() => {
    if (recheck) void queryClient.refetchQueries({ queryKey: directoryKey(member), exact: true }, { cancelRefetch: false })
  }, [recheck, queryClient, member])
  return recheck ? { kind: "pending" } : resolved
}
