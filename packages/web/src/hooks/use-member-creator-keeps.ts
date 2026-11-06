import { useQuery } from "@tanstack/react-query"
import { accountsApi, memberIdOf, type BoardRole, type BoardRosterWire } from "@/lib/accounts-api"
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

/** The answer once its sources are in: null while either is still on its way. */
function resolveKeeps(identity: string, root: WorkItemDetailWire | null | undefined, board: string | null, roster: BoardRosterWire | undefined): MemberCreator | null {
  if (root && board === null) return { identity, keeps: "none" }
  if (!roster) return null
  const userId = memberIdOf(identity)
  return { identity, keeps: keepsFor(roster.members.find((member) => member.userId === userId)?.role) }
}

/**
 * What the creator of a root keeps, as the gateway will decide it: creator access is anchored to the board the root was
 * filed on (recorded on its `created` event). A creator who holds that board as a collaborator or owner keeps reading and
 * commenting; as a viewer, reading only; one who no longer holds it, or a root with no recorded board, keeps nothing. Null
 * until both the root's record and that board's roster have answered, or when there is no member creator: a note is
 * never shown on a guess. Only the operator asks.
 */
export function useMemberCreator(identity: string | null, rootId: string | undefined): MemberCreator | null {
  const accountsEnabled = useAuthOptional()?.authState?.accountsEnabled === true
  const active = identity !== null && !!rootId && accountsEnabled
  const root = useTodoById(active ? (rootId as string) : null)
  const board = filedOnBoard(root.data)
  const roster = useQuery({
    queryKey: ["board-roster", "operator", board ?? ""],
    queryFn: () => accountsApi.getBoardRoster(board!),
    enabled: active && board !== null,
    staleTime: 30_000,
    retry: false,
  })
  return active && identity !== null ? resolveKeeps(identity, root.data, board, roster.data) : null
}
