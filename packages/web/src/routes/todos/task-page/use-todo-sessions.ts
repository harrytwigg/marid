import { useQuery } from "@tanstack/react-query"
import { api, type LinkedSessionWire } from "@/lib/api"
import { getWorkItemSessionTree, sessionTreeQueryKey, type SessionTreeWire } from "@/lib/session-tree-api"

/**
 * Everything the Todo page knows about the sessions working it.
 *
 * Lifted out of task-page.tsx, which sits on its recorded size budget. Both
 * queries key off `work-item-sessions`, which is the point: the gateway event
 * handler invalidates that PREFIX on session created/updated/deleted, so a
 * delegation made while the page is open reaches the tree with no new
 * signalling (`hooks/use-query-invalidation.ts`).
 */

const LIVE_SESSION_STATES = new Set(["running", "waiting"])

export interface TodoSessions {
  sessions: LinkedSessionWire[] | undefined
  tree: SessionTreeWire | undefined
  hasLiveSession: boolean
  /** The session to offer in the rail. The live Todo Dispatcher wins because it
   *  is the durable thread for the Todo, but any linked session is reachable —
   *  a Todo worked by another employee used to offer nothing to click. */
  railSession: LinkedSessionWire | undefined
}

/**
 * Which linked session the rail offers.
 *
 * It used to be "the live todo-dispatcher, or nothing", so a Todo worked by any
 * other employee — or one whose dispatcher had finished — offered nothing to
 * click. The dispatcher still wins when it is live, because it is the durable
 * thread for the Todo; past that, any live session beats a finished one, and a
 * finished one is still worth reaching (an audit reads the attempt that ended).
 */
export function pickRailSession(sessions: readonly LinkedSessionWire[]): LinkedSessionWire | undefined {
  const live = sessions.filter((s) => LIVE_SESSION_STATES.has(s.status ?? ""))
  return live.find((s) => s.employee === "todo-dispatcher") ?? live[0] ?? sessions[0]
}

/** Whether the rail's session is still doing something — the flag that decides
 *  if Dispatch stays on offer. */
export function isLiveSession(session: LinkedSessionWire | undefined): boolean {
  return LIVE_SESSION_STATES.has(session?.status ?? "")
}

export function useTodoSessions(id: string | null | undefined): TodoSessions {
  const { data: sessions } = useQuery({
    queryKey: ["work-item-sessions", id ?? ""],
    queryFn: () => api.listWorkItemSessions(id!),
    enabled: !!id,
    staleTime: 10_000,
  })
  const { data: tree } = useQuery({
    queryKey: sessionTreeQueryKey(id ?? ""),
    queryFn: () => getWorkItemSessionTree(id!),
    enabled: !!id,
    staleTime: 10_000,
  })
  const all = sessions ?? []
  return {
    sessions,
    tree,
    hasLiveSession: all.some((s) => LIVE_SESSION_STATES.has(s.status ?? "")),
    railSession: pickRailSession(all),
  }
}
