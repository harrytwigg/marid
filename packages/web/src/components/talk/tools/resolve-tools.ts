import { api } from "@/lib/api"
import { chatPath, todoPath } from "./nav-paths"
import { companyTodoPrefix, go } from "./navigate-tools"
import {
  looksLikeId,
  rankCandidates,
  searchTerms,
  spokenId,
  viewPrefix,
  type Candidate,
  type CandidateKind,
  type RankedCandidate,
} from "./resolve"
import { params, str, type TalkTool, type ToolArgs, type ToolResult } from "./tool-spec"

/**
 * One way in for "open the thing I just named".
 *
 * The operator says an id, a bare number, or their own words, and this turns
 * any of the three into a route. An id costs no request and commits its route
 * change with nothing awaited in front of it, like the navigation tools. Words
 * cost a search per distinctive word plus the two lists that have no search
 * route, which is why they are the slower path — and when several things fit
 * them the tool answers with a short ranked list so Aurora can ask out loud,
 * because silently picking rank one would be dishonest.
 */

/** Enough candidates to distinguish out loud without turning into a catalogue. */
const SPOKEN_CANDIDATES = 5
const SEARCH_LIMIT = 20

const KIND_LABEL: Record<CandidateKind, string> = {
  todo: "Todo",
  session: "Chat",
}

/** Distinct per ask, so the sheet keys its entrance on each new question. */

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function pathFor(candidate: Candidate): string {
  switch (candidate.kind) {
    case "todo":
      return todoPath(candidate.id)
    case "session":
      return chatPath({ sessionId: candidate.id })
  }
}

/** A word of a title reaches the same object as the word beside it does, and a
 *  repeat would read on the sheet as a second thing to choose between. */
function distinct(candidates: readonly Candidate[]): Candidate[] {
  const byKey = new Map<string, Candidate>()
  for (const candidate of candidates) byKey.set(`${candidate.kind}:${candidate.id}`, candidate)
  return [...byKey.values()]
}

/**
 * Everything the two surfaces can offer for the spoken terms, flattened.
 *
 * Todos and sessions are searched once per term. A source that fails takes the
 * whole resolution down with it rather than quietly shrinking the field: a
 * "nothing matched" that really meant "one search errored" would send the
 * operator looking for something that is there.
 */
async function candidatesFor(terms: readonly string[]): Promise<Candidate[]> {
  const [todos, sessions] = await Promise.all([
    Promise.all(terms.map((term) => api.searchWorkItems({ text: term, limit: SEARCH_LIMIT }))),
    Promise.all(terms.map((term) => api.searchSessions(term))),
  ])
  return distinct([
    ...todos.flatMap((page) => page.workItems).map((item) => ({ kind: "todo" as const, id: item.id, title: item.title, detail: item.status })),
    ...sessions.flat().map((row) => ({ kind: "session" as const, id: text(row.id), title: text(row.title), detail: text(row.employee) })),
  ])
}

/** The kind first, because two objects can carry the same title and only their
 *  kind tells the operator which of the two they are about to open. */
function spokenCandidate(candidate: RankedCandidate): string {
  const kind = KIND_LABEL[candidate.kind]
  return `${candidate.title} (${kind}, ${candidate.id}${candidate.detail ? `, ${candidate.detail}` : ""})`
}

function askWhichOne(what: string, ranked: readonly RankedCandidate[]): ToolResult {
  const offered = ranked.slice(0, SPOKEN_CANDIDATES).map(spokenCandidate).join("; ")
  const more = ranked.length > SPOKEN_CANDIDATES ? ` There are ${ranked.length} matches in all.` : ""
  return {
    ok: false,
    error: `Nothing was opened because "${what}" is ambiguous. Ask which one they mean: ${offered}.${more}`,
  }
}

async function openByDescription(what: string): Promise<ToolResult> {
  const terms = searchTerms(what)
  if (terms.length === 0) {
    return { ok: false, error: `"${what}" names nothing to look for. Say a word from its title, or give the id.` }
  }

  let ranked: RankedCandidate[]
  try {
    ranked = rankCandidates(what, await candidatesFor(terms))
  } catch (error) {
    const why = error instanceof Error && error.message ? error.message : "the gateway did not answer"
    return { ok: false, error: `Could not search for "${what}": ${why}.` }
  }

  const only = ranked[0]
  if (!only) {
    return { ok: false, error: `Nothing here matches "${what}", so nothing was opened. Say it another way, or give the id.` }
  }
  if (ranked.length === 1) return go(pathFor(only))
  return askWhichOne(what, ranked)
}

const resolveAndOpen: TalkTool = {
  name: "resolve_and_open",
  description:
    'Open whatever the operator just named — a Todo or a chat session. Takes an id ("ABC-59"), a bare number ("59", meaning the namespace on screen), or their own words ("the talk orb one"). Asks which they meant when the words fit several things.',
  parameters: params(
    { what: str("Exactly what the operator called it: the id, the bare number, or their own description.") },
    ["what"],
  ),
  execute: (args: ToolArgs): ToolResult | Promise<ToolResult> => {
    const what = String(args.what).trim()
    if (!looksLikeId(what)) return openByDescription(what)

    const resolved = spokenId(what, [viewPrefix(window.location.pathname), companyTodoPrefix()])
    if ("error" in resolved) return { ok: false, error: resolved.error }
    return go(todoPath(resolved.id))
  },
}

export const RESOLVE_TOOLS: readonly TalkTool[] = [resolveAndOpen]
