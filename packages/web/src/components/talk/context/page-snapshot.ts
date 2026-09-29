/**
 * Where the operator is, read straight off the URL.
 *
 * Almost every Jinn surface already keeps "what you are looking at" in the
 * location — the board and its filters, the open Todo, the workflow run, the
 * selected chat session — so the orb can be told without asking the page
 * anything. This is `tools/nav-paths.ts` in reverse, and it holds to the same
 * rule: nothing here invents state a page does not actually carry in its URL.
 *
 * Pure. No React, no DOM, no fetch — which is what lets the router publish a
 * snapshot from a subscription and lets every case be tested without a page.
 */
import { resolveDeepLink } from "@/components/chat/chat-route-helpers"
import { filtersFromSearchParams } from "@/lib/todos"
import { parseBoardParam, boardKey } from "@/routes/todos/board/board-route"
import { parseNotesLocation } from "@/routes/notes/notes-route"
import type { PageKind, PageSnapshot } from "./screen-context-types"

export type {
  PageKind,
  PageSelection,
  PageSnapshot,
  SemanticControl,
  SemanticObject,
  SemanticRelation,
  SemanticVisibleItem,
  TalkScreenContext,
} from "./screen-context-types"

/** Everything but the path, which `describeLocation` fills for every branch.
 *  `null` is "no declared route matches this", which the app renders as the
 *  plugin splat and the snapshot reports as its path alone. */
type View = Omit<PageSnapshot, "path"> | null

const UNKNOWN: Omit<PageSnapshot, "path"> = { kind: "other", params: {}, filters: {}, selection: null }

/** A path segment can be any bytes the operator pasted, and a lone `%` throws.
 *  A segment we cannot decode is still the segment they are looking at. */
