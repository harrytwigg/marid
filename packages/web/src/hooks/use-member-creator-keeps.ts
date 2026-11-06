import { useQuery } from "@tanstack/react-query"
import { accountsApi, memberIdOf, type BoardRole, type BoardRosterWire, type PersonWire } from "@/lib/accounts-api"
import type { WorkItemDetailWire } from "@/lib/api"
import { useTodoById } from "@/routes/todos/use-todos"
import { useAuthOptional } from "@/routes/auth-provider"

/** What a board member who created a Todo keeps once the operator assigns or moves it: comment and read, read only, or nothing. */
export type CreatorKeeps = "comment" | "read" | "none"

export interface MemberCreator {
  /** The member's `user:<id>`. */
  identity: string
  keeps: CreatorKeeps
}

/** The board a root was filed on, from its `created` event; null for one with none recorded. */
function filedOnBoard(root: WorkItemDetailWire | null | undefined): string | null {
  const recorded = root?.events.find((event) => event.kind === "created")?.detail?.createdOnBoard
  return typeof recorded === "string" && recorded !== "" ? recorded : null
}

/** What a creator keeps by their role on the board they filed it on; no role (no longer on that board) keeps nothing. */
function keepsFor(role: BoardRole | undefined): CreatorKeeps {
  if (role === undefined) return "none"
  return role === "viewer" ? "read" : "comment"
}

/** The answer once its sources are in: null while any is still on its way. A disabled account keeps nothing, whatever the roster still lists. */
function resolveKeeps(
  identity: string,
  sources: { root: WorkItemDetailWire | null | undefined; board: string | null; roster: BoardRosterWire | undefined; people: PersonWire[] | undefined },
): MemberCreator | null {
  const { root, board, roster, people } = sources
  if (root && board === null) return { identity, keeps: "none" }
  if (!roster || !people) return null
  const userId = memberIdOf(identity)
  if (people.find((person) => person.id === userId)?.status === "disabled") return { identity, keeps: "none" }
  return { identity, keeps: keepsFor(roster.members.find((member) => member.userId === userId)?.role) }
}

/** The reads the answer rests on: the root's own record, the board it was filed on, that board's roster, and the people list (for account status). */
function useCreatorSources(active: boolean, rootId: string | undefined) {
  const root = useTodoById(active ? (rootId as string) : null)
  const board = filedOnBoard(root.data)
  const boardKnown = active && board !== null
  const roster = useQuery({
    queryKey: ["board-roster", "operator", board ?? ""],
    queryFn: () => accountsApi.getBoardRoster(board!),
    enabled: boardKnown,
    staleTime: 30_000,
    retry: false,
  })
  const people = useQuery({ queryKey: ["people"], queryFn: accountsApi.listPeople, enabled: boardKnown, staleTime: 30_000, retry: false })
  return { root: root.data, board, roster: roster.data, people: people.data }
}

/**
 * What the creator of a root keeps, as the gateway will decide it: creator access is anchored to the board the root was
 * filed on (recorded on its `created` event). A creator who holds that board as a collaborator or owner keeps reading and
 * commenting; as a viewer, reading only; one who no longer holds it, is disabled, or whose root has no recorded board, keeps
 * nothing. Null until every read has answered, or when there is no member creator: a note is never shown on a guess. Only the
 * operator asks.
 */
export function useMemberCreator(identity: string | null, rootId: string | undefined): MemberCreator | null {
  const accountsEnabled = useAuthOptional()?.authState?.accountsEnabled === true
  const active = identity !== null && !!rootId && accountsEnabled
  const sources = useCreatorSources(active, rootId)
  return active && identity !== null ? resolveKeeps(identity, sources) : null
}
