/**
 * Turning what the operator said into one object.
 *
 * Pure, in the spirit of `nav-paths.ts`: no DOM, no network, no router. The
 * resolver tool adds the searching and the asking on top; the rules for reading
 * an id out of speech and for scoring a description against a list live here,
 * where they can be read and tested without a page.
 */

export type CandidateKind = "todo" | "session"

export interface Candidate {
  kind: CandidateKind
  id: string
  title: string
  /** One supporting line, shown under the card when the sheet has to ask. */
  detail?: string
}

export interface RankedCandidate extends Candidate {
  score: number
}

export type ResolvedId = { id: string } | { error: string }

const PREFIXED = /^([A-Za-z]{3})[-\s]?(\d+)$/
const BARE = /^\d+$/
/** Only a Todo page carries a namespace a bare number can inherit. Every other
 *  route's id is a slug or an opaque key, and neither prefixes anything. */
const TODO_ROUTE = /^\/todos\/([A-Za-z]{3})-\d+/

function spoken(value: unknown): string {
  if (typeof value === "number") return String(value)
  return typeof value === "string" ? value.trim() : ""
}

/** The namespace of the Todo currently on screen, so "open 744" means the one in
 *  front of the operator before it means whatever this instance mints. */
export function viewPrefix(pathname: string): string | null {
  const match = TODO_ROUTE.exec(pathname)
  return match ? match[1].toUpperCase() : null
}

/** Whether the operator gave an id at all. A description takes the search path
 *  instead, and must never be reported back as a malformed id. */
export function looksLikeId(value: unknown): boolean {
  const raw = spoken(value)
  return PREFIXED.test(raw) || BARE.test(raw)
}

/**
 * "ABC-59", "abc 59" and a bare "59" are all things a voice model produces for
 * the same object. `prefixes` is tried in order — the view first, the instance
 * default second — and an empty one is skipped rather than used.
 */
export function spokenId(value: unknown, prefixes: readonly (string | null)[]): ResolvedId {
  const raw = spoken(value)
  if (raw === "") return { error: 'Give an id, like "ABC-59", or just the number.' }

  const prefixed = PREFIXED.exec(raw)
  if (prefixed) return { id: `${prefixed[1].toUpperCase()}-${prefixed[2]}` }

  if (BARE.test(raw)) {
    const prefix = prefixes.find((candidate) => candidate)
    if (!prefix) {
      return {
        error: `Say the id with its prefix, like "ABC-${raw}" — neither the page on screen nor an instance default says which prefix "${raw}" belongs to.`,
      }
    }
    return { id: `${prefix.toUpperCase()}-${raw}` }
  }
  return { error: `"${raw}" is not an id. Ids look like "ABC-59", or say the number on its own.` }
}

/** Words that say nothing about WHICH object is meant: articles, and the nouns
 *  the operator uses for the kind rather than for the thing itself. */
const FILLER = new Set([
  "a", "an", "the", "this", "that", "it", "one", "about", "for", "of", "on", "in", "and", "my", "our",
  "todo", "task", "ticket", "item", "session", "chat", "run", "page", "open",
])

function words(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== "" && !FILLER.has(word))
}

/**
 * The terms to send to the gateway. Todo and session search both match a
 * substring, so a whole spoken phrase — "the talk orb ticket" — matches
 * nothing at all. Each distinctive word is asked for on its own instead, and
 * all of them go: the one that finds the object is not always the longest, and
 * a phrase already stripped of filler has few words left to ask for. The pooled
 * answers are a superset that `rankCandidates` narrows against everything the
 * operator said.
 */
export function searchTerms(query: string): string[] {
  return [...new Set(words(query))]
}

/**
 * Score every candidate on how much of what the operator said its title
 * accounts for, drop the ones nothing lands on, and sort what is left.
 *
 * The score is comparative only. Deciding is the caller's, and a leader never
 * gets taken on its own: on a voice channel there is no way for the operator to
 * notice that a silent pick was the wrong one.
 */
export function rankCandidates(query: string, candidates: readonly Candidate[]): RankedCandidate[] {
  const asked = words(query)
  if (asked.length === 0) return []
  return candidates
    .map((candidate) => {
      const held = new Set(words(candidate.title))
      const hits = asked.filter((word) => held.has(word)).length
      return { ...candidate, score: hits / asked.length }
    })
    .filter((ranked) => ranked.score > 0)
    .sort((first, second) => second.score - first.score)
}
