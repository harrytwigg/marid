import { useContext, useMemo } from "react"
import { QueryClient, QueryClientContext, useQuery } from "@tanstack/react-query"
import { accountsApi, initialsOf, type PersonWire } from "@/lib/accounts-api"
import { useAuthOptional } from "@/routes/auth-provider"
import { PEOPLE_KEY } from "@/routes/settings/people/use-people"
import type { PersonChoice } from "./use-person-choices"

/** What `@operator` reads as to the operator's own view of the board. */
export type OperatorSelfMode =
  /** No active owner account (no accounts at all, or members only): "You (operator)" and the operator's emoji, as always. */
  | "legacy"
  /** Exactly one active owner: the operator is that account, by name and avatar. */
  | "single"
  /** Several active owners: the desk belongs to all of them, so it is "Operator (shared)" with the operator's emoji. */
  | "shared"

export interface OperatorSelf {
  mode: OperatorSelfMode
  /** The active instance-owner accounts; empty in legacy mode. */
  owners: PersonChoice[]
  /** The account this browser is: its own sign-in when that is an active owner, else the only owner, else nobody. */
  you: PersonChoice | null
  /** `@operator` as a name. */
  label: string
}

export const LEGACY_OPERATOR_LABEL = "You (operator)"
export const SHARED_OPERATOR_LABEL = "Operator (shared)"

/** Stands in where a surface renders outside a QueryClientProvider (a bare card or chip in a test): never asked, so never used. */
const UNPROVIDED_CLIENT = new QueryClient()

const LEGACY: OperatorSelf = { mode: "legacy", owners: [], you: null, label: LEGACY_OPERATOR_LABEL }

/** The reading of `@operator` for a People list and the owner account this browser is signed in as (if any). */
export function deriveOperatorSelf(people: PersonWire[] | undefined, signedInAs: string | undefined): OperatorSelf {
  if (!people) return LEGACY
  const owners: PersonChoice[] = people
    .filter((person) => person.status === "active" && person.instanceRole === "owner")
    .map((person) => ({ id: person.id, displayName: person.displayName, initials: person.initials || initialsOf(person.displayName) }))
  if (owners.length === 0) return LEGACY
  const you = owners.find((owner) => owner.id === signedInAs) ?? (owners.length === 1 ? owners[0]! : null)
  return owners.length === 1
    ? { mode: "single", owners, you, label: owners[0]!.displayName }
    : { mode: "shared", owners, you, label: SHARED_OPERATOR_LABEL }
}

/**
 * Who `@operator` is, for the operator's own pickers, chips and circles. Every owner account signs in to the one operator,
 * and `@operator` is the one desk they share, so once an owner exists the synthetic "You (operator)" stops being a person
 * beside that account (docs/design/board-members.md, "The operator's own account in the person slot"). Asked only of an
 * operator view on an instance that has accounts: without them, and for a board member, it makes no request and answers
 * the legacy reading. The owners come from the People list, the one query the rest of the page shares. A surface that only
 * sometimes names the operator (a card's circle) passes `wanted` false until it does, so it asks nothing for the Todos that don't.
 */
function useOperatorScope(wanted: boolean): { enabled: boolean; signedInAs: string | undefined } {
  const auth = useAuthOptional()
  const principal = auth?.principal
  // The operator's view is every view that is not a board member's (the same split `useViewer` makes).
  return { enabled: wanted && principal?.kind !== "member" && auth?.authState?.hasAccounts === true, signedInAs: principal?.kind === "operator" ? principal.user?.id : undefined }
}

export function useOperatorSelf(wanted = true): OperatorSelf {
  const { enabled, signedInAs } = useOperatorScope(wanted)
  // Cards, chips and circles are small surfaces rendered in many places; one with no provider simply reads as legacy.
  const client = useContext(QueryClientContext) ?? UNPROVIDED_CLIENT
  const query = useQuery({
    queryKey: PEOPLE_KEY,
    enabled,
    staleTime: 30_000,
    queryFn: accountsApi.listPeople,
  }, client)
  const people = enabled ? query.data : undefined
  return useMemo(() => deriveOperatorSelf(people, signedInAs), [people, signedInAs])
}
