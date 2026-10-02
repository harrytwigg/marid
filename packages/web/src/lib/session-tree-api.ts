import { get } from "./api"

/**
 * The tree a Todo caused, as the gateway serves it.
 *
 * These types live outside `lib/api.ts` because that file sits exactly on its
 * recorded size budget (`size-baseline.json`), and the ratchet only tightens.
 * They mirror `packages/jinn/src/sessions/session-tree.ts` — change both.
 *
 * `LinkedSessionWire` is deliberately left alone: `parentSessionId`,
 * `workItemId` and `workItemRole` already arrive on it through its index
 * signature (the gateway spreads the whole session), and nothing reads them off
 * the flat shape — the tree carries its own.
 */

/** One session in the tree. */
export interface SessionTreeNodeWire {
  id: string
  employee: string | null
  status: string | null
  title: string | null
  role: "execute" | "review" | "consult"
  workItemId: string | null
  isRootLink: boolean
  archived: boolean
  /** Set on the node whose children the depth or count bound withheld, so the
   *  operator is told rather than shown a short tree. */
  truncated: { reason: "depth" | "count" } | null
  children: SessionTreeNodeWire[]
}

/** Identity for a session id the Todo names, in the tree or not — the session
 *  that MINTED a Todo need not be linked to it, and the rail still has to show
 *  a name instead of a raw id. */
export interface SessionDirectoryEntryWire {
  id: string
  employee: string | null
  status: string | null
  title: string | null
  archived: boolean
  missing: boolean
}

export interface SessionTreeWire {
  roots: SessionTreeNodeWire[]
  directory: Record<string, SessionDirectoryEntryWire>
  truncated: { depth: boolean; count: boolean }
  totals: { nodes: number; live: number }
}

/** One call for the whole tree. The per-node route (`/api/sessions/:id/children`)
 *  exists, but walking with it is a round trip per node with no bound on depth. */
export function getWorkItemSessionTree(id: string): Promise<SessionTreeWire> {
  return get<SessionTreeWire>(`/api/work-items/${encodeURIComponent(id)}/sessions?tree=1`)
}

/** The query key. It begins with `work-item-sessions` on purpose: the gateway
 *  event handler already invalidates that PREFIX on session created/updated/
 *  deleted (`hooks/use-query-invalidation.ts`), so the tree follows a delegation
 *  made while the page is open without any new signalling. */
export function sessionTreeQueryKey(todoId: string): [string, string, string] {
  return ["work-item-sessions", todoId, "tree"]
}

/** The `session:` prefix a Todo's `createdBy`, comment authors and audit actors
 *  carry. Anything else is not a session reference. */
export function sessionIdFromActor(actor: string | null | undefined): string | null {
  if (typeof actor !== "string" || !actor.startsWith("session:")) return null
  return actor.slice("session:".length).trim() || null
}
