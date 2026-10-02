import { sessionPath } from "@/components/chat/chat-route-helpers"
import { filtersToSearchParams, type TodoFilters } from "@/lib/todos"
import { boardPath, parseBoardParam } from "@/routes/todos/board/board-route"
import type { ToolArgs } from "./tool-spec"

/**
 * Tool arguments to a URL. Pure: no router, no React, no DOM — which is what
 * lets a navigation tool commit its route change with nothing awaited in front
 * of it, and lets almost every test in this directory run without a page.
 *
 * Filters are only expressed here where the destination page already holds them
 * in the URL. Nothing in this module invents state a page cannot read back.
 */

function text(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim()
    return trimmed === "" ? undefined : trimmed
  }
  return undefined
}

function segment(value: unknown): string | undefined {
  const raw = text(value)
  return raw === undefined ? undefined : encodeURIComponent(raw)
}

function query(pairs: Array<[string, string | undefined]>): string {
  const search = new URLSearchParams()
  for (const [key, value] of pairs) if (value !== undefined) search.set(key, value)
  const encoded = search.toString()
  return encoded === "" ? "" : `?${encoded}`
}

// ── Todos ───────────────────────────────────────────────────────────────────

/** The board filters a voice caller can set. Every one of these round-trips
 *  through `filtersFromSearchParams`, so the board reads back what we wrote. */
function todoFilters(args: ToolArgs): TodoFilters {
  const filters: TodoFilters = { status: (text(args.status) ?? "open") as TodoFilters["status"] }
  const assignee = text(args.assignee)
  if (assignee) filters.assignee = assignee
  const department = text(args.department)
  if (department) filters.department = department
  const source = text(args.source)
  if (source) filters.source = source as TodoFilters["source"]
  const label = text(args.label)
  if (label) filters.label = label
  const due = text(args.due)
  if (due) filters.due = due as TodoFilters["due"]
  const q = text(args.q)
  if (q) filters.q = q
  return filters
}

export function todosPath(args: ToolArgs): string {
  // parseBoardParam falls back to the home board for anything unusable, which is
  // the behaviour a stale department link already gets.
  const board = boardPath(parseBoardParam(text(args.board)))
  return `${board}${query([...filtersToSearchParams(todoFilters(args))])}`
}

export type TodoIdResolution = { id: string } | { error: string }

const PREFIXED_TODO = /^([A-Za-z]{3})[-\s]?(\d+)$/
const BARE_TODO = /^\d+$/

/** "ICI-59", "ici 59" and a bare "59" are all things a voice model produces for
 *  the same Todo. A bare number needs the company prefix the operator's own
 *  Todos are minted under, which the app already holds from `/api/onboarding`. */
export function resolveTodoId(spoken: unknown, companyPrefix: string | null): TodoIdResolution {
  const raw = typeof spoken === "number" ? String(spoken) : text(spoken)
  if (raw === undefined) return { error: 'Give a Todo id, like "ABC-59" or just 59.' }

  const prefixed = PREFIXED_TODO.exec(raw)
  if (prefixed) return { id: `${prefixed[1].toUpperCase()}-${prefixed[2]}` }

  if (BARE_TODO.test(raw)) {
    if (!companyPrefix) {
      return { error: `Say the Todo id with its prefix, like "ABC-${raw}" — this company's default Todo prefix is not loaded yet.` }
    }
    return { id: `${companyPrefix.toUpperCase()}-${raw}` }
  }
  return { error: `"${raw}" is not a Todo id. Todo ids look like "ABC-59", or say the number on its own.` }
}

export function todoPath(id: string): string {
  return `/todos/${encodeURIComponent(id)}`
}

// ── Workflows, Chats, Org, Cron ────────────────────────────────

export function workflowPath(args: ToolArgs): string {
  const id = segment(args.id)
  if (!id) return "/workflow"
  // `editor` is the page's default lens and it writes an empty search string for
  // it (routes/workflow/page.tsx), so naming it here would add a param the page
  // immediately drops.
  return `/workflow/${id}${text(args.lens) === "runs" ? "?lens=runs" : ""}`
}

export function chatPath(args: ToolArgs): string {
  const sessionId = text(args.sessionId)
  return sessionId ? sessionPath(sessionId) : "/"
}

export function orgPath(args: ToolArgs): string {
  return `/org${query([["employee", text(args.employee)]])}`
}

export function cronPath(args: ToolArgs): string {
  const id = segment(args.id)
  // A single job has its own page with neither lens nor filter on it.
  if (id) return `/cron/${id}`
  const lens = text(args.lens)
  const filter = text(args.filter)
  return `/cron${query([
    ["lens", lens === "week" ? lens : undefined],
    ["filter", filter === "enabled" || filter === "disabled" ? filter : undefined],
  ])}`
}