function decode(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

function segmentsOf(pathname: string): string[] {
  return pathname.split("/").filter(Boolean).map(decode)
}

/** Only the entries that carry something. An empty string in the snapshot reads
 *  as a filter set to nothing, which is not what an absent one means. */
function present(entries: Array<[string, string | undefined | null]>): Record<string, string> {
  const kept: Record<string, string> = {}
  for (const [key, value] of entries) {
    const text = value?.trim()
    if (text) kept[key] = text
  }
  return kept
}

function todosView(rest: string[], params: URLSearchParams): View {
  // /todos/:todoId is the task page; /todos/b/:board and bare /todos are boards.
  if (rest.length === 1 && rest[0] !== "b") {
    return { kind: "todo", params: {}, filters: {}, selection: { kind: "Todo", id: rest[0] } }
  }
  if (rest.length > 0 && !(rest.length === 2 && rest[0] === "b")) return null

  const filters = filtersFromSearchParams(params)
  return {
    kind: "todos",
    params: { board: boardKey(parseBoardParam(rest[1])) },
    filters: present([
      ["status", filters.status],
      ["assignee", filters.assignee],
      ["department", filters.department],
      ["source", filters.source],
      ["date", filters.date],
      ["label", filters.label],
      ["due", filters.due],
      ["q", filters.q],
    ]),
    selection: null,
  }
}

function workflowView(rest: string[], params: URLSearchParams): View {
  const id = rest[0]
  if (!id) return { kind: "workflows", params: {}, filters: {}, selection: null }
  if (rest.length === 3 && rest[1] === "runs") {
    return { kind: "workflow-run", params: { workflow: id }, filters: {}, selection: { kind: "workflow run", id: rest[2] } }
  }
  if (rest.length > 1) return null
  // `editor` is the page's default lens and it writes no param for it, so the
  // runs lens is the only one ever in the URL to report.
  return {
    kind: "workflow",
    params: {},
    filters: present([["lens", params.get("lens") === "runs" ? "runs" : null]]),
    selection: { kind: "workflow", id },
  }
}

function chatView(params: URLSearchParams): View {
  // Same precedence the chat page itself resolves by: a session id beats an
  // employee, because it is the more specific intent.
  const link = resolveDeepLink(params)
  const selection =
    link?.kind === "session" ? { kind: "chat session", id: link.id }
    : link?.kind === "employee" ? { kind: "employee", id: link.name }
    : null
  return { kind: "chat", params: {}, filters: {}, selection }
}

function cronView(rest: string[], params: URLSearchParams): View {
  if (rest.length > 1) return null
  const jobId = rest[0]
  if (jobId) return { kind: "cron", params: {}, filters: {}, selection: { kind: "cron job", id: jobId } }
  return {
    kind: "cron",
    params: {},
    filters: present([["lens", params.get("lens")], ["filter", params.get("filter")]]),
    selection: null,
  }
}

function notesView(pathname: string): View {
  const notes = parseNotesLocation(pathname)
  return {
    kind: "notes",
    params: present([["folder", notes.folder]]),
    filters: {},
    selection: notes.notePath ? { kind: "note", id: notes.notePath } : null,
  }
}

/** A list route and its detail route differ only by whether the id is there. */
function listOrDetail(list: PageKind, detail: PageKind, selectionKind: string, id: string | undefined): View {
  if (!id) return { kind: list, params: {}, filters: {}, selection: null }
  return { kind: detail, params: {}, filters: {}, selection: { kind: selectionKind, id } }
}

function experimentsView(rest: string[]): View {
  if (rest.length > 1) return null
  return listOrDetail("experiments", "experiment", "experiment", rest[0])
}

/** Org keeps the open employee in the query string, so it is one route deep
 *  whether or not anything is selected. */
function orgView(rest: string[], params: URLSearchParams): View {
  if (rest.length > 0) return null
  return listOrDetail("org", "org", "employee", params.get("employee")?.trim())
}

function staticView(kind: PageKind, rest: string[]): View {
  return rest.length === 0 ? { kind, params: {}, filters: {}, selection: null } : null
}

function skillView(rest: string[]): View {
  if (rest.length > 1) return null
  return listOrDetail("skills", "skill", "skill", rest[0])
}

function fileView(rest: string[], params: URLSearchParams): View {
  if (rest.length > 0) return null
  const path = params.get("path")?.trim()
  return {
    kind: "file",
    params: {},
    filters: {},
    selection: path ? { kind: "published file", id: path } : null,
  }
}

type RouteReader = (rest: string[], params: URLSearchParams, pathname: string) => View

function settingsView(rest: string[]): View {
  if (rest.length === 0) return staticView("settings", rest)
  return rest.length === 1 && rest[0] === "plugins" ? staticView("settings-plugins", []) : null
}

function redirectView(head: "chat" | "kanban", rest: string[]): View {
  if (rest.length > 0) return null
  return { kind: head === "chat" ? "chat" : "todos", params: {}, filters: {}, selection: null }
}

const ROUTE_READERS: Readonly<Record<string, RouteReader>> = {
  todos: (rest, params) => todosView(rest, params),
  workflow: (rest, params) => workflowView(rest, params),
  experiments: (rest) => experimentsView(rest),
  cron: (rest, params) => cronView(rest, params),
  org: (rest, params) => orgView(rest, params),
  notes: (_rest, _params, pathname) => notesView(pathname),
  logs: (rest) => staticView("logs", rest),
  limits: (rest) => staticView("limits", rest),
  "auto-dispatch": (rest) => staticView("auto-dispatch", rest),
  settings: (rest) => settingsView(rest),
  skills: (rest) => skillView(rest),
  file: (rest, params) => fileView(rest, params),
  more: (rest) => staticView("more", rest),
  "talk-orb": (rest) => staticView("talk-orb", rest),
  redesign: (rest) => staticView("redesign", rest),
  chat: (rest) => redirectView("chat", rest),
  kanban: (rest) => redirectView("kanban", rest),
}

/**
 * Describe a location. Anything unrecognised comes back as its path and nothing
 * else — a route this parser has not been taught is a page the orb should name
 * the path of, not a reason to take the conversation down. That includes a path
 * that only starts like a route it knows: the depth each branch accepts is the
 * depth the router declares, so `/todos/ABC-744/extra` is an unknown page and
 * not the Todo whose id it happens to contain.
 */
export function describeLocation(pathname: string, search: string): PageSnapshot {
  const params = new URLSearchParams(search)
  const [head, ...rest] = segmentsOf(pathname)
  const view = head === undefined ? chatView(params) : ROUTE_READERS[head]?.(rest, params, pathname) ?? null

  return { ...(view ?? UNKNOWN), path: pathname }
}
