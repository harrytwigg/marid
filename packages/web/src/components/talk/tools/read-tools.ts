import type { QueryKey } from "@tanstack/react-query"
import { api } from "@/lib/api"
import { queryClient } from "@/lib/query-client"
import { queryKeys } from "@/lib/query-keys"
import { trimSession, trimTodo } from "./read-shapes"
import { params, str, type TalkTool, type ToolArgs, type ToolResult } from "./tool-spec"

/**
 * Reads over company state, served from the cache the app's own pages fill.
 *
 * Each tool reads the exact query key its page uses, so the page and the orb can
 * never disagree about what is true. A present entry answers immediately even
 * once it is stale: the operator is asking about what is on their screen, and a
 * refetch would stall a voice turn on the network to re-learn it. Only a genuine
 * miss goes to the gateway, and what comes back fills that same entry.
 */

async function cached<T>(key: QueryKey, fetch: () => Promise<T>): Promise<T> {
  const held = queryClient.getQueryData<T>(key)
  if (held !== undefined) return held
  return queryClient.fetchQuery({ queryKey: key, queryFn: fetch, staleTime: 0 })
}

/** The two keys a session's rows arrive under — `trimSession` reads either. */
function carriesMessages(held: unknown): boolean {
  const session = (held ?? {}) as Record<string, unknown>
  return Array.isArray(session.messages) || Array.isArray(session.history)
}

/**
 * The session key is one the app also fills with a PARTIAL shape: a page that
 * fetched it with `messages: false` left an entry that cannot say what was
 * said. Refilling it goes around `fetchQuery` deliberately, because react-query
 * deduplicates by key — a partial request that page still has open would answer
 * this one with its own half of the object. Writing the result back leaves the
 * page's own entry whole.
 */
async function fetchWholeSession(id: string, key: QueryKey): Promise<unknown> {
  const session = await api.getSession(id, { last: 6 })
  queryClient.setQueryData(key, session)
  return session
}

function failed(subject: string, error: unknown): ToolResult {
  const why = error instanceof Error && error.message ? error.message : "the gateway did not answer"
  return { ok: false, error: `Could not read ${subject}: ${why}.` }
}

const readTodo: TalkTool = {
  name: "read_todo",
  description: "Read one Todo: its status, assignee, labels, body, and most recent comments.",
  parameters: params(
    { id: str("The full Todo id, such as \"ABC-59\"."), comments: { type: "boolean", description: "Include the recent comments. Defaults to true." } },
    ["id"],
  ),
  execute: async (args: ToolArgs): Promise<ToolResult> => {
    const id = String(args.id)
    try {
      const detail = await cached(["work-item", id], () => api.getWorkItem(id))
      if (!detail) return { ok: false, error: `Todo ${id} does not exist.` }
      return { ok: true, data: trimTodo(detail, args.comments !== false) }
    } catch (error) {
      return failed(`Todo ${id}`, error)
    }
  },
}

const readSession: TalkTool = {
  name: "read_session",
  description: "Read one chat session: who is on it, whether it is running, and the last few messages.",
  parameters: params({ id: str("The session id.") }, ["id"]),
  execute: async (args: ToolArgs): Promise<ToolResult> => {
    const id = String(args.id)
    const key = queryKeys.sessions.detail(id)
    try {
      const held = queryClient.getQueryData(key)
      const raw = carriesMessages(held) ? held : await fetchWholeSession(id, key)
      return { ok: true, data: trimSession(raw as Record<string, unknown>, id) }
    } catch (error) {
      return failed(`session ${id}`, error)
    }
  },
}

export const READ_TOOLS: readonly TalkTool[] = [readTodo, readSession]
